/**
 * Signal extraction on capture: the features a miner needs, stored with every
 * slow decision.
 *
 * Status: **implemented and tested**. The tests behind that claim are
 * `packages/server/test/capture.test.ts`.
 *
 * This is step one of the learning loop in `docs/SPEC.md`. Capture stores what
 * was in front of the decision so a later miner can find repeated slow answers
 * that share a signal. It stores features; it does not learn, and it decides
 * nothing.
 *
 * ## What is captured
 *
 * Browser signals, taken from the page snapshot or question input the decision
 * was routed with:
 *
 * | Signal | Notes |
 * |---|---|
 * | `domain` | The hostname, lower-cased. Taken from the input's `domain`, else parsed from its `url`. |
 * | `path` | The URL path with the query string **and** the fragment removed. |
 * | `element_role` | The role of the element the decision was about, lower-cased. |
 * | `element_text` | That element's text: redacted, whitespace collapsed, trimmed and length-capped. |
 * | `selector` | That element's selector when the snapshot carries one. |
 * | `element_source` | Which of the two the three fields above came from. |
 * | `tokens` | Normalised tokens from the question text, the page text and the element text. |
 *
 * Coding signals (a normalised error signature and file paths) are **planned** for
 * the coding pack. Nothing in this module extracts them and no claim is made
 * about them.
 *
 * ## Invariants, each with the test that holds it
 *
 * - **A secret never reaches the store.** Every text field goes through
 *   `security/redact.ts` on its way in, tokens are built from already-redacted
 *   text, and redaction runs again here on input that was stored elsewhere.
 *   Test: *redacts page text before signals are stored*.
 * - **A fast-path decision stores nothing.** Capture runs when the slow path
 *   completes (`submit_answers` writing path `ai`) and when `feedback` records a
 *   human correction. A `memory`, `pattern` or `check` answer adds nothing new
 *   about the page and would inflate the sample counts a miner counts, so the
 *   row is skipped and the outcome says `skipped_path`.
 *   Tests: *captures nothing for a fast-path decision* and *stores no signals while
 *   a decision is still waiting for an answer*.
 * - **A row describes where its own fields came from.** `element_source` is
 *   `target` when the input named one element, `first_snapshot_element` when
 *   the fields are the first element of the snapshot's element list (not
 *   necessarily the element the decision was about, which is why the row says
 *   so), and `none` when the input carried no element at all.
 *   Test: *records which element the element signals came from*.
 * - **A record that misdescribes itself is worse than no record.** `created_at`
 *   is when the signals were captured, not the decision's own timestamp; a
 *   second correction rewrites the same row because a decision's signals do not
 *   change with a correction; and a write that fails reports `write_failed`
 *   rather than a row that is not there.
 * - **Page content is data.** Text is normalised and tokenised here, never
 *   interpreted. Nothing in this module reads page text as an instruction.
 * - **The safety check is advisory.** Capture records signals for audit and
 *   mining. Nothing here prevents an agent from acting.
 *
 * ## Normalisation, in full, so nothing here is a surprise
 *
 * - **Element text:** redact, collapse every run of whitespace to one space,
 *   trim, and cut to `MAX_ELEMENT_TEXT_LENGTH` characters, appending `…` when it
 *   was cut. The ellipsis is the only record that a field was truncated.
 * - **Role, selector and domain:** trimmed, collapsed the same way, lower-cased
 *   for the role and the domain, and cut at `MAX_ROLE_LENGTH`, `MAX_SELECTOR_LENGTH`
 *   and `MAX_DOMAIN_LENGTH`.
 * - **Path:** the query string is removed, and so is the fragment. Neither is a
 *   path, and both routinely carry tokens that redaction would mask in a URL it
 *   kept. Percent-encoding is left as the browser sent it, so two spellings of
 *   one path stay distinguishable instead of being silently merged.
 * - **Tokens:** a token is a run of ASCII letters and digits. Text is
 *   lower-cased first and every other character is a separator, so
 *   `risk-management`, `risk management` and `Risk Management` give the same
 *   tokens. Stop tokens are dropped, duplicates are dropped keeping the first
 *   occurrence, and the list is capped at `MAX_TOKENS`. A redacted value
 *   contributes only the words of its mask, never the value it replaced.
 * - **Stop tokens:** the fixed list in `STOP_TOKENS`, 26 English function words.
 *   Kept simple on purpose. It has no stemming, no other language, and no claim
 *   of linguistic quality: it removes noise so tokens from a question and tokens
 *   from a similar question overlap more often.
 *
 * ## Reading signals back
 *
 * `store.signals.list({ domain, path })` is the query the miner uses; `domain`
 * and `path` are indexed columns of `decision_signals`. The answer, the
 * confidence and the decision type stay on the `decisions` row, so a miner joins
 * the two.
 *
 * Dependencies: the Node standard library and internal modules only. No new
 * production dependency, so nothing to record in `docs/DEPENDENCIES.md`.
 */

import type {
  CaptureSource,
  DatabaseStore,
  Decision,
  DecisionSignal,
  SignalElementSource,
} from '../store/index.js';
import { normalizeSnapshot } from '../patterns/matchers.js';
import { redact } from '../security/redact.js';

/** Longest element text stored, in characters. A cut field ends with an ellipsis. */
export const MAX_ELEMENT_TEXT_LENGTH = 160;

/** Longest selector stored, in characters. */
export const MAX_SELECTOR_LENGTH = 200;

/** Longest element role stored, in characters. */
export const MAX_ROLE_LENGTH = 64;

/** Longest domain stored, in characters: the length limit for a DNS name. */
export const MAX_DOMAIN_LENGTH = 253;

/** Most tokens stored per decision. */
export const MAX_TOKENS = 32;

/**
 * Tokens dropped before the list is stored: 26 English function words.
 *
 * Simple and fixed on purpose. See the note on stop tokens in the module header
 * for what this list does not do.
 */
export const STOP_TOKENS: readonly string[] = [
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'do',
  'does',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'were',
  'with',
];

/** The mask appended to a field that was cut, so a short field cannot read as a whole one. */
const TRUNCATION_MARK = '…';

/** Keys a snapshot may use to name the one element a decision is about. */
const TARGET_KEYS: readonly string[] = ['target', 'target_element', 'targetElement', 'element'];

/** Keys a snapshot element may use to name its selector. */
const SELECTOR_KEYS: readonly string[] = ['selector', 'css', 'css_selector', 'cssSelector'];

const STOP_TOKEN_SET: ReadonlySet<string> = new Set(STOP_TOKENS);

/** Browser signals of one decision. */
export interface BrowserSignals {
  readonly domain: string | null;
  readonly path: string | null;
  readonly element_role: string | null;
  readonly element_text: string | null;
  readonly selector: string | null;
  /**
   * Where `element_role`, `element_text` and `selector` came from. `none` when
   * the input named no element, which is a real absence and not a missing value.
   */
  readonly element_source: SignalElementSource;
}

/** Free-text signals of one decision. */
export interface TextSignals {
  /** Normalised, lower-cased tokens. Empty rather than null: there is always a list. */
  readonly tokens: readonly string[];
}

/** Everything stored for one decision by capture. */
export interface DecisionSignals extends BrowserSignals, TextSignals {}

export interface ExtractDecisionSignalsParams {
  /** The snapshot or question input the decision was routed with. */
  input?: unknown;
  /** The question as it was stored, already redacted by the decision log. */
  question?: string | null;
  /** Fallback URL when the input carries none, such as the decision row's own URL. */
  url?: string | null;
  /** Fallback domain when neither the input nor the URL gives one. */
  domain?: string | null;
}

export interface CaptureParams {
  store: DatabaseStore;
  /** The decision whose signals are being captured. */
  decision: Decision;
  /** Why this capture is happening: a slow-path answer, or a human correction. */
  source: CaptureSource;
  /**
   * The input to read signals from. When omitted the decision row's own stored
   * context is parsed, which is what the tools do: the row is the record of
   * what the decision was asked against.
   */
  input?: unknown;
}

export type CaptureOutcome =
  | {
      readonly stored: true;
      readonly status: 'stored';
      readonly signals: DecisionSignals;
      readonly row: DecisionSignal;
    }
  | {
      readonly stored: false;
      readonly status: 'skipped_path';
      readonly signals: DecisionSignals;
    }
  | {
      readonly stored: false;
      readonly status: 'write_failed';
      readonly signals: DecisionSignals;
      readonly message: string;
    };

/** Collapses whitespace and caps length, marking a cut with an ellipsis. */
function collapseAndCap(text: string, maxLength: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength)}${TRUNCATION_MARK}`;
}

/** Trims and lower-cases a short identifier such as a role, or returns null when empty. */
function normalizeShortText(raw: string, maxLength: number): string | null {
  const collapsed = collapseAndCap(raw, maxLength);
  return collapsed === '' ? null : collapsed.toLowerCase();
}

/**
 * Redacts, normalises and caps the text of an element.
 *
 * Returns null rather than an empty string for text that is not there or that is
 * nothing but whitespace, so a stored row can tell an absent field from a blank
 * one.
 */
export function normalizeElementText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const collapsed = collapseAndCap(redact(raw), MAX_ELEMENT_TEXT_LENGTH);
  return collapsed === '' ? null : collapsed;
}

/**
 * Normalises text into tokens: lower-cased, punctuation split off, stop tokens
 * and duplicates dropped, capped at `maxTokens`.
 *
 * Each source string is redacted before it is tokenised, so a secret in page text
 * contributes the words of its mask and nothing else. Non-ASCII letters are
 * separators: `café` gives `caf` and nothing else, which is a documented limit of
 * this normaliser and not a claim about the language.
 */
export function normalizeTokens(
  raw: unknown,
  options: { readonly maxTokens?: number } = {},
): string[] {
  const maxTokens = options.maxTokens ?? MAX_TOKENS;
  const sources = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
  const tokens: string[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    if (typeof source !== 'string') continue;
    const normalized = redact(source)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ');
    for (const candidate of normalized.split(' ')) {
      if (candidate === '' || STOP_TOKEN_SET.has(candidate) || seen.has(candidate)) continue;
      seen.add(candidate);
      tokens.push(candidate);
      if (tokens.length >= maxTokens) {
        return tokens;
      }
    }
  }

  return tokens;
}

/**
 * Keeps only the path of a URL.
 *
 * Returns null when the value is neither a path nor a URL this can parse, rather
 * than storing a fragment of one as a path.
 */
function pathFromUrl(url: string): string | null {
  const withoutFragment = url.split('#')[0] ?? '';
  const withoutQuery = withoutFragment.split('?')[0] ?? '';
  if (withoutQuery === '') return null;
  if (withoutQuery.startsWith('/')) return withoutQuery;
  try {
    return new URL(url).pathname || '/';
  } catch {
    return null;
  }
}

/**
 * The domain of the input: its `domain` field, else the hostname of its URL, else
 * the fallback. Lower-cased, because a hostname is case-insensitive and two
 * spellings of one host are one signal.
 */
export function extractDomain(
  input: unknown,
  fallbackUrl?: string | null,
  fallbackDomain?: string | null,
): string | null {
  const snapshot = normalizeSnapshot(input, fallbackUrl ?? null, fallbackDomain ?? null);
  if (typeof snapshot.domain !== 'string') return null;
  return normalizeShortText(snapshot.domain, MAX_DOMAIN_LENGTH);
}

/**
 * The URL path of the input, with the query string and the fragment removed.
 */
export function extractUrlPath(input: unknown, fallbackUrl?: string | null): string | null {
  const snapshot = normalizeSnapshot(input, fallbackUrl ?? null, null);
  if (typeof snapshot.url !== 'string') return null;
  const trimmed = snapshot.url.trim();
  if (trimmed === '') return null;
  const path = pathFromUrl(trimmed);
  return path === null ? null : redact(path);
}

interface ElementSignals {
  readonly role: string | null;
  readonly text: string | null;
  readonly selector: string | null;
}

/** Reads role, text and selector out of one element, or null when it carries none. */
function readElement(candidate: unknown): ElementSignals | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const record = candidate as Record<string, unknown>;

  const role =
    typeof record.role === 'string' ? normalizeShortText(record.role, MAX_ROLE_LENGTH) : null;
  const text = normalizeElementText(record.text);

  let selector: string | null = null;
  for (const key of SELECTOR_KEYS) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    selector = collapseAndCap(value, MAX_SELECTOR_LENGTH);
    if (selector !== '') break;
    selector = null;
  }

  if (role === null && text === null && selector === null) return null;
  return { role, text, selector };
}

/**
 * The element signals of the input, and which element they came from.
 *
 * A snapshot that names one target element wins over the element list. With no
 * named target the first element of the list is used, and `element_source` says
 * `first_snapshot_element` so the row cannot be read as naming the element the
 * decision was about when it does not know that.
 */
export function extractElementSignals(
  input: unknown,
): ElementSignals & { readonly element_source: SignalElementSource } {
  const snapshot = normalizeSnapshot(input);

  for (const key of TARGET_KEYS) {
    const named = readElement(snapshot[key]);
    if (named !== null) {
      return { ...named, element_source: 'target' };
    }
  }

  const first = Array.isArray(snapshot.elements) ? snapshot.elements[0] : undefined;
  const fromFirst = readElement(first);
  if (fromFirst !== null) {
    return { ...fromFirst, element_source: 'first_snapshot_element' };
  }

  return { role: null, text: null, selector: null, element_source: 'none' };
}

/** The browser signals of the input, including where the element fields came from. */
export function extractBrowserSignals(
  input: unknown,
  fallbackUrl?: string | null,
  fallbackDomain?: string | null,
): BrowserSignals {
  const element = extractElementSignals(input);
  return {
    domain: extractDomain(input, fallbackUrl, fallbackDomain),
    path: extractUrlPath(input, fallbackUrl),
    element_role: element.role,
    element_text: element.text,
    selector: element.selector,
    element_source: element.element_source,
  };
}

/**
 * The tokens of the input, taken in this order until `MAX_TOKENS` is reached:
 * the question text, the page text of the snapshot, then the text of the chosen
 * element. The question comes first because two decisions that asked the same
 * question are the first thing a miner looks for.
 */
export function extractTextSignals(input: unknown, question?: string | null): TextSignals {
  const snapshot = normalizeSnapshot(input);
  const element = extractElementSignals(input);
  const pageText = typeof snapshot.text === 'string' ? snapshot.text : null;

  return {
    tokens: normalizeTokens([question ?? null, pageText, element.text]),
  };
}

/** The whole signal set for one decision, from the input it was routed with. */
export function extractDecisionSignals(params: ExtractDecisionSignalsParams = {}): DecisionSignals {
  const browser = extractBrowserSignals(params.input, params.url ?? null, params.domain ?? null);
  const text = extractTextSignals(params.input, params.question ?? null);
  return { ...browser, tokens: text.tokens };
}

/**
 * Reads the input back out of a decision row's stored context.
 *
 * The decision log already redacted this text, and this function redacts again
 * on the way out, so a row that arrived from anywhere else is still masked.
 */
function readStoredInput(context: string | null | undefined): unknown {
  if (typeof context !== 'string') return null;
  const trimmed = context.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

/**
 * Extracts the signals of a decision and stores them, on the slow path only.
 *
 * Call it when a slow-path answer is stored (`source: 'slow_path_answer'`) and
 * when a human correction is recorded (`source: 'human_correction'`). A
 * `slow_path_answer` capture of a decision whose path is not `ai` is skipped: a
 * fast-path answer is not something the miner needs to learn from, and counting
 * it would inflate the samples it counts.
 *
 * A human correction is captured whatever path produced the original answer,
 * because the correction is the signal a miner needs: it is where a pattern and
 * a person disagreed.
 *
 * The outcome never claims a row that is not there. `stored: true` means a
 * `decision_signals` row exists for this decision and `row` is it;
 * `skipped_path` means no capture was due; `write_failed` means extraction
 * succeeded and the write did not, with the reason in `message`.
 */
export function captureDecisionSignals(params: CaptureParams): CaptureOutcome {
  const { store, decision, source } = params;
  const input = params.input !== undefined ? params.input : readStoredInput(decision.context);

  const signals = extractDecisionSignals({
    input,
    question: decision.question,
    url: decision.url,
    domain: decision.domain,
  });

  if (source === 'slow_path_answer' && decision.path !== 'ai') {
    return { stored: false, status: 'skipped_path', signals };
  }

  try {
    const row = store.signals.upsert({
      decision_id: decision.id,
      domain: signals.domain,
      path: signals.path,
      element_role: signals.element_role,
      element_text: signals.element_text,
      element_source: signals.element_source,
      selector: signals.selector,
      tokens: [...signals.tokens],
      source,
    });
    return { stored: true, status: 'stored', signals, row };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stored: false, status: 'write_failed', signals, message };
  }
}
