/**
 * Matcher implementations for pattern rules.
 *
 * Matchers:
 * - text_any: Substring search across element texts or page text.
 * - text_regex: Regular expression matching on element text with bounded input length.
 * - role: Element role matching (e.g. 'button', 'dialog').
 * - url_domain: Domain / hostname matching with subdomain support.
 * - url_path: Path matching on the URL pathname.
 * - file_path_glob: Glob matching against file path lists.
 * - exit_code: Process exit code matching.
 * - log_regex: Regular expression matching on log excerpts with bounded input length.
 *
 * Invariants:
 * - Page content is data: text is matched against rules and never executed as an instruction.
 * - text_regex and log_regex bound input length to guard against catastrophic backtracking.
 * - Compound rules require all specified matchers to succeed (conjunction).
 */

import type { CompiledRule, Rule, Snapshot, SnapshotElement } from './types.js';
import { computeSpecificity } from './specificity.js';

export const DEFAULT_MAX_REGEX_INPUT_LENGTH = 256;

/**
 * Compiles a string or RegExp pattern into a RegExp object.
 */
export function compileRegex(pattern: string | RegExp, defaultFlags = 'i'): RegExp {
  if (pattern instanceof RegExp) {
    return pattern;
  }

  // Check if string is formatted as /pattern/flags
  if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
    const lastSlash = pattern.lastIndexOf('/');
    const body = pattern.slice(1, lastSlash);
    const flags = pattern.slice(lastSlash + 1);
    try {
      return new RegExp(body, flags);
    } catch {
      // Fallback to literal pattern with default flags
    }
  }

  return new RegExp(pattern, defaultFlags);
}

/**
 * Converts a standard file glob pattern into a regular expression.
 */
export function globToRegex(glob: string): RegExp {
  let reStr = '';
  let i = 0;
  while (i < glob.length) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          reStr += '(?:.*/)?';
          i += 3;
          continue;
        } else {
          reStr += '.*';
          i += 2;
          continue;
        }
      } else {
        reStr += '[^/]*';
        i += 1;
        continue;
      }
    } else if (char === '?') {
      reStr += '[^/]';
      i += 1;
      continue;
    } else if (['.', '+', '^', '$', '(', ')', '[', ']', '{', '}', '|', '\\'].includes(char)) {
      reStr += '\\' + char;
      i += 1;
    } else {
      reStr += char;
      i += 1;
    }
  }

  if (!glob.includes('/')) {
    return new RegExp(`(?:^|/)${reStr}$`, 'i');
  }
  return new RegExp(`^${reStr}$`, 'i');
}

/**
 * Normalizes an arbitrary input into a standard Snapshot object.
 */
export function normalizeSnapshot(
  input: unknown,
  fallbackUrl?: string | null,
  fallbackDomain?: string | null,
): Snapshot {
  let raw: Record<string, unknown> = {};
  if (typeof input === 'object' && input !== null) {
    const obj = input as Record<string, unknown>;
    if (typeof obj.snapshot === 'object' && obj.snapshot !== null) {
      raw = obj.snapshot as Record<string, unknown>;
    } else if (typeof obj.state === 'object' && obj.state !== null) {
      raw = obj.state as Record<string, unknown>;
    } else {
      raw = obj;
    }
  }

  const url = (typeof raw.url === 'string' ? raw.url : fallbackUrl) ?? null;
  let domain = (typeof raw.domain === 'string' ? raw.domain : fallbackDomain) ?? null;
  if (!domain && url) {
    try {
      domain = new URL(url).hostname;
    } catch {
      // Ignore URL parsing errors
    }
  }

  let elements: SnapshotElement[] = [];
  if (Array.isArray(raw.elements)) {
    elements = raw.elements.filter(
      (e): e is SnapshotElement => typeof e === 'object' && e !== null,
    );
  }

  let exitCode: number | null = null;
  if (typeof raw.exit_code === 'number') {
    exitCode = raw.exit_code;
  } else if (typeof raw.exitCode === 'number') {
    exitCode = raw.exitCode;
  }

  let log: string | null = null;
  if (typeof raw.log === 'string') {
    log = raw.log;
  } else if (typeof raw.log_excerpt === 'string') {
    log = raw.log_excerpt;
  } else if (typeof raw.logExcerpt === 'string') {
    log = raw.logExcerpt;
  }

  let filePaths: string[] = [];
  if (Array.isArray(raw.file_paths)) {
    filePaths = raw.file_paths.filter((f): f is string => typeof f === 'string');
  } else if (Array.isArray(raw.filePaths)) {
    filePaths = raw.filePaths.filter((f): f is string => typeof f === 'string');
  } else if (Array.isArray(raw.files)) {
    filePaths = raw.files.filter((f): f is string => typeof f === 'string');
  }

  const text = typeof raw.text === 'string' ? raw.text : null;

  return {
    url,
    domain,
    elements,
    exit_code: exitCode,
    exitCode,
    log,
    log_excerpt: log,
    logExcerpt: log,
    file_paths: filePaths,
    filePaths,
    text,
    ...raw,
  };
}

/**
 * Matches text_any: true if text contains any of the search terms (case-insensitive).
 */
export function matchTextAny(terms: readonly string[], text: string | null | undefined): boolean {
  if (!text || terms.length === 0) return false;
  const lower = text.toLowerCase();
  for (const term of terms) {
    if (lower.includes(term.toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * Matches text_regex: bounded input length protects against catastrophic backtracking.
 */
export function matchTextRegex(
  regex: RegExp,
  text: string | null | undefined,
  maxLength: number = DEFAULT_MAX_REGEX_INPUT_LENGTH,
): boolean {
  if (!text) return false;
  const bounded = text.length > maxLength ? text.slice(0, maxLength) : text;
  return regex.test(bounded);
}

/**
 * Matches element role (case-insensitive).
 */
export function matchRole(roles: readonly string[], role: string | null | undefined): boolean {
  if (!role || roles.length === 0) return false;
  const lowerRole = role.toLowerCase();
  return roles.some((r) => r.toLowerCase() === lowerRole);
}

/**
 * Matches url_domain: checks exact domain, suffix/subdomain, or wildcard pattern.
 */
export function matchUrlDomain(
  domains: readonly string[],
  domain: string | null | undefined,
  url: string | null | undefined,
): boolean {
  let targetDomain = domain;
  if (!targetDomain && url) {
    try {
      targetDomain = new URL(url).hostname;
    } catch {
      // not a valid URL
    }
  }
  if (!targetDomain) return false;

  const lowerTarget = targetDomain.toLowerCase();
  for (const d of domains) {
    const lowerD = d.toLowerCase();
    if (lowerTarget === lowerD) {
      return true;
    }
    // Subdomain matching or wildcard *.domain.com
    const cleanD = lowerD.startsWith('*.') ? lowerD.slice(2) : lowerD;
    if (lowerTarget.endsWith(`.${cleanD}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Matches url_path: checks exact pathname, wildcard glob, prefix, or RegExp.
 */
export function matchUrlPath(
  patterns: readonly (string | RegExp)[],
  url: string | null | undefined,
): boolean {
  if (!url) return false;

  let pathname = url;
  if (url.startsWith('http://') || url.startsWith('https://')) {
    try {
      pathname = new URL(url).pathname;
    } catch {
      // Keep original url string as path
    }
  }

  for (const pattern of patterns) {
    if (pattern instanceof RegExp) {
      if (pattern.test(pathname)) return true;
      continue;
    }

    if (pattern === pathname) return true;

    // Wildcard glob support in path
    if (pattern.includes('*')) {
      const re = globToRegex(pattern);
      if (re.test(pathname)) return true;
      continue;
    }

    // Prefix matching for directory paths
    if (pattern.endsWith('/') && pathname.startsWith(pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Matches file_path_glob against a list of file paths.
 */
export function matchFilePathGlob(
  globs: readonly RegExp[],
  filePaths: readonly string[] | null | undefined,
): boolean {
  if (!filePaths || filePaths.length === 0 || globs.length === 0) return false;

  for (const filePath of filePaths) {
    for (const globRe of globs) {
      if (globRe.test(filePath)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Matches exit_code against expected exit code numbers.
 */
export function matchExitCode(
  expected: readonly number[],
  exitCode: number | null | undefined,
): boolean {
  if (exitCode === null || exitCode === undefined || expected.length === 0) return false;
  return expected.includes(exitCode);
}

/**
 * Matches log_regex on log excerpts with bounded input length.
 */
export function matchLogRegex(
  regex: RegExp,
  log: string | null | undefined,
  maxLength: number = DEFAULT_MAX_REGEX_INPUT_LENGTH,
): boolean {
  if (!log) return false;
  const bounded = log.length > maxLength ? log.slice(0, maxLength) : log;
  return regex.test(bounded);
}

/**
 * Compiles a raw Rule object into an efficient CompiledRule.
 */
export function compileRule(rule: Rule): CompiledRule {
  const isSafety = Boolean(rule.safety ?? rule.is_safety ?? false);
  const matchers = rule.matchers ?? {};
  const specificity =
    typeof rule.specificity === 'number' ? rule.specificity : computeSpecificity(matchers);

  // Pre-process text_any
  let textAny: string[] | undefined = undefined;
  if (matchers.text_any !== undefined) {
    textAny = Array.isArray(matchers.text_any)
      ? matchers.text_any.map(String)
      : [String(matchers.text_any)];
  }

  // Pre-process text_regex
  let textRegex: RegExp | undefined = undefined;
  if (matchers.text_regex !== undefined) {
    textRegex = compileRegex(matchers.text_regex);
  }

  // Pre-process role
  let roles: string[] | undefined = undefined;
  if (matchers.role !== undefined) {
    roles = Array.isArray(matchers.role) ? matchers.role.map(String) : [String(matchers.role)];
  }

  // Pre-process url_domain
  let urlDomains: string[] | undefined = undefined;
  if (matchers.url_domain !== undefined) {
    urlDomains = Array.isArray(matchers.url_domain)
      ? matchers.url_domain.map(String)
      : [String(matchers.url_domain)];
  }

  // Pre-process url_path
  let urlPaths: (string | RegExp)[] | undefined = undefined;
  if (matchers.url_path !== undefined) {
    const rawPaths = Array.isArray(matchers.url_path) ? matchers.url_path : [matchers.url_path];
    urlPaths = rawPaths.map((p) => (p instanceof RegExp ? p : String(p)));
  }

  // Pre-process file_path_glob
  let filePathGlobs: RegExp[] | undefined = undefined;
  if (matchers.file_path_glob !== undefined) {
    const rawGlobs = Array.isArray(matchers.file_path_glob)
      ? matchers.file_path_glob
      : [matchers.file_path_glob];
    filePathGlobs = rawGlobs.map((g) => globToRegex(String(g)));
  }

  // Pre-process exit_code
  let exitCodes: number[] | undefined = undefined;
  if (matchers.exit_code !== undefined) {
    exitCodes = Array.isArray(matchers.exit_code)
      ? matchers.exit_code.map(Number)
      : [Number(matchers.exit_code)];
  }

  // Pre-process log_regex
  let logRegex: RegExp | undefined = undefined;
  if (matchers.log_regex !== undefined) {
    logRegex = compileRegex(matchers.log_regex);
  }

  return {
    id: rule.id,
    rule,
    name: rule.name,
    pack_id: rule.pack_id,
    is_safety: isSafety,
    matchers,
    output: rule.output,
    specificity,
    compiled: {
      textAny,
      textRegex,
      roles,
      urlDomains,
      urlPaths,
      filePathGlobs,
      exitCodes,
      logRegex,
    },
  };
}

/**
 * Evaluates whether an element matches the element-specific matchers of a rule.
 */
function elementMatches(
  element: SnapshotElement,
  roles: readonly string[] | undefined,
  textAny: readonly string[] | undefined,
  textRegex: RegExp | undefined,
  maxLength: number,
): boolean {
  if (roles && !matchRole(roles, element.role)) {
    return false;
  }
  if (textAny && !matchTextAny(textAny, element.text)) {
    return false;
  }
  if (textRegex && !matchTextRegex(textRegex, element.text, maxLength)) {
    return false;
  }
  return true;
}

/**
 * Evaluates a single compiled rule against a normalized snapshot.
 * ALL listed matchers in the rule must match for the rule to match.
 */
export function matchRule(
  rule: CompiledRule,
  snapshot: Snapshot,
  maxLength: number = DEFAULT_MAX_REGEX_INPUT_LENGTH,
): boolean {
  const { compiled, matchers } = rule;

  // 1. URL Domain
  if (compiled.urlDomains && !matchUrlDomain(compiled.urlDomains, snapshot.domain, snapshot.url)) {
    return false;
  }

  // 2. URL Path
  if (compiled.urlPaths && !matchUrlPath(compiled.urlPaths, snapshot.url)) {
    return false;
  }

  // 3. File Path Glob
  if (compiled.filePathGlobs && !matchFilePathGlob(compiled.filePathGlobs, snapshot.file_paths)) {
    return false;
  }

  // 4. Exit Code
  if (compiled.exitCodes && !matchExitCode(compiled.exitCodes, snapshot.exit_code)) {
    return false;
  }

  // 5. Log Regex
  if (compiled.logRegex && !matchLogRegex(compiled.logRegex, snapshot.log, maxLength)) {
    return false;
  }

  // 6. Element Matchers: role, text_any, text_regex
  const hasElementMatchers =
    compiled.roles !== undefined ||
    compiled.textAny !== undefined ||
    compiled.textRegex !== undefined;

  if (hasElementMatchers) {
    const elements = snapshot.elements ?? [];
    let matchedElement = false;

    for (const elem of elements) {
      if (elementMatches(elem, compiled.roles, compiled.textAny, compiled.textRegex, maxLength)) {
        matchedElement = true;
        break;
      }
    }

    // Fallback: if no element matched, but role was NOT required and snapshot has plain text,
    // evaluate text_any / text_regex against snapshot.text
    if (!matchedElement && compiled.roles === undefined && snapshot.text) {
      const textMatches =
        (!compiled.textAny || matchTextAny(compiled.textAny, snapshot.text)) &&
        (!compiled.textRegex || matchTextRegex(compiled.textRegex, snapshot.text, maxLength));
      if (textMatches) {
        matchedElement = true;
      }
    }

    if (!matchedElement) {
      return false;
    }
  }

  // 7. Target question constraint if specified on rule
  if (matchers.target_question_id !== undefined || matchers.question_id !== undefined) {
    const targetQId = matchers.target_question_id ?? matchers.question_id;
    const snapQId =
      (snapshot as Record<string, unknown>).question_id ??
      (snapshot as Record<string, unknown>).questionId;
    if (snapQId && snapQId !== targetQId) {
      return false;
    }
  }

  return true;
}
