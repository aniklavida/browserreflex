/**
 * Miner: keyword and short-phrase rules for text decisions (Bangla and English).
 *
 * Status: **implemented and tested**. The tests behind that claim are
 * `packages/server/test/miner-text.test.ts`.
 *
 * This is step two of the learning loop in `docs/SPEC.md`. Capture stored the
 * signals of every slow answer; this module looks for a word or a two-word phrase
 * that keeps coming back with the same answer and writes a candidate pattern for
 * it. It never decides anything and it never runs by itself: nothing in the
 * server calls `mineTextCandidates`, so mining happens when a person or a later
 * card asks for it. Test: *mines nothing on its own after a decide and a slow-path
 * answer*.
 *
 * ## What becomes a candidate
 *
 * A term (a token, or two adjacent tokens) becomes a candidate when, among the
 * decisions read:
 *
 * - at least `MIN_AGREEING` of them contain the term and all carry the same answer
 *   for the same decision type and the same question, and
 * - no captured decision of that decision type contains the term under a different
 *   answer, whatever its question, and
 * - the stored answer is usable as a rule output (a check answer validates against
 *   the decision schema, a choice answer is a non-empty string, a score answer is a
 *   finite number), and
 * - no pattern row with this candidate's id exists yet.
 *
 * Anything else is reported in `skipped` with the reason. The four reasons are
 * `conflicting_answer`, `below_min_agreeing`, `already_mined` and `write_failed`,
 * and the numbers behind each one are in the record, so a report cannot read as a
 * success that did not happen. A read decision that cannot be mined at all is counted
 * in `summary.skipped_decisions` under its own reason. Tests: *needs the agreement
 * threshold before it creates a candidate*, *creates nothing for a keyword that also
 * appears under a different answer*, *gives a candidate the same id when mining runs
 * twice* and *reports a failed write instead of a candidate that is not there*.
 *
 * ## Why the exclusion is wider than the agreement
 *
 * Agreement is counted within one decision type, one question and one answer,
 * because that is the only group whose samples really did answer the same thing.
 * The exclusion is counted across **every captured decision of that decision type**
 * and is never narrowed by a domain, path or limit filter. The generated rule
 * carries a `text_any` matcher and nothing else, so it cannot say which question or
 * which site it is answering; a keyword answered one way by one question and another
 * way by a different question of the same type is therefore not learned at all,
 * even when the two questions have nothing to do with each other. This over-excludes
 * on purpose: a keyword left out costs one more slow answer, a keyword learned from
 * a half-truth costs a wrong fast answer. Test: *creates nothing for a keyword that
 * also appears under a different answer* and *keeps the exclusion wider than the read
 * filter*.
 *
 * ## The tokens a sample is built from
 *
 * The stored `tokens` column is ASCII-only: `learning/capture.ts` documents every
 * non-ASCII letter as a separator, so a Bangla page text contributes nothing to it.
 * A sample's terms are therefore built from two sources, in this order:
 *
 * 1. the row's stored tokens **with the tokens of the question text removed**, and
 * 2. a tokenisation of the row's stored `element_text` that keeps non-Latin words
 *    whole.
 *
 * The question's own tokens are removed because a candidate is grouped by question:
 * a word every sample carries only because the samples asked the same question says
 * nothing about the page, and `text_any` matches a substring, so such a word would
 * fire on unrelated pages. A word that is in the question *and* on the page is left
 * out as well: the stored list is capped and does not say which occurrence a token
 * came from, so the miner cannot tell the two apart and drops the word. Test:
 * *leaves the question's own words out of a sample*.
 *
 * ## Tokenisation, in full
 *
 * - Each source string goes through `security/redact.ts` first, and the masks
 *   redaction writes are cut out before the text is split. A secret on a page
 *   cannot become a keyword, and neither can the words of a mask.
 * - A token is a run of Unicode letters, digits and marks, lower-cased. Bangla
 *   words stay whole, including their dependent vowel signs and nukta, because
 *   marks are part of the run. `café` stays `café`, which is the one documented
 *   difference from the capture tokeniser.
 * - Tokens shorter than two characters are dropped: `text_any` is a substring test,
 *   so a one-character keyword would match almost any page.
 * - The words inside a redaction mask (`redacted`, `api`, `key`, `card`, …) are
 *   dropped. They are derived from the masks `security/redact.ts` writes, because the
 *   stored ASCII token list has no mask handling and a redacted value contributes its
 *   mask's words to it. The cost is stated: a page whose only keyword is one of those
 *   words is not mined.
 * - The English stop-token list of `learning/capture.ts` is reused, and duplicates
 *   are dropped keeping the first occurrence.
 * - A phrase is two adjacent tokens of the same source joined by one space. Tokens
 *   from the two sources are never joined into a phrase: the boundary between them
 *   is not adjacency on the page.
 *
 * ## The confidence a candidate carries
 *
 * The formula is exported as `learnedConfidence` and its text is stored on every
 * candidate as `confidence_formula`, so a row states the formula that produced its
 * number:
 *
 * ```
 * confidence = min(CONFIDENCE_CAP, CONFIDENCE_BASE × min(1, support / CONFIDENCE_SUPPORT_SATURATION) × mean_source_confidence)
 * ```
 *
 * with `CONFIDENCE_BASE = 0.9`, `CONFIDENCE_SUPPORT_SATURATION = 10` and
 * `CONFIDENCE_CAP = 0.6`, rounded to four decimals. `support` is the number of
 * decisions that carry the term with this answer; `mean_source_confidence` is the
 * mean of the confidences those answers were recorded with. The cap is below the
 * default `auto_at_or_above` of `0.8`, so even a candidate promoted without
 * recalibration could not answer automatically on this number. This is a starting
 * number for the shadow card to measure, **not** a claim that the keyword is right:
 * nothing here has been measured against real answers. Test: *computes the
 * confidence from the formula it documents*.
 *
 * ## What a candidate is, and what it is not
 *
 * - The row is written with `status: 'shadow'` and `kind: 'learned'`. It is never
 *   active: the engine is loaded from pack files by `mcp/server.ts` and nothing in
 *   the server reads the `patterns` table into it, so a stored candidate cannot
 *   answer anything. Promotion is a later card's job.
 * - The row never carries the safety flag, and a decision whose own row is flagged
 *   `is_safety` is not mined at all. The engine's precedence already puts a safety
 *   rule first, and nothing here weakens that. Test: *never marks a mined candidate
 *   as a safety rule*.
 * - The row's `rules` column holds one engine `Rule`, and `learnedRuleFromPatternRow`
 *   reads it back, so the later shadow card can hand it to the engine as it stands.
 * - **A distribution is never invented.** A candidate carries the mean of the
 *   distributions every supporting decision recorded, and only when all of them
 *   recorded one over the same options. When none did, the rule carries no
 *   distribution, `distribution_recorded` is false, and a choice rule in that state
 *   does not validate against a choice question: the decision schema requires a
 *   distribution for a choice answer. That is a known limit of this card, recorded on
 *   the candidate and tested as one. Tests: *does not invent a distribution for a
 *   choice candidate* and *records the mean distribution when every supporting
 *   decision carried one*.
 * - The row's `domain` column is descriptive: it is the domain every supporting
 *   decision shared, or null when they did not share one. No matcher is built from
 *   it, and the rule matches on text alone.
 * - The safety check is advisory. This module writes records and nothing else; it
 *   cannot prevent an agent from acting.
 * - Page content is data. Text is tokenised and counted here and never interpreted
 *   as an instruction.
 *
 * Dependencies: the Node standard library and internal modules only. No new
 * production dependency, so nothing to record in `docs/DEPENDENCIES.md`.
 */

import { createHash } from 'node:crypto';
import { validateAnswer, type DecisionType } from '../../core/schema.js';
import type { Rule } from '../../patterns/types.js';
import { STOP_TOKENS } from '../capture.js';
import { maskFor, redact, redactionRules } from '../../security/redact.js';
import type {
  CaptureSource,
  DatabaseStore,
  Decision,
  DecisionSignal,
  Pattern,
} from '../../store/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Decisions that must agree on a term before it becomes a candidate. */
export const MIN_AGREEING = 3;

/** Shortest term mined, in characters. A `text_any` term matches as a substring. */
export const MIN_TERM_LENGTH = 2;

/** Longest term mined, in characters. */
export const MAX_TERM_LENGTH = 64;

/** Tokens in a mined phrase. Two is the only phrase length mined. */
export const MAX_PHRASE_TOKENS = 2;

/** Longest question text used to group and record samples, in characters. */
export const MAX_QUESTION_LENGTH = 200;

/** Marks a cut string, the same as capture's. */
const TRUNCATION_MARK = '…';

/** The `kind` recorded on every candidate this module writes. */
export const CANDIDATE_KIND = 'learned';

/** The id prefix of every candidate, so a candidate is recognisable in the table. */
export const CANDIDATE_ID_PREFIX = 'learned_text_';

/** Multiplier of the confidence formula. */
export const CONFIDENCE_BASE = 0.9;

/** Support at which the confidence formula stops rewarding more samples. */
export const CONFIDENCE_SUPPORT_SATURATION = 10;

/** Ceiling of the confidence formula, below the default automatic-answer threshold. */
export const CONFIDENCE_CAP = 0.6;

/** The formula, as text, stored on every candidate so the row states its own maths. */
export const CONFIDENCE_FORMULA = 'min(0.6, 0.9 * min(1, support / 10) * mean_source_confidence)';

const STOP_TOKEN_SET: ReadonlySet<string> = new Set(STOP_TOKENS);

/** The masks redaction writes, cut out before text is split into tokens. */
const REDACTION_MASK_PATTERN = /\[REDACTED:[A-Z_]+\]/g;

/** A run of Unicode letters, digits and marks: a word in any script, kept whole. */
const WORD_PATTERN = /[\p{L}\p{N}\p{M}]+/gu;

/**
 * The words inside every mask `security/redact.ts` can write, taken from that module
 * rather than copied here, so a new redaction rule drops its words here too.
 *
 * The stored `tokens` column is built by capture's ASCII tokeniser, which has no mask
 * handling at all, so a redacted value contributes `redacted`, `api`, `key` and the
 * rest of its mask to that column. Those words are dropped from every sample. The cost
 * is deliberate and stated: a page whose only keyword is one of them (`card`, `email`,
 * `token`, `key`, `password`, `cookie`, `phone`, `secret`, `private`, `url`,
 * `credentials`, `redacted`) is not mined, because a keyword mined from a redaction
 * mask is a keyword about the mask.
 */
const MASK_WORDS: ReadonlySet<string> = new Set(
  redactionRules().flatMap((rule) =>
    [...maskFor(rule).toLowerCase().matchAll(WORD_PATTERN)].map((match) => match[0]),
  ),
);

/** The separator used inside ids and internal keys; never in stored text. */
const KEY_SEPARATOR = '\u0000';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Whether a mined term is a single token or two adjacent tokens. */
export type TextTermKind = 'token' | 'phrase';

/** Why a term that was considered was not turned into a candidate. */
export type TextSkipReason =
  'conflicting_answer' | 'below_min_agreeing' | 'already_mined' | 'write_failed';

/** Why a captured decision could not be mined at all. */
export type DecisionSkipReason =
  | 'missing_decision'
  | 'other_decision_type'
  | 'safety_decision'
  | 'no_answer'
  | 'unusable_answer'
  | 'no_terms';

export interface MineTextOptions {
  /** Decisions that must agree on a term. Defaults to `MIN_AGREEING`. */
  readonly minAgreeing?: number | undefined;
  /** Read set filter: only signals rows of this domain. */
  readonly domain?: string | undefined;
  /** Read set filter: only signals rows of this URL path. */
  readonly path?: string | undefined;
  /** Read set filter: only signals rows captured from this source. */
  readonly source?: CaptureSource | undefined;
  /** Read set filter: only decisions of this type. */
  readonly decisionType?: DecisionType | undefined;
  /** Read set filter: at most this many signals rows, newest capture first. */
  readonly limit?: number | undefined;
}

/** A candidate this run created, with everything a reviewer needs to judge it. */
export interface TextCandidate {
  /** The row as it sits in the `patterns` table. */
  readonly pattern: Pattern;
  /** The engine rule the row's `rules` column holds, parsed back from the row. */
  readonly rule: Rule;
  /** The mined term, lower-cased: the token or the two words joined by a space. */
  readonly term: string;
  readonly term_kind: TextTermKind;
  readonly decision_type: DecisionType;
  /** The question every supporting decision asked, collapsed and capped. */
  readonly question: string;
  /** The answer the supporting decisions agree on, as a rule output value. */
  readonly answer: string | number | boolean;
  readonly answer_key: string;
  /** How many read decisions carry this term with this answer. */
  readonly support: number;
  /** Mean of the recorded confidences of those decisions. */
  readonly mean_source_confidence: number;
  /** The number `learnedConfidence` produced, and the formula that produced it. */
  readonly confidence: number;
  readonly confidence_formula: string;
  /** Every read decision that supports this candidate. */
  readonly decision_ids: readonly string[];
  /** The domain every supporting decision shared, or null when they did not. */
  readonly domain: string | null;
  /**
   * Whether the rule carries a distribution. False when no supporting decision
   * recorded one, or when they recorded different option sets. A choice rule without
   * a distribution does not validate against a choice question, so this says whether
   * the rule can answer one as it stands.
   */
  readonly distribution_recorded: boolean;
}

/** A term that was considered and not turned into a candidate, and why. */
export interface SkippedTextCandidate {
  readonly term: string;
  readonly term_kind: TextTermKind;
  readonly decision_type: DecisionType;
  readonly answer_key: string;
  /** Decisions carrying this term with this answer in the read set. */
  readonly support: number;
  /** Decisions carrying this term under another answer of the same type. */
  readonly conflicting_support: number;
  readonly reason: TextSkipReason;
  /** The numbers behind the reason, in one sentence. */
  readonly detail: string;
}

/** What the run read, and what it did with it. */
export interface TextMiningSummary {
  /** The threshold actually used, after the requested one was checked. */
  readonly min_agreeing: number;
  /** Signals rows in the read set. */
  readonly read_signals: number;
  /** Read decisions that produced terms. */
  readonly mined_decisions: number;
  /** Why a read decision was not mined, and how many. */
  readonly skipped_decisions: readonly {
    readonly reason: DecisionSkipReason;
    readonly count: number;
  }[];
  /** Distinct terms considered across every group. */
  readonly terms_considered: number;
  /** Read set filters that narrowed what was read, as text. */
  readonly read_filter: string;
}

export interface TextMiningResult {
  readonly created: readonly TextCandidate[];
  readonly skipped: readonly SkippedTextCandidate[];
  readonly summary: TextMiningSummary;
  /** When this run happened. Not part of any candidate id, so mining again is stable. */
  readonly mined_at: string;
}

// ---------------------------------------------------------------------------
// Tokenisation
// ---------------------------------------------------------------------------

/**
 * Splits text into lower-cased tokens, keeping non-Latin words whole.
 *
 * Each source string is redacted first and the masks redaction writes are then cut
 * out, so a secret contributes neither its own value nor the words of its mask. A
 * token is a run of Unicode letters, digits and marks, which keeps Bangla words
 * whole: a dependent vowel sign is a mark, so it stays inside the word it belongs
 * to. Tokens shorter than two characters and the English stop words are dropped,
 * duplicates are dropped keeping the first occurrence.
 */
export function tokenizeText(raw: unknown): string[] {
  const sources = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
  const tokens: string[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    if (typeof source !== 'string') continue;
    const normalized = redact(source).replace(REDACTION_MASK_PATTERN, ' ').toLowerCase();

    for (const match of normalized.matchAll(WORD_PATTERN)) {
      const token = match[0];
      if (token.length < MIN_TERM_LENGTH) continue;
      if (STOP_TOKEN_SET.has(token) || seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
    }
  }

  return tokens;
}

/** True when a token is long enough and short enough to be mined as a term. */
function isMineableTerm(term: string): boolean {
  return term.length >= MIN_TERM_LENGTH && term.length <= MAX_TERM_LENGTH;
}

/** Joins two adjacent tokens into the one phrase length this module mines. */
function phraseOf(first: string, second: string): string | null {
  if (!isMineableTerm(first) || !isMineableTerm(second)) return null;
  const phrase = `${first} ${second}`;
  return isMineableTerm(phrase) ? phrase : null;
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

interface StoredAnswer {
  readonly value: string | number | boolean;
  readonly distribution?: Record<string, number> | undefined;
}

/**
 * Reads the answer value out of a decision row, or null when there is none that can
 * be a rule output.
 *
 * The `decisions.answer` column is text: `submit_answers` writes `String(value)`, or
 * `{"value":…}` when a distribution came with it, so a check answer is read back as
 * the boolean it was written from. A decision still waiting for an answer stores the
 * literal `pending`, which is not an answer and must never become a learned one. A
 * check answer is validated against the decision schema exactly as
 * `tools/submit_answers.ts` validates it; a choice answer is kept as its string,
 * because the option list is not stored on the decision row and this module cannot
 * invent one; a score answer must be a finite number.
 */
export function parseStoredAnswer(decision: Decision): StoredAnswer | null {
  const raw = decision.answer;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'pending') return null;

  let candidate: unknown = trimmed;
  let distribution: Record<string, number> | undefined;

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      candidate = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
    const record = candidate as Record<string, unknown>;
    if (record.value === undefined) return null;
    candidate = record.value;
    const rawDistribution = record.distribution;
    if (typeof rawDistribution === 'object' && rawDistribution !== null) {
      const entries = Object.entries(rawDistribution as Record<string, unknown>);
      const allNumbers = entries.every(
        ([, probability]) => typeof probability === 'number' && !Number.isNaN(probability),
      );
      if (allNumbers && entries.length > 0) {
        distribution = Object.fromEntries(
          entries.map(([option, probability]) => [option, probability as number]),
        );
      }
    }
  }

  if (typeof candidate === 'boolean') {
    return distribution === undefined ? { value: candidate } : { value: candidate, distribution };
  }

  if (decision.decision_type === 'score') {
    const asNumber = typeof candidate === 'number' ? candidate : Number(String(candidate).trim());
    if (!Number.isFinite(asNumber)) return null;
    return { value: asNumber };
  }

  if (typeof candidate !== 'string') return null;
  const text = candidate.trim();
  if (text === '') return null;

  if (decision.decision_type === 'check') {
    // `tools/submit_answers.ts` stores `String(value)`, so the strings a check
    // answer was written from are read back as the booleans they came from. The
    // decision schema does not accept the words `true` and `false` as a check value,
    // and reading them as anything else would drop every check answer there is.
    const boolean: boolean | null = text === 'true' ? true : text === 'false' ? false : null;
    if (boolean !== null) {
      return distribution === undefined ? { value: boolean } : { value: boolean, distribution };
    }
    const checkQuestion = { id: decision.id, type: 'check' as const, text: decision.question };
    const validation = validateAnswer(checkQuestion, {
      value: text,
      confidence: 1,
      path: 'pattern' as const,
    });
    if (!validation.success) return null;
  }

  return distribution === undefined ? { value: text } : { value: text, distribution };
}

/** The key two decisions must share to be counted as the same answer. */
export function answerKeyOf(decisionType: DecisionType, answer: StoredAnswer): string {
  return `${decisionType}:${typeof answer.value}:${String(answer.value)}`;
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/** Collapses whitespace, lower-cases and caps a question, marking a cut. */
export function normalizeQuestion(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim().toLowerCase();
  if (collapsed.length <= MAX_QUESTION_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_QUESTION_LENGTH)}${TRUNCATION_MARK}`;
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

/**
 * The confidence a candidate starts with, and the formula behind it.
 *
 * `min(CONFIDENCE_CAP, CONFIDENCE_BASE × min(1, support / CONFIDENCE_SUPPORT_SATURATION) ×
 * mean_source_confidence)`, rounded to four decimals. Support is the number of
 * decisions that carry the term with this answer; the mean source confidence is what
 * those answers were recorded with. Inputs that are not finite numbers are read as 0
 * for support and clamped into 0..1 for the mean, so a nonsense input cannot produce
 * a confidence above the cap.
 *
 * This is a starting number for the shadow card to measure. It is not a claim that
 * the keyword is right: nothing here has been measured against real answers.
 */
export function learnedConfidence(params: {
  readonly support: number;
  readonly meanSourceConfidence: number;
}): number {
  const support = Number.isFinite(params.support) ? Math.max(0, params.support) : 0;
  const rawMean = params.meanSourceConfidence;
  const mean = Number.isFinite(rawMean) ? Math.min(1, Math.max(0, rawMean)) : 0;
  const supportFactor = Math.min(1, support / CONFIDENCE_SUPPORT_SATURATION);
  const confidence = Math.min(CONFIDENCE_CAP, CONFIDENCE_BASE * supportFactor * mean);
  return Number(confidence.toFixed(4));
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/**
 * The candidate id for one term, group and answer. It is a hash of exactly those
 * four values and nothing else: no timestamp, no row order, no count. Mining the
 * same data twice therefore asks for the same ids and creates nothing the second
 * time.
 */
export function candidateId(params: {
  readonly term: string;
  readonly termKind: TextTermKind;
  readonly decisionType: DecisionType;
  readonly questionKey: string;
  readonly answerKey: string;
}): string {
  const key = [
    params.decisionType,
    params.questionKey,
    params.answerKey,
    params.termKind,
    params.term,
  ].join(KEY_SEPARATOR);
  const digest = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
  return `${CANDIDATE_ID_PREFIX}${digest}`;
}

/**
 * The mean of the distributions every supporting decision recorded, or undefined.
 *
 * A distribution is only produced when every supporting decision carried one over
 * the same options; a mean over two different option sets would be a number nothing
 * measured. Nothing is invented when the decisions recorded nothing: the candidate
 * then records no distribution, `distribution_recorded` is false, and a choice rule
 * without one does not validate against a choice question. The shadow card is where a
 * distribution is measured, and until then the record says it has none.
 */
function meanDistribution(samples: readonly Sample[]): Record<string, number> | undefined {
  const first = samples[0]?.answer.distribution;
  if (first === undefined || samples.length === 0) return undefined;

  const options = Object.keys(first).sort();
  const totals = new Map<string, number>(options.map((option) => [option, 0]));

  for (const sample of samples) {
    const distribution = sample.answer.distribution;
    if (distribution === undefined) return undefined;
    const keys = Object.keys(distribution).sort();
    if (keys.length !== options.length || keys.some((key, index) => key !== options[index])) {
      return undefined;
    }
    for (const option of options) {
      const probability = distribution[option];
      if (typeof probability !== 'number' || !Number.isFinite(probability)) return undefined;
      totals.set(option, totals.get(option)! + probability);
    }
  }

  let sum = 0;
  for (const total of totals.values()) {
    sum += total / samples.length;
  }
  if (sum <= 0) return undefined;

  const mean: Record<string, number> = {};
  for (const [option, total] of totals) {
    mean[option] = Number((total / samples.length / sum).toFixed(6));
  }
  return mean;
}

/**
 * The engine rule a candidate stores in its `rules` column.
 *
 * The rule carries a `text_any` matcher and nothing else, plus the evidence it was
 * built from and the formula behind its confidence. It never carries `safety`: a
 * learned pattern cannot be a safety rule and cannot override one, and the engine
 * puts a safety rule first in any case.
 */
export function buildLearnedRule(params: {
  readonly id: string;
  readonly term: string;
  readonly decisionType: DecisionType;
  readonly answer: StoredAnswer;
  readonly question: string;
  readonly support: number;
  readonly confidence: number;
  readonly decisionIds: readonly string[];
  readonly distribution?: Record<string, number> | undefined;
}): Rule {
  const distribution = params.distribution ?? params.answer.distribution;
  const output: Rule['output'] = {
    value: params.answer.value,
    confidence: params.confidence,
    type: params.decisionType,
    decision_type: params.decisionType,
    ...(distribution ? { distribution } : {}),
  };

  return {
    id: params.id,
    name: `learned text ${params.term} => ${String(params.answer.value)} (${params.decisionType})`,
    pack_id: null,
    safety: false,
    is_safety: false,
    matchers: { text_any: [params.term] },
    output,
    kind: CANDIDATE_KIND,
    learned_by: 'text_miner',
    term: params.term,
    question: params.question,
    support: params.support,
    confidence_formula: CONFIDENCE_FORMULA,
    decision_ids: [...params.decisionIds],
    ...(distribution ? { distribution_recorded: true } : { distribution_recorded: false }),
  };
}

/**
 * Reads the engine rule back out of a `patterns.rules` cell, or null when the cell
 * holds no rule.
 *
 * Accepts what this module writes (one rule object) and the two shapes a pack or a
 * later card might use (a list of rules, or `{ rules: [...] }`). A cell that does not
 * parse, an empty object as `core/log.ts` writes for a pattern id it has only seen
 * quoted, and an object without matchers and an output with a value all return null
 * rather than a half-built rule.
 */
export function learnedRuleFromPatternRow(rules: string): Rule | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rules);
  } catch {
    return null;
  }

  const candidates: unknown[] = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as { rules?: unknown }).rules)
      ? ((parsed as { rules: unknown[] }).rules as unknown[])
      : [parsed];

  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const record = candidate as Record<string, unknown>;
    if (typeof record.id !== 'string' || record.id === '') continue;
    if (typeof record.matchers !== 'object' || record.matchers === null) continue;
    const output = record.output;
    if (typeof output !== 'object' || output === null) continue;
    if ((output as Record<string, unknown>).value === undefined) continue;
    return candidate as Rule;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Mining
// ---------------------------------------------------------------------------

interface Sample {
  readonly decisionId: string;
  readonly decisionType: DecisionType;
  readonly questionKey: string;
  readonly answer: StoredAnswer;
  readonly answerKey: string;
  readonly confidence: number;
  readonly domain: string | null;
}

interface TermGroup {
  readonly term: string;
  readonly termKind: TextTermKind;
  readonly decisionType: DecisionType;
  readonly questionKey: string;
  readonly answer: StoredAnswer;
  readonly answerKey: string;
  readonly samples: Sample[];
}

/**
 * The terms one captured decision contributes.
 *
 * The row's stored tokens with the question's own tokens removed, then the row's
 * stored element text tokenised so non-Latin words survive. Phrases are built inside
 * one source only: the boundary between the two sources is not adjacency on the page.
 * The words of a redaction mask are dropped from both sources; see `MASK_WORDS`.
 */
function sampleTerms(
  row: DecisionSignal,
  questionTokens: ReadonlySet<string>,
): { term: string; termKind: TextTermKind }[] {
  const storedTokens = row.tokens.filter(
    (token) => !questionTokens.has(token) && !MASK_WORDS.has(token) && isMineableTerm(token),
  );
  const elementTokens = tokenizeText(row.element_text).filter((token) => !MASK_WORDS.has(token));

  const terms: { term: string; termKind: TextTermKind }[] = [];
  const seen = new Set<string>();

  for (const token of [...storedTokens, ...elementTokens]) {
    if (seen.has(token)) continue;
    seen.add(token);
    terms.push({ term: token, termKind: 'token' });
  }

  for (const source of [storedTokens, elementTokens]) {
    for (let index = 0; index + 1 < source.length; index += 1) {
      const phrase = phraseOf(source[index]!, source[index + 1]!);
      if (phrase === null || seen.has(phrase)) continue;
      seen.add(phrase);
      terms.push({ term: phrase, termKind: 'phrase' });
    }
  }

  return terms;
}

function hasReadFilter(options: MineTextOptions): boolean {
  return (
    options.domain !== undefined ||
    options.path !== undefined ||
    options.source !== undefined ||
    options.limit !== undefined
  );
}

function describeReadFilter(options: MineTextOptions): string {
  const parts: string[] = [];
  if (options.domain !== undefined) parts.push(`domain=${options.domain}`);
  if (options.path !== undefined) parts.push(`path=${options.path}`);
  if (options.source !== undefined) parts.push(`source=${options.source}`);
  if (options.limit !== undefined) parts.push(`limit=${options.limit}`);
  return parts.length === 0 ? 'none' : parts.join(' ');
}

function bumpSkip(counts: Map<DecisionSkipReason, number>, reason: DecisionSkipReason): void {
  counts.set(reason, (counts.get(reason) ?? 0) + 1);
}

/**
 * Mines keyword and short-phrase candidates from captured slow decisions.
 *
 * Never runs by itself: nothing in the server calls it, and this function does not
 * schedule itself. It reads `decision_signals` and the `decisions` rows they point
 * at, counts the terms, and writes one `patterns` row per qualifying term with
 * `status: 'shadow'` and `kind: 'learned'`. Every term it did not create is in
 * `skipped` with a reason and the numbers behind it, and `summary` states the
 * threshold and the read set actually used.
 *
 * A `write_failed` skip means extraction and counting succeeded and the insert did
 * not. No result claims a row that is not there: `created` only ever holds rows read
 * back from the table.
 */
export function mineTextCandidates(
  store: DatabaseStore,
  options: MineTextOptions = {},
): TextMiningResult {
  const requested = options.minAgreeing;
  const minAgreeing =
    typeof requested === 'number' && Number.isFinite(requested)
      ? Math.max(1, Math.floor(requested))
      : MIN_AGREEING;

  const allSignals = store.signals.list();
  const readSignals = hasReadFilter(options)
    ? store.signals.list({
        ...(options.domain !== undefined ? { domain: options.domain } : {}),
        ...(options.path !== undefined ? { path: options.path } : {}),
        ...(options.source !== undefined ? { source: options.source } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      })
    : allSignals;

  const skippedDecisionCounts = new Map<DecisionSkipReason, number>();

  interface Prepared {
    readonly sample: Sample;
    readonly terms: { term: string; termKind: TextTermKind }[];
  }

  const prepared: Prepared[] = [];

  // The conflict index is built from every captured decision, never from the read
  // set: the generated rule carries a text matcher and nothing else, so a keyword
  // contradicted anywhere in the table is contradicted wherever the rule would match.
  const answersByTerm = new Map<string, Map<string, number>>();
  const readDecisionIds = new Set(readSignals.map((row) => row.decision_id));

  for (const row of allSignals) {
    const decision = store.decisions.getById(row.decision_id);
    if (decision === null) {
      if (readDecisionIds.has(row.decision_id)) {
        bumpSkip(skippedDecisionCounts, 'missing_decision');
      }
      continue;
    }

    const decisionType = decision.decision_type;
    const answer = parseStoredAnswer(decision);
    const questionKey = normalizeQuestion(decision.question);
    const questionTokens = new Set(tokenizeText(decision.question));
    const terms = sampleTerms(row, questionTokens);

    if (answer !== null) {
      const answerKey = answerKeyOf(decisionType, answer);
      for (const { term } of terms) {
        const termKey = `${decisionType}${KEY_SEPARATOR}${term}`;
        let answers = answersByTerm.get(termKey);
        if (answers === undefined) {
          answers = new Map<string, number>();
          answersByTerm.set(termKey, answers);
        }
        answers.set(answerKey, (answers.get(answerKey) ?? 0) + 1);
      }
    }

    if (!readDecisionIds.has(row.decision_id)) continue;

    if (options.decisionType !== undefined && decisionType !== options.decisionType) {
      bumpSkip(skippedDecisionCounts, 'other_decision_type');
      continue;
    }
    if (decision.is_safety) {
      bumpSkip(skippedDecisionCounts, 'safety_decision');
      continue;
    }
    if (answer === null) {
      bumpSkip(
        skippedDecisionCounts,
        decision.answer === 'pending' ? 'no_answer' : 'unusable_answer',
      );
      continue;
    }
    if (terms.length === 0) {
      bumpSkip(skippedDecisionCounts, 'no_terms');
      continue;
    }

    prepared.push({
      sample: {
        decisionId: decision.id,
        decisionType,
        questionKey,
        answer,
        answerKey: answerKeyOf(decisionType, answer),
        confidence: decision.confidence,
        domain: row.domain ?? decision.domain,
      },
      terms,
    });
  }

  const groups = new Map<string, TermGroup>();
  for (const entry of prepared) {
    const { sample, terms } = entry;
    for (const { term, termKind } of terms) {
      const key = [sample.decisionType, sample.questionKey, sample.answerKey, termKind, term].join(
        KEY_SEPARATOR,
      );
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          term,
          termKind,
          decisionType: sample.decisionType,
          questionKey: sample.questionKey,
          answer: sample.answer,
          answerKey: sample.answerKey,
          samples: [],
        };
        groups.set(key, group);
      }
      group.samples.push(sample);
    }
  }

  const created: TextCandidate[] = [];
  const skipped: SkippedTextCandidate[] = [];

  const orderedGroups = [...groups.values()].sort((left, right) => {
    if (left.decisionType !== right.decisionType) {
      return left.decisionType < right.decisionType ? -1 : 1;
    }
    if (left.questionKey !== right.questionKey) {
      return left.questionKey < right.questionKey ? -1 : 1;
    }
    if (left.answerKey !== right.answerKey) {
      return left.answerKey < right.answerKey ? -1 : 1;
    }
    if (left.termKind !== right.termKind) {
      return left.termKind === 'token' ? -1 : 1;
    }
    return left.term < right.term ? -1 : left.term > right.term ? 1 : 0;
  });

  for (const group of orderedGroups) {
    const answers = answersByTerm.get(`${group.decisionType}${KEY_SEPARATOR}${group.term}`);
    let conflictingSupport = 0;
    if (answers !== undefined) {
      for (const [answerKey, count] of answers) {
        if (answerKey !== group.answerKey) conflictingSupport += count;
      }
    }

    const support = group.samples.length;
    const record = {
      term: group.term,
      term_kind: group.termKind,
      decision_type: group.decisionType,
      answer_key: group.answerKey,
      support,
      conflicting_support: conflictingSupport,
    } as const;

    if (conflictingSupport > 0) {
      skipped.push({
        ...record,
        reason: 'conflicting_answer',
        detail: `appears in ${conflictingSupport} captured decision(s) of type ${group.decisionType} under another answer`,
      });
      continue;
    }

    if (support < minAgreeing) {
      skipped.push({
        ...record,
        reason: 'below_min_agreeing',
        detail: `${support} agreeing decision(s), ${minAgreeing} needed`,
      });
      continue;
    }

    const id = candidateId({
      term: group.term,
      termKind: group.termKind,
      decisionType: group.decisionType,
      questionKey: group.questionKey,
      answerKey: group.answerKey,
    });

    const decisionIds = group.samples.map((sample) => sample.decisionId);
    const meanSourceConfidence =
      group.samples.reduce((total, sample) => total + sample.confidence, 0) / support;
    const confidence = learnedConfidence({ support, meanSourceConfidence });
    const domains = new Set(group.samples.map((sample) => sample.domain));
    const domain = domains.size === 1 ? [...domains][0]! : null;
    const distribution = meanDistribution(group.samples);

    const rule = buildLearnedRule({
      id,
      term: group.term,
      decisionType: group.decisionType,
      answer: group.answer,
      question: group.questionKey,
      support,
      confidence,
      decisionIds,
      ...(distribution ? { distribution } : {}),
    });

    try {
      if (store.patterns.getById(id) !== null) {
        skipped.push({
          ...record,
          reason: 'already_mined',
          detail: `pattern ${id} already exists`,
        });
        continue;
      }

      const pattern = store.patterns.create({
        id,
        name: rule.name!,
        domain,
        decision_type: group.decisionType,
        rules: JSON.stringify(rule),
        status: 'shadow',
        confidence,
        is_safety: false,
      });
      const stored = store.patterns.getById(pattern.id);
      if (stored === null) {
        skipped.push({
          ...record,
          reason: 'write_failed',
          detail: `pattern ${id} was not readable after it was written`,
        });
        continue;
      }
      created.push({
        pattern: stored,
        rule,
        term: group.term,
        term_kind: group.termKind,
        decision_type: group.decisionType,
        question: group.questionKey,
        answer: group.answer.value,
        answer_key: group.answerKey,
        support,
        mean_source_confidence: Number(meanSourceConfidence.toFixed(4)),
        confidence,
        confidence_formula: CONFIDENCE_FORMULA,
        decision_ids: decisionIds,
        domain: stored.domain,
        distribution_recorded: distribution !== undefined,
      });
    } catch (error) {
      skipped.push({
        ...record,
        reason: 'write_failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const skippedDecisions = [...skippedDecisionCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => (left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0));

  return {
    created,
    skipped,
    summary: {
      min_agreeing: minAgreeing,
      read_signals: readSignals.length,
      mined_decisions: prepared.length,
      skipped_decisions: skippedDecisions,
      terms_considered: groups.size,
      read_filter: describeReadFilter(options),
    },
    mined_at: new Date().toISOString(),
  };
}
