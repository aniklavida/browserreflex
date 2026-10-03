/**
 * Specificity scoring and rule precedence ordering.
 *
 * Precedence rules:
 * 1. Safety rules always take precedence over non-safety rules.
 * 2. More specific rules take precedence over broader rules.
 * 3. Deterministic tie-breaking by rule ID.
 */

import type { CompiledRule, RuleMatchers } from './types.js';

/**
 * Computes a specificity score derived from the matchers present on a rule.
 *
 * Constraints on URLs, elements, text, and environment conditions all contribute
 * to narrowing the rule's scope, with compound rules ranking higher than single-signal rules.
 */
export function computeSpecificity(matchers: RuleMatchers): number {
  let score = 0;

  if (matchers.url_domain !== undefined) {
    score += 10;
  }

  if (matchers.url_path !== undefined) {
    score += 10;
  }

  if (matchers.role !== undefined) {
    score += 10;
  }

  if (matchers.text_any !== undefined) {
    score += 10;
    const term =
      typeof matchers.text_any === 'string'
        ? matchers.text_any
        : Array.isArray(matchers.text_any) && matchers.text_any.length > 0
          ? String(matchers.text_any[0])
          : '';
    score += Math.min(5, term.length);
  }

  if (matchers.text_regex !== undefined) {
    score += 15;
  }

  if (matchers.file_path_glob !== undefined) {
    score += 10;
  }

  if (matchers.exit_code !== undefined) {
    score += 10;
  }

  if (matchers.log_regex !== undefined) {
    score += 15;
  }

  if (matchers.target_question_id !== undefined || matchers.question_id !== undefined) {
    score += 5;
  }

  return score;
}

/**
 * Compares two compiled rules for precedence sorting.
 *
 * Returns:
 * - negative number if `a` has higher precedence than `b` (comes first)
 * - positive number if `b` has higher precedence than `a`
 * - 0 if both are identical in precedence
 */
export function compareRulePrecedence(a: CompiledRule, b: CompiledRule): number {
  // 1. Safety rules always win over non-safety rules
  const aSafety = a.is_safety ? 1 : 0;
  const bSafety = b.is_safety ? 1 : 0;
  if (aSafety !== bSafety) {
    return bSafety - aSafety;
  }

  // 2. Most specific rule wins
  if (a.specificity !== b.specificity) {
    return b.specificity - a.specificity;
  }

  // 3. Deterministic tie-break by ID
  return a.id.localeCompare(b.id);
}
