/**
 * Answering `needs_ai` items through a provider adapter.
 *
 * Status: **implemented and tested** in `packages/server/test/resolve-needs-ai.test.ts`.
 *
 * In chat mode the agent answers a `needs_ai` item through `submit_answers`. In
 * BYOK mode BrowserReflex answers it itself with the user's own key, and this
 * module is that path. It is deliberately separate from `decide`: the routing and
 * the default behaviour of `decide` are unchanged by it, and a card later wires
 * it in.
 *
 * Invariants, each with a named test:
 *
 * - **A valid answer is recorded through the existing submit path, with path
 *   `ai`.** `resolveNeedsAi` builds the same payload the agent would send and
 *   hands the batch to `executeSubmitAnswers`, rather than writing rows of its
 *   own, so validation, the confidence threshold and the stored shape are the ones
 *   already tested there. One place decides what a stored answer looks like.
 * - **An invalid model answer is rejected and never stored.** The question stays
 *   in `needs_ai` with its decision pending, exactly as it does when an agent
 *   submits something the schema rejects, and the reject names the reason.
 * - **A question the model skipped is reported.** It comes back as a reject with
 *   `no_model_answer`, not as an answer and not as silence.
 * - **A provider failure stores nothing.** Every item comes back as a reject and
 *   every decision stays pending.
 * - **A valid answer below the threshold is recorded and listed in
 *   `needs_human`.** That is submit's rule and this module does not restate it.
 * - **The result says what actually happened.** `provider` and `model` name who
 *   answered, `model` is `null` when no model answered at all, and `latency_ms` is
 *   this function's own measured wall time.
 * - **A message from an adapter this project did not write is not copied into the
 *   output.** Only an `AdapterError` message is used; anything else becomes a
 *   fixed sentence naming the provider, because an unknown throwable's text is
 *   not known to be free of a key.
 * - **The safety check is advisory.** Nothing here stops an agent from acting.
 */

import { performance } from 'node:perf_hooks';
import type { NeedsAiItem } from '../core/router.js';
import { getDefaultStore } from '../core/log.js';
import type { DatabaseStore, Session } from '../store/index.js';
import {
  type NeedsHumanAnswerItem,
  type ValidatedAnswerItem,
  executeSubmitAnswers,
} from '../tools/submit_answers.js';
import { AdapterError, type ModelAdapter } from './types.js';

/** Why one question has no recorded answer after a provider call. */
export type ResolveNeedsAiRejectType =
  /** The model answered something the decision schema does not accept. */
  | 'invalid_model_output'
  /** The model returned no answer for this question. */
  | 'no_model_answer'
  /** The provider call failed, so nothing was stored for any item. */
  | 'adapter_error'
  /** `submit_answers` refused to record an answer the adapter had produced. */
  | 'submit_rejected';

export interface ResolveNeedsAiReject {
  type: ResolveNeedsAiRejectType;
  reason: string;
  /** The decision the reject is about, when one is known. */
  decision_id?: string | undefined;
  /** The question the reject is about, when one is known. */
  question_id?: string | undefined;
  /** The field the schema named, when it named one. */
  field?: string | undefined;
}

export interface ResolveNeedsAiResult {
  [key: string]: unknown;
  /** Answers recorded with path `ai`. */
  answers: ValidatedAnswerItem[];
  /** Answers recorded with path `ai` and sent to review, below the threshold. */
  needs_human: NeedsHumanAnswerItem[];
  /** Questions with no recorded answer, each with the reason. */
  rejects: ResolveNeedsAiReject[];
  /** The provider that was called. */
  provider: string;
  /** The model that answered, or `null` when no model answered. */
  model: string | null;
  /** This function's measured wall time in milliseconds. */
  latency_ms: number;
  /** Requests made, including retries. Zero when no item was asked about. */
  attempts: number;
}

export interface ResolveNeedsAiDeps {
  /** Where decisions are read and written. The default store when absent. */
  store?: DatabaseStore | undefined;
  /** The session the decisions belong to. */
  session?: Session | undefined;
  /** The session id, when there is a session object to take it from. */
  sessionId?: string | undefined;
  /** Confidence threshold for accepting an answer without review. 0.8 default. */
  threshold?: number | undefined;
  /** Redacted page data to send as context. Never sent as an instruction. */
  context?: unknown;
  /** The clock. Injected so a test can state a latency. */
  now?: (() => number) | undefined;
}

function defaultNow(): number {
  return performance.now();
}

/** The item a decision id belongs to, for naming a reject. */
function itemForDecision(
  items: readonly NeedsAiItem[],
  decisionId: string | undefined,
): NeedsAiItem | undefined {
  if (decisionId === undefined) return undefined;
  return items.find((item) => item.decision_id === decisionId);
}

/** A stable view of the questions asked, so a reject can name its decision. */
function itemFor(items: readonly NeedsAiItem[], questionId: string): NeedsAiItem | undefined {
  return items.find((item) => item.question.id === questionId);
}

/**
 * Answers a list of `needs_ai` items through an adapter, validates each answer and
 * records the valid ones.
 *
 * Returns the answers that were recorded, the answers that were recorded and sent
 * to review, and a reject for every question that has no recorded answer. Nothing
 * here throws for a provider failure or for an answer the schema rejects: those are
 * results, because a caller that gets an exception cannot tell a pending decision
 * from one that was never offered.
 */
export async function resolveNeedsAi(
  items: readonly NeedsAiItem[],
  adapter: ModelAdapter,
  deps: ResolveNeedsAiDeps = {},
): Promise<ResolveNeedsAiResult> {
  const store = deps.store ?? getDefaultStore();
  const now = deps.now ?? defaultNow;
  const startedAt = now();

  if (items.length === 0) {
    return {
      answers: [],
      needs_human: [],
      rejects: [],
      provider: adapter.provider,
      model: null,
      latency_ms: 0,
      attempts: 0,
    };
  }

  const questions = items.map((item) => item.question);
  const rejects: ResolveNeedsAiReject[] = [];

  let provider: string;
  let model: string | null = null;
  let attempts = 0;
  let drafts: readonly {
    questionId: string;
    value: string | number | boolean;
    confidence: number;
    distribution?: Record<string, number> | undefined;
  }[];

  try {
    const result = await adapter.decide({
      questions,
      ...(deps.context !== undefined ? { context: deps.context } : {}),
    });
    provider = result.provider;
    model = result.model;
    attempts = result.attempts;
    drafts = result.answers;

    // A reject the adapter already reported is reported here too, so a caller
    // reads one list rather than two.
    for (const reject of result.rejects) {
      const item = reject.questionId ? itemFor(items, reject.questionId) : undefined;
      rejects.push({
        type: 'invalid_model_output',
        reason: reject.reason,
        ...(reject.questionId !== undefined ? { question_id: reject.questionId } : {}),
        ...(reject.field !== undefined ? { field: reject.field } : {}),
        ...(item !== undefined ? { decision_id: item.decision_id } : {}),
      });
    }
  } catch (cause) {
    provider = adapter.provider;
    // Only a message from this project's own adapter type is used. An unknown
    // throwable could be carrying anything, so it is not copied into the output.
    const reason =
      cause instanceof AdapterError
        ? cause.message
        : `The provider adapter threw an error this build does not recognise, so nothing was stored: ${describeThrown(cause)}`;
    for (const item of items) {
      rejects.push({
        type: 'adapter_error',
        reason,
        decision_id: item.decision_id,
        question_id: item.question.id,
      });
    }
    return {
      answers: [],
      needs_human: [],
      rejects,
      provider,
      model,
      latency_ms: Number((now() - startedAt).toFixed(3)),
      attempts,
    };
  }

  // Attach each draft to the decision it answers. A draft for a question id that
  // was never asked is reported, never applied to whatever happens to match. Two
  // drafts for one question are both reported and neither is recorded: which of
  // the two to believe is a question only a person can answer.
  const draftCounts = new Map<string, number>();
  for (const draft of drafts) {
    draftCounts.set(draft.questionId, (draftCounts.get(draft.questionId) ?? 0) + 1);
  }
  const duplicated = new Set(
    [...draftCounts.entries()].filter(([, count]) => count > 1).map(([questionId]) => questionId),
  );

  const answeredQuestionIds = new Set<string>();
  const payload: Record<string, unknown>[] = [];

  for (const draft of drafts) {
    if (duplicated.has(draft.questionId)) continue;
    const item = itemFor(items, draft.questionId);
    if (!item) {
      rejects.push({
        type: 'invalid_model_output',
        reason: `The adapter returned an answer for question id "${draft.questionId}", which was not asked.`,
        question_id: draft.questionId,
      });
      continue;
    }
    answeredQuestionIds.add(draft.questionId);
    payload.push({
      decision_id: item.decision_id,
      id: item.id,
      type: item.type,
      question: item.question,
      value: draft.value,
      confidence: draft.confidence,
      path: 'ai',
      ...(draft.distribution !== undefined ? { distribution: draft.distribution } : {}),
    });
  }

  // A question with two drafts was answered by nobody, so say that rather than
  // leaving it to look like a question the model skipped.
  for (const questionId of duplicated) {
    const item = itemFor(items, questionId);
    if (item === undefined) continue;
    rejects.push({
      type: 'invalid_model_output',
      reason: `The adapter returned more than one answer for question id "${questionId}".`,
      decision_id: item.decision_id,
      question_id: questionId,
    });
  }

  // Every question the model left out is named. Silence is not an answer.
  for (const item of items) {
    if (answeredQuestionIds.has(item.question.id)) continue;
    if (rejects.some((reject) => reject.question_id === item.question.id)) continue;
    rejects.push({
      type: 'no_model_answer',
      reason: `The model returned no answer for question id "${item.question.id}".`,
      decision_id: item.decision_id,
      question_id: item.question.id,
    });
  }

  const submitted = await executeSubmitAnswers(
    {
      answers: payload,
      ...(deps.threshold !== undefined ? { threshold: deps.threshold } : {}),
    },
    {
      store,
      ...(deps.session !== undefined ? { session: deps.session } : {}),
      ...(deps.sessionId !== undefined ? { sessionId: deps.sessionId } : {}),
    },
  );

  for (const violation of submitted.schema_violations) {
    const item =
      itemForDecision(items, violation.decision_id) ??
      (typeof violation.id === 'string' ? itemFor(items, violation.id) : undefined);
    rejects.push({
      type: 'invalid_model_output',
      reason: violation.reason,
      ...(violation.decision_id !== undefined ? { decision_id: violation.decision_id } : {}),
      ...(violation.id !== undefined ? { question_id: violation.id } : {}),
      ...(violation.field !== undefined ? { field: violation.field } : {}),
      ...(item !== undefined && violation.decision_id === undefined
        ? { decision_id: item.decision_id }
        : {}),
    });
  }

  for (const error of submitted.errors) {
    rejects.push({
      type: 'submit_rejected',
      reason: error.message,
      decision_id: error.decision_id,
    });
  }

  return {
    answers: submitted.answers,
    needs_human: submitted.needs_human,
    rejects,
    provider,
    model,
    latency_ms: Number((now() - startedAt).toFixed(3)),
    attempts,
  };
}

/**
 * A description of an unknown throwable that is not its message.
 *
 * An adapter written outside this project could throw a string that holds a key,
 * so only the type and, for an `Error`, its own class name are used.
 */
function describeThrown(cause: unknown): string {
  if (cause instanceof Error) return `${cause.constructor.name}`;
  return typeof cause;
}
