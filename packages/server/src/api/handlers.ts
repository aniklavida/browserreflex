/**
 * Route handlers for the local REST API.
 *
 * Each handler reads from the store repositories and writes a JSON response.
 * The handlers are deliberately thin: the counting for `/api/stats` lives in
 * `stats.ts` and the write for both review endpoints lives in
 * `review-answer.ts`, so a later card can put the real statistics and feedback
 * functions behind the same endpoints without editing these handlers.
 *
 * Every response body is snake_case, matching the decision schema.
 *
 * Status: **implemented and tested** in `packages/server/test/api.test.ts`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseStore } from '../store/index.js';
import type {
  DecisionFilter,
  DecisionPath,
  DecisionType,
  PatternFilter,
  PatternStatus,
} from '../store/types.js';
import type { RouteParams } from './router.js';
import {
  boolParam,
  errorResponse,
  errorStatus,
  intParam,
  jsonResponse,
  parseQuery,
  readJsonBody,
  UNREADABLE_BODY,
} from './http.js';
import { maskSetting, refuseSettingWrite } from './settings-mask.js';
import { applyReviewAnswer, describeReviewError } from './review-answer.js';
import { buildStats } from './stats.js';

/** Reads a JSON object body, or writes a 4xx and returns undefined. */
async function readObjectBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | undefined> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    errorResponse(res, errorStatus(err), err instanceof Error ? err.message : UNREADABLE_BODY);
    return undefined;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    errorResponse(res, 400, 'Request body must be a JSON object');
    return undefined;
  }
  return body as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// GET /api/stats
// ---------------------------------------------------------------------------

export function handleGetStats(store: DatabaseStore) {
  return async function (_req: IncomingMessage, res: ServerResponse): Promise<void> {
    jsonResponse(res, 200, buildStats(store));
  };
}

// ---------------------------------------------------------------------------
// GET /api/decisions
// ---------------------------------------------------------------------------

export function handleListDecisions(store: DatabaseStore) {
  return async function (req: IncomingMessage, res: ServerResponse): Promise<void> {
    const q = parseQuery(req.url ?? '/');
    const limit = intParam(q.limit, 50, 1, 500);
    const offset = intParam(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    // Built imperatively because exactOptionalPropertyTypes forbids a key that
    // is present with an undefined value.
    const filter: DecisionFilter = { limit, offset };
    if (q.session_id !== undefined) filter.session_id = q.session_id;
    if (q.domain !== undefined) filter.domain = q.domain;
    if (q.path !== undefined) filter.path = q.path as DecisionPath;
    if (q.pattern_id !== undefined) filter.pattern_id = q.pattern_id;
    if (q.from !== undefined) filter.created_from = q.from;
    if (q.to !== undefined) filter.created_to = q.to;
    if (q.q !== undefined) filter.search = q.q.slice(0, 200);
    const needsReview = boolParam(q.needs_review);
    if (needsReview !== undefined) filter.needs_review = needsReview;
    const isSafety = boolParam(q.is_safety);
    if (isSafety !== undefined) filter.is_safety = isSafety;

    jsonResponse(res, 200, {
      items: store.decisions.list(filter),
      total: store.decisions.count(filter),
      limit,
      offset,
    });
  };
}

// ---------------------------------------------------------------------------
// GET /api/decisions/:id
// ---------------------------------------------------------------------------

export function handleGetDecision(store: DatabaseStore) {
  return async function (
    _req: IncomingMessage,
    res: ServerResponse,
    params: RouteParams,
  ): Promise<void> {
    const decision = store.decisions.getById(params.id ?? '');
    if (decision === null) {
      errorResponse(res, 404, 'Decision not found');
      return;
    }
    jsonResponse(res, 200, decision);
  };
}

// ---------------------------------------------------------------------------
// GET /api/reviews
// ---------------------------------------------------------------------------

export function handleListReviews(store: DatabaseStore) {
  return async function (req: IncomingMessage, res: ServerResponse): Promise<void> {
    const q = parseQuery(req.url ?? '/');
    const limit = intParam(q.limit, 20, 1, 200);
    const offset = intParam(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    const filter: DecisionFilter = { needs_review: true, limit, offset };
    jsonResponse(res, 200, {
      items: store.decisions.list(filter),
      total: store.decisions.count({ needs_review: true }),
      limit,
      offset,
    });
  };
}

// ---------------------------------------------------------------------------
// POST /api/reviews/:id/answer
// ---------------------------------------------------------------------------

export function handleAnswerReview(store: DatabaseStore) {
  return async function (
    req: IncomingMessage,
    res: ServerResponse,
    params: RouteParams,
  ): Promise<void> {
    const body = await readObjectBody(req, res);
    if (body === undefined) return;

    const correctValue = body.correct_value;
    if (
      typeof correctValue !== 'string' &&
      typeof correctValue !== 'number' &&
      typeof correctValue !== 'boolean'
    ) {
      errorResponse(
        res,
        400,
        'correct_value is required and must be a string, a number or a boolean',
      );
      return;
    }

    const result = await applyReviewAnswer(store, {
      decision_id: params.id ?? '',
      correct_value: correctValue,
      note: typeof body.note === 'string' ? body.note : null,
    });

    if (!result.ok) {
      if (result.error.kind === 'not_found') {
        errorResponse(res, 404, 'Decision not found');
        return;
      }
      errorResponse(res, 400, result.error.reason);
      return;
    }

    jsonResponse(res, 201, {
      feedback: result.feedback,
      recorded: result.recorded,
      review_cleared: result.review_cleared,
    });
  };
}

// ---------------------------------------------------------------------------
// POST /api/reviews/bulk
// ---------------------------------------------------------------------------

export function handleBulkReviews(store: DatabaseStore) {
  return async function (req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readObjectBody(req, res);
    if (body === undefined) return;

    if (!Array.isArray(body.answers)) {
      errorResponse(res, 400, 'answers must be an array');
      return;
    }

    const results: unknown[] = [];
    const errors: { index: number; error: string }[] = [];

    for (const [index, entry] of body.answers.entries()) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push({ index, error: 'Each answer must be an object' });
        continue;
      }
      const item = entry as Record<string, unknown>;
      const correctValue = item.correct_value;
      const result = await applyReviewAnswer(store, {
        decision_id: typeof item.decision_id === 'string' ? item.decision_id : '',
        correct_value:
          typeof correctValue === 'string' ||
          typeof correctValue === 'number' ||
          typeof correctValue === 'boolean'
            ? correctValue
            : '',
        note: typeof item.note === 'string' ? item.note : null,
      });
      if (!result.ok) {
        errors.push({ index, error: describeReviewError(result.error) });
        continue;
      }
      results.push({ feedback: result.feedback, recorded: result.recorded });
    }

    jsonResponse(res, 200, { processed: results.length, results, errors });
  };
}

// ---------------------------------------------------------------------------
// GET /api/settings
// ---------------------------------------------------------------------------

export function handleGetSettings(store: DatabaseStore) {
  return async function (_req: IncomingMessage, res: ServerResponse): Promise<void> {
    jsonResponse(res, 200, { settings: store.settings.list().map((s) => maskSetting(s)) });
  };
}

// ---------------------------------------------------------------------------
// PUT /api/settings
// ---------------------------------------------------------------------------

export function handlePutSettings(store: DatabaseStore) {
  return async function (req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readObjectBody(req, res);
    if (body === undefined) return;

    if (typeof body.key !== 'string' || body.key.trim() === '') {
      errorResponse(res, 400, 'key is required and must be a non-empty string');
      return;
    }
    if (body.value === undefined || body.value === null) {
      errorResponse(res, 400, 'value is required');
      return;
    }

    const key = body.key.trim();
    const value = typeof body.value === 'string' ? body.value : JSON.stringify(body.value);

    // A credential never reaches the settings table: keys belong in the keychain,
    // and a value the redaction rules would mask is not stored under any name.
    const refusal = refuseSettingWrite(key, value);
    if (refusal !== undefined) {
      errorResponse(res, 400, refusal);
      return;
    }

    jsonResponse(res, 200, { setting: maskSetting(store.settings.set(key, value)) });
  };
}

// ---------------------------------------------------------------------------
// GET /api/packs
// ---------------------------------------------------------------------------

export function handleGetPacks(store: DatabaseStore) {
  return async function (req: IncomingMessage, res: ServerResponse): Promise<void> {
    const q = parseQuery(req.url ?? '/');
    const limit = intParam(q.limit, 100, 1, 500);
    const offset = intParam(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const items = store.packs.list({ activeOnly: q.active === 'true', limit, offset });
    jsonResponse(res, 200, { items, total: items.length, limit, offset });
  };
}

// ---------------------------------------------------------------------------
// GET /api/patterns
// ---------------------------------------------------------------------------

export function handleGetPatterns(store: DatabaseStore) {
  return async function (req: IncomingMessage, res: ServerResponse): Promise<void> {
    const q = parseQuery(req.url ?? '/');
    const filter: PatternFilter = {
      limit: intParam(q.limit, 100, 1, 500),
      offset: intParam(q.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    };
    if (q.pack_id !== undefined) filter.pack_id = q.pack_id;
    if (q.domain !== undefined) filter.domain = q.domain;
    if (q.status !== undefined) filter.status = q.status as PatternStatus;
    if (q.decision_type !== undefined) filter.decision_type = q.decision_type as DecisionType;
    const isSafety = boolParam(q.is_safety);
    if (isSafety !== undefined) filter.is_safety = isSafety;

    const items = store.patterns.list(filter);
    jsonResponse(res, 200, {
      items,
      total: items.length,
      limit: filter.limit,
      offset: filter.offset,
    });
  };
}
