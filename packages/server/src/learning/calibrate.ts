/**
 * Confidence calibration: what a rule says about its own certainty, against what
 * feedback found.
 *
 * Status: **implemented and tested**. The tests behind that claim are
 * `packages/server/test/calibrate.test.ts`, including the router wiring.
 *
 * This is the calibration step of the learning loop in `docs/SPEC.md`: "confidence is
 * calibrated per pattern and decision type from user feedback". A rule states a
 * confidence. Feedback later says whether the answer it produced was right. This module
 * reads those two numbers against each other, so that a rule which says "90%" and is
 * right 30% of the time stops saying 90%.
 *
 * ## What a calibrated confidence is
 *
 * A rule's stated confidence is grouped per (pattern id or URL path, decision type) and
 * binned into `CALIBRATION_BINS` equal bins of the 0 to 1 range. For the bin the stated
 * confidence falls into, the module reads the share of feedback-confirmed answers in that
 * bin that were right, and blends that share with the bin's own mean stated confidence:
 *
 * ```text
 * weight      = min(1, samples / MIN_SAMPLES)
 * calibrated  = weight * observed accuracy + (1 - weight) * mean stated confidence
 * ```
 *
 * At `MIN_SAMPLES` confirmed answers the bin speaks for itself and the calibrated value
 * is its observed accuracy. Below that the weight is smaller, so a bin with three samples
 * cannot move a confidence far; with none at all the stated value passes through unchanged.
 * The prior is the bin's mean stated confidence rather than the individual answer's, so one
 * replay of one bin gives one number for every answer in it.
 *
 * `calibrationError` is the expected calibration error: the sample-weighted mean, over the
 * populated bins, of how far the stated confidence sits from the accuracy of its own bin.
 * It is what makes the claim "says 90% matches right 90%" measurable rather than a slogan,
 * and the replay test shows it dropping on a systematically overconfident history.
 *
 * ## Invariants, each with the test that holds it
 *
 * - **Only the confidence moves.** No value is changed, no option list, no scale, no
 *   verdict. Tests: *never changes an answer value, only its confidence* and *returns the
 *   calibrated confidence for a pattern answer, and records that same confidence*.
 * - **A calibrated confidence is a probability.** Both terms of the blend are
 *   probabilities and the result is clamped, so nothing leaves 0 to 1. Test: *keeps every
 *   calibrated confidence inside 0 to 1*.
 * - **A thin bin cannot swing a confidence.** The weight is the sample count over
 *   `MIN_SAMPLES`. Test: *moves a thin bin only part of the way to its observed accuracy*.
 * - **No confirmed history, no change.** A bin with no sample returns the stated value
 *   untouched. Test: *leaves the stated confidence unchanged when no sample lands in its
 *   bin*.
 * - **A record that misdescribes itself is worse than no record.** The router logs the
 *   calibrated confidence, because that is the confidence the answer carried. The stated
 *   confidence is the rule's own, in the rule that matched, and the answer names that rule
 *   in `pattern_id`. Test: *returns the calibrated confidence for a pattern answer, and
 *   records that same confidence*.
 * - **Page content is data.** Nothing here reads a page, a selector or any text at all. A
 *   sample is two numbers and a verdict about one stored answer, and the values compared
 *   are the stored answer and the reported correction.
 *
 * ## Safety
 *
 * A safety rule keeps its stated confidence, and that is the whole of the rule here. A
 * safety rule's answer is a verdict, not a prediction: `ask_user` is what it says, and it
 * says it whether the confidence is 0.95 or 0.3. Lowering a safety confidence could move
 * an answer across a routing threshold, which would change what the agent is asked to do
 * while changing nothing about the risk the rule saw, so calibration never touches a
 * safety scope and `calibrate` returns before it reads any history. Test: *keeps a safety
 * rule at its stated confidence, and its verdict*.
 *
 * The safety check is advisory: nothing in this module enforces anything, and a calibrated
 * or an uncalibrated confidence does not stop an agent from acting.
 *
 * ## Honest limits
 *
 * - **A sample needs a feedback row.** An answer nobody ever checked contributes nothing,
 *   so a pattern whose answers are all accepted silently is never calibrated. Absence of
 *   feedback is not confirmation, and this module does not treat it as one.
 * - **Calibration sees only the answers somebody looked at.** If a pattern is corrected
 *   when it is wrong and ignored when it is right, the observed accuracy is the rate of
 *   corrections among the checked answers and the calibrated confidence is biased low.
 *   Nothing here can tell that case from a genuinely 30%-accurate pattern; only the
 *   re-checking step can, and that is a later card.
 * - **The reader takes the newest `CALIBRATION_HISTORY_LIMIT` rows.** A busy database can
 *   hide an older, well-sampled pattern behind newer corrections from elsewhere. A hidden
 *   history means the stated confidence passes through unchanged, which is the safe
 *   direction.
 *   `decisions.pattern_id` has no index of its own (migration 001 indexes sessions, input
 *   hash, domain, path and timestamps), so the cost of this read grows with the number of
 *   stored decisions. An index would need a new migration, which is not part of this card.
 * - **A past row keeps the confidence it was written with.** For a decision served before
 *   calibration was wired that is the rule's stated confidence; for one served after it,
 *   the calibrated value. Nothing here rewrites an old row, so a history read is a mix of
 *   the two while the first calibrated answers are settling.
 * - **The decision type is part of the group, never a blend across types.** A `choice` rule
 *   and a `check` rule with the same id are two groups.
 *
 * Dependencies: the Node standard library and internal types only, so nothing is added to
 * `docs/DEPENDENCIES.md` by this module.
 */

import type { DecisionType } from '../core/schema.js';
import type { DatabaseStore } from '../store/index.js';

/** Equal-width bins of the 0 to 1 range a stated confidence is grouped into. */
export const CALIBRATION_BINS = 10;

/**
 * Confirmed answers a bin needs before its observed accuracy speaks for itself.
 *
 * Below this the bin's accuracy is blended with the bin's mean stated confidence in
 * proportion to the sample count, so a handful of samples cannot move a confidence far.
 */
export const MIN_SAMPLES = 20;

/** Most feedback rows one history read looks at. */
export const CALIBRATION_HISTORY_LIMIT = 200;

/** One group a confidence is calibrated within: a pattern, or a URL path, and a decision type. */
export interface CalibrationScope {
  /** The rule that answered. Wins over `path` when both are given. */
  readonly pattern_id?: string | null | undefined;
  /**
   * The URL path of the decision, read from `decision_signals`. Used when no rule named
   * the answer, which the router's pattern path never is; the shape exists because the
   * group is defined per pattern id or path.
   */
  readonly path?: string | null | undefined;
  readonly decision_type: DecisionType;
  /** True for a rule marked `safety`. Such a scope is never calibrated: see the header. */
  readonly safety?: boolean | undefined;
}

/** One feedback-confirmed decision: the confidence it stated, and whether it was right. */
export interface CalibrationSample {
  readonly pattern_id?: string | null | undefined;
  readonly path?: string | null | undefined;
  readonly decision_type: DecisionType;
  /** The confidence the answer stated. */
  readonly stated_confidence: number;
  /** Whether feedback confirmed the stored answer was right. */
  readonly correct: boolean;
}

/** One bin of one group. */
export interface CalibrationBin {
  /** Bin index, 0 (0 to 0.1) to `CALIBRATION_BINS - 1` (0.9 to 1). */
  readonly bin: number;
  /** Inclusive lower edge of the bin. */
  readonly lower: number;
  /** Exclusive upper edge of the bin, or 1 for the last bin. */
  readonly upper: number;
  readonly samples: number;
  readonly correct: number;
  /** Share of the bin that was right, or null when the bin is empty. */
  readonly accuracy: number | null;
  /** Mean stated confidence of the bin, or 0 when the bin is empty. */
  readonly mean_stated: number;
}

/** The bins of one group, and how much history they hold. */
export interface CalibrationSummary {
  /** Always `CALIBRATION_BINS` long, so bin `n` is always at index `n`. */
  readonly bins: readonly CalibrationBin[];
  readonly samples: number;
  readonly correct: number;
}

export interface CalibrateOptions {
  /** The group to calibrate within. Omitted pools every sample in the history. */
  readonly scope?: CalibrationScope | undefined;
  /** Overrides `MIN_SAMPLES`. Anything not a positive number means `MIN_SAMPLES`. */
  readonly minSamples?: number | undefined;
}

export interface CalibrationErrorOptions extends CalibrateOptions {
  /** Calibrate the stated confidences before measuring the error. */
  readonly calibrated?: boolean | undefined;
}

export interface CalibrationHistoryQuery {
  readonly scope: CalibrationScope;
  /** Defaults to `CALIBRATION_HISTORY_LIMIT`; anything below one reads the newest row. */
  readonly limit?: number | undefined;
}

/** Rounds to four decimals, as the other ratios in this server do. */
function round4(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * Confines a number to 0 to 1.
 *
 * Both terms of the blend are already probabilities, so a calibrated confidence is in range
 * whatever happens here. This only bites a stated confidence that arrived out of range, which
 * the schema rejects before it can be stored.
 */
function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The bin a stated confidence falls into: bin `n` holds stated confidences in
 * `[n / CALIBRATION_BINS, (n + 1) / CALIBRATION_BINS)`, and the last bin also holds 1.
 */
export function confidenceBin(statedConfidence: number): number {
  if (!Number.isFinite(statedConfidence)) return 0;
  const stated = clamp01(statedConfidence);
  return Math.min(CALIBRATION_BINS - 1, Math.floor(stated * CALIBRATION_BINS));
}

/**
 * Whether a sample belongs to a group. A pattern id wins over a URL path, so one rule is
 * one group; a scope naming neither pools everything.
 */
function matchesScope(sample: CalibrationSample, scope: CalibrationScope): boolean {
  if (sample.decision_type !== scope.decision_type) return false;
  const patternId = nonEmpty(scope.pattern_id);
  if (patternId !== null) return nonEmpty(sample.pattern_id) === patternId;
  const path = nonEmpty(scope.path);
  if (path !== null) return nonEmpty(sample.path) === path;
  return true;
}

/**
 * Groups the history into bins and reports the observed accuracy of each.
 *
 * A stated confidence that is not a number is skipped rather than binned: the schema
 * rejects one before it can be stored, so a sample that carries one was not written by
 * this server.
 */
export function summarizeCalibration(
  history: readonly CalibrationSample[],
  scope?: CalibrationScope,
): CalibrationSummary {
  const samples = new Array<number>(CALIBRATION_BINS).fill(0);
  const correct = new Array<number>(CALIBRATION_BINS).fill(0);
  const statedSum = new Array<number>(CALIBRATION_BINS).fill(0);
  let total = 0;
  let totalCorrect = 0;

  for (const sample of history) {
    if (scope !== undefined && !matchesScope(sample, scope)) continue;
    if (!Number.isFinite(sample.stated_confidence)) continue;

    const stated = clamp01(sample.stated_confidence);
    const index = confidenceBin(stated);
    const right = sample.correct ? 1 : 0;

    samples[index] = (samples[index] ?? 0) + 1;
    correct[index] = (correct[index] ?? 0) + right;
    statedSum[index] = (statedSum[index] ?? 0) + stated;
    total += 1;
    totalCorrect += right;
  }

  const bins: CalibrationBin[] = samples.map((count, index) => ({
    bin: index,
    lower: round4(index / CALIBRATION_BINS),
    upper: round4((index + 1) / CALIBRATION_BINS),
    samples: count,
    correct: correct[index] ?? 0,
    accuracy: count === 0 ? null : round4((correct[index] ?? 0) / count),
    mean_stated: count === 0 ? 0 : round4((statedSum[index] ?? 0) / count),
  }));

  return { bins, samples: total, correct: totalCorrect };
}

/** The sample count a bin needs before its own accuracy is taken at face value. */
function resolveMinSamples(minSamples: number | undefined): number {
  if (minSamples === undefined) return MIN_SAMPLES;
  if (!Number.isFinite(minSamples) || minSamples <= 0) return MIN_SAMPLES;
  return minSamples;
}

/**
 * The smoothed mapping of one bin: the observed accuracy once the bin holds
 * `minSamples` confirmed answers, and a blend with the bin's own mean stated confidence
 * before that.
 *
 * Both terms are probabilities, so no blend of them can leave 0 to 1; the result is clamped
 * and rounded anyway, because a confidence is returned and logged to four decimals.
 */
function blendConfidence(bin: CalibrationBin, minSamples: number): number {
  const accuracy = bin.accuracy ?? bin.mean_stated;
  const weight = bin.samples <= 0 ? 0 : Math.min(1, bin.samples / minSamples);
  return round4(clamp01(weight * accuracy + (1 - weight) * bin.mean_stated));
}

/**
 * Maps a stated confidence to a calibrated one, for one group of the history.
 *
 * The stated confidence passes through unchanged when the group has no confirmed sample in
 * its bin, and when the group is a safety scope.
 */
export function calibrate(
  statedConfidence: number,
  history: readonly CalibrationSample[],
  options: CalibrateOptions = {},
): number {
  if (!Number.isFinite(statedConfidence)) return statedConfidence;
  const stated = clamp01(statedConfidence);

  // A safety scope is never calibrated, and the history behind it is not even read: a
  // safety verdict does not depend on its confidence, so there is nothing to adjust.
  if (options.scope?.safety === true) return round4(stated);

  const summary = summarizeCalibration(history, options.scope);
  const bin = summary.bins[confidenceBin(stated)];
  if (bin === undefined || bin.samples === 0) return round4(stated);

  return blendConfidence(bin, resolveMinSamples(options.minSamples));
}

/**
 * The expected calibration error of a history: the sample-weighted mean, over the populated
 * bins, of how far the stated confidence sits from the accuracy of its own bin.
 *
 * With `calibrated: true` the stated confidences are calibrated first, so the same history
 * can be measured before and after. An empty history has no error to report and reads 0.
 */
export function calibrationError(
  history: readonly CalibrationSample[],
  options: CalibrationErrorOptions = {},
): number {
  const summary = summarizeCalibration(history, options.scope);
  if (summary.samples === 0) return 0;

  const minSamples = resolveMinSamples(options.minSamples);
  const calibrated = options.calibrated === true && options.scope?.safety !== true;
  let error = 0;

  for (const bin of summary.bins) {
    if (bin.samples === 0) continue;
    const stated = calibrated ? blendConfidence(bin, minSamples) : bin.mean_stated;
    error += (bin.samples / summary.samples) * Math.abs(stated - (bin.accuracy ?? 0));
  }

  return round4(error);
}

/**
 * Reads a stored answer or a reported correction as a single value.
 *
 * The decision log writes an answer as a bare value, a JSON scalar, or a JSON object
 * wrapping the value, so all three are read here and a comparison is between values rather
 * than between two spellings of one value.
 */
function readScalar(raw: string): string | number | boolean | null {
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
      return inner;
    }
    return null;
  }
  if (typeof parsed === 'string' || typeof parsed === 'number' || typeof parsed === 'boolean') {
    return parsed;
  }
  return null;
}

/**
 * Reads a value as the token two values of one decision type compare by, so `true`, `yes`
 * and a stored `true` are one token and not three.
 *
 * This is the same reading `tools/feedback.ts` uses when it decides whether a correction
 * agrees with an answer, kept here so this module stays independent of the tool: a null
 * token means the value could not be read as one of the type, and agreement is then unknown
 * rather than false.
 */
function agreementToken(raw: string, type: DecisionType): string | null {
  const value = readScalar(raw);
  if (value === null) return null;

  if (type === 'choice') {
    const text = typeof value === 'string' ? value.trim() : String(value);
    return text === '' ? null : text;
  }

  if (type === 'score') {
    if (typeof value === 'boolean') return null;
    const numeric = typeof value === 'number' ? value : Number(String(value).trim());
    return Number.isFinite(numeric) ? String(numeric) : null;
  }

  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (value === 0 || value === 1) return value === 1 ? 'true' : 'false';
    if (value > 0 && value < 1) return String(value);
    return null;
  }

  const lower = value.trim().toLowerCase();
  if (lower === 'true' || lower === 'yes') return 'true';
  if (lower === 'false' || lower === 'no') return 'false';
  const numeric = Number(lower);
  if (lower !== '' && Number.isFinite(numeric) && numeric >= 0 && numeric <= 1) {
    return String(numeric);
  }
  return null;
}

const HISTORY_SELECT = `
  SELECT f.id AS feedback_id,
         f.correct_value AS correct_value,
         d.id AS decision_id,
         d.pattern_id AS pattern_id,
         d.decision_type AS decision_type,
         d.answer AS answer,
         d.confidence AS confidence
  FROM feedback f
  JOIN decisions d ON d.id = f.decision_id
`;

/**
 * Reads the feedback-confirmed history of one group, newest correction first.
 *
 * A sample is a decision somebody checked: the confidence the row carries, and whether the
 * stored answer was right when the latest correction is compared with it. One sample per
 * decision, because a second correction changes the verdict on the same answer rather than
 * adding an answer. A decision whose stored answer or whose correction cannot be read as a
 * value of the decision type is left out: unknown agreement is not a wrong answer.
 *
 * Only the router's pattern path reads history today, and a pattern answer always names a
 * rule, so the pattern form is the one the router uses. The path form reads the URL path
 * from `decision_signals`, which is where capture stores it; `decisions.path` holds the
 * decision path and is not a URL path.
 */
export function readCalibrationHistory(
  store: DatabaseStore,
  query: CalibrationHistoryQuery,
): CalibrationSample[] {
  const { scope } = query;
  const patternId = nonEmpty(scope.pattern_id);
  const path = nonEmpty(scope.path);

  let rows: Record<string, unknown>[];
  if (patternId !== null) {
    rows = store.db
      .prepare(
        `${HISTORY_SELECT}
         WHERE d.pattern_id = ? AND d.decision_type = ?
         ORDER BY f.created_at DESC, f.id DESC
         LIMIT ?`,
      )
      .all(patternId, scope.decision_type, resolveLimit(query.limit)) as Record<string, unknown>[];
  } else if (path !== null) {
    rows = store.db
      .prepare(
        `${HISTORY_SELECT}
         JOIN decision_signals s ON s.decision_id = d.id
         WHERE s.path = ? AND d.decision_type = ?
         ORDER BY f.created_at DESC, f.id DESC
         LIMIT ?`,
      )
      .all(path, scope.decision_type, resolveLimit(query.limit)) as Record<string, unknown>[];
  } else {
    // A scope naming neither a rule nor a path names no group, and there is nothing to read.
    return [];
  }

  const samples: CalibrationSample[] = [];
  const seenDecisions = new Set<string>();

  for (const row of rows) {
    const decisionId = typeof row.decision_id === 'string' ? row.decision_id : '';
    if (decisionId === '' || seenDecisions.has(decisionId)) continue;
    // Marked before the values are read: rows arrive newest correction first, so an older
    // correction for the same decision must not stand in for one that cannot be read.
    seenDecisions.add(decisionId);

    const type = row.decision_type;
    const confidence = row.confidence;
    if (
      (type !== 'choice' && type !== 'score' && type !== 'check') ||
      typeof confidence !== 'number' ||
      typeof row.answer !== 'string' ||
      typeof row.correct_value !== 'string'
    ) {
      continue;
    }

    const stated = agreementToken(row.answer, type);
    const corrected = agreementToken(row.correct_value, type);
    if (stated === null || corrected === null) continue;

    samples.push({
      pattern_id: typeof row.pattern_id === 'string' ? row.pattern_id : null,
      ...(path !== null ? { path } : {}),
      decision_type: type,
      stated_confidence: confidence,
      correct: stated === corrected,
    });
  }

  return samples;
}

/** The row count one history read takes, at least one. */
function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return CALIBRATION_HISTORY_LIMIT;
  if (!Number.isFinite(limit)) return CALIBRATION_HISTORY_LIMIT;
  return Math.max(1, Math.floor(limit));
}
