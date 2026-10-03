/**
 * Pattern engine type definitions.
 *
 * Rules provide typed answers to repeated browser decisions using direct
 * matching against page snapshots, URLs, elements, logs, exit codes, and file paths.
 *
 * Status: **implemented and tested**.
 *
 * Invariants:
 * - A decision record that misdescribes itself is worse than no record:
 *   a pattern hit states path 'pattern' and the pattern_id that actually matched.
 * - The safety check is advisory; it never prevents an agent from acting.
 * - Safety rules always take precedence over non-safety rules.
 */

import type { DecisionType } from '../core/schema.js';

export interface SnapshotElement {
  role?: string | null | undefined;
  text?: string | null | undefined;
  [key: string]: unknown;
}

export interface Snapshot {
  url?: string | null | undefined;
  domain?: string | null | undefined;
  elements?: readonly SnapshotElement[] | SnapshotElement[] | undefined;
  exit_code?: number | null | undefined;
  exitCode?: number | null | undefined;
  log?: string | null | undefined;
  log_excerpt?: string | null | undefined;
  logExcerpt?: string | null | undefined;
  file_paths?: readonly string[] | string[] | undefined;
  filePaths?: readonly string[] | string[] | undefined;
  files?: readonly string[] | string[] | undefined;
  text?: string | null | undefined;
  [key: string]: unknown;
}

export interface RuleMatchers {
  text_any?: string | readonly string[] | string[] | undefined;
  text_regex?: string | RegExp | undefined;
  role?: string | readonly string[] | string[] | undefined;
  url_domain?: string | readonly string[] | string[] | undefined;
  url_path?: string | readonly string[] | string[] | RegExp | undefined;
  file_path_glob?: string | readonly string[] | string[] | undefined;
  exit_code?: number | readonly number[] | number[] | undefined;
  log_regex?: string | RegExp | undefined;
  target_question_id?: string | undefined;
  question_id?: string | undefined;
  [key: string]: unknown;
}

export interface RuleOutput {
  decision_type?: DecisionType | undefined;
  type?: DecisionType | undefined;
  value: string | number | boolean;
  confidence: number;
  distribution?: Record<string, number> | undefined;
}

export interface Rule {
  id: string;
  name?: string | undefined;
  description?: string | null | undefined;
  pack_id?: string | null | undefined;
  safety?: boolean | undefined;
  is_safety?: boolean | number | undefined;
  matchers: RuleMatchers;
  output: RuleOutput;
  specificity?: number | undefined;
  [key: string]: unknown;
}

export interface CompiledRule {
  id: string;
  rule: Rule;
  name?: string | undefined;
  pack_id?: string | null | undefined;
  is_safety: boolean;
  matchers: RuleMatchers;
  output: RuleOutput;
  specificity: number;
  compiled: {
    textAny?: string[] | undefined;
    textRegex?: RegExp | undefined;
    roles?: string[] | undefined;
    urlDomains?: string[] | undefined;
    urlPaths?: (string | RegExp)[] | undefined;
    filePathGlobs?: RegExp[] | undefined;
    exitCodes?: number[] | undefined;
    logRegex?: RegExp | undefined;
  };
}

export interface PatternMatchResult {
  rule: Rule;
  pattern_id: string;
  is_safety: boolean;
  specificity: number;
  output: RuleOutput;
}

export interface PatternEngineOptions {
  rules?: readonly Rule[] | Rule[] | undefined;
  maxRegexInputLength?: number | undefined;
}
