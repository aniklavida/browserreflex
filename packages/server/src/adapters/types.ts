/**
 * The provider adapter interface used by BYOK mode.
 *
 * Status: **implemented and tested**. The interface and the validation it
 * enforces are covered by `packages/server/test/anthropic-adapter.test.ts` and
 * `packages/server/test/resolve-needs-ai.test.ts`.
 *
 * What an adapter is: one object that turns a list of typed `Question` values
 * into typed answer drafts, using the user's own provider key, and says what it
 * did: which provider answered, which model answered, how long it took, how many
 * attempts it made, and which questions it could not answer.
 *
 * Invariants this interface holds, each with a named test:
 *
 * - **An adapter never states a path.** `AdapterAnswerDraft` has no `path`
 *   field, so an adapter cannot claim an answer came from memory, a pattern or a
 *   check. Only the recording layer writes a path, and it writes `ai` because the
 *   provider is what produced the answer. A decision record that misdescribes
 *   itself is worse than no record.
 * - **An adapter returns drafts, not records.** Nothing here writes to the
 *   database, so a draft that has not been validated cannot reach a decision row.
 * - **An answer the schema rejects is a reject, not a repair.** Every draft is
 *   checked against the question it answers with `validateAnswer`, and a failure
 *   becomes an `AdapterReject` carrying the reason and the field. Nothing is
 *   coerced, rounded, clamped or dropped silently.
 * - **A question the provider skipped is reported.** A `decide` result says which
 *   questions came back; the caller is told about the rest, so a skipped question
 *   cannot be mistaken for an answered one.
 * - **The key never crosses this boundary.** `AdapterDecideResult` and
 *   `AdapterError` have no field a key could occupy, and the key is read from the
 *   key store at call time rather than held by the adapter.
 * - **The safety check is advisory.** An adapter answers questions; it does not
 *   stop an agent from acting, and nothing here enforces anything.
 *
 * Known limit: the interface says nothing about cost. `AdapterUsage` carries the
 * token counts the provider reported so a caller can add them up, but no price
 * table ships with it, because a price table would be a guess about someone
 * else's invoice.
 */

import type { Question } from '../core/schema.js';

/** Why an adapter call failed. Every code names something that was observed. */
export type AdapterErrorCode =
  /** No key is stored for this provider, so no call was made. */
  | 'no_key'
  /** The model id, the questions or the retry policy is unusable. Not repaired. */
  | 'config'
  /** The request was still running when the configured timeout elapsed. */
  | 'timeout'
  /** The provider answered 429 and the retry budget ran out. */
  | 'rate_limited'
  /** The provider answered 401 or 403. Not retried: the same key fails again. */
  | 'auth'
  /** The provider answered some other non-success status. */
  | 'http_error'
  /** The provider answered 200 and the body was not an answer this build reads. */
  | 'invalid_output'
  /** The request failed before any response arrived. Not retried. */
  | 'transport';

/**
 * A typed adapter failure.
 *
 * There is deliberately no field here that could hold a key, a request body or a
 * raw response body: the message names the provider, the status and the reason,
 * and nothing else reaches an agent or a log line.
 */
export class AdapterError extends Error {
  public readonly code: AdapterErrorCode;
  public readonly provider: string;
  /** The model that was asked, or `null` when no model was reached. */
  public readonly model: string | null;
  /** The HTTP status, when a response arrived. */
  public readonly status: number | null;
  /** How many requests were made, including the one that failed. */
  public readonly attempts: number;

  constructor(params: {
    code: AdapterErrorCode;
    message: string;
    provider: string;
    model?: string | null | undefined;
    status?: number | null | undefined;
    attempts?: number | undefined;
  }) {
    super(params.message);
    this.name = 'AdapterError';
    this.code = params.code;
    this.provider = params.provider;
    this.model = params.model ?? null;
    this.status = params.status ?? null;
    this.attempts = params.attempts ?? 0;
  }
}

/** Bounded retry with backoff. Nothing here retries a 4xx authentication error. */
export interface RetryPolicy {
  /** Total requests to make, including the first. At least 1. */
  maxAttempts: number;
  /** Wait before the second request, in milliseconds. */
  initialDelayMs: number;
  /** Longest wait between two requests, in milliseconds. */
  maxDelayMs: number;
  /** Multiplier applied to the wait after each further attempt. */
  backoffFactor: number;
}

/**
 * One answer as a provider produced it.
 *
 * `path` is absent on purpose: the provider says what it answered, and the
 * recording layer is the only thing that may say where the answer came from.
 */
export interface AdapterAnswerDraft {
  questionId: string;
  value: string | number | boolean;
  confidence: number;
  distribution?: Record<string, number> | undefined;
}

/** Why one question has no usable answer. */
export interface AdapterReject {
  /** The question the reject is about, when it is about one. */
  questionId?: string | undefined;
  reason: string;
  /** The field the schema named, when it named one. */
  field?: string | undefined;
}

/** What one provider call returned. */
export interface AdapterDecideResult {
  readonly provider: string;
  /** The model that answered, which is not always the adapter's default. */
  readonly model: string;
  readonly answers: AdapterAnswerDraft[];
  readonly rejects: AdapterReject[];
  readonly latencyMs: number;
  /** Requests made, including retries. One means the first attempt answered. */
  readonly attempts: number;
  /** Token counts the provider reported, when it reported any. */
  readonly usage?: AdapterUsage | undefined;
}

/** Token counts as a provider reported them. No price is derived from these. */
export interface AdapterUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

/** What a caller asks an adapter to answer. */
export interface AdapterDecideRequest {
  /** The typed questions to answer. Each one is validated before it is sent. */
  questions: readonly Question[];
  /**
   * Redacted page data or context. It is sent as data and is never treated as an
   * instruction; the system prompt says so on every call.
   */
  context?: unknown;
  /** Overrides the resolved model for this call only. */
  model?: string | undefined;
  /** Overrides the adapter's token budget for this call. */
  maxTokens?: number | undefined;
}

/**
 * A provider adapter.
 *
 * The four readonly fields are settings rather than results: a caller can read
 * them without calling the provider, which is what the review queue and the
 * setup wizard need.
 */
export interface ModelAdapter {
  /** The provider id, which is also the key store account for that provider. */
  readonly provider: string;
  /** The model used when nothing overrides it. */
  readonly defaultModel: string;
  /** How long one request may run before it is aborted. */
  readonly timeoutMs: number;
  /** The bounded retry policy this adapter uses. */
  readonly retry: RetryPolicy;
  /** Answers a list of typed questions with typed answer drafts. */
  decide(request: AdapterDecideRequest): Promise<AdapterDecideResult>;
}

/** The default retry policy: three requests, backing off from 250 ms. */
export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: 3,
  initialDelayMs: 250,
  maxDelayMs: 4000,
  backoffFactor: 2,
});

/** Default time limit for one provider request, in milliseconds. */
export const DEFAULT_ADAPTER_TIMEOUT_MS = 15_000;

/**
 * Rejects a retry policy that is not usable, rather than repairing it.
 *
 * A caller that passes `maxAttempts: 0` gets an error rather than one silent
 * request, and a caller that passes a negative delay gets an error rather than a
 * busy loop.
 */
export function validateRetryPolicy(policy: RetryPolicy): RetryPolicy {
  const positive = (value: number, name: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`A retry policy needs a ${name} of zero or more milliseconds.`);
    }
    return value;
  };

  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new TypeError('A retry policy needs maxAttempts of at least 1.');
  }
  positive(policy.initialDelayMs, 'initialDelayMs');
  positive(policy.maxDelayMs, 'maxDelayMs');
  if (
    typeof policy.backoffFactor !== 'number' ||
    !Number.isFinite(policy.backoffFactor) ||
    policy.backoffFactor < 1
  ) {
    throw new TypeError('A retry policy needs a backoffFactor of 1 or more.');
  }
  return policy;
}

/** Whether a status is one this adapter will ask again after a wait. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * The wait before the request that follows `attempt`.
 *
 * `attempt` is 1 for the wait after the first request. The wait doubles each time
 * and stops at `maxDelayMs`. A provider that sends `retry-after` in seconds sets
 * the wait itself, because a rate limit with a stated wait is better served by the
 * wait the provider asked for; a value beyond the bound is ignored rather than
 * followed, because a retry budget that can be stretched by a response header is
 * not bounded.
 */
export function backoffDelayMs(
  policy: RetryPolicy,
  attempt: number,
  retryAfterMs: number | null = null,
): number {
  if (retryAfterMs !== null && retryAfterMs >= 0) return retryAfterMs;
  const raw = policy.initialDelayMs * Math.pow(policy.backoffFactor, Math.max(0, attempt - 1));
  return Math.min(policy.maxDelayMs, raw);
}

/** Longest `retry-after` this adapter will wait for. */
export const MAX_RETRY_AFTER_MS = 30_000;

/** How a `retry-after` header in seconds becomes a wait, or `null` to ignore it. */
export function retryAfterMsOf(headerValue: string | null | undefined): number | null {
  if (typeof headerValue !== 'string') return null;
  const trimmed = headerValue.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const ms = seconds * 1000;
  return ms <= MAX_RETRY_AFTER_MS ? ms : null;
}

/** The fetch shape an adapter needs. Narrow on purpose, so a test can supply one. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<AdapterHttpResponse>;

/** The part of a response an adapter reads. */
export interface AdapterHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** The wait an adapter uses between attempts. Injected so no test waits. */
export type SleepLike = (ms: number) => Promise<void>;

/** A monotonic clock in milliseconds. Injected so a test can state a latency. */
export type ClockLike = () => number;
