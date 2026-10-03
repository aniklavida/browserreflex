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
