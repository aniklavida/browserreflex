/**
 * Learning monitor: re-check sampling and demotion for active learned patterns.
 *
 * Status: **implemented and tested**.
 *
 * ## Re-check
 *
 * When `decide` serves a fast-path answer from an ACTIVE LEARNED pattern (path
 * 'pattern', pattern kind 'learned', i.e. status 'active' in the patterns table
 * and not a safety pattern), a deterministic sample of those answers is selected
 * for re-check. The sampling rate is 2% by default and is injectable via settings
 * (`monitor.recheck_rate`, a float 0–1).
 *
 * A sampled decision is recorded in the `rechecks` table with `status = 'pending'`
 * and the answer the pattern gave. The decision is still returned normally to the
 * agent — re-check never blocks or alters the answer.
 *
 * Completing a re-check: a sampled decision already holds the pattern's answer, so
 * `submit_answers` (which only completes a pending decision) does not apply. The
 * re-check is completed by `feedback`: when it records the correct value for a
 * decision that has a pending re-check, the monitor compares that value with the
 * pattern answer and records agree/disagree in the `rechecks` row. An agent finds
 * pending re-checks through `get_pending_reviews` (they surface as `needs_review`
 * items) and answers them with `feedback`.
 *
 * ## Demote
 *
 * After each re-check is completed, the monitor evaluates the pattern's recent
 * accuracy over the last N completed re-checks (N = 20, setting
 * `monitor.recheck_window`). If accuracy falls below the demotion threshold
 * (default 90%, setting `monitor.demotion_threshold`; never below 90% for
 * safety-related patterns — but learned patterns are never safety, so this only
 * guards against misconfiguration), the pattern is:
 *
 * 1. Set to `status = 'disabled'` in the patterns table.
 * 2. Removed from the live PatternEngine without restart (via `engine.removeRule`).
 * 3. A `demotion_events` row is written.
 * 4. A `drift_alerts` row is written with `status = 'active'`.
 *
 * Demotion is idempotent: a pattern already disabled is not processed again, and a
 * drift alert is only created once per demotion event (checked before insert).
 * Demotion failure is logged and never throws to the tool call.
 *
 * ## Safety invariants
 *
 * Safety packs and rules (is_safety = 1) are never demoted or touched by this
 * module. This module only operates on learned patterns (is_safety = 0, status
 * 'active' in the patterns table). Safety rules cannot be learned (promotion forces
 * is_safety = false) and cannot be demoted.
 *
 * ## Injectable random source
 *
 * The random source is injectable for deterministic tests. Production code passes
 * `undefined`, which falls back to `Math.random()`.
 */

import { randomUUID } from 'node:crypto';
import type { PatternEngine } from '../patterns/index.js';
import type { DatabaseStore } from '../store/index.js';

/**
 * Whether a stored pattern is an active LEARNED pattern.
 *
 * The decision log writes a stub `patterns` row (status `active`, empty rules) for every
 * rule that answers, pack rules and safety rules included, so a row alone proves nothing.
 * A learned pattern is the one promotion made active: it has a promotion event. A rule with
 * no promotion event is never re-checked, demoted or disabled by this module.
 */
export function isActiveLearnedPattern(store: DatabaseStore, patternId: string): boolean {
  const pattern = store.patterns.getById(patternId);
  if (!pattern || pattern.status !== 'active' || pattern.is_safety) {
    return false;
  }
  return store.promotionEvents.listByPatternId(patternId).length > 0;
}

/** Minimum allowed demotion threshold (the promotion agreement floor). */
const MIN_DEMOTION_THRESHOLD = 0.9;

/** Default re-check sampling rate: 2% of fast-path learned-pattern answers. */
const DEFAULT_RECHECK_RATE = 0.02;

/** Default re-check window: evaluate demotion over the last 20 re-checks. */
const DEFAULT_RECHECK_WINDOW = 20;

/** Default demotion threshold: disable a pattern whose recent accuracy drops below 90%. */
const DEFAULT_DEMOTION_THRESHOLD = 0.9;

export interface MonitorSettings {
  /** Re-check sampling rate, 0–1. Default 0.02 (2%). */
  recheckRate: number;
  /** Window of recent completed re-checks to evaluate for demotion. Default 20. */
  recheckWindow: number;
  /** Accuracy threshold below which a pattern is demoted. Default 0.90. Never below 0.90. */
  demotionThreshold: number;
}

export interface RecordRecheckOptions {
  store: DatabaseStore;
  decisionId: string;
  patternId: string;
  /** The value the pattern answered, serialised to a string. */
  patternAnswer: string;
  /** ISO-8601 timestamp; injected by tests. */
  now?: string;
}

export interface RecordRecheckResult {
  sampled: boolean;
  recheckId?: string;
}

export interface CompleteRecheckOptions {
  store: DatabaseStore;
  decisionId: string;
  /** The slow/human answer, serialised to a string. */
  slowAnswer: string;
  /** Source: 'submit_answers' | 'feedback' */
  source: string;
  engine?: PatternEngine | undefined;
  now?: string;
}

export interface CompleteRecheckResult {
  found: boolean;
  recheckId?: string;
  agreed?: boolean;
  demoted?: boolean;
  patternId?: string;
}

export interface DemotePatternOptions {
  store: DatabaseStore;
  patternId: string;
  sampleCount: number;
  agreedCount: number;
  disagreedCount: number;
  accuracy: number;
  threshold: number;
  reason: string;
  engine?: PatternEngine | undefined;
  now?: string;
}

export interface DemotePatternResult {
  demoted: boolean;
  reason: string;
  driftAlertId?: string;
}

/**
 * Reads monitor settings from the store's settings table, falling back to defaults.
 * Keys: `monitor.recheck_rate`, `monitor.recheck_window`, `monitor.demotion_threshold`.
 */
export function getMonitorSettings(store: DatabaseStore): MonitorSettings {
  const rateRaw = store.settings.getValue('monitor.recheck_rate');
  const windowRaw = store.settings.getValue('monitor.recheck_window');
  const thresholdRaw = store.settings.getValue('monitor.demotion_threshold');

  const recheckRate = rateRaw !== null ? parseFloat(rateRaw) : DEFAULT_RECHECK_RATE;
  const recheckWindow = windowRaw !== null ? parseInt(windowRaw, 10) : DEFAULT_RECHECK_WINDOW;
  let demotionThreshold =
    thresholdRaw !== null ? parseFloat(thresholdRaw) : DEFAULT_DEMOTION_THRESHOLD;

  // The demotion threshold may never be weaker than the promotion agreement floor.
  if (demotionThreshold < MIN_DEMOTION_THRESHOLD) {
    demotionThreshold = MIN_DEMOTION_THRESHOLD;
  }

  return {
    recheckRate: Number.isFinite(recheckRate)
      ? Math.max(0, Math.min(1, recheckRate))
      : DEFAULT_RECHECK_RATE,
    recheckWindow:
      Number.isFinite(recheckWindow) && recheckWindow > 0 ? recheckWindow : DEFAULT_RECHECK_WINDOW,
    demotionThreshold,
  };
}

/**
 * Decides whether a fast-path answer from an active learned pattern should be
 * sampled for re-check, and records a pending re-check row if so.
 *
 * The answer returned to the agent is not changed. This function is a side-effect
 * that may be called fire-and-forget after the pattern answer has been returned.
 *
 * @param random - Injectable random source returning a float in [0, 1). Default: Math.random.
 */
export function sampleForRecheck(
  options: RecordRecheckOptions,
  random: () => number = Math.random,
): RecordRecheckResult {
  const { store, decisionId, patternId, patternAnswer } = options;
  const now = options.now ?? new Date().toISOString();

  const settings = getMonitorSettings(store);

  if (random() >= settings.recheckRate) {
    return { sampled: false };
  }

  // Only an active, non-safety learned pattern is re-checked.
  if (!isActiveLearnedPattern(store, patternId)) {
    return { sampled: false };
  }

  // Idempotent: do not create a duplicate re-check for the same decision.
  const existing = store.rechecks.getByDecisionId(decisionId);
  if (existing) {
    return { sampled: false };
  }

  const recheck = store.rechecks.create({
    decision_id: decisionId,
    pattern_id: patternId,
    pattern_answer: patternAnswer,
    status: 'pending',
    created_at: now,
  });

  // Mark the decision needs_review = 1 so it surfaces in get_pending_reviews.
  store.db
    .prepare(`UPDATE decisions SET needs_review = 1 WHERE id = ? AND needs_review = 0`)
    .run(decisionId);

  return { sampled: true, recheckId: recheck.id };
}

/**
 * Checks whether a completed decision (from submit_answers or feedback) has a
 * pending re-check, and if so, resolves it by comparing the slow/human answer
 * with the pattern answer and recording agree/disagree.
 *
 * Also triggers demotion evaluation for the pattern.
 *
 * Returns `{ found: false }` when there is no pending re-check for the decision.
 * Never throws; callers log and continue.
 */
export function completeRecheck(options: CompleteRecheckOptions): CompleteRecheckResult {
  const { store, decisionId, slowAnswer, source } = options;
  const now = options.now ?? new Date().toISOString();

  const recheck = store.rechecks.getByDecisionId(decisionId);
  if (!recheck || recheck.status !== 'pending') {
    return { found: false };
  }

  // Compare the slow/human answer with what the pattern answered.
  const agreed = normalizeAnswer(slowAnswer) === normalizeAnswer(recheck.pattern_answer);

  // Complete the re-check row.
  store.rechecks.complete(recheck.id, agreed, slowAnswer, source);

  // The outcome lives in the `rechecks` row. It is not added to `pattern_stats`: the
  // `feedback` call that completes a re-check already records its own agree or disagree
  // sample there, and counting it twice would inflate the pattern's sample count.

  // Evaluate for demotion.
  let demoted = false;
  try {
    const demoteResult = evaluateDemotion({
      store,
      patternId: recheck.pattern_id,
      engine: options.engine,
      now,
    });
    demoted = demoteResult.demoted;
  } catch (err) {
    console.error('[browserreflex monitor] demotion evaluation failed:', err);
  }

  return {
    found: true,
    recheckId: recheck.id,
    agreed,
    demoted,
    patternId: recheck.pattern_id,
  };
}

interface EvaluateDemotionOptions {
  store: DatabaseStore;
  patternId: string;
  engine?: PatternEngine | undefined;
  now?: string;
}

interface EvaluateDemotionResult {
  demoted: boolean;
  reason: string;
}

/**
 * Evaluates whether a pattern should be demoted after a re-check completes.
 * Reads the last N completed re-checks and checks if recent accuracy is below
 * the demotion threshold.
 */
function evaluateDemotion(options: EvaluateDemotionOptions): EvaluateDemotionResult {
  const { store, patternId } = options;
  const now = options.now ?? new Date().toISOString();

  // Safety patterns are never demoted — but they can never be learned either.
  const pattern = store.patterns.getById(patternId);
  if (!pattern) {
    return { demoted: false, reason: 'pattern_not_found' };
  }

  if (pattern.is_safety) {
    return { demoted: false, reason: 'safety_pattern_not_demoted' };
  }

  if (pattern.status !== 'active') {
    // Already disabled or in another non-active state: idempotent.
    return { demoted: false, reason: 'not_active' };
  }

  if (!isActiveLearnedPattern(store, patternId)) {
    return { demoted: false, reason: 'not_learned' };
  }

  const settings = getMonitorSettings(store);

  const recentRechecks = store.rechecks.listRecentCompleted(patternId, settings.recheckWindow);

  if (recentRechecks.length < settings.recheckWindow) {
    // Not enough completed re-checks to evaluate yet.
    return { demoted: false, reason: 'insufficient_rechecks' };
  }

  const agreedCount = recentRechecks.filter((r) => r.agreed === 1).length;
  const accuracy = agreedCount / recentRechecks.length;

  if (accuracy >= settings.demotionThreshold) {
    return { demoted: false, reason: 'accuracy_acceptable' };
  }

  // Accuracy is below threshold — demote.
  const demoteResult = demotePattern({
    store,
    patternId,
    sampleCount: recentRechecks.length,
    agreedCount,
    disagreedCount: recentRechecks.length - agreedCount,
    accuracy,
    threshold: settings.demotionThreshold,
    reason: `recent_accuracy_${accuracy.toFixed(4)}_below_threshold_${settings.demotionThreshold}`,
    engine: options.engine,
    now,
  });

  return { demoted: demoteResult.demoted, reason: demoteResult.reason };
}

/**
 * Demotes a single active learned pattern: sets its status to 'disabled',
 * removes it from the live engine, writes a demotion event and a drift alert.
 *
 * Idempotent: if the pattern is already disabled, returns immediately without
 * writing duplicate rows. Never throws.
 */
export function demotePattern(options: DemotePatternOptions): DemotePatternResult {
  const { store, patternId } = options;
  const now = options.now ?? new Date().toISOString();

  const pattern = store.patterns.getById(patternId);
  if (!pattern) {
    return { demoted: false, reason: 'pattern_not_found' };
  }

  // Safety patterns are never demoted.
  if (pattern.is_safety) {
    return { demoted: false, reason: 'safety_pattern_not_demoted' };
  }

  // Idempotent.
  if (pattern.status === 'disabled') {
    return { demoted: false, reason: 'already_disabled' };
  }

  // A rule promotion never made active (a pack rule, a safety rule) is never demoted.
  if (!isActiveLearnedPattern(store, patternId)) {
    return { demoted: false, reason: 'not_learned' };
  }

  // Atomic: update the pattern row and write the demotion event.
  const demotionEventId = randomUUID();
  const driftAlertId = randomUUID();

  const tx = store.db.transaction(() => {
    // Re-check status inside transaction for idempotency.
    const current = store.patterns.getById(patternId);
    if (!current || current.status === 'disabled' || current.is_safety) {
      return false;
    }

    store.db
      .prepare(`UPDATE patterns SET status = 'disabled', updated_at = ? WHERE id = ?`)
      .run(now, patternId);

    store.db
      .prepare(
        `INSERT INTO demotion_events (
          id, pattern_id, sample_count, agreed_count, disagreed_count,
          accuracy, threshold, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        demotionEventId,
        patternId,
        options.sampleCount,
        options.agreedCount,
        options.disagreedCount,
        options.accuracy,
        options.threshold,
        options.reason,
        now,
      );

    const message =
      `Learned pattern ${patternId} disabled: recent accuracy ` +
      `${(options.accuracy * 100).toFixed(1)}% is below the ${(options.threshold * 100).toFixed(0)}% threshold. ` +
      `Checked ${options.sampleCount} re-checks; ${options.agreedCount} agreed, ` +
      `${options.disagreedCount} disagreed.`;

    store.db
      .prepare(
        `INSERT INTO drift_alerts (
          id, pattern_id, sample_count, agreed_count, disagreed_count,
          accuracy, threshold, status, message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        driftAlertId,
        patternId,
        options.sampleCount,
        options.agreedCount,
        options.disagreedCount,
        options.accuracy,
        options.threshold,
        message,
        now,
      );

    return true;
  });

  let committed: boolean;
  try {
    committed = tx() as boolean;
  } catch (err) {
    console.error('[browserreflex monitor] demotion transaction failed:', err);
    return { demoted: false, reason: 'transaction_failed' };
  }

  if (!committed) {
    return { demoted: false, reason: 'idempotent_skip' };
  }

  // Remove from live engine without restart.
  if (options.engine) {
    options.engine.removeRule(patternId);
  }

  console.error(
    `[browserreflex monitor] pattern demoted: ${patternId} (accuracy=${options.accuracy.toFixed(4)})`,
  );

  return { demoted: true, reason: options.reason, driftAlertId };
}

/**
 * Normalises an answer value to a canonical string for comparison.
 * Trims whitespace and lower-cases, so 'True', 'true', and ' true ' all compare equal.
 */
function normalizeAnswer(value: string): string {
  return value.trim().toLowerCase();
}
