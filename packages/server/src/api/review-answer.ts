/**
 * Writing one review answer, shared by the single and the bulk endpoint.
 *
 * Both `POST /api/reviews/:id/answer` and `POST /api/reviews/bulk` call
 * `applyReviewAnswer`, so the two paths cannot drift apart and there is one
 * place for the feedback function added in a later card to hook into. The
 * handler stays a thin wrapper around the store.
 *
 * What this records, and what it does not: it writes the answer the user gave
 * through the feedback repository, marks the decision as no longer needing
 * review, and returns what was stored. It does not claim that the answer was
 * applied to memory or to any pattern: nothing measures or updates a pattern
 * confidence here, and the response says nothing about that.
 *
 * The safety check is advisory. Recording a user's answer to a safety prompt
 * here does not stop an agent from acting, and nothing in this file enforces a
 * rule.
 *
 * Status: **implemented and tested** in `packages/server/test/api.test.ts`.
 */

import type { DatabaseStore } from '../store/index.js';
import type { Feedback } from '../store/types.js';
import { redact } from '../security/redact.js';

/** Where an answer came from. The API is the human path. */
const REVIEW_SOURCE = 'human';

export interface ReviewAnswerInput {
  readonly decision_id: string;
  readonly correct_value: string;
  readonly note?: string | null | undefined;
}

/** Why an answer could not be written. */
export type ReviewAnswerError =
  | { readonly kind: 'not_found'; readonly decision_id: string }
  | { readonly kind: 'invalid'; readonly reason: string };

export type ReviewAnswerResult =
  | { readonly ok: true; readonly feedback: Feedback }
  | { readonly ok: false; readonly error: ReviewAnswerError };

/**
 * Stores one review answer.
 *
 * The note is redacted before it is written, like every other piece of text that
 * reaches the database. The feedback row returned is what was actually stored,
 * so a caller cannot report an unredacted note that was never kept.
 */
export function applyReviewAnswer(
  store: DatabaseStore,
  input: ReviewAnswerInput,
): ReviewAnswerResult {
  const decisionId = input.decision_id.trim();
  if (decisionId === '') {
    return { ok: false, error: { kind: 'invalid', reason: 'decision_id is required' } };
  }

  const correctValue = input.correct_value.trim();
  if (correctValue === '') {
    return { ok: false, error: { kind: 'invalid', reason: 'correct_value is required' } };
  }

  if (!store.decisions.getById(decisionId)) {
    return { ok: false, error: { kind: 'not_found', decision_id: decisionId } };
  }

  const note = typeof input.note === 'string' && input.note !== '' ? redact(input.note) : null;

  const feedback = store.feedback.create({
    decision_id: decisionId,
    correct_value: correctValue,
    note,
    source: REVIEW_SOURCE,
  });

  store.decisions.update(decisionId, { needs_review: false });

  return { ok: true, feedback };
}

/** A short message for an error, for the bulk endpoint's per-item error list. */
export function describeReviewError(error: ReviewAnswerError): string {
  return error.kind === 'not_found' ? `Decision ${error.decision_id} not found` : error.reason;
}
