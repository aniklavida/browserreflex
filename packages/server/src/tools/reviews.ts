/**
 * The `get_pending_reviews` tool: the decisions still waiting on a person, for a chat
 * user with no review queue.
 *
 * Status: **implemented and tested**. The tests behind that claim are
 * `packages/server/test/reviews-tool.test.ts`, including a run over a real MCP client.
 *
 * What counts as waiting on a person, and why each rule is here:
 *
 * - `pending_needs_ai`: the slow path did not answer, so the row carries path `ai` and
 *   the answer `pending` that the router writes for exactly that case. A row whose
 *   answer has since been submitted no longer matches.
 * - `needs_human`: the row's path is `human`. Nothing in this build writes that path
 *   yet; the rule is here so an item appears in the queue as soon as the code that
 *   routes to a person writes it, rather than needing a change to this tool.
 * - `needs_review`: the row is flagged for review whatever its path, so a low-confidence
 *   or disputed answer is not hidden by the path it came from.
 *
 * A row can match more than one rule, and when it does the output lists every reason
 * it is in the queue rather than picking one and dropping the rest.
 *
 * Redaction runs again on the way out. `core/log.ts` redacts before storing, so most
 * rows arrive already masked, but that is a property of the writer, not of this reader.
 * Running the rules here is what makes the guarantee this tool states true of its own
 * output: every text field it returns has been through redaction.
 *
 * Invariants:
 * - Items come back oldest first, because this is a queue.
 * - `matching_count` is the number of rows the filters match, so a caller can tell a
 *   full queue from a truncated one.
 * - Context is redacted; nothing here is the original page text.
 * - The safety check is advisory. An item in this list, including one flagged
 *   `is_safety`, is a request for a person to look. Nothing in this server stops an
 *   agent from acting, and this tool does not claim otherwise.
 */

import { z } from 'zod';
import type { ZodRawShape } from 'zod';
import {
  DecisionPathSchema,
  DecisionTypeSchema,
  type DecisionPath,
  type DecisionType,
} from '../core/schema.js';
import { getDefaultStore } from '../core/log.js';
import { redact } from '../security/redact.js';
import type { DatabaseStore } from '../store/index.js';

/** Why an item is in the review queue, in the order the output lists them. */
export const REVIEW_REASONS = ['needs_human', 'needs_review', 'pending_needs_ai'] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

/**
 * The answer the router writes when the slow path could not answer. A pending item is
 * recognised by this value together with path `ai`, not by either alone: a path of `ai`
 * on its own also covers an answer that has been submitted.
 */
export const PENDING_ANSWER_MARKER = 'pending';

/** How many items a call returns when the caller does not say. */
export const DEFAULT_REVIEW_LIMIT = 20;

/** The largest page this tool will return. */
export const MAX_REVIEW_LIMIT = 200;

/** The rules that put a row in the queue, as one parenthesised SQL fragment. */
const QUEUE_RULES =
  "((path = 'ai' AND answer = :pending_marker) OR path = 'human' OR needs_review = 1)";

/** The columns an item is built from. Kept in one place so both queries agree. */
const ITEM_COLUMNS = `id, decision_type, question, context, url, domain, path, answer, confidence,
       latency_ms, is_safety, needs_review, created_at,
       CASE WHEN path = 'human' THEN 1 ELSE 0 END AS is_needs_human,
       CASE WHEN needs_review = 1 THEN 1 ELSE 0 END AS is_needs_review,
       CASE WHEN path = 'ai' AND answer = :pending_marker THEN 1 ELSE 0 END AS is_pending_ai`;

export interface PendingReviewItem {
  readonly decision_id: string;
  readonly decision_type: DecisionType;
  /** Redacted question text. */
  readonly question: string;
  /** Redacted stored context, or `null` when the row has none. */
  readonly context: string | null;
  /** Redacted URL, or `null` when the row has none. */
  readonly url: string | null;
  readonly domain: string | null;
  readonly path: DecisionPath;
  /** Redacted answer text. `pending` when the slow path has not answered. */
  readonly answer: string;
  readonly confidence: number;
  readonly latency_ms: number;
  readonly is_safety: boolean;
  readonly needs_review: boolean;
  readonly created_at: string;
  /** Whole seconds since `created_at`, or `null` when the timestamp cannot be read. */
  readonly age_seconds: number | null;
  /** Every reason this item is in the queue. Never empty. */
  readonly reasons: ReviewReason[];
}

export interface GetPendingReviewsOutput {
  readonly items: PendingReviewItem[];
  /** Rows the filters matched, before `limit` was applied. */
  readonly matching_count: number;
  readonly returned_count: number;
  readonly limit: number;
  /** The type filter that was applied, or `null` when there was none. */
  readonly type: DecisionType | null;
  /** The age filter that was applied in minutes, or `null` when there was none. */
  readonly older_than_minutes: number | null;
  /** Always `advisory`: nothing in this server stops an agent from acting. */
  readonly safety_check: 'advisory';
}

export const getPendingReviewsInputSchema: ZodRawShape = {
  type: z
    .enum(['choice', 'score', 'check'])
    .optional()
    .describe('Only items of this decision type: choice, score or check.'),
  older_than_minutes: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Only items that have been waiting at least this many minutes.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_REVIEW_LIMIT)
    .optional()
    .describe(
      `How many items to return, oldest first. Defaults to ${DEFAULT_REVIEW_LIMIT}, maximum ${MAX_REVIEW_LIMIT}.`,
    ),
};

export const getPendingReviewsOutputSchema: ZodRawShape = {
  items: z.array(
    z.object({
      decision_id: z.string(),
      decision_type: DecisionTypeSchema,
      question: z.string(),
      context: z.string().nullable(),
      url: z.string().nullable(),
      domain: z.string().nullable(),
      path: DecisionPathSchema,
      answer: z.string(),
      confidence: z.number().min(0).max(1),
      latency_ms: z.number(),
      is_safety: z.boolean(),
      needs_review: z.boolean(),
      created_at: z.string(),
      age_seconds: z.number().min(0).nullable(),
      reasons: z.array(z.enum(REVIEW_REASONS)).min(1),
    }),
  ),
  matching_count: z.number().int().min(0),
  returned_count: z.number().int().min(0),
  limit: z.number().int().min(1),
  type: DecisionTypeSchema.nullable(),
  older_than_minutes: z.number().int().min(0).nullable(),
  safety_check: z.literal('advisory'),
};

export interface GetPendingReviewsContext {
  readonly store?: DatabaseStore | undefined;
  /** Clock reading for this call. Injected by tests; production passes nothing. */
  readonly now?: Date | undefined;
}

interface QueueRow {
  id: string;
  decision_type: DecisionType;
  question: string;
  context: string | null;
  url: string | null;
  domain: string | null;
  path: DecisionPath;
  answer: string;
  confidence: number;
  latency_ms: number;
  is_safety: number;
  needs_review: number;
  created_at: string;
  is_needs_human: number;
  is_needs_review: number;
  is_pending_ai: number;
}

/** Turns one row into one item, redacting every text field it carries. */
function toItem(row: QueueRow, now: Date): PendingReviewItem {
  const reasons: ReviewReason[] = [];
  if (row.is_needs_human === 1) {
    reasons.push('needs_human');
  }
  if (row.is_needs_review === 1) {
    reasons.push('needs_review');
  }
  if (row.is_pending_ai === 1) {
    reasons.push('pending_needs_ai');
  }

  const createdAtMs = Date.parse(row.created_at);
  const ageSeconds = Number.isFinite(createdAtMs)
    ? Math.max(0, Math.round((now.getTime() - createdAtMs) / 1000))
    : null;

  return {
    decision_id: row.id,
    decision_type: row.decision_type,
    question: redact(row.question),
    context: row.context === null ? null : redact(row.context),
    url: row.url === null ? null : redact(row.url),
    domain: row.domain,
    path: row.path,
    answer: redact(row.answer),
    confidence: row.confidence,
    latency_ms: row.latency_ms,
    is_safety: row.is_safety === 1,
    needs_review: row.needs_review === 1,
    created_at: row.created_at,
    age_seconds: ageSeconds,
    reasons,
  };
}

/**
 * Executes the `get_pending_reviews` tool logic: the items waiting on a person, oldest
 * first, with the optional type and age filters applied.
 *
 * An argument the tool cannot honour is refused rather than dropped. A caller that
 * asked for a decision type and silently received every type would be reading a queue
 * it did not ask for.
 */
export function executeGetPendingReviews(
  args: Record<string, unknown>,
  context: GetPendingReviewsContext = {},
): GetPendingReviewsOutput {
  const store = context.store ?? getDefaultStore();
  const now = context.now ?? new Date();

  const type = readType(args.type);
  const olderThanMinutes = readOlderThanMinutes(args.older_than_minutes);
  const limit = readLimit(args.limit);

  const params: Record<string, unknown> = { pending_marker: PENDING_ANSWER_MARKER };
  const filters: string[] = [];

  if (type !== null) {
    filters.push('decision_type = :decision_type');
    params.decision_type = type;
  }

  if (olderThanMinutes !== null) {
    // created_at is ISO-8601 UTC text written the same way by every write path, so the
    // cutoff is the same comparison: items at or before the cutoff have waited long
    // enough.
    const cutoff = new Date(now.getTime() - olderThanMinutes * 60 * 1000);
    filters.push('created_at <= :cutoff');
    params.cutoff = cutoff.toISOString();
  }

  const where = filters.length > 0 ? `${QUEUE_RULES} AND ${filters.join(' AND ')}` : QUEUE_RULES;

  const countRow = store.db
    .prepare(`SELECT COUNT(*) AS total FROM decisions WHERE ${where}`)
    .get(params) as { total: number };

  const rows = store.db
    .prepare(
      `SELECT ${ITEM_COLUMNS} FROM decisions WHERE ${where} ORDER BY created_at ASC, id ASC LIMIT :limit`,
    )
    .all({ ...params, limit }) as QueueRow[];

  const items = rows.map((row) => toItem(row, now));

  return {
    items,
    matching_count: Number(countRow.total),
    returned_count: items.length,
    limit,
    type,
    older_than_minutes: olderThanMinutes,
    safety_check: 'advisory',
  };
}

function readType(value: unknown): DecisionType | null {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = DecisionTypeSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Unknown decision type ${JSON.stringify(value)}. Expected choice, score or check, or nothing.`,
    );
  }
  return parsed.data;
}

function readOlderThanMinutes(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `older_than_minutes must be a whole number of minutes, zero or more; received ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function readLimit(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_REVIEW_LIMIT;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_REVIEW_LIMIT
  ) {
    throw new Error(
      `limit must be a whole number between 1 and ${MAX_REVIEW_LIMIT}; received ${JSON.stringify(value)}.`,
    );
  }
  return value;
}
