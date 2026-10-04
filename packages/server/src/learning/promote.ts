/**
 * Promotion rules: promotes shadow candidates to active fast-path patterns.
 *
 * Status: **implemented and tested**.
 *
 * Step four of the learning loop in `docs/SPEC.md`:
 * - A standard shadow candidate becomes active when it has >= 20 samples and >= 95% agreement.
 * - A safety-related candidate needs >= 50 samples and >= 99% agreement.
 * - The thresholds live in settings (`core/thresholds.ts`), with safety minimums clamped
 *   so they can never be lower than standard ones or below 50 samples / 99% agreement.
 * - A candidate is safety-related if its decision type, question, or rule text touches
 *   a safety family (payment, destructive, outbound), or any of its samples come from
 *   decisions flagged `is_safety`.
 * - Invariant: A promoted pattern NEVER carries the safety flag and can never override
 *   a safety rule (safety rules always evaluate first in the engine).
 * - Invariant: A learned pattern's own output confidence is capped by its measured agreement.
 * - Invariant: Promotion is atomic (one database transaction) and logs a promotion EVENT.
 * - Invariant: Promotion is idempotent.
 * - Invariant: A failure in promotion must never fail submit_answers or feedback (log and continue).
 * - Re-check, demotion, and drift monitoring remain **planned**.
 */

import { randomUUID } from 'node:crypto';
import {
  getPromotionThresholds,
  type PromotionSettings,
  type PromotionThresholdConfig,
} from '../core/thresholds.js';
import { loadActivePatternsIntoEngine } from '../patterns/loader.js';
import type { PatternEngine } from '../patterns/engine.js';
import type { Rule } from '../patterns/types.js';
import type { DatabaseStore, Pattern, PromotionEvent } from '../store/index.js';
import {
  ACTION_GUARD_QUESTION_ID,
  DESTRUCTIVE_COMMAND,
  DESTRUCTIVE_TEXT,
  OUTBOUND_TEXT,
  PAYMENT_PATH_PATTERNS,
  PAYMENT_TEXT,
} from '../tools/action_guard.js';

export interface PromotionEvaluationResult {
  pattern_id: string;
  promoted: boolean;
  status: string;
  sample_count: number;
  agreement: number;
  required_samples: number;
  required_agreement: number;
  is_safety: boolean;
  event?: PromotionEvent | undefined;
  reason?: string | undefined;
}

export interface PromoteCandidateOptions {
  store: DatabaseStore;
  patternId: string;
  engine?: PatternEngine | undefined;
  now?: string | undefined;
}

export interface PromoteAllOptions {
  store: DatabaseStore;
  engine?: PatternEngine | undefined;
  now?: string | undefined;
}

/**
 * Checks whether a text string touches any of the safety families
 * (payment, destructive, outbound, destructive commands) as defined by the browser pack.
 *
 * Reuses the pack's matchers and compiled regexes without inventing new keyword lists.
 */
export function touchesSafetyFamilyText(text: string | null | undefined): boolean {
  if (!text || typeof text !== 'string') return false;
  return (
    PAYMENT_TEXT.test(text) ||
    DESTRUCTIVE_TEXT.test(text) ||
    OUTBOUND_TEXT.test(text) ||
    DESTRUCTIVE_COMMAND.test(text)
  );
}

/**
 * Determines whether a candidate pattern is safety-related.
 *
 * Criteria:
 * 1. The pattern or its rule carries `is_safety` or `safety`.
 * 2. Any sample in `shadow_samples` comes from a decision flagged `is_safety = 1`.
 * 3. The candidate's question, decision type, matchers, or rule text touches a safety family
 *    (payment, destructive, outbound) as defined by the browser pack.
 */
export function isCandidateSafetyRelated(
  store: DatabaseStore,
  pattern: Pattern,
  rule?: Rule | undefined,
): boolean {
  let effectiveRule = rule;
  if (!effectiveRule && pattern.rules) {
    try {
      const parsed = JSON.parse(pattern.rules);
      if (Array.isArray(parsed) && parsed.length > 0) {
        effectiveRule = parsed[0];
      } else if (parsed && typeof parsed === 'object') {
        effectiveRule = parsed as Rule;
      }
    } catch {
      // Ignore parsing errors on stored rule JSON
    }
  }

  // 1. Direct safety flag on pattern or rule
  if (
    pattern.is_safety === 1 ||
    Boolean(effectiveRule?.safety) ||
    Boolean(effectiveRule?.is_safety)
  ) {
    return true;
  }

  // 2. Check if any shadow sample comes from a decision flagged is_safety = 1
  const safetySample = store.db
    .prepare(
      `SELECT 1 FROM shadow_samples s
       JOIN decisions d ON s.decision_id = d.id
       WHERE s.pattern_id = ? AND d.is_safety = 1
       LIMIT 1`,
    )
    .get(pattern.id);

  if (safetySample) {
    return true;
  }

  // 3. Question checks
  if (
    effectiveRule?.matchers?.target_question_id === ACTION_GUARD_QUESTION_ID ||
    effectiveRule?.matchers?.question_id === ACTION_GUARD_QUESTION_ID
  ) {
    return true;
  }

  // Check rule id / pack id for safety family naming
  const packIdLower = (pattern.pack_id ?? effectiveRule?.pack_id ?? '').toLowerCase();
  const patternIdLower = pattern.id.toLowerCase();
  if (
    packIdLower.includes('payment') ||
    packIdLower.includes('destructive') ||
    packIdLower.includes('outbound') ||
    patternIdLower.includes('browser.risky.') ||
    patternIdLower.includes('payment') ||
    patternIdLower.includes('destructive') ||
    patternIdLower.includes('outbound')
  ) {
    return true;
  }

  // Check pattern name & description
  if (touchesSafetyFamilyText(pattern.name)) return true;
  if (touchesSafetyFamilyText(effectiveRule?.name)) return true;
  if (touchesSafetyFamilyText(effectiveRule?.description)) return true;

  // Check rule matchers text
  if (effectiveRule?.matchers) {
    if (
      typeof effectiveRule.matchers.text_any === 'string' &&
      touchesSafetyFamilyText(effectiveRule.matchers.text_any)
    ) {
      return true;
    }
    if (Array.isArray(effectiveRule.matchers.text_any)) {
      for (const t of effectiveRule.matchers.text_any) {
        if (touchesSafetyFamilyText(String(t))) return true;
      }
    }
    if (
      typeof effectiveRule.matchers.text_regex === 'string' &&
      touchesSafetyFamilyText(effectiveRule.matchers.text_regex)
    ) {
      return true;
    }
    if (
      effectiveRule.matchers.text_regex instanceof RegExp &&
      touchesSafetyFamilyText(effectiveRule.matchers.text_regex.source)
    ) {
      return true;
    }

    // Check payment URL path patterns
    if (typeof effectiveRule.matchers.url_path === 'string') {
      const path = effectiveRule.matchers.url_path.toLowerCase();
      for (const p of PAYMENT_PATH_PATTERNS) {
        const prefix = p.replace(/\/\*$/, '');
        if (path.startsWith(prefix) || p === path) {
          return true;
        }
      }
    }
  }

  if (pattern.url_pattern) {
    const path = pattern.url_pattern.toLowerCase();
    for (const p of PAYMENT_PATH_PATTERNS) {
      const prefix = p.replace(/\/\*$/, '');
      if (path.startsWith(prefix) || p === path) {
        return true;
      }
    }
  }

  // Check if candidate output is ask_user or block
  if (effectiveRule?.output?.value === 'ask_user' || effectiveRule?.output?.value === 'block') {
    return true;
  }

  // Check questions from recorded samples for safety family keywords
  const sampleDecisions = store.db
    .prepare(
      `SELECT d.question, d.context FROM shadow_samples s
       JOIN decisions d ON s.decision_id = d.id
       WHERE s.pattern_id = ?
       LIMIT 10`,
    )
    .all(pattern.id) as Array<{ question?: string; context?: string }>;

  for (const d of sampleDecisions) {
    if (touchesSafetyFamilyText(d.question) || touchesSafetyFamilyText(d.context)) {
      return true;
    }
  }

  return false;
}

/**
 * Evaluates a single candidate pattern for promotion and promotes it if eligible.
 *
 * Promotion is atomic (one transaction), idempotent, logs a promotion event,
 * caps output confidence by measured agreement, and forces safety/is_safety to false.
 */
export function promoteCandidate(options: PromoteCandidateOptions): PromotionEvaluationResult {
  const { store, patternId } = options;
  const pattern = store.patterns.getById(patternId);

  if (!pattern) {
    return {
      pattern_id: patternId,
      promoted: false,
      status: 'unknown',
      sample_count: 0,
      agreement: 0,
      required_samples: 0,
      required_agreement: 0,
      is_safety: false,
      reason: 'pattern_not_found',
    };
  }

  // Idempotency: only candidates with status 'shadow' can be promoted
  if (pattern.status !== 'shadow') {
    return {
      pattern_id: patternId,
      promoted: false,
      status: pattern.status,
      sample_count: 0,
      agreement: 0,
      required_samples: 0,
      required_agreement: 0,
      is_safety: false,
      reason: 'not_shadow',
    };
  }

  let parsedRule: Rule | undefined;
  try {
    parsedRule = JSON.parse(pattern.rules) as Rule;
  } catch {
    // Corrupted rule cannot be promoted
    return {
      pattern_id: patternId,
      promoted: false,
      status: pattern.status,
      sample_count: 0,
      agreement: 0,
      required_samples: 0,
      required_agreement: 0,
      is_safety: false,
      reason: 'invalid_rule_json',
    };
  }

  const isSafety = isCandidateSafetyRelated(store, pattern, parsedRule);
  const settings: PromotionSettings = getPromotionThresholds(store);
  const threshold: PromotionThresholdConfig = isSafety ? settings.safety : settings.standard;

  const stats = store.patternStats.getById(patternId);
  const sampleCount = stats?.sample_count ?? 0;
  const agreedCount = stats?.agreed_count ?? 0;
  const agreement = sampleCount > 0 ? Number((agreedCount / sampleCount).toFixed(4)) : 0;

  // Check promotion criteria
  if (sampleCount < threshold.min_samples) {
    return {
      pattern_id: patternId,
      promoted: false,
      status: 'shadow',
      sample_count: sampleCount,
      agreement,
      required_samples: threshold.min_samples,
      required_agreement: threshold.min_agreement,
      is_safety: isSafety,
      reason: 'insufficient_samples',
    };
  }

  if (agreement < threshold.min_agreement) {
    return {
      pattern_id: patternId,
      promoted: false,
      status: 'shadow',
      sample_count: sampleCount,
      agreement,
      required_samples: threshold.min_samples,
      required_agreement: threshold.min_agreement,
      is_safety: isSafety,
      reason: 'insufficient_agreement',
    };
  }

  // Eligible for promotion!
  // Promotion is atomic: pattern row update and promotion EVENT insert occur in one transaction.
  const now = options.now ?? new Date().toISOString();
  const eventId = randomUUID();
  let promotionEvent: PromotionEvent | undefined;

  const tx = store.db.transaction(() => {
    // Re-verify status inside transaction for idempotency
    const current = store.patterns.getById(patternId);
    if (!current || current.status !== 'shadow') {
      return null;
    }

    // Invariant: A learned pattern's own output confidence must be capped by its measured agreement
    let updatedRulesJson = current.rules;
    let cappedConfidence = agreement;
    try {
      const r = JSON.parse(current.rules) as Rule;
      const originalConfidence =
        typeof r.output?.confidence === 'number' ? r.output.confidence : 1.0;
      cappedConfidence = Number(Math.min(originalConfidence, agreement).toFixed(4));

      if (!r.output) {
        r.output = {
          value: '',
          confidence: cappedConfidence,
          decision_type: current.decision_type,
        };
      } else {
        r.output.confidence = cappedConfidence;
      }

      // Invariant: A promoted pattern NEVER carries the safety flag and can never override a safety rule
      r.safety = false;
      r.is_safety = false;
      r.status = 'active';

      updatedRulesJson = JSON.stringify(r);
    } catch {
      // Keep existing rules
    }

    // 1. Update pattern row: status = 'active', is_safety = 0, confidence = cappedConfidence
    store.db
      .prepare(
        `UPDATE patterns
         SET status = 'active',
             is_safety = 0,
             confidence = ?,
             rules = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(cappedConfidence, updatedRulesJson, now, patternId);

    // 2. Insert promotion EVENT
    const thresholdsJson = JSON.stringify(threshold);
    store.db
      .prepare(
        `INSERT INTO promotion_events (
           id, pattern_id, sample_count, agreement,
           threshold_samples, threshold_agreement, thresholds,
           is_safety, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        patternId,
        sampleCount,
        agreement,
        threshold.min_samples,
        threshold.min_agreement,
        thresholdsJson,
        isSafety ? 1 : 0,
        now,
      );

    promotionEvent = {
      id: eventId,
      pattern_id: patternId,
      sample_count: sampleCount,
      agreement,
      threshold_samples: threshold.min_samples,
      threshold_agreement: threshold.min_agreement,
      thresholds: thresholdsJson,
      is_safety: isSafety ? 1 : 0,
      created_at: now,
    };

    return promotionEvent;
  });

  const txResult = tx();
  if (!txResult) {
    return {
      pattern_id: patternId,
      promoted: false,
      status: 'active',
      sample_count: sampleCount,
      agreement,
      required_samples: threshold.min_samples,
      required_agreement: threshold.min_agreement,
      is_safety: isSafety,
      reason: 'already_promoted',
    };
  }

  // Load promoted pattern into engine if provided
  if (options.engine) {
    loadActivePatternsIntoEngine(options.engine, store);
  }

  return {
    pattern_id: patternId,
    promoted: true,
    status: 'active',
    sample_count: sampleCount,
    agreement,
    required_samples: threshold.min_samples,
    required_agreement: threshold.min_agreement,
    is_safety: isSafety,
    event: promotionEvent,
  };
}

/**
 * Evaluates and promotes all eligible shadow candidates in the store.
 *
 * Callable as a function over all shadow candidates. Idempotent.
 */
export function promoteAllCandidates(options: PromoteAllOptions): PromotionEvaluationResult[] {
  const { store } = options;
  // The store lists by creation time, which can tie; order by id so a run is repeatable.
  const shadowPatterns = [...store.patterns.list({ status: 'shadow' })].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const results: PromotionEvaluationResult[] = [];

  for (const pattern of shadowPatterns) {
    try {
      const outcome = promoteCandidate({
        store,
        patternId: pattern.id,
        engine: options.engine,
        now: options.now,
      });
      results.push(outcome);
    } catch (err) {
      console.error(
        `[browserreflex promotion error] Failed to promote candidate ${pattern.id}:`,
        err,
      );
    }
  }

  return results;
}
