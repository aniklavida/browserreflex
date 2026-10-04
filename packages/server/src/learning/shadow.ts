/**
 * Shadow testing: evaluates candidate patterns against completed slow answers
 * and feedback corrections.
 *
 * Status: **implemented and tested**.
 *
 * This is step three of the learning loop in `docs/SPEC.md`. Capture
 * (`learning/capture.ts`) stores what was in front of a slow decision; the miners
 * (`learning/miners/`) look for repeated slow answers that share a signal and write
 * candidate patterns with `status: 'shadow'`. This module runs those candidate patterns
 * silently against completed slow decisions and human corrections to record their
 * agreement against real outcomes before any promotion to the fast path.
 *
 * Invariants:
 * - A decision record that misdescribes itself is worse than no record:
 *   every shadow sample row records the exact source ('slow_answer' or 'feedback')
 *   and whether the candidate agreed with the recorded outcome.
 * - Shadow candidates NEVER change the returned answer and never answer in decide:
 *   nothing in the pattern engine serves shadow candidates, and shadow evaluation runs
 *   silently after answers or corrections are committed.
 * - A shadow candidate never carries the safety flag and cannot touch safety rules:
 *   safety rules and safety-flagged decisions are never evaluated or touched by shadow
 *   candidates. The safety check is advisory; it never prevents an agent from acting.
 * - Atomic persistence: writing the shadow_samples row and updating pattern_stats
 *   (sample_count, agreed_count, disagreed_count, last_evaluated_at, updated_at) occurs
 *   in one atomic database transaction.
 * - No duplicate evaluations: the same (decision_id, pattern_id) pair evaluated a second
 *   time is a no-op, preserving primary-key integrity and preventing sample inflation.
 * - Fault tolerance: a failure inside shadow evaluation must not fail the tool call;
 *   callers log and continue.
 * - Promotion, monitoring and demotion remain planned and are not implemented here.
 */

import type { DecisionType } from '../core/schema.js';
import { compileRule, matchRule, normalizeSnapshot } from '../patterns/matchers.js';
import type { Rule, Snapshot, SnapshotElement } from '../patterns/types.js';
import type {
  DatabaseStore,
  Decision,
  DecisionSignal,
  ShadowSampleSource,
} from '../store/index.js';

export interface EvaluateShadowParams {
  store: DatabaseStore;
  decision: Decision;
  source: ShadowSampleSource;
  recordedAnswer?: string | number | boolean | undefined;
}

export interface ShadowSampleOutcome {
  pattern_id: string;
  agreed: boolean;
  recorded: boolean;
}

export interface ShadowEvaluationOutcome {
  decision_id: string;
  source: ShadowSampleSource;
  evaluated_count: number;
  matched_count: number;
  samples: ShadowSampleOutcome[];
}

interface ParsedToken {
  ok: true;
  value: string | number | boolean;
  token: string;
}

interface UnparsedToken {
  ok: false;
  reason: string;
}

const CHECK_REASON = 'a check value must be true, false, yes, no, or a number between 0 and 1';

/**
 * Extracts a single primitive value from a raw string, boolean, number, or JSON object.
 */
function readPrimitiveValue(
  raw: unknown,
): { ok: true; value: string | number | boolean } | UnparsedToken {
  if (typeof raw === 'boolean' || typeof raw === 'number') {
    return { ok: true, value: raw };
  }

  if (typeof raw !== 'string') {
    return { ok: false, reason: 'value is not a string, number, or boolean' };
  }

  const trimmed = raw.trim();
  let parsed: unknown = trimmed;

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = trimmed;
    }
  }

  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const inner = (parsed as Record<string, unknown>).value;
    if (typeof inner === 'string' || typeof inner === 'number' || typeof inner === 'boolean') {
      return { ok: true, value: inner };
    }
    return { ok: false, reason: 'the stored answer object contains no valid value' };
  }

  if (typeof parsed === 'string' || typeof parsed === 'number' || typeof parsed === 'boolean') {
    return { ok: true, value: parsed };
  }

  return { ok: false, reason: 'the answer is not a single value' };
}

/**
 * Coerces a value to a comparison token based on the decision type.
 */
function coerceTokenForType(
  value: string | number | boolean,
  type: DecisionType,
): ParsedToken | UnparsedToken {
  if (type === 'choice') {
    const text = typeof value === 'string' ? value.trim() : String(value).trim();
    if (text === '') {
      return { ok: false, reason: 'a choice value cannot be empty' };
    }
    return { ok: true, value: text, token: text };
  }

  if (type === 'score') {
    if (typeof value === 'boolean') {
      return { ok: false, reason: 'a score value must be a number' };
    }
    const numeric = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(numeric)) {
      return { ok: false, reason: 'a score value must be a finite number' };
    }
    return { ok: true, value: numeric, token: String(numeric) };
  }

  // check decision type
  if (typeof value === 'boolean') {
    return { ok: true, value, token: value ? 'true' : 'false' };
  }

  if (typeof value === 'number') {
    if (value === 0 || value === 1) {
      return { ok: true, value: value === 1, token: value === 1 ? 'true' : 'false' };
    }
    if (value > 0 && value < 1) {
      return { ok: true, value, token: String(value) };
    }
    return { ok: false, reason: CHECK_REASON };
  }

  const lower = String(value).trim().toLowerCase();
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

/**
 * Parses an answer value into a normalized comparison token for the decision type.
 */
export function parseAnswerToken(raw: unknown, type: DecisionType): ParsedToken | UnparsedToken {
  const primitive = readPrimitiveValue(raw);
  if (!primitive.ok) {
    return primitive;
  }
  return coerceTokenForType(primitive.value, type);
}

/**
 * Builds a snapshot suitable for rule matchers from the decision and its stored signals.
 */
export function buildSnapshotFromSignals(
  decision: Decision,
  signal: DecisionSignal | null,
): Snapshot {
  let base: Snapshot = {};
  if (decision.context) {
    try {
      base = normalizeSnapshot(JSON.parse(decision.context), decision.url, decision.domain);
    } catch {
      base = normalizeSnapshot(decision.context, decision.url, decision.domain);
    }
  } else {
    base = normalizeSnapshot({}, decision.url, decision.domain);
  }

  const domain = signal?.domain ?? decision.domain ?? base.domain ?? null;
  const path = signal?.path ?? null;
  let url = decision.url ?? base.url ?? null;
  if (!url && path) {
    url = domain ? `https://${domain}${path}` : path;
  }

  const elements: SnapshotElement[] = Array.isArray(base.elements) ? [...base.elements] : [];

  if (signal?.element_role || signal?.element_text || signal?.selector) {
    const alreadyPresent = elements.some(
      (e) =>
        (!signal.element_role || e.role === signal.element_role) &&
        (!signal.element_text || e.text === signal.element_text),
    );
    if (!alreadyPresent) {
      elements.push({
        role: signal.element_role,
        text: signal.element_text,
        selector: signal.selector,
      });
    }
  }

  const textParts: string[] = [];
  if (base.text) textParts.push(base.text);
  if (signal?.element_text) textParts.push(signal.element_text);
  if (signal?.tokens && signal.tokens.length > 0) textParts.push(signal.tokens.join(' '));

  return {
    ...base,
    domain,
    url,
    elements,
    text: textParts.length > 0 ? textParts.join(' ') : (base.text ?? null),
  };
}

/**
 * Evaluates all matching candidate rules with status 'shadow' against a decision
 * and records comparison samples.
 *
 * Invariants enforced:
 * - A decision marked as a safety rule is never touched by shadow candidates.
 * - Shadow candidates marked as safety rules are never evaluated.
 * - A candidate's output value is compared with the recorded answer.
 * - One shadow_samples row is recorded and pattern_stats is updated in one transaction.
 * - Repeated evaluation of the same (decision, pattern) pair is a no-op.
 */
export function evaluateShadowCandidates(params: EvaluateShadowParams): ShadowEvaluationOutcome {
  const { store, decision, source } = params;

  // Invariant: A shadow candidate never touches safety rules
  if (decision.is_safety !== 0) {
    return {
      decision_id: decision.id,
      source,
      evaluated_count: 0,
      matched_count: 0,
      samples: [],
    };
  }

  // Determine the recorded answer to compare against
  let rawRecorded: unknown = params.recordedAnswer;
  if (rawRecorded === undefined) {
    if (source === 'feedback') {
      const feedbackRows = store.feedback.getByDecisionId(decision.id);
      rawRecorded = feedbackRows[0]?.correct_value;
    } else {
      rawRecorded = decision.answer;
    }
  }

  if (rawRecorded === undefined || rawRecorded === null || rawRecorded === 'pending') {
    return {
      decision_id: decision.id,
      source,
      evaluated_count: 0,
      matched_count: 0,
      samples: [],
    };
  }

  const recordedToken = parseAnswerToken(rawRecorded, decision.decision_type);
  if (!recordedToken.ok) {
    return {
      decision_id: decision.id,
      source,
      evaluated_count: 0,
      matched_count: 0,
      samples: [],
    };
  }

  const signal = store.signals.getByDecisionId(decision.id);
  const snapshot = buildSnapshotFromSignals(decision, signal);

  // Fetch all shadow candidates matching this decision type
  const shadowPatterns = store.patterns.list({
    status: 'shadow',
    decision_type: decision.decision_type,
  });

  const samples: ShadowSampleOutcome[] = [];
  let evaluatedCount = 0;
  let matchedCount = 0;

  for (const pattern of shadowPatterns) {
    // Invariant: A shadow candidate never carries the safety flag
    if (pattern.is_safety !== 0) {
      continue;
    }

    let rule: Rule;
    try {
      rule = JSON.parse(pattern.rules) as Rule;
    } catch {
      continue;
    }

    if (rule.safety === true || rule.is_safety === true || rule.is_safety === 1) {
      continue;
    }

    const compiled = compileRule(rule);
    evaluatedCount++;

    if (!matchRule(compiled, snapshot)) {
      continue;
    }

    matchedCount++;

    const candidateToken = parseAnswerToken(rule.output.value, decision.decision_type);
    if (!candidateToken.ok) {
      continue;
    }

    const agreed = candidateToken.token === recordedToken.token;

    // Atomically write shadow_samples row and update pattern_stats in ONE transaction.
    // Duplicate pair evaluation returns recorded: false (no-op).
    const recordResult = store.shadowSamples.recordSample({
      decision_id: decision.id,
      pattern_id: pattern.id,
      source,
      agreed,
    });

    samples.push({
      pattern_id: pattern.id,
      agreed,
      recorded: recordResult.recorded,
    });
  }

  return {
    decision_id: decision.id,
    source,
    evaluated_count: evaluatedCount,
    matched_count: matchedCount,
    samples,
  };
}
