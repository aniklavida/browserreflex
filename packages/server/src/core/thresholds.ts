/**
 * Decision thresholds and routing configuration.
 *
 * Defines confidence thresholds per decision type (choice, score, check):
 * - Confidences at or above `auto_at_or_above` are returned automatically (fast path).
 * - Confidences between `human_below` and `auto_at_or_above` route to AI for confirmation (slow path).
 * - Confidences below `human_below` route to human review.
 *
 * Status: **implemented and tested**.
 *
 * Invariants:
 * - A decision record that misdescribes itself is worse than no record:
 *   thresholds route decisions faithfully and log the actual path and confidence.
 * - The safety check is advisory; it never prevents an agent from acting.
 * - Safety-flagged answers are never auto-allowed past a human gate:
 *   a safety rule's ask_user is not a confidence matter and is not affected by thresholds.
 * - Thresholds can never cross: `human_below` must be less than or equal to `auto_at_or_above`.
 * - Changing a threshold takes effect on the next call without requiring a server restart.
 */

import type { DatabaseStore, Decision } from '../store/index.js';
import type { DecisionType } from './schema.js';

export const SETTINGS_KEY_THRESHOLDS = 'thresholds';

/** UI range constants: human below 10% to 80%, auto at or above 50% to 99%. */
export const MIN_HUMAN_BELOW = 0.1;
export const MAX_HUMAN_BELOW = 0.8;
export const MIN_AUTO_AT_OR_ABOVE = 0.5;
export const MAX_AUTO_AT_OR_ABOVE = 0.99;

export interface ThresholdConfig {
  /** Confidences strictly below this threshold route to human review. (10% to 80%) */
  human_below: number;
  /** Confidences at or above this threshold route automatically. (50% to 99%) */
  auto_at_or_above: number;
}

export type ThresholdSettings = Record<DecisionType, ThresholdConfig>;

/**
 * Sane default thresholds per decision type.
 * Choice, score, and check all default to human below 20% and auto at or above 80%.
 */
export const DEFAULT_THRESHOLDS: Readonly<ThresholdSettings> = Object.freeze({
  choice: Object.freeze({ human_below: 0.2, auto_at_or_above: 0.8 }),
  score: Object.freeze({ human_below: 0.2, auto_at_or_above: 0.8 }),
  check: Object.freeze({ human_below: 0.2, auto_at_or_above: 0.8 }),
});

/**
 * Normalizes a raw threshold value to a fraction between 0.0 and 1.0.
 * If supplied as a percentage (> 1, e.g. 20 or 80), converts it to 0.20 or 0.80.
 */
export function normalizeConfidence(val: number): number {
  if (typeof val !== 'number' || Number.isNaN(val)) {
    throw new Error(`Invalid threshold confidence value: ${String(val)}. Must be a number.`);
  }
  const normalized = val > 1 ? val / 100 : val;
  return Number(normalized.toFixed(4));
}

/**
 * Validates a threshold configuration.
 *
 * Rules:
 * - `human_below` must be between 10% and 80% (0.10 to 0.80).
 * - `auto_at_or_above` must be between 50% and 99% (0.50 to 0.99).
 * - Thresholds can never cross: `human_below` cannot be greater than `auto_at_or_above`.
 */
export function validateThresholdConfig(config: ThresholdConfig): ThresholdConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('Threshold configuration must be an object.');
  }

  const humanBelow = normalizeConfidence(config.human_below);
  const autoAtOrAbove = normalizeConfidence(config.auto_at_or_above);

  if (humanBelow < MIN_HUMAN_BELOW || humanBelow > MAX_HUMAN_BELOW) {
    throw new Error(
      `human_below threshold must be between 10% and 80% (0.10 to 0.80), got ${humanBelow}.`,
    );
  }

  if (autoAtOrAbove < MIN_AUTO_AT_OR_ABOVE || autoAtOrAbove > MAX_AUTO_AT_OR_ABOVE) {
    throw new Error(
      `auto_at_or_above threshold must be between 50% and 99% (0.50 to 0.99), got ${autoAtOrAbove}.`,
    );
  }

  if (humanBelow > autoAtOrAbove) {
    throw new Error(
      `Thresholds cannot cross: human_below (${humanBelow}) cannot be greater than auto_at_or_above (${autoAtOrAbove}).`,
    );
  }

  return {
    human_below: humanBelow,
    auto_at_or_above: autoAtOrAbove,
  };
}

/**
 * Reads all decision type thresholds from the store's settings repository.
 *
 * Reads directly from the settings table on every call so that changes take effect
 * immediately without requiring a server restart.
 */
export function getThresholds(store: DatabaseStore): ThresholdSettings {
  const stored = store.settings.getJson<Record<string, unknown>>(SETTINGS_KEY_THRESHOLDS);

  const result: ThresholdSettings = {
    choice: { ...DEFAULT_THRESHOLDS.choice },
    score: { ...DEFAULT_THRESHOLDS.score },
    check: { ...DEFAULT_THRESHOLDS.check },
  };

  const types: DecisionType[] = ['choice', 'score', 'check'];

  for (const type of types) {
    let rawConfig: unknown = undefined;

    if (stored && typeof stored === 'object' && type in stored) {
      rawConfig = stored[type];
    } else {
      const perType = store.settings.getJson<unknown>(`${SETTINGS_KEY_THRESHOLDS}.${type}`);
      if (perType) {
        rawConfig = perType;
      }
    }

    if (rawConfig && typeof rawConfig === 'object') {
      try {
        const validated = validateThresholdConfig(rawConfig as ThresholdConfig);
        result[type] = validated;
      } catch {
        // Fall back to default on corrupted stored configuration
        result[type] = { ...DEFAULT_THRESHOLDS[type] };
      }
    }
  }

  return result;
}

/**
 * Returns the threshold configuration for a specific decision type.
 */
export function getThresholdForType(store: DatabaseStore, type: DecisionType): ThresholdConfig {
  const all = getThresholds(store);
  return all[type] ?? { ...(DEFAULT_THRESHOLDS[type] ?? DEFAULT_THRESHOLDS.choice) };
}

/**
 * Updates threshold settings in the store's settings repository.
 *
 * Validates the new thresholds before persisting. Changes take effect on the next
 * decision call without requiring a restart.
 */
export function setThresholds(
  store: DatabaseStore,
  thresholds: Partial<ThresholdSettings> | ThresholdConfig,
  typeOverride?: DecisionType,
): ThresholdSettings {
  const current = getThresholds(store);
  const updated: ThresholdSettings = {
    choice: { ...current.choice },
    score: { ...current.score },
    check: { ...current.check },
  };

  if (typeOverride) {
    const validated = validateThresholdConfig(thresholds as ThresholdConfig);
    updated[typeOverride] = validated;
  } else if ('human_below' in thresholds && 'auto_at_or_above' in thresholds) {
    // Single config applied to all decision types
    const validated = validateThresholdConfig(thresholds as ThresholdConfig);
    updated.choice = { ...validated };
    updated.score = { ...validated };
    updated.check = { ...validated };
  } else {
    // Per-type partial object
    const map = thresholds as Partial<ThresholdSettings>;
    if (map.choice) {
      updated.choice = validateThresholdConfig(map.choice);
    }
    if (map.score) {
      updated.score = validateThresholdConfig(map.score);
    }
    if (map.check) {
      updated.check = validateThresholdConfig(map.check);
    }
  }

  store.settings.setJson(SETTINGS_KEY_THRESHOLDS, updated);
  return updated;
}

/**
 * Updates thresholds for a specific decision type.
 */
export function setThresholdForType(
  store: DatabaseStore,
  type: DecisionType,
  config: ThresholdConfig,
): ThresholdConfig {
  const validated = validateThresholdConfig(config);
  setThresholds(store, validated, type);
  return validated;
}

export interface RoutingShare {
  /** Share of decisions that would route automatically (0.0 to 1.0). */
  automatic: number;
  /** Share of decisions that would route to AI model confirmation (0.0 to 1.0). */
  model: number;
  /** Share of decisions that would route to human review (0.0 to 1.0). */
  human: number;

  /** Convenience alias for automatic. */
  auto: number;
  /** Convenience alias for model. */
  ai: number;

  /** Total number of decisions evaluated. */
  total: number;

  /** Raw decision counts in each bucket. */
  counts: {
    automatic: number;
    model: number;
    human: number;
    total: number;
  };

  /** Percentage values (0 to 100) for each bucket. */
  percentages: {
    automatic: number;
    model: number;
    human: number;
    auto: number;
    ai: number;
  };
}

/**
 * Previews routing distribution over a list of past decisions under the given thresholds.
 *
 * Invariants:
 * - Safety-flagged answers are never auto-allowed past a human gate:
 *   a safety rule's ask_user is not a confidence matter and is not affected by thresholds.
 * - Evaluates each past decision against its decision type's threshold config:
 *   auto at or above `auto_at_or_above`, model between, human below `human_below`.
 */
export function previewRouting(
  history: readonly Decision[] | Decision[],
  thresholds?: ThresholdSettings | ThresholdConfig | Partial<ThresholdSettings>,
): RoutingShare {
  let resolved: ThresholdSettings;

  if (!thresholds) {
    resolved = { ...DEFAULT_THRESHOLDS };
  } else if ('human_below' in thresholds && 'auto_at_or_above' in thresholds) {
    const single = validateThresholdConfig(thresholds as ThresholdConfig);
    resolved = {
      choice: { ...single },
      score: { ...single },
      check: { ...single },
    };
  } else {
    const partial = thresholds as Partial<ThresholdSettings>;
    resolved = {
      choice: partial.choice
        ? validateThresholdConfig(partial.choice)
        : { ...DEFAULT_THRESHOLDS.choice },
      score: partial.score
        ? validateThresholdConfig(partial.score)
        : { ...DEFAULT_THRESHOLDS.score },
      check: partial.check
        ? validateThresholdConfig(partial.check)
        : { ...DEFAULT_THRESHOLDS.check },
    };
  }

  let automaticCount = 0;
  let modelCount = 0;
  let humanCount = 0;

  for (const decision of history) {
    const decisionType = decision.decision_type in resolved ? decision.decision_type : 'choice';
    const config = resolved[decisionType] ?? DEFAULT_THRESHOLDS.choice;

    // Safety rules requiring user confirmation always go to human review regardless of confidence
    const isAskUser =
      decision.answer === 'ask_user' ||
      decision.answer === '"ask_user"' ||
      (typeof decision.context === 'string' && decision.context.includes('ask_user'));

    if (Boolean(decision.is_safety) && isAskUser) {
      humanCount++;
      continue;
    }

    if (decision.confidence >= config.auto_at_or_above) {
      automaticCount++;
    } else if (decision.confidence < config.human_below) {
      humanCount++;
    } else {
      modelCount++;
    }
  }

  const total = history.length;
  const automatic = total > 0 ? Number((automaticCount / total).toFixed(4)) : 0;
  const model = total > 0 ? Number((modelCount / total).toFixed(4)) : 0;
  const human = total > 0 ? Number((humanCount / total).toFixed(4)) : 0;

  const pctAutomatic = total > 0 ? Number(((automaticCount / total) * 100).toFixed(2)) : 0;
  const pctModel = total > 0 ? Number(((modelCount / total) * 100).toFixed(2)) : 0;
  const pctHuman = total > 0 ? Number(((humanCount / total) * 100).toFixed(2)) : 0;

  return {
    automatic,
    model,
    human,
    auto: automatic,
    ai: model,
    total,
    counts: {
      automatic: automaticCount,
      model: modelCount,
      human: humanCount,
      total,
    },
    percentages: {
      automatic: pctAutomatic,
      model: pctModel,
      human: pctHuman,
      auto: pctAutomatic,
      ai: pctModel,
    },
  };
}

export const SETTINGS_KEY_PROMOTION_THRESHOLDS = 'promotion_thresholds';

/** Minimum samples and agreement defaults for promotion */
export const STANDARD_MIN_SAMPLES = 20;
export const STANDARD_MIN_AGREEMENT = 0.95;
export const SAFETY_MIN_SAMPLES = 50;
export const SAFETY_MIN_AGREEMENT = 0.99;

export interface PromotionThresholdConfig {
  /** Minimum number of shadow test samples required. */
  min_samples: number;
  /** Minimum agreement ratio required (0.0 to 1.0). */
  min_agreement: number;
}

export interface PromotionSettings {
  /** Threshold for non-safety learned patterns. Default: 20 samples, 95% agreement. */
  standard: PromotionThresholdConfig;
  /** Threshold for safety-related patterns. Default: 50 samples, 99% agreement. */
  safety: PromotionThresholdConfig;
}

export const DEFAULT_PROMOTION_THRESHOLDS: Readonly<PromotionSettings> = Object.freeze({
  standard: Object.freeze({
    min_samples: STANDARD_MIN_SAMPLES,
    min_agreement: STANDARD_MIN_AGREEMENT,
  }),
  safety: Object.freeze({
    min_samples: SAFETY_MIN_SAMPLES,
    min_agreement: SAFETY_MIN_AGREEMENT,
  }),
});

/**
 * Validates and clamps promotion thresholds.
 *
 * Invariant: Never accept a threshold that would make promotion easier than the defaults
 * for the safety-related case below 50 samples / 99% agreement, and clamp safety minimums
 * so they can never be lower than the standard (non-safety) ones.
 */
export function validatePromotionThresholds(
  config: Partial<PromotionSettings> | unknown,
): PromotionSettings {
  if (!config || typeof config !== 'object') {
    throw new Error('Promotion threshold configuration must be an object.');
  }

  const raw = config as Partial<PromotionSettings>;
  const rawStandard = raw.standard;
  const rawSafety = raw.safety;

  let standardMinSamples = STANDARD_MIN_SAMPLES;
  if (rawStandard && rawStandard.min_samples !== undefined) {
    const num = Number(rawStandard.min_samples);
    if (!Number.isFinite(num) || num < 1) {
      throw new Error(
        `Invalid standard min_samples: ${String(rawStandard.min_samples)}. Must be >= 1.`,
      );
    }
    standardMinSamples = Math.floor(num);
  }

  let standardMinAgreement = STANDARD_MIN_AGREEMENT;
  if (rawStandard && rawStandard.min_agreement !== undefined) {
    const conf = normalizeConfidence(rawStandard.min_agreement);
    if (conf <= 0 || conf > 1) {
      throw new Error(`Invalid standard min_agreement: ${conf}. Must be between 0 and 1.`);
    }
    standardMinAgreement = conf;
  }

  let safetyMinSamples = SAFETY_MIN_SAMPLES;
  if (rawSafety && rawSafety.min_samples !== undefined) {
    const num = Number(rawSafety.min_samples);
    if (!Number.isFinite(num)) {
      throw new Error(
        `Invalid safety min_samples: ${String(rawSafety.min_samples)}. Must be a number.`,
      );
    }
    const samples = Math.floor(num);
    if (samples < SAFETY_MIN_SAMPLES) {
      throw new Error(
        `Safety promotion threshold min_samples cannot be less than ${SAFETY_MIN_SAMPLES} (cannot make safety promotion easier than default), got ${samples}.`,
      );
    }
    safetyMinSamples = samples;
  }

  let safetyMinAgreement = SAFETY_MIN_AGREEMENT;
  if (rawSafety && rawSafety.min_agreement !== undefined) {
    const conf = normalizeConfidence(rawSafety.min_agreement);
    if (conf < SAFETY_MIN_AGREEMENT) {
      throw new Error(
        `Safety promotion threshold min_agreement cannot be less than ${SAFETY_MIN_AGREEMENT} (99%) (cannot make safety promotion easier than default), got ${conf}.`,
      );
    }
    safetyMinAgreement = conf;
  }

  // Safety minimums can never be lower than standard ones
  if (safetyMinSamples < standardMinSamples) {
    throw new Error(
      `Safety min_samples (${safetyMinSamples}) cannot be lower than standard min_samples (${standardMinSamples}).`,
    );
  }

  if (safetyMinAgreement < standardMinAgreement) {
    throw new Error(
      `Safety min_agreement (${safetyMinAgreement}) cannot be lower than standard min_agreement (${standardMinAgreement}).`,
    );
  }

  // Extra fail-safe clamping
  safetyMinSamples = Math.max(safetyMinSamples, standardMinSamples, SAFETY_MIN_SAMPLES);
  safetyMinAgreement = Math.max(safetyMinAgreement, standardMinAgreement, SAFETY_MIN_AGREEMENT);

  return {
    standard: {
      min_samples: standardMinSamples,
      min_agreement: standardMinAgreement,
    },
    safety: {
      min_samples: safetyMinSamples,
      min_agreement: safetyMinAgreement,
    },
  };
}

/**
 * Reads promotion threshold settings from the store's settings repository.
 *
 * Sane defaults are returned if nothing is stored or on invalid configuration,
 * with safety minimums clamped so they cannot be lower than 50 samples / 99% agreement
 * or standard thresholds.
 */
export function getPromotionThresholds(store: DatabaseStore): PromotionSettings {
  const stored = store.settings.getJson<Record<string, unknown>>(SETTINGS_KEY_PROMOTION_THRESHOLDS);

  if (!stored || typeof stored !== 'object') {
    return {
      standard: { ...DEFAULT_PROMOTION_THRESHOLDS.standard },
      safety: { ...DEFAULT_PROMOTION_THRESHOLDS.safety },
    };
  }

  try {
    return validatePromotionThresholds(stored);
  } catch {
    // If stored configuration is invalid or corrupted, sanitize and clamp to safe bounds
    const rawStandard = stored.standard as Partial<PromotionThresholdConfig> | undefined;
    const rawSafety = stored.safety as Partial<PromotionThresholdConfig> | undefined;

    const stdSamples =
      typeof rawStandard?.min_samples === 'number' && rawStandard.min_samples >= 1
        ? Math.floor(rawStandard.min_samples)
        : STANDARD_MIN_SAMPLES;

    let stdAgreement = STANDARD_MIN_AGREEMENT;
    try {
      if (typeof rawStandard?.min_agreement === 'number') {
        stdAgreement = normalizeConfidence(rawStandard.min_agreement);
      }
    } catch {
      stdAgreement = STANDARD_MIN_AGREEMENT;
    }

    const safeSamples = Math.max(
      SAFETY_MIN_SAMPLES,
      stdSamples,
      typeof rawSafety?.min_samples === 'number'
        ? Math.floor(rawSafety.min_samples)
        : SAFETY_MIN_SAMPLES,
    );

    let safeAgreement = SAFETY_MIN_AGREEMENT;
    try {
      if (typeof rawSafety?.min_agreement === 'number') {
        safeAgreement = normalizeConfidence(rawSafety.min_agreement);
      }
    } catch {
      safeAgreement = SAFETY_MIN_AGREEMENT;
    }
    safeAgreement = Math.max(SAFETY_MIN_AGREEMENT, stdAgreement, safeAgreement);

    return {
      standard: {
        min_samples: stdSamples,
        min_agreement: stdAgreement,
      },
      safety: {
        min_samples: safeSamples,
        min_agreement: safeAgreement,
      },
    };
  }
}

/**
 * Persists updated promotion thresholds in settings after validation.
 */
export function setPromotionThresholds(
  store: DatabaseStore,
  thresholds: Partial<PromotionSettings>,
): PromotionSettings {
  const current = getPromotionThresholds(store);
  const toValidate: PromotionSettings = {
    standard: {
      ...current.standard,
      ...(thresholds.standard ?? {}),
    },
    safety: {
      ...current.safety,
      ...(thresholds.safety ?? {}),
    },
  };

  const validated = validatePromotionThresholds(toValidate);
  store.settings.setJson(SETTINGS_KEY_PROMOTION_THRESHOLDS, validated);
  return validated;
}
