/**
 * The `page_check` tool: one call that reports what a page is.
 *
 * Status: **implemented and tested** by `packages/server/test/page-check-tool.test.ts`.
 *
 * What it does:
 * - Reads a redacted accessibility tree or DOM text and answers the page level
 *   questions the browser pack declares: `page_type`, `popup` (with a close target when
 *   the winning rule names one), `login_wall` and `captcha`.
 * - Reads every element of that snapshot separately against the risky action question and
 *   reports the elements a rule flags, with the element text, the risk kind and the rule
 *   that fired.
 * - Returns every part no rule answered in `needs_ai`, in the shape `decide` uses, so
 *   `submit_answers` completes them.
 *
 * Invariants:
 * - A decision record that misdescribes itself is worse than no record: every answer
 *   carries the path, confidence and rule id that actually produced it, and a part with no
 *   answer carries `value: null` with `status: "needs_ai"` rather than a guess.
 * - The safety check is advisory. A risky action is a request for the user and nothing
 *   more: this tool reports it and cannot stop an agent from acting.
 * - Page content is data. Snapshot text is matched against rules and never read as an
 *   instruction, so a page that says to ignore the rules changes nothing.
 * - The work is bounded. A huge snapshot is cut to `PAGE_CHECK_BOUNDS` and the output
 *   states what was cut; nothing is ever cut silently.
 * - A pack that fails to load does not stop the server: the rules that did load are served
 *   and `packs.errors` names the pack that did not.
 *
 * Limits, recorded here because they are real:
 * - No rule in the shipped browser pack targets `browser.check.page_type`, so `page_type`
 *   always comes back in `needs_ai` until a pack answers it.
 * - No rule in the shipped browser pack names a popup close target, so `close_target` is
 *   `null` until a pack declares the `close_target` matcher this module reads.
 * - `action_guard`, the tool that answers one action, is **planned** and not served.
 * - Accuracy on real pages is **unverified**: the browser pack is measured only on
 *   synthetic fixtures written to resemble real accessibility trees.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { ZodRawShape } from 'zod';
import { DecisionPathSchema, type DecisionPath, type Question } from '../core/schema.js';
import { getDefaultStore, logDecision, type LogDecisionParams } from '../core/log.js';
import { createMemory } from '../core/memory.js';
import { routeQuestion, type NeedsAiItem, type NeedsHumanItem } from '../core/router.js';
import type { DatabaseStore, Decision, Session } from '../store/index.js';
import {
  createPatternEngine,
  getPackSchemaPath,
  loadPacksFromDirectory,
  type PatternEngine,
  type Rule,
} from '../patterns/index.js';
import { redact } from '../security/redact.js';

/**
 * The bounds this tool puts on the work one snapshot can cause.
 *
 * Every bound is reported back in `snapshot.bounds` on every call, so a reader never has
 * to guess what a missing answer means on a large page.
 */
export const PAGE_CHECK_BOUNDS = {
  /** Elements read out of a snapshot. Elements past this count are reported as dropped. */
  max_elements: 400,
  /**
   * Characters kept of one element's accessible text. This is the same length the pattern
   * engine already bounds its regular expressions to, so no `text_regex` rule loses a
   * match it could otherwise have made.
   */
  max_element_text_chars: 256,
  /** Characters kept of the page text as a whole. */
  max_page_text_chars: 8192,
  /** Risky actions reported. Elements past this count are reported as dropped. */
  max_risky_actions: 50,
} as const;

export type AnswerStatus = 'answered' | 'needs_ai' | 'needs_human';

/** The three risky families the browser pack declares, in rule id order. */
export const RISKY_KINDS = ['payment', 'destructive', 'outbound'] as const;
export type RiskyKind = (typeof RISKY_KINDS)[number];

/**
 * Option ids of the page type question.
 *
 * No rule in the shipped browser pack targets this question, so the page type always comes
 * back in `needs_ai`. The ids are this server's contract for a pack that does target it: a
 * rule whose output value is not one of them is not accepted as an answer to it.
 */
export const PAGE_TYPE_OPTIONS = [
  'unknown',
  'search_results',
  'listing',
  'product_detail',
  'article',
  'form',
  'checkout',
  'account',
  'error',
] as const;

/**
 * The canonical browser questions.
 *
 * Their ids are the `target_question_id` the browser pack rules declare, so a rule answers
 * exactly one of these and no other. Their option ids are the ones the rules' distributions
 * are written over.
 */
export const PAGE_TYPE_QUESTION: Question = {
  id: 'browser.check.page_type',
  type: 'choice',
  text: 'What kind of page is this?',
  options: PAGE_TYPE_OPTIONS.map((id) => ({ id })),
};

export const POPUP_KIND_QUESTION: Question = {
  id: 'browser.check.popup_kind',
  type: 'choice',
  text: 'What kind of popup is on this page, if any?',
  options: [{ id: 'none' }, { id: 'cookie_banner' }, { id: 'promo' }],
};

export const LOGIN_WALL_QUESTION: Question = {
  id: 'browser.check.login_wall',
  type: 'check',
  text: 'Is a login wall in the way?',
};

export const CAPTCHA_QUESTION: Question = {
  id: 'browser.check.captcha',
  type: 'check',
  text: 'Is a human verification widget on this page?',
};

export const RISKY_ACTION_QUESTION: Question = {
  id: 'browser.check.risky_action',
  type: 'choice',
  text: 'Should the agent ask the user before taking this action?',
  options: [{ id: 'allow' }, { id: 'ask_user' }, { id: 'block' }],
};

/** Every question id this tool answers, in the order it answers them. */
export const PAGE_CHECK_QUESTION_IDS = [
  PAGE_TYPE_QUESTION.id,
  POPUP_KIND_QUESTION.id,
  LOGIN_WALL_QUESTION.id,
  CAPTCHA_QUESTION.id,
  RISKY_ACTION_QUESTION.id,
] as const;

const CANONICAL_QUESTION_IDS: ReadonlySet<string> = new Set(PAGE_CHECK_QUESTION_IDS);

export interface PageCheckAnswer {
  /** The canonical question id this part answers. */
  question_id: string;
  /** The typed answer, or `null` when no rule answered this part. */
  value: string | boolean | null;
  /** Whether a rule answered, or the part is waiting on the agent or on a person. */
  status: AnswerStatus;
  /** The confidence of the answer, or `0` when there is no answer. */
  confidence: number;
  /** The path that actually produced the answer. */
  path: DecisionPath;
  /** The rule that produced the answer, or `null` when none did. */
  pattern_id: string | null;
  latency_ms: number;
  decision_id: string;
  /** Why a part needs a person, when it does. */
  reason: string | null;
}

export interface PopupCloseTarget {
  role: string | null;
  text: string;
  /** The rule that named this close target. */
  rule_id: string;
}

export interface PopupCheckAnswer extends PageCheckAnswer {
  /** The popup kind, the same value as `value`, named for the caller. */
  kind: string | null;
  /** The close control, when the winning rule names one. */
  close_target: PopupCloseTarget | null;
  /** The rule that named the close target, or `null` when no rule did. */
  close_target_rule_id: string | null;
}

export interface RiskyActionReport {
  /** The risky family, or `null` when the rule that fired is not in one of the three. */
  risk: RiskyKind | null;
  /** The value the rule answered, which is `ask_user` or `block`. */
  action: string;
  element_role: string | null;
  /** The accessible text of the element, redacted. */
  element_text: string;
  /** The rule that flagged the element. */
  rule_id: string;
  confidence: number;
  path: 'pattern';
  /** True when the rule is an advisory safety rule. */
  is_safety: boolean;
  latency_ms: number;
  decision_id: string;
}

export interface SnapshotReport {
  /** Whether the snapshot arrived as an element list, as tree text, or as nothing. */
  source: 'elements' | 'text' | 'empty';
  url: string | null;
  /** Elements read and matched against. */
  elements_considered: number;
  /** Elements left out because the element bound was reached. */
  elements_dropped: number;
  /** Entries that were not an element with a role or a text. */
  elements_ignored: number;
  /** Characters of element text left out because the text bound was reached. */
  element_text_chars_dropped: number;
  /** Characters of page text left out because the text bound was reached. */
  page_text_chars_dropped: number;
  /** Risky actions left out because the report bound was reached. */
  risky_actions_dropped: number;
  /** True when anything at all was cut. */
  truncated: boolean;
  bounds: typeof PAGE_CHECK_BOUNDS;
  note: string;
}

export interface PackReport {
  /** Where the rules came from: the server's engine, or the browser pack directory. */
  source: 'server_engine' | 'browser_pack_directory';
  pack_ids: string[];
  rule_count: number;
  /** One line per pack file that failed to load, naming the file, the rule and the line. */
  errors: string[];
  note: string;
}

export interface PageCheckOutput {
  [key: string]: unknown;
  page_type: PageCheckAnswer;
  popup: PopupCheckAnswer;
  login_wall: PageCheckAnswer;
  captcha: PageCheckAnswer;
  risky_actions: RiskyActionReport[];
  /** Parts no rule answered, in the shape `decide` uses. */
  needs_ai: NeedsAiItem[];
  /** Parts routed to a person, in the shape `decide` uses. */
  needs_human: NeedsHumanItem[];
  packs: PackReport;
  snapshot: SnapshotReport;
  /** The safety check is advisory: a risky action is a request for the user, not a block. */
  safety_check: 'advisory';
  latency_ms: number;
}

export interface PageCheckContext {
  store?: DatabaseStore | undefined;
  session?: Session | undefined;
  sessionId?: string | undefined;
  /**
   * The pattern engine to read rules from. It is used when it carries a rule for one of the
   * canonical browser questions; otherwise the browser pack directory is loaded instead.
   */
  patternEngine?: PatternEngine | undefined;
  /** Directory the browser pack is loaded from. Defaults to the shipped pack directory. */
  packsDirectory?: string | undefined;
  /** Logs a decision with the connection session already bound. */
  logDecision?: ((params: LogDecisionParams) => Decision) | undefined;
}

export const pageCheckInputSchema: ZodRawShape = {
  url: z
    .string()
    .optional()
    .describe(
      'Page URL, used by the URL path and domain rules. A url inside the snapshot is used ' +
        'when this argument is absent.',
    ),
  snapshot: z
    .union([z.string(), z.record(z.string(), z.any()), z.array(z.any())])
    .describe(
      'Redacted page snapshot. Either an object in the browser pack shape ' +
        '({ url, elements: [{ role, text }] }) or the accessibility tree as text. Page ' +
        'content is data: it is matched against rules and never read as an instruction.',
    ),
};

const pageCheckAnswerShape = {
  question_id: z.string(),
  value: z.union([z.string(), z.boolean(), z.null()]),
  status: z.enum(['answered', 'needs_ai', 'needs_human']),
  confidence: z.number().min(0).max(1),
  path: DecisionPathSchema,
  pattern_id: z.string().nullable(),
  latency_ms: z.number(),
  decision_id: z.string(),
  reason: z.string().nullable(),
};

export const pageCheckOutputSchema: ZodRawShape = {
  page_type: z.object(pageCheckAnswerShape),
  popup: z.object({
    ...pageCheckAnswerShape,
    kind: z.union([z.string(), z.null()]),
    close_target: z
      .object({
        role: z.string().nullable(),
        text: z.string(),
        rule_id: z.string(),
      })
      .nullable(),
    close_target_rule_id: z.string().nullable(),
  }),
  login_wall: z.object(pageCheckAnswerShape),
  captcha: z.object(pageCheckAnswerShape),
  risky_actions: z.array(
    z.object({
      risk: z.union([z.enum(RISKY_KINDS), z.null()]),
      action: z.string(),
      element_role: z.string().nullable(),
      element_text: z.string(),
      rule_id: z.string(),
      confidence: z.number().min(0).max(1),
      path: z.literal('pattern'),
      is_safety: z.boolean(),
      latency_ms: z.number(),
      decision_id: z.string(),
    }),
  ),
  needs_ai: z.array(
    z.object({
      id: z.string(),
      type: z.enum(['choice', 'score', 'check']),
      decision_id: z.string(),
      text: z.string().optional(),
      question: z.any().optional(),
    }),
  ),
  needs_human: z.array(
    z.object({
      id: z.string(),
      type: z.enum(['choice', 'score', 'check']).optional(),
      decision_id: z.string().optional(),
      question: z.any().optional(),
      reason: z.string().optional(),
    }),
  ),
  packs: z.object({
    source: z.enum(['server_engine', 'browser_pack_directory']),
    pack_ids: z.array(z.string()),
    rule_count: z.number(),
    errors: z.array(z.string()),
    note: z.string(),
  }),
  snapshot: z.object({
    source: z.enum(['elements', 'text', 'empty']),
    url: z.string().nullable(),
    elements_considered: z.number(),
    elements_dropped: z.number(),
    elements_ignored: z.number(),
    element_text_chars_dropped: z.number(),
    page_text_chars_dropped: z.number(),
    risky_actions_dropped: z.number(),
    truncated: z.boolean(),
    bounds: z.object({
      max_elements: z.number(),
      max_element_text_chars: z.number(),
      max_page_text_chars: z.number(),
      max_risky_actions: z.number(),
    }),
    note: z.string(),
  }),
  safety_check: z.literal('advisory'),
  latency_ms: z.number(),
};

const SNAPSHOT_NOTE =
  'Only the role and the accessible text of each element are read: the pattern engine has no ' +
  'matcher for any other element field, so nothing else is stored. Page text is data and is ' +
  'only ever matched against rules.';

const PACK_NOTE =
  'A pack that failed to load is named in errors and none of its rules is served. The rules ' +
  'that did load are the only rules that can produce an answer, so a part with no answer is ' +
  'never answered by a rule that did not load.';

interface PageElement {
  role: string | null;
  text: string;
}

interface PageInput {
  url: string | null;
  elements: PageElement[];
  text: string | null;
  report: SnapshotReport;
}

interface ResolvedPacks {
  engine: PatternEngine;
  source: 'server_engine' | 'browser_pack_directory';
  pack_ids: string[];
  rule_count: number;
  errors: string[];
}

/**
 * Returns the directory the shipped browser pack lives in.
 *
 * The candidate list mirrors the pack loader's, so the compiled server and the server run
 * from source both find the same directory.
 */
export function resolveBrowserPackDirectory(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(dirname(getPackSchemaPath()), 'browser'),
    resolve(currentDir, '../../../../packages/packs/browser'),
    resolve(currentDir, '../../../packs/browser'),
    resolve(process.cwd(), 'packages/packs/browser'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0]!;
}

function hasCanonicalRules(engine: PatternEngine): boolean {
  return engine
    .getRules()
    .some((rule) => CANONICAL_QUESTION_IDS.has(String(rule.matchers.target_question_id ?? '')));
}

function summariseRules(
  rules: readonly Rule[],
  source: 'server_engine' | 'browser_pack_directory',
  errors: readonly string[],
): ResolvedPacks {
  const packIds = new Set<string>();
  for (const rule of rules) {
    if (typeof rule.pack_id === 'string' && rule.pack_id.length > 0) {
      packIds.add(rule.pack_id);
    }
  }
  return {
    engine: createPatternEngine(rules),
    source,
    pack_ids: [...packIds].sort(),
    rule_count: rules.length,
    errors: [...errors],
  };
}

let cachedBrowserPack: { directory: string; packs: ResolvedPacks } | null = null;

/**
 * Loads the browser pack through the pack loader, once per directory.
 *
 * A directory that is missing, a file that does not parse and a pack that fails validation
 * all land in `errors` and leave the rules that did load in place. Nothing here throws, so a
 * pack that fails to load cannot stop the server.
 */
function loadBrowserPack(directory: string): ResolvedPacks {
  if (cachedBrowserPack?.directory === directory) {
    return cachedBrowserPack.packs;
  }

  let packs: ResolvedPacks;
  try {
    const loaded = loadPacksFromDirectory(directory);
    packs = summariseRules(
      loaded.rules,
      'browser_pack_directory',
      loaded.errors.map((e) => e.formatted),
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    packs = summariseRules([], 'browser_pack_directory', [
      `The pattern pack schema or directory at ${directory} could not be read: ${message}`,
    ]);
  }

  cachedBrowserPack = { directory, packs };
  return packs;
}

/**
 * Resolves the rules this tool answers from.
 *
 * The server's engine is used when it carries a rule for one of the canonical browser
 * questions, which is the case once the server has loaded the browser pack. Otherwise the
 * browser pack directory is loaded here, so the tool also answers when it is called without
 * an engine.
 */
export function resolvePageCheckPacks(context: PageCheckContext = {}): ResolvedPacks {
  const provided = context.patternEngine;
  if (provided && hasCanonicalRules(provided)) {
    return summariseRules(provided.getRules(), 'server_engine', []);
  }
  return loadBrowserPack(context.packsDirectory ?? resolveBrowserPackDirectory());
}

/** Reads the risky family a rule id names, or `null` when it names none of the three. */
export function riskyKindFromRuleId(ruleId: string): RiskyKind | null {
  for (const kind of RISKY_KINDS) {
    if (ruleId.startsWith(`browser.risky.${kind}.`)) {
      return kind;
    }
  }
  return null;
}

function hostnameOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * One line of an accessibility tree: an optional list marker, an optional element
 * reference, a role in lower case and the accessible name that follows it, separated by a
 * colon or by whitespace. A line that carries only a role is an element with no name.
 *
 * A line whose first word is not lower case is prose rather than an element, so it is left
 * to the page text instead of becoming an element with a role nobody wrote.
 */
const ACCESSIBILITY_LINE =
  /^\s*(?:[-*+]\s*)?(?:\[([^\]]{1,64})\]\s*)?([a-z][a-z0-9_-]{0,32})(?:\s*:\s*(.*)|\s+(.*))?\s*$/;

function unquote(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseAccessibilityTree(
  text: string,
  bounds: typeof PAGE_CHECK_BOUNDS,
): { elements: PageElement[]; ignored: number; dropped: number } {
  const elements: PageElement[] = [];
  let ignored = 0;
  let dropped = 0;

  for (const line of text.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    const match = ACCESSIBILITY_LINE.exec(line);
    if (!match) {
      ignored += 1;
      continue;
    }
    if (elements.length >= bounds.max_elements) {
      dropped += 1;
      continue;
    }
    elements.push({ role: match[2] ?? null, text: unquote(match[3] ?? match[4] ?? '') });
  }

  return { elements, ignored, dropped };
}

function boundedText(text: string, limit: number): { kept: string; droppedChars: number } {
  if (text.length <= limit) {
    return { kept: text, droppedChars: 0 };
  }
  return { kept: text.slice(0, limit), droppedChars: text.length - limit };
}

function elementFrom(raw: unknown): PageElement | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const role = typeof record.role === 'string' ? record.role : null;
  const text = typeof record.text === 'string' ? record.text : null;
  if (role === null && text === null) {
    return null;
  }
  return { role, text: text ?? '' };
}

function readPageInput(args: Record<string, unknown>, bounds: typeof PAGE_CHECK_BOUNDS): PageInput {
  const snapshot = args.snapshot;
  const requestedUrl = typeof args.url === 'string' ? args.url.trim() : '';
  const boundsReport = {
    ...bounds,
  };
  let source: SnapshotReport['source'] = 'empty';
  let url: string | null = requestedUrl.length > 0 ? requestedUrl : null;
  let elements: PageElement[] = [];
  let ignored = 0;
  let dropped = 0;
  let elementTextCharsDropped = 0;
  let rawText: string | null = null;

  if (typeof snapshot === 'string') {
    source = 'text';
    rawText = snapshot;
    const parsed = parseAccessibilityTree(snapshot, bounds);
    elements = parsed.elements;
    ignored = parsed.ignored;
    dropped = parsed.dropped;
  } else if (Array.isArray(snapshot)) {
    source = 'elements';
    for (const entry of snapshot) {
      const element = elementFrom(entry);
      if (element === null) {
        ignored += 1;
        continue;
      }
      if (elements.length >= bounds.max_elements) {
        dropped += 1;
        continue;
      }
      elements.push(element);
    }
  } else if (typeof snapshot === 'object' && snapshot !== null) {
    const record = snapshot as Record<string, unknown>;
    source = 'elements';
    if (url === null && typeof record.url === 'string' && record.url.trim().length > 0) {
      url = record.url.trim();
    }
    if (typeof record.text === 'string') {
      rawText = record.text;
    }
    const rawElements = Array.isArray(record.elements) ? record.elements : [];
    for (const entry of rawElements) {
      const element = elementFrom(entry);
      if (element === null) {
        ignored += 1;
        continue;
      }
      if (elements.length >= bounds.max_elements) {
        dropped += 1;
        continue;
      }
      elements.push(element);
    }
  }

  const boundedElements: PageElement[] = [];
  for (const element of elements) {
    const boundedElementText = boundedText(element.text, bounds.max_element_text_chars);
    elementTextCharsDropped += boundedElementText.droppedChars;
    boundedElements.push({ role: element.role, text: boundedElementText.kept });
  }

  const boundedPageText =
    rawText === null
      ? { kept: null, droppedChars: 0 }
      : boundedText(rawText, bounds.max_page_text_chars);

  const report: SnapshotReport = {
    source,
    url,
    elements_considered: boundedElements.length,
    elements_dropped: dropped,
    elements_ignored: ignored,
    element_text_chars_dropped: elementTextCharsDropped,
    page_text_chars_dropped: boundedPageText.droppedChars,
    risky_actions_dropped: 0,
    truncated:
      dropped > 0 || ignored > 0 || elementTextCharsDropped > 0 || boundedPageText.droppedChars > 0,
    bounds: boundsReport,
    note: SNAPSHOT_NOTE,
  };

  return {
    url,
    elements: boundedElements,
    text: boundedPageText.kept,
    report,
  };
}

function answerValue(value: string | number | boolean): string | boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return null;
  }
  return value.length > 0 ? value : null;
}

function routedAnswer(
  question: Question,
  routed: ReturnType<typeof routeQuestion>,
): { answer: PageCheckAnswer; needsAi?: NeedsAiItem; needsHuman?: NeedsHumanItem } {
  if (routed.status === 'answered') {
    return {
      answer: {
        question_id: question.id,
        value: answerValue(routed.answer.value),
        status: 'answered',
        confidence: routed.answer.confidence,
        path: routed.answer.path,
        pattern_id: routed.answer.pattern_id ?? null,
        latency_ms: routed.answer.latency_ms,
        decision_id: routed.answer.decision_id,
        reason: null,
      },
    };
  }

  if (routed.status === 'needs_ai') {
    return {
      answer: {
        question_id: question.id,
        value: null,
        status: 'needs_ai',
        confidence: 0,
        path: 'ai',
        pattern_id: null,
        latency_ms: routed.decision.latency_ms,
        decision_id: routed.needsAi.decision_id,
        reason: null,
      },
      needsAi: routed.needsAi,
    };
  }

  return {
    answer: {
      question_id: question.id,
      value: null,
      status: 'needs_human',
      confidence: routed.decision.confidence,
      path: routed.decision.path,
      pattern_id: routed.decision.pattern_id ?? null,
      latency_ms: routed.decision.latency_ms,
      decision_id: routed.needsHuman.decision_id ?? routed.decision.id,
      reason: routed.needsHuman.reason ?? null,
    },
    needsHuman: routed.needsHuman,
  };
}

/** Reads the accessible texts a rule declares as the popup's close control. */
function closeTargetTexts(rule: Rule | undefined): string[] {
  if (!rule) {
    return [];
  }
  const declared = rule.matchers.close_target;
  if (typeof declared === 'string') {
    return [declared];
  }
  if (Array.isArray(declared)) {
    return declared.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

function findCloseTarget(
  rule: Rule | undefined,
  elements: readonly PageElement[],
): PopupCloseTarget | null {
  const texts = closeTargetTexts(rule);
  if (texts.length === 0) {
    return null;
  }
  const wanted = texts.map((text) => text.toLowerCase()).filter((text) => text.length > 0);
  if (wanted.length === 0) {
    return null;
  }
  for (const element of elements) {
    const text = element.text.toLowerCase();
    if (text.length === 0) {
      continue;
    }
    if (wanted.some((candidate) => text.includes(candidate))) {
      return {
        role: element.role,
        text: redact(element.text),
        rule_id: rule?.id ?? '',
      };
    }
  }
  return null;
}

/**
 * Runs the `page_check` tool logic.
 *
 * Every part is answered by a rule of the loaded packs or returned in `needs_ai`, and every
 * part is written to the decision log with the path, confidence and rule id that produced
 * it.
 */
export async function executePageCheck(
  args: Record<string, unknown>,
  context: PageCheckContext = {},
): Promise<PageCheckOutput> {
  const startedAt = performance.now();
  const store = context.store ?? getDefaultStore();
  const memory = createMemory(store);
  const session = context.session ?? context.sessionId ?? null;
  const packs = resolvePageCheckPacks(context);
  const page = readPageInput(args, PAGE_CHECK_BOUNDS);
  const domain = hostnameOf(page.url);
  const input: Record<string, unknown> = {
    url: page.url,
    elements: page.elements,
    text: page.text,
  };

  const log = context.logDecision
    ? context.logDecision
    : (params: LogDecisionParams): Decision => logDecision({ ...params, store, session });

  const routed = {
    page_type: routeQuestion({
      question: PAGE_TYPE_QUESTION,
      input,
      memory,
      store,
      session,
      url: page.url,
      domain,
      patternEngine: packs.engine,
    }),
    popup: routeQuestion({
      question: POPUP_KIND_QUESTION,
      input,
      memory,
      store,
      session,
      url: page.url,
      domain,
      patternEngine: packs.engine,
    }),
    login_wall: routeQuestion({
      question: LOGIN_WALL_QUESTION,
      input,
      memory,
      store,
      session,
      url: page.url,
      domain,
      patternEngine: packs.engine,
    }),
    captcha: routeQuestion({
      question: CAPTCHA_QUESTION,
      input,
      memory,
      store,
      session,
      url: page.url,
      domain,
      patternEngine: packs.engine,
    }),
  };

  const parts = {
    page_type: routedAnswer(PAGE_TYPE_QUESTION, routed.page_type),
    popup: routedAnswer(POPUP_KIND_QUESTION, routed.popup),
    login_wall: routedAnswer(LOGIN_WALL_QUESTION, routed.login_wall),
    captcha: routedAnswer(CAPTCHA_QUESTION, routed.captcha),
  };

  const rulesById = new Map<string, Rule>(packs.engine.getRules().map((rule) => [rule.id, rule]));
  const popupRule =
    parts.popup.answer.pattern_id === null
      ? undefined
      : rulesById.get(parts.popup.answer.pattern_id);
  const closeTarget = findCloseTarget(popupRule, page.elements);

  const riskyActions: RiskyActionReport[] = [];
  let riskyActionsDropped = 0;

  for (const element of page.elements) {
    const elementStartedAt = performance.now();
    const hit = packs.engine.matchForQuestion(
      { url: page.url, elements: [element] },
      RISKY_ACTION_QUESTION,
      { threshold: 0, url: page.url, domain },
    );
    if (!hit) {
      continue;
    }
    const action = typeof hit.output.value === 'string' ? hit.output.value : null;
    if (action === null || action === 'allow') {
      continue;
    }

    const latencyMs = Number((performance.now() - elementStartedAt).toFixed(3));
    const logged = log({
      question: RISKY_ACTION_QUESTION,
      answer: {
        value: action,
        ...(hit.output.distribution ? { distribution: hit.output.distribution } : {}),
      },
      path: 'pattern',
      confidence: hit.output.confidence,
      latencyMs,
      input: { url: page.url, element },
      url: page.url,
      domain,
      patternId: hit.pattern_id,
      isSafety: hit.is_safety,
      needsReview: hit.is_safety,
    });

    // The decision is logged above for every flagged element; only the response is bounded.
    if (riskyActions.length >= PAGE_CHECK_BOUNDS.max_risky_actions) {
      riskyActionsDropped += 1;
      continue;
    }

    riskyActions.push({
      risk: riskyKindFromRuleId(hit.pattern_id),
      action,
      element_role: element.role,
      element_text: redact(element.text),
      rule_id: hit.pattern_id,
      confidence: hit.output.confidence,
      path: 'pattern',
      is_safety: hit.is_safety,
      latency_ms: latencyMs,
      decision_id: logged.id,
    });
  }

  const needsAi: NeedsAiItem[] = [];
  const needsHuman: NeedsHumanItem[] = [];
  for (const part of [parts.page_type, parts.popup, parts.login_wall, parts.captcha]) {
    if (part.needsAi) {
      needsAi.push(part.needsAi);
    }
    if (part.needsHuman) {
      needsHuman.push(part.needsHuman);
    }
  }

  return {
    page_type: parts.page_type.answer,
    popup: {
      ...parts.popup.answer,
      kind: typeof parts.popup.answer.value === 'string' ? parts.popup.answer.value : null,
      close_target: closeTarget,
      close_target_rule_id: closeTarget?.rule_id ?? null,
    },
    login_wall: parts.login_wall.answer,
    captcha: parts.captcha.answer,
    risky_actions: riskyActions,
    needs_ai: needsAi,
    needs_human: needsHuman,
    packs: {
      source: packs.source,
      pack_ids: packs.pack_ids,
      rule_count: packs.rule_count,
      errors: packs.errors,
      note: PACK_NOTE,
    },
    snapshot: {
      ...page.report,
      risky_actions_dropped: riskyActionsDropped,
      truncated: page.report.truncated || riskyActionsDropped > 0,
    },
    safety_check: 'advisory',
    latency_ms: Number((performance.now() - startedAt).toFixed(3)),
  };
}
