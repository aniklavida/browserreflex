/**
 * The `feedback` tool: records a correction to a decision from the user or the agent.
 *
 * Status: **implemented and tested**.
 *
 * What one call does, in order:
 * 1. Reads the decision named by `decision_id`. An unknown id returns a typed error
 *    and writes nothing.
 * 2. Reads the correction as a value of that decision's declared type. A correction
 *    that cannot be read as one is rejected, not repaired.
 * 3. Writes one `feedback` row, with the note redacted first.
 * 4. Reports that the decision is now confirmed. The memory reuse rule counts any
 *    feedback as confirmation, so the corrected value is what memory serves for this
 *    input, not the value the decision row carries.
 * 5. When the decision names a pattern, records one agree or disagree sample against
 *    that pattern's statistics and reports the resulting accuracy.
 * 6. Captures the signals of the decision through `learning/capture.ts`. A correction is
 *    where a pattern and a person disagreed, so it is captured whatever path produced
 *    the original answer.
 *
 * Invariants:
 * - The decision row is left exactly as it was written. A correction is a separate
 *   record, so the row keeps the path and the confidence that actually produced its
 *   answer. Rewriting either of those would be a record describing something that did
 *   not happen.
 * - A secret never reaches the database: the note is redacted before it is stored, and
 *   the redacted text is what the acknowledgement returns.
 * - This tool records. It changes no pattern and no rule. The safety check is advisory
 *   and nothing here prevents an agent from acting.
 *
 * Known limits, because they are real:
 * - The option list of a choice question is not stored with the decision, so a choice
 *   correction is only checked for being a non-empty string. Memory re-checks it
 *   against the question on the next lookup and falls back to `needs_ai` when it does
 *   not fit.
 * - The scale of a score question is not stored with the decision either, so a score
 *   correction is only checked for being a number.
 * - When several decisions share one input hash, memory serves the most recent one that
 *   is reusable, so a newer reusable decision for the same input takes precedence over
 *   an older corrected one. Correcting the newest decision for an input is therefore
 *   the call that changes what memory serves. `memory_confirmed` says this decision is
 *   now reusable; it does not name which decision memory picks for a given input.
 */

import { z } from 'zod';
import type { ZodRawShape } from 'zod';
import type { DecisionType } from '../core/schema.js';
import { getDefaultStore } from '../core/log.js';
import { captureDecisionSignals } from '../learning/capture.js';
import { redact } from '../security/redact.js';
import type {
  DatabaseStore,
  Decision,
  Feedback as FeedbackRow,
  PatternStats,
  Session,
} from '../store/index.js';

/** Who reported the correction. The agent is the default: the tool is called by it. */
export type FeedbackSource = 'user' | 'agent';

/** Typed error codes this tool returns. */
export type FeedbackErrorCode = 'decision_not_found' | 'invalid_correct_value';

/** What the tool did to the statistics of the decision's pattern, if it had one. */
export interface FeedbackPatternReport {
  pattern_id: string;
  /** True when this call added one sample. False when no sample could be recorded. */
  sample_recorded: boolean;
  /** Whether the correction agreed with the pattern's answer. Null when unknowable. */
  agreed: boolean | null;
  sample_count: number;
  agreed_count: number;
  disagreed_count: number;
  /** agreed_count / sample_count, or 0 when there is no sample yet. */
  accuracy: number;
}

export interface FeedbackOutput {
  [key: string]: unknown;
  status: 'recorded' | 'error';
  feedback_id?: string;
  decision_id: string;
  decision_path?: Decision['path'];
  source?: FeedbackSource;
  previous_value?: string | number | boolean;
  correct_value?: string | number | boolean;
  note?: string;
  /**
   * True when the memory reuse rule will now reuse this decision, because it counts
   * feedback as confirmation. It says nothing about which decision memory serves for
   * an input that several decisions share.
   */
  memory_confirmed?: boolean;
  /** Null when the decision came from no pattern. */
  pattern?: FeedbackPatternReport | null;
  error?: FeedbackErrorCode;
  message?: string;
}

export interface FeedbackContext {
  store?: DatabaseStore | undefined;
  session?: Session | undefined;
  sessionId?: string | undefined;
}

export interface FeedbackInput {
  decision_id?: unknown;
  correct_value?: unknown;
  source?: unknown;
  note?: unknown;
}

export const feedbackInputSchema: ZodRawShape = {
  decision_id: z.string().min(1).describe('Id of the decision being corrected'),
  correct_value: z
    .union([z.string(), z.number(), z.boolean()])
    .describe('The value that is actually correct for that decision'),
  source: z
    .enum(['user', 'agent'])
    .optional()
    .describe('Who reported the correction: the user or the agent (default)'),
  note: z.string().optional().describe('Why the decision was wrong. Redacted before it is stored'),
};

export const feedbackOutputSchema: ZodRawShape = {
  status: z.enum(['recorded', 'error']),
  feedback_id: z.string().optional(),
  decision_id: z.string(),
  decision_path: z.string().optional(),
  source: z.enum(['user', 'agent']).optional(),
  previous_value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  correct_value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  note: z.string().optional(),
  memory_confirmed: z.boolean().optional(),
  pattern: z
    .object({
      pattern_id: z.string(),
      sample_recorded: z.boolean(),
      agreed: z.boolean().nullable(),
      sample_count: z.number(),
      agreed_count: z.number(),
      disagreed_count: z.number(),
      accuracy: z.number(),
    })
    .nullable()
    .optional(),
  error: z.string().optional(),
  message: z.string().optional(),
};

/** One value read from text: the value itself, and the token two values compare by. */
interface ReadSingleValue {
  ok: true;
  value: string | number | boolean;
  token: string;
}

type UnparsedValue = { ok: false; reason: string };

const CHECK_REASON = 'a check value must be true, false, yes, no, or a number between 0 and 1';

/**
 * Reads one value out of a stored answer or a reported correction.
 *
 * A stored answer is written by the decision log as text: a bare value, a JSON scalar,
 * or a JSON object wrapping the value. All three are read here, so a comparison against
 * a stored answer compares values rather than two spellings of one value.
 */
function readValue(raw: string): { ok: true; value: string | number | boolean } | UnparsedValue {
  const trimmed = raw.trim();
  let parsed: unknown = trimmed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = trimmed;
  }

  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const inner = (parsed as Record<string, unknown>).value;
    if (typeof inner === 'string' || typeof inner === 'number' || typeof inner === 'boolean') {
      return { ok: true, value: inner };
    }
    return { ok: false, reason: 'the stored answer is not a single value' };
  }

  if (typeof parsed === 'string' || typeof parsed === 'number' || typeof parsed === 'boolean') {
    return { ok: true, value: parsed };
  }
  return { ok: false, reason: 'the value is not a single value' };
}

/**
 * Reads a value as the decision type it is correcting, and produces the token two
 * values are compared by.
 *
 * The token is what `agree` and `disagree` are decided on, so `true`, `yes` and a
 * stored `true` are one token and not three.
 */
function coerceForType(
  value: string | number | boolean,
  type: DecisionType,
): ReadSingleValue | UnparsedValue {
  if (type === 'choice') {
    const text = typeof value === 'string' ? value.trim() : String(value);
    if (text === '') {
      return { ok: false, reason: 'a choice value cannot be empty' };
    }
    return { ok: true, value: text, token: text };
  }

  if (type === 'score') {
    if (typeof value === 'boolean') {
      return { ok: false, reason: 'a score value must be a number' };
    }
    const numeric = typeof value === 'number' ? value : Number(value.trim());
    if (!Number.isFinite(numeric)) {
      return { ok: false, reason: 'a score value must be a number' };
    }
    return { ok: true, value: numeric, token: String(numeric) };
  }

  if (typeof value === 'boolean') {
    return { ok: true, value, token: value ? 'true' : 'false' };
  }
  if (typeof value === 'number') {
    if (value === 0 || value === 1) {
      return { ok: true, value, token: value === 1 ? 'true' : 'false' };
    }
    if (value > 0 && value < 1) {
      return { ok: true, value, token: String(value) };
    }
    return { ok: false, reason: CHECK_REASON };
  }

  const lower = value.trim().toLowerCase();
  if (lower === 'true' || lower === 'yes') {
    return { ok: true, value: true, token: 'true' };
  }
  if (lower === 'false' || lower === 'no') {
    return { ok: true, value: false, token: 'false' };
  }
  const numeric = Number(lower);
  if (lower !== '' && Number.isFinite(numeric) && numeric >= 0 && numeric <= 1) {
    return { ok: true, value: numeric, token: String(numeric) };
  }
  return { ok: false, reason: CHECK_REASON };
}

/** Reads a raw string as a value of `type`, with the token two values compare by. */
function parseFeedbackValue(raw: string, type: DecisionType): ReadSingleValue | UnparsedValue {
  const read = readValue(raw);
  if (!read.ok) {
    return read;
  }
  return coerceForType(read.value, type);
}

/**
 * Records one agree or disagree sample against the pattern that produced the decision,
 * and reports the statistics as they stand afterwards.
 *
 * No sample is recorded when the stored answer cannot be read as a value of the
 * decision's type, because then agreement is unknown rather than false. The report
 * says so instead of guessing.
 */
function recordPatternSample(
  store: DatabaseStore,
  decision: Decision,
  agreed: boolean | null,
): FeedbackPatternReport | null {
  const patternId = decision.pattern_id;
  if (patternId === null || patternId === '') {
    return null;
  }

  let stats: PatternStats | null = null;
  let sampleRecorded = false;
  if (agreed !== null && store.patterns.getById(patternId) !== null) {
    stats = store.patternStats.recordSample(patternId, agreed);
    sampleRecorded = true;
  }
  if (stats === null) {
    stats = store.patternStats.getById(patternId);
  }

  const sampleCount = stats?.sample_count ?? 0;
  const agreedCount = stats?.agreed_count ?? 0;
  const disagreedCount = stats?.disagreed_count ?? 0;

  return {
    pattern_id: patternId,
    sample_recorded: sampleRecorded,
    agreed,
    sample_count: sampleCount,
    agreed_count: agreedCount,
    disagreed_count: disagreedCount,
    accuracy: sampleCount === 0 ? 0 : agreedCount / sampleCount,
  };
}

/**
 * Executes the `feedback` tool: records a correction and reports what changed.
 *
 * Returns a typed error rather than throwing, so a caller reading the result sees why
 * nothing was written.
 */
export async function executeFeedback(
  args: FeedbackInput,
  context: FeedbackContext = {},
): Promise<FeedbackOutput> {
  const store = context.store ?? getDefaultStore();

  const decisionId = typeof args.decision_id === 'string' ? args.decision_id.trim() : '';
  if (decisionId === '') {
    return {
      status: 'error',
      decision_id: decisionId,
      error: 'decision_not_found',
      message: 'decision_id is required, and no decision was named.',
    };
  }

  const decision = store.decisions.getById(decisionId);
  if (decision === null) {
    return {
      status: 'error',
      decision_id: decisionId,
      error: 'decision_not_found',
      message: `No decision with id ${decisionId} is stored, so there is nothing to correct.`,
    };
  }

  const rawCorrectValue = args.correct_value;
  if (
    typeof rawCorrectValue !== 'string' &&
    typeof rawCorrectValue !== 'number' &&
    typeof rawCorrectValue !== 'boolean'
  ) {
    return {
      status: 'error',
      decision_id: decision.id,
      decision_path: decision.path,
      error: 'invalid_correct_value',
      message: `correct_value is required and must be a string, a number or a boolean; received ${
        rawCorrectValue === undefined ? 'nothing' : typeof rawCorrectValue
      }.`,
    };
  }

  const corrected = parseFeedbackValue(String(rawCorrectValue), decision.decision_type);
  if (!corrected.ok) {
    return {
      status: 'error',
      decision_id: decision.id,
      decision_path: decision.path,
      error: 'invalid_correct_value',
      message: `correct_value does not match the decision type ${decision.decision_type}: ${corrected.reason}. Nothing was written.`,
    };
  }

  const stored = parseFeedbackValue(decision.answer, decision.decision_type);
  const agreed: boolean | null = stored.ok ? stored.token === corrected.token : null;

  const source: FeedbackSource = args.source === 'user' ? 'user' : 'agent';
  const redactedNote = typeof args.note === 'string' ? redact(args.note) : null;

  // The stored text is the form memory reads back, so the acknowledgement and the next
  // decision cannot disagree about what the correction was.
  const storedText =
    typeof corrected.value === 'string' ? corrected.value : String(corrected.value);
  const row: FeedbackRow = store.feedback.create({
    decision_id: decision.id,
    correct_value: storedText,
    note: redactedNote,
    source,
  });

  // A correction is a slow-path signal the miner needs, whatever path produced the
  // original answer. The decision row itself is left exactly as it was written.
  captureDecisionSignals({ store, decision, source: 'human_correction' });

  return {
    status: 'recorded',
    feedback_id: row.id,
    decision_id: decision.id,
    decision_path: decision.path,
    source,
    ...(stored.ok ? { previous_value: stored.value } : {}),
    correct_value: corrected.value,
    ...(redactedNote !== null ? { note: redactedNote } : {}),
    memory_confirmed: true,
    pattern: recordPatternSample(store, decision, agreed),
  };
}
