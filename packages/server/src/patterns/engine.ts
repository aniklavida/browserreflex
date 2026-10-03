/**
 * Pattern engine core: loads typed rules and matches them in microseconds.
 *
 * Status: **implemented and tested**.
 *
 * Core invariants:
 * - A decision record that misdescribes itself is worse than no record:
 *   a pattern hit states path 'pattern' and the pattern_id that actually matched.
 * - The safety check is advisory; it never prevents an agent from acting.
 * - Precedence: safety rules first, then most specific rule, then deterministic tie-break by ID.
 * - Fast matching: pre-compiled and precedence-sorted rules match typical inputs in microseconds.
 */

import type { Question } from '../core/schema.js';
import { validateAnswer } from '../core/schema.js';
import type { CompiledRule, PatternEngineOptions, PatternMatchResult, Rule } from './types.js';
import { compareRulePrecedence } from './specificity.js';
import {
  DEFAULT_MAX_REGEX_INPUT_LENGTH,
  compileRule,
  matchRule,
  normalizeSnapshot,
} from './matchers.js';

export class PatternEngine {
  private compiledRules: CompiledRule[] = [];
  private readonly maxRegexInputLength: number;

  constructor(options?: readonly Rule[] | Rule[] | PatternEngineOptions) {
    if (Array.isArray(options)) {
      this.maxRegexInputLength = DEFAULT_MAX_REGEX_INPUT_LENGTH;
      this.loadRules(options);
    } else if (options && typeof options === 'object') {
      const opts = options as PatternEngineOptions;
      this.maxRegexInputLength = opts.maxRegexInputLength ?? DEFAULT_MAX_REGEX_INPUT_LENGTH;
      if (opts.rules) {
        this.loadRules(opts.rules);
      }
    } else {
      this.maxRegexInputLength = DEFAULT_MAX_REGEX_INPUT_LENGTH;
    }
  }

  /**
   * Adds a single rule, re-sorting compiled rules by precedence.
   */
  addRule(rule: Rule): void {
    const compiled = compileRule(rule);
    // Remove any existing rule with the same ID
    this.compiledRules = this.compiledRules.filter((r) => r.id !== rule.id);
    this.compiledRules.push(compiled);
    this.compiledRules.sort(compareRulePrecedence);
  }

  /**
   * Loads multiple typed rules, replacing any existing rules with matching IDs,
   * and sorting all compiled rules by precedence.
   */
  loadRules(rules: readonly Rule[]): void {
    const newCompiled = rules.map((r) => compileRule(r));
    const newIds = new Set(newCompiled.map((r) => r.id));
    const retained = this.compiledRules.filter((r) => !newIds.has(r.id));
    this.compiledRules = [...retained, ...newCompiled];
    this.compiledRules.sort(compareRulePrecedence);
  }

  /**
   * Clears all rules from the engine.
   */
  clearRules(): void {
    this.compiledRules = [];
  }

  /**
   * Returns all raw rules currently loaded.
   */
  getRules(): readonly Rule[] {
    return this.compiledRules.map((c) => c.rule);
  }

  /**
   * Returns all compiled rules currently loaded in precedence order.
   */
  getCompiledRules(): readonly CompiledRule[] {
    return this.compiledRules;
  }

  /**
   * Returns the count of rules loaded in the engine.
   */
  get size(): number {
    return this.compiledRules.length;
  }

  /**
   * Matches an input against loaded rules and returns the single highest precedence matching rule.
   *
   * Because compiled rules are kept sorted by precedence (safety first, then specificity, then ID),
   * the first rule that matches is guaranteed to be the winner.
   */
  match(input: unknown): PatternMatchResult | null {
    const snapshot = normalizeSnapshot(input);
    for (const rule of this.compiledRules) {
      if (matchRule(rule, snapshot, this.maxRegexInputLength)) {
        return {
          rule: rule.rule,
          pattern_id: rule.id,
          is_safety: rule.is_safety,
          specificity: rule.specificity,
          output: rule.output,
        };
      }
    }
    return null;
  }

  /**
   * Matches an input against all loaded rules and returns all matching rules in precedence order.
   */
  matchAll(input: unknown): PatternMatchResult[] {
    const snapshot = normalizeSnapshot(input);
    const results: PatternMatchResult[] = [];
    for (const rule of this.compiledRules) {
      if (matchRule(rule, snapshot, this.maxRegexInputLength)) {
        results.push({
          rule: rule.rule,
          pattern_id: rule.id,
          is_safety: rule.is_safety,
          specificity: rule.specificity,
          output: rule.output,
        });
      }
    }
    return results;
  }

  /**
   * Matches an input snapshot for a specific Question being routed.
   *
   * Filters candidate matching rules to those compatible with the question:
   * - decision_type matches question.type
   * - if choice question, rule value is a valid option id
   * - if score question, rule value is within scale range
   * - if check question, rule value is boolean
   * - if target_question_id is specified on rule, matches question.id
   * - if rule is not safety, confidence meets threshold
   * - output validates against schema validator
   */
  matchForQuestion(
    input: unknown,
    question: Question,
    options?: {
      threshold?: number | undefined;
      url?: string | null | undefined;
      domain?: string | null | undefined;
    },
  ): PatternMatchResult | null {
    const snapshot = normalizeSnapshot(input, options?.url, options?.domain);
    const threshold = options?.threshold ?? 0.8;

    for (const rule of this.compiledRules) {
      // 1. Question ID constraint if present on rule
      const targetQId = rule.matchers.target_question_id ?? rule.matchers.question_id;
      if (targetQId && targetQId !== question.id) {
        continue;
      }

      // 2. Decision type compatibility
      const ruleType = rule.output.type ?? rule.output.decision_type;
      if (ruleType && ruleType !== question.type) {
        continue;
      }

      // 3. Confidence threshold: safety rules always fire; non-safety must meet threshold
      if (!rule.is_safety && rule.output.confidence < threshold) {
        continue;
      }

      // 4. Match snapshot against rule matchers
      if (!matchRule(rule, snapshot, this.maxRegexInputLength)) {
        continue;
      }

      // 5. Validate that rule output satisfies the question schema
      const candidateAnswer = {
        value: rule.output.value,
        confidence: rule.output.confidence,
        path: 'pattern' as const,
        pattern_id: rule.id,
        ...(rule.output.distribution ? { distribution: rule.output.distribution } : {}),
      };

      const valResult = validateAnswer(question, candidateAnswer);
      if (!valResult.success) {
        continue;
      }

      // Found highest precedence valid rule
      return {
        rule: rule.rule,
        pattern_id: rule.id,
        is_safety: rule.is_safety,
        specificity: rule.specificity,
        output: rule.output,
      };
    }

    return null;
  }
}

/**
 * Creates a new PatternEngine instance with the given rules or configuration.
 */
export function createPatternEngine(
  rulesOrOptions?: readonly Rule[] | Rule[] | PatternEngineOptions,
): PatternEngine {
  return new PatternEngine(rulesOrOptions);
}

let defaultPatternEngine: PatternEngine | null = null;

/**
 * Returns the default global PatternEngine instance, lazily created if necessary.
 */
export function getDefaultPatternEngine(): PatternEngine {
  if (!defaultPatternEngine) {
    defaultPatternEngine = new PatternEngine();
  }
  return defaultPatternEngine;
}

/**
 * Sets or clears the default global PatternEngine instance.
 */
export function setDefaultPatternEngine(engine: PatternEngine | null): void {
  defaultPatternEngine = engine;
}
