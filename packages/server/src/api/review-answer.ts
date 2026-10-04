/**
 * Writing one review answer, shared by the single and the bulk endpoint.
 *
 * Both `POST /api/reviews/:id/answer` and `POST /api/reviews/bulk` call
 * `applyReviewAnswer`, so the two paths cannot drift apart and there is one place
 * for a change to land. The write itself goes through `executeFeedback`, the same
 * function the `feedback` tool uses, so an answer given in the UI and a
 * correction given by an agent are recorded the same way: the value is checked
 * against the decision's type, the note is redacted before it is stored, and the
 * pattern statistics are updated. Nothing about that is duplicated here.
 *
 * What this adds on top of the feedback function: the decision is marked as no
 * longer needing review, and the caller is told what the answer actually changed,
 * because `executeFeedback` reports it. The response says nothing about memory or
 * patterns beyond what that report contains.
 *
 * The safety check is advisory. Recording a user's answer to a safety prompt here
 * does not stop an agent from acting, and nothing in this file enforces a rule.
 *
 * Status: **implemented and tested** in `packages/server/test/api.test.ts`.
 */

import type { DatabaseStore } from '../store/index.js';
import type { Feedback } from '../store/types.js';
import { executeFeedback, type FeedbackOutput } from '../tools/feedback.js';

/** Who answered: the review queue is the human path. */
const REVIEW_SOURCE = 'user';

export interface ReviewAnswerInput {
  readonly decision_id: string;
  readonly correct_value: string | number | boolean;
  readonly note?: string | null | undefined;
}

/** Why an answer could not be written. */
export type ReviewAnswerError =
  | { readonly kind: 'not_found'; readonly decision_id: string }
  | { readonly kind: 'invalid'; readonly reason: string };

export interface ReviewAnswerSuccess {
  readonly ok: true;
  /** The feedback row as stored, so the response cannot describe something else. */
  readonly feedback: Feedback | null;
  /** What the write changed, as the feedback function reported it. */
  readonly recorded: FeedbackOutput;
  /** False when the stored row could not be read back; the write still happened. */
  readonly review_cleared: boolean;
}

export type ReviewAnswerResult =
  ReviewAnswerSuccess | { readonly ok: false; readonly error: ReviewAnswerError };

/**
 * Stores one review answer and clears the review flag.
 *
 * The feedback row returned is what was actually stored, so a caller cannot report
 * an unredacted note that was never kept.
 */
export async function applyReviewAnswer(
  store: DatabaseStore,
  input: ReviewAnswerInput,
): Promise<ReviewAnswerResult> {
  const decisionId = typeof input.decision_id === 'string' ? input.decision_id.trim() : '';
  if (decisionId === '') {
    return { ok: false, error: { kind: 'invalid', reason: 'decision_id is required' } };
  }

  const output = await executeFeedback(
    {
      decision_id: decisionId,
      correct_value: input.correct_value,
      source: REVIEW_SOURCE,
      note: input.note ?? undefined,
    },
    { store },
  );

  if (output.status === 'error') {
    return output.error === 'decision_not_found'
      ? { ok: false, error: { kind: 'not_found', decision_id: decisionId } }
      : {
          ok: false,
          error: { kind: 'invalid', reason: output.message ?? 'correct_value was refused' },
        };
  }

  const stored = store.decisions.update(decisionId, { needs_review: false });
  const row = output.feedback_id === undefined ? null : store.feedback.getById(output.feedback_id);

  return {
    ok: true,
    feedback: row,
    recorded: output,
    review_cleared: stored !== null && stored.needs_review === 0,
  };
}

/** A short message for an error, for the bulk endpoint's per-item error list. */
export function describeReviewError(error: ReviewAnswerError): string {
  return error.kind === 'not_found' ? `Decision ${error.decision_id} not found` : error.reason;
}
