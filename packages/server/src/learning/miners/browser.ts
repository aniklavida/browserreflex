/**
 * Browser miner: candidate patterns from repeated browser decisions.
 *
 * Status: **implemented and tested**. The tests behind that claim are
 * `packages/server/test/miner-browser.test.ts`.
 *
 * This is step two of the learning loop in `docs/SPEC.md`. Capture
 * (`learning/capture.ts`) stores what was in front of a slow decision; this module
 * looks for repeated slow decisions that share a signal and writes one candidate
 * pattern for each group that agreed. A candidate is a proposal, not an answer:
 * nothing here runs it, and nothing in this repository calls this module.
 *
 * ## What a sample is
 *
 * A sample is one `decision_signals` row joined to its `decisions` row. The join is
 * needed because the row holds what was in front of the decision and the decision row
 * holds the answer, and neither holds both.
 *
 * `decision_signals.decision_id` is the primary key and capture writes it with an
 * upsert, so there is one row per decision: a decision can be a sample at most once,
 * and a second capture of the same decision rewrites the row rather than adding
 * another sample of it.
 *
 * ## What a group is
 *
 * Samples are grouped by:
 *
 * | Key part | Where it comes from |
 * |---|---|
 * | `decision_type` | the decisions row |
 * | `domain` | the signals row; required, a candidate without it would match every site |
 * | `path` | the signals row, already without query string and fragment; `null` omits the `url_path` matcher |
 * | `element_role` | the signals row; required |
 * | `element_text` | the signals row, already redacted and normalised; `null` omits the `text_any` matcher |
 * | `question` | the decisions row, already redacted |
 *
 * `decision_type` is in the key although the learning loop names only domain, path,
 * element and text. A `choice` answering `promo` and a `check` answering `true` are
 * not disagreement, they are two different questions; merging them would invent a
 * disagreement and hide a real one.
 *
 * `path` is the stored path verbatim. Capture has already removed the query string
 * and the fragment, so it is a path and not a guess about one. It is not widened
 * into a glob: a glob would match paths that no decision in the group was ever
 * asked about, and a candidate that matches more than its evidence is the exact
 * failure this project guards against.
 *
 * The question is part of the key and **not** a matcher. The engine's only question
 * matchers are `target_question_id` and `question_id`, and the store keeps question
 * text rather than a question id. Writing that text into either field would make
 * the rule claim to target an id that does not exist.
 *
 * **A documented limit of that choice:** the store keeps the question text and not
 * the option list, so two questions that share one text and offer different options
 * are one group here. The mined candidate therefore constrains the page and the
 * element, not the option list, and the value it answers is the value that group
 * agreed on.
 *
 * ## What is skipped before a group exists
 *
 * A row that cannot carry a candidate is counted with the reason, so a report never
 * says a group was considered when it was dropped. In the order checked:
 *
 * | Reason | Why |
 * |---|---|
 * | `decision_missing` | the signals row has no decision row to take the answer from |
 * | `correction_row` | the row records a human correction, and the decision row still holds the answer that was corrected |
 * | `not_slow_path` | the row says the slow path answered it while the decision row carries a fast path |
 * | `safety_flagged` | the decision row carries `is_safety`; see below |
 * | `no_domain` | no `url_domain` matcher would match every site on the internet |
 * | `element_not_targeted` | the row's `element_source` is not `target` |
 * | `no_element_role` | no element kind to match |
 * | `no_answer_value` | the stored answer is empty, still `pending`, or cannot be typed as its declared decision type |
 *
 * - **A correction is not an agreeing sample.** `feedback` leaves the decision row
 *   exactly as it was written and stores the correction in `feedback.correct_value`,
 *   so the value the `decisions` row holds after a correction is the value a person
 *   disagreed with. Mining it would count a disputed answer as agreement and teach
 *   the wrong value; the row is skipped as `correction_row` instead. Corrections are
 *   evidence for the shadow and promotion cards and for the confidence calibration
 *   `docs/SPEC.md` describes, not for the agreed value of a group.
 * - **A row that says it came from the slow path while its decision is a fast path is
 *   a row that misdescribes itself.** Capture only writes a `slow_path_answer` row for
 *   a decision the slow path answered, so this combination should not exist; nothing is
 *   learned from it if it does.
 * - **`element_source` must be `target`.** Capture records `first_snapshot_element`
 *   for a row built from the first element of a snapshot, which its own header says
 *   is not necessarily the element the decision was about. A matcher built from such
 *   a row would describe itself as matching a specific element the row does not
 *   name, so those rows are not mined.
 * - **A safety-flagged decision is not mined.** A learned candidate never carries the
 *   safety flag, because the flag belongs to a written rule and to the user's own
 *   decision about it. A candidate mined from a safety decision would record a
 *   safety answer as an ordinary confident one. The engine already keeps safety
 *   rules ahead of learned ones (`patterns/engine.ts`, precedence sort); this is a
 *   second, separate guard so the candidate never carries that answer at all.
 * - **Agreement is about the answer value.** The stored answer is the answer:
 *   `submit_answers` writes a boolean or a number as `String(value)`, a choice as the
 *   option id, and an answer that carries a distribution as
 *   `{"value":…,"distribution":…}`. Both shapes are read back to the value they hold,
 *   and the declared decision type then says what that text is, so one stored `7` is
 *   the number `7` for a `score` and the option id `"7"` for a `choice`. What is
 *   compared is the value: two answers that differ only in their distribution agreed,
 *   and the confidence a decision happened to carry is not agreement and is not read.
 * - **A `check` answer is read as the boolean it means.** `true` and `false` are
 *   themselves, and the `yes` and `no` spellings the answer validator accepts
 *   (`core/schema.ts`) are read as `true` and `false`. A number for a `check` is
 *   skipped: the validator accepts a probability there and this store does not say
 *   whether the agent meant a probability or a yes or no, so nothing is guessed.
 * - **Nothing is repaired.** A decision whose stored answer cannot be typed as its
 *   declared type (`score` holding a word, `check` holding a number) is skipped as
 *   `no_answer_value` rather than coerced into one.
 *
 * ## When a candidate is created
 *
 * A group is turned into one candidate when all three hold:
 *
 * 1. every sample in the group has the same answer value (no disagreement);
 * 2. the group has at least `MIN_AGREEING` (default 3) samples;
 * 3. no pattern with the group's id is in the store already.
 *
 * **Any disagreement in the group creates nothing.** Not a candidate for the majority
 * value, not a candidate with a distribution, not a candidate marked for review. A
 * group where the model and a person disagreed is the group the shadow test exists
 * to measure, and this card does not get to decide the answer in advance.
 *
 * The candidate is written with `status: 'shadow'`. Nothing loads a shadow pattern
 * into the fast path, and no promotion code exists yet: promotion, shadow testing,
 * monitoring and demotion are **planned**. No served answer uses a candidate this
 * card creates; the one engine call that can return one directly is described under
 * *What a candidate cannot do yet* below.
 *
 * The order of the three checks is the order they are reported in: a group with a
 * disagreement is reported as a disagreement even when it is also below the
 * threshold, because that is the more useful thing to read.
 *
 * ## What the candidate says about itself
 *
 * `patterns.rules` holds the engine's typed `Rule` as JSON, so the shadow card can
 * load it with `compileRule` and run it against a snapshot without translating
 * anything. It also passes the shipped pack schema (`packages/packs/schema.json`), so
 * a candidate can be validated the way a pack rule is. Alongside it:
 *
 * | Field | Value | Why |
 * |---|---|---|
 * | `kind` | `learned` | the `patterns` table has no `kind` column; the kind travels inside the rule JSON. Do not infer it from `status`. |
 * | `safety`, `is_safety` | `false` | a learned candidate never carries the safety flag |
 * | `pack_id` | absent from the rule, `null` in the row | a candidate is not from a pack, and the pack schema types `pack_id` as a string |
 * | `matchers.url_domain` | the group's domain | required |
 * | `matchers.url_path` | the group's path, or absent | `url_path` is optional |
 * | `matchers.role` | the group's element role | required |
 * | `matchers.text_any` | the group's element text as one substring, or absent | `text_any` is a case-insensitive substring match, so the exact captured text is the narrowest form the engine offers |
 * | `output.value` | the agreed answer value, typed | what the group agreed on |
 * | `output.confidence` | the same number as the row's `confidence` | one number in two places, so they cannot drift apart |
 * | `mined_from` | `samples`, `decision_ids`, `answer_value`, `question` | which decisions the candidate came from. `samples` always equals `decision_ids.length`, so the record checks itself. |
 *
 * `mined_from.decision_ids` is sorted, so the same group produces byte-identical rule
 * JSON whatever order the rows were read in.
 *
 * The row's `selector` column is left null on purpose. The engine's typed `Rule` has
 * no selector matcher, so a candidate that recorded a selector would read as narrower
 * than what it can actually match.
 *
 * ### What a candidate cannot do yet
 *
 * `PatternEngine.matchForQuestion` validates a candidate answer against the question
 * before returning it, and the validator requires a `choice` answer to carry a
 * distribution over **every** option of the question. The store keeps question text
 * and no options, so a mined `choice` candidate is rejected by that path and returns
 * no hit; a mined `check` or `score` candidate is returned, because neither needs a
 * distribution. Where a distribution for a mined candidate comes from is a decision
 * for the shadow and promotion cards, and this card does not invent one: a
 * distribution over options nobody in the group ever answered would be a fabricated
 * claim. The rule itself is a valid typed rule either way, and `PatternEngine.match`
 * runs it.
 *
 * ## The confidence formula
 *
 * ```
 * confidence = min(MAX_MINED_CONFIDENCE,
 *                  BASE_MINED_CONFIDENCE + MINED_CONFIDENCE_STEP * (agreeing - MIN_AGREEING))
 * ```
 *
 * With the shipped constants: 3 agreeing decisions give 0.5, 4 give 0.6, 5 give 0.7,
 * and 6 or more stay at 0.7.
 *
 * This number is **agreement, not accuracy**. Nothing here has measured how often the
 * candidate is right; the shadow test is what measures that, and a later card
 * recalibrates from user feedback as `docs/SPEC.md` describes. The ceiling of 0.7
 * sits below the 0.8 `auto_at_or_above` that `core/thresholds.ts` uses by default, so
 * a mined candidate stays under the automatic threshold while it is in shadow,
 * whichever card later loads it. That is a second guard on the same promise; the
 * status `shadow` is the first.
 *
 * ## Stable ids
 *
 * The id is `learned-browser-` plus the first 16 hex characters of the SHA-256 of the
 * group's key parts, JSON-encoded in the order of the table above. Nothing in it is a
 * timestamp, a counter or a random value, so mining the same group twice produces the
 * same id and the second run reports `already_mined` instead of a second row. The
 * group is hashed rather than joined into a readable string because every part is
 * page-derived text and no separator is safe against text that contains it.
 *
 * A disagreement in a group that already has a candidate changes nothing here. The
 * group is reported as a disagreement and the existing candidate keeps its status;
 * shadow testing and monitoring are what react to a candidate that stops agreeing.
 *
 * Dependencies: the Node standard library (`node:crypto`) and internal modules only.
 * No new production dependency, so the shipped dependency table is unchanged:
 * `docs/DEPENDENCIES.md` records that in one line.
 */

import { createHash } from 'node:crypto';
import type { DecisionType } from '../../core/schema.js';
import type { Rule } from '../../patterns/types.js';
import type { DatabaseStore, Decision, DecisionSignal, Pattern } from '../../store/index.js';
import { PENDING_ANSWER_MARKER } from '../../tools/reviews.js';

/** Agreeing decisions a group needs before a candidate is created. */
export const MIN_AGREEING = 3;

/** Confidence of a candidate with exactly `MIN_AGREEING` agreeing decisions. */
export const BASE_MINED_CONFIDENCE = 0.5;

/** Added to the confidence for each agreeing decision above `MIN_AGREEING`. */
export const MINED_CONFIDENCE_STEP = 0.1;

/**
 * Ceiling of the mined confidence, below the 0.8 default `auto_at_or_above` in
 * `core/thresholds.ts`. A mined candidate is agreement, not measured accuracy.
 */
export const MAX_MINED_CONFIDENCE = 0.7;

/** Prefix of every mined candidate's id. */
export const LEARNED_PATTERN_ID_PREFIX = 'learned-browser-';

/** Hex characters of the group digest kept in the id. */
export const PATTERN_ID_HASH_LENGTH = 16;

/** Characters of the element text quoted in a candidate's name. */
export const MAX_NAME_TEXT_LENGTH = 32;

/** An answer value as the engine's `RuleOutput.value` carries it. */
export type AnswerValue = string | number | boolean;

/** The signals of one group: what its candidate matches, and what it answers. */
export interface CandidateGroup {
  readonly decision_type: DecisionType;
  readonly domain: string;
  /** Already without query string and fragment. Null when the decision had no URL path. */
  readonly path: string | null;
  readonly element_role: string;
  /** Already redacted and normalised by capture. Null when the element had no text. */
  readonly element_text: string | null;
  /** Already redacted by the decision log. Part of the key, never a matcher. */
  readonly question: string;
}

/** Why one signals row never became part of a group. */
export type MiningRowSkipReason =
  | 'decision_missing'
  | 'correction_row'
  | 'not_slow_path'
  | 'safety_flagged'
  | 'no_domain'
  | 'element_not_targeted'
  | 'no_element_role'
  | 'no_answer_value';

/** Why one group produced no candidate. */
export type MiningGroupSkipReason =
  'disagreement' | 'below_threshold' | 'already_mined' | 'write_failed';

/** One signals row that was not mined, with its reason and how many rows shared it. */
export interface MiningRowSkip {
  readonly reason: MiningRowSkipReason;
  readonly count: number;
}

/** A candidate written to the `patterns` table, and the rule it carries. */
export interface MinedCandidate {
  readonly pattern_id: string;
  readonly group: CandidateGroup;
  /** Agreeing decisions behind the candidate. Equals `decision_ids.length`. */
  readonly samples: number;
  /** Sorted, so the record is the same whatever order the rows were read in. */
  readonly decision_ids: readonly string[];
  readonly answer_value: AnswerValue;
  readonly confidence: number;
  /** The row as stored. `status` is `shadow`. */
  readonly pattern: Pattern;
  /** The rule that was serialised into the row's `rules` JSON, typed. */
  readonly rule: Rule;
}

/** One group that produced no candidate, with the reason it produced none. */
export interface SkippedCandidateGroup {
  /** The id the group would have had, so a skip can be traced back to its group. */
  readonly pattern_id: string;
  readonly group: CandidateGroup;
  readonly samples: number;
  readonly decision_ids: readonly string[];
  /** Every distinct answer value in the group, sorted by its JSON form. */
  readonly answer_values: readonly AnswerValue[];
  readonly reason: MiningGroupSkipReason;
  /** A sentence naming the numbers behind the reason. */
  readonly message: string;
}

/** What one mining run did, and what it did not do. */
export interface MiningReport {
  readonly created: readonly MinedCandidate[];
  readonly skipped: readonly SkippedCandidateGroup[];
  /** Signals rows the run read. */
  readonly rows_read: number;
  /** Rows that joined a group. `rows_read` minus `rows_used` is the row skips. */
  readonly rows_used: number;
  readonly rows_skipped: readonly MiningRowSkip[];
  /** Groups considered: `created.length + skipped.length`. */
  readonly groups: number;
  /** True when a `limit` left rows unread, so the report is not the whole store. */
  readonly truncated: boolean;
  /** The threshold this run used. */
  readonly min_agreeing: number;
}

export interface MineBrowserCandidatesOptions {
  /** Agreeing decisions a group needs. Defaults to `MIN_AGREEING`. */
  readonly minAgreeing?: number;
  /** Most signals rows to read. Unset reads every row. */
  readonly limit?: number;
}

/**
 * The answer value a decision row holds, typed for its declared decision type, or
 * null when it holds none that can be used.
 *
 * The stored answer is the answer. `submit_answers` writes a boolean or a number as
 * `String(value)` and a choice as the option id, and it writes an answer that carries
 * a distribution as `{"value":…,"distribution":…}`; both shapes are read back to the
 * value they hold. The declared decision type then says what that text is, which is
 * why one stored `7` is the number `7` for a `score` and the option id `"7"` for a
 * `choice`.
 *
 * A `pending` decision, an empty answer, and an answer that cannot be typed as its
 * declared type all return null rather than a coerced value.
 */
export function answerValueOf(decision: Decision): AnswerValue | null {
  const stored = decision.answer;
  if (typeof stored !== 'string') return null;
  const trimmed = stored.trim();
  if (trimmed === '' || trimmed === PENDING_ANSWER_MARKER) return null;

  let parsed: unknown;
  let parsedOk = false;
  try {
    parsed = JSON.parse(trimmed);
    parsedOk = true;
  } catch {
    parsedOk = false;
  }

  let candidate: string;
  if (parsedOk && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    // The shape submit_answers writes for an answer with a distribution.
    const record = parsed as Record<string, unknown>;
    if (!('value' in record)) return null;
    const inner = record.value;
    if (typeof inner !== 'string' && typeof inner !== 'number' && typeof inner !== 'boolean') {
      return null;
    }
    return typedForDecisionType(inner, decision.decision_type);
  }
  if (parsedOk && typeof parsed === 'string') {
    candidate = parsed;
  } else {
    candidate = trimmed;
  }

  return typedForDecisionType(candidate, decision.decision_type);
}

/**
 * Types one extracted answer for the decision type it was stored under.
 *
 * A `check` accepts the four spellings the answer validator accepts as a yes or no
 * (`true`, `false`, `yes`, `no`) and reads them as the boolean they mean. A number for
 * a `check` is not read: the validator accepts a probability there, and this store
 * does not say whether the agent meant a probability or a yes or no.
 */
function typedForDecisionType(raw: unknown, type: DecisionType): AnswerValue | null {
  if (type === 'check') {
    if (typeof raw === 'boolean') return raw;
    const spelling = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (spelling === 'true' || spelling === 'yes') return true;
    if (spelling === 'false' || spelling === 'no') return false;
    return null;
  }
  if (type === 'score') {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
      return Number(raw);
    }
    return null;
  }
  if (typeof raw === 'string' && raw.trim() !== '') return raw;
  return null;
}

/** The group's key parts, JSON-encoded in the order the module header lists them. */
function groupKeyJson(group: CandidateGroup): string {
  return JSON.stringify([
    group.decision_type,
    group.domain,
    group.path,
    group.element_role,
    group.element_text,
    group.question,
  ]);
}

/**
 * The candidate id for a group: stable across runs and machines, and derived from the
 * group alone, so mining the same group twice cannot create a second row.
 */
export function candidatePatternId(group: CandidateGroup): string {
  const digest = createHash('sha256').update(groupKeyJson(group)).digest('hex');
  return `${LEARNED_PATTERN_ID_PREFIX}${digest.slice(0, PATTERN_ID_HASH_LENGTH)}`;
}

/** A readable name for a candidate: what it matches, in one line. */
export function candidatePatternName(group: CandidateGroup): string {
  const parts: string[] = [group.domain];
  if (group.path !== null) parts.push(group.path);
  parts.push(group.element_role);
  if (group.element_text !== null) {
    parts.push(`"${group.element_text.slice(0, MAX_NAME_TEXT_LENGTH)}"`);
  }
  return `learned: ${parts.join(' ')}`;
}

/**
 * The confidence a candidate with this many agreeing decisions is written with.
 *
 * Agreement, not measured accuracy. See the formula in the module header.
 */
export function minedConfidence(agreeing: number, minAgreeing: number = MIN_AGREEING): number {
  const steps = Math.max(0, agreeing - minAgreeing);
  const raw = BASE_MINED_CONFIDENCE + MINED_CONFIDENCE_STEP * steps;
  return Number(Math.min(raw, MAX_MINED_CONFIDENCE).toFixed(2));
}

/** One sample: the decision that answered, and the value it answered with. */
interface Sample {
  readonly decision_id: string;
  readonly value: AnswerValue;
}

interface Group {
  readonly group: CandidateGroup;
  readonly pattern_id: string;
  readonly samples: Sample[];
}

type SampleRead =
  | { readonly ok: true; readonly group: CandidateGroup; readonly value: AnswerValue }
  | { readonly ok: false; readonly reason: MiningRowSkipReason };

/**
 * Reads one signals row as a sample, or says why it cannot be one.
 *
 * The reasons are checked in the order the module header lists them, so the report
 * names the first thing that was wrong with the row.
 */
function readSample(store: DatabaseStore, row: DecisionSignal): SampleRead {
  const decision = store.decisions.getById(row.decision_id);
  if (decision === null) return { ok: false, reason: 'decision_missing' };
  if (row.source === 'human_correction') return { ok: false, reason: 'correction_row' };
  if (decision.path !== 'ai') return { ok: false, reason: 'not_slow_path' };
  if (decision.is_safety) return { ok: false, reason: 'safety_flagged' };
  if (row.domain === null) return { ok: false, reason: 'no_domain' };
  if (row.element_source !== 'target') return { ok: false, reason: 'element_not_targeted' };
  if (row.element_role === null) return { ok: false, reason: 'no_element_role' };

  const value = answerValueOf(decision);
  if (value === null) return { ok: false, reason: 'no_answer_value' };

  return {
    ok: true,
    value,
    group: {
      decision_type: decision.decision_type,
      domain: row.domain,
      path: row.path,
      element_role: row.element_role,
      element_text: row.element_text,
      question: decision.question,
    },
  };
}

/**
 * Builds the typed rule a candidate carries, and the JSON row that holds it.
 *
 * The rule carries its kind and where it came from, and its description states its
 * shadow status and that the confidence is agreement rather than a measured accuracy,
 * because the table it is stored in has no column for any of them and a reader must
 * not have to infer them. `pack_id` is left out rather than set to null: the pack
 * schema types it as a string, and a candidate is not from a pack, so the row's
 * `pack_id` column is where that fact is recorded.
 */
function buildRule(
  group: CandidateGroup,
  patternId: string,
  name: string,
  value: AnswerValue,
  confidence: number,
  decisionIds: readonly string[],
): Rule {
  const where = group.path === null ? group.domain : `${group.domain}${group.path}`;
  return {
    id: patternId,
    name,
    kind: 'learned',
    safety: false,
    is_safety: false,
    description:
      `Mined from ${decisionIds.length} agreeing ${group.decision_type} decisions on ` +
      `${where}, asked the same question about an element with the same role, and ` +
      `the same text when it had any. Shadow status: not loaded on the fast path, and ` +
      `the value is agreement, not a measured accuracy.`,
    matchers: {
      url_domain: group.domain,
      ...(group.path !== null ? { url_path: group.path } : {}),
      role: group.element_role,
      ...(group.element_text !== null ? { text_any: [group.element_text] } : {}),
    },
    output: {
      type: group.decision_type,
      decision_type: group.decision_type,
      value,
      confidence,
    },
    mined_from: {
      samples: decisionIds.length,
      decision_ids: [...decisionIds],
      answer_value: value,
      question: group.question,
    },
  };
}

/**
 * Mines one candidate per group of agreeing browser decisions.
 *
 * Reads every `decision_signals` row (or `limit` of them), joins each to its decision
 * for the answer, groups the rows that survive, and writes a `shadow` candidate for
 * every group that agreed, reached `minAgreeing` and has no candidate yet. Every
 * group that produced nothing is reported with the reason.
 *
 * Nothing here runs a candidate, and nothing in the repository calls this function.
 *
 * @param store The store to read decisions and signals from and to write patterns to.
 * @param options `minAgreeing` (default `MIN_AGREEING`) and `limit`.
 * @returns What was created, what was skipped and why, and how many rows went into
 *   groups. `truncated` says whether a `limit` left rows unread.
 */
export function mineBrowserCandidates(
  store: DatabaseStore,
  options: MineBrowserCandidatesOptions = {},
): MiningReport {
  const minAgreeing = options.minAgreeing ?? MIN_AGREEING;
  const rows = store.signals.list(options.limit === undefined ? {} : { limit: options.limit });
  // Counted without the limit so `truncated` says rows were left unread, rather than
  // saying so whenever the limit happened to equal the number of rows there are.
  const rowsAvailable = options.limit === undefined ? rows.length : store.signals.count();

  const groups = new Map<string, Group>();
  const rowSkipCounts = new Map<MiningRowSkipReason, number>();
  let rowsUsed = 0;

  for (const row of rows) {
    const read = readSample(store, row);
    if (!read.ok) {
      rowSkipCounts.set(read.reason, (rowSkipCounts.get(read.reason) ?? 0) + 1);
      continue;
    }
    rowsUsed += 1;

    const key = groupKeyJson(read.group);
    const existing = groups.get(key);
    if (existing) {
      existing.samples.push({ decision_id: row.decision_id, value: read.value });
    } else {
      groups.set(key, {
        group: read.group,
        pattern_id: candidatePatternId(read.group),
        samples: [{ decision_id: row.decision_id, value: read.value }],
      });
    }
  }

  const created: MinedCandidate[] = [];
  const skipped: SkippedCandidateGroup[] = [];

  // Sorted by id so the report does not depend on the order the rows were read in.
  const ordered = [...groups.values()].sort((a, b) => a.pattern_id.localeCompare(b.pattern_id));

  for (const entry of ordered) {
    const { group, pattern_id: patternId, samples } = entry;
    const decisionIds = samples.map((sample) => sample.decision_id).sort();
    // Sorted by JSON form so the report reads the same whatever order the rows came
    // back in.
    const answerValues: AnswerValue[] = [...new Set(samples.map((sample) => sample.value))].sort(
      (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );

    const base = {
      pattern_id: patternId,
      group,
      samples: samples.length,
      decision_ids: decisionIds,
      answer_values: answerValues,
    };

    if (answerValues.length > 1) {
      skipped.push({
        ...base,
        reason: 'disagreement',
        message:
          `The group holds ${samples.length} decisions with ` +
          `${answerValues.length} different answer values (${answerValues
            .map((value) => JSON.stringify(value))
            .join(', ')}). No candidate is created for a group that disagrees.`,
      });
      continue;
    }

    if (samples.length < minAgreeing) {
      skipped.push({
        ...base,
        reason: 'below_threshold',
        message:
          `The group holds ${samples.length} agreeing decisions and ${minAgreeing} are ` +
          `needed. Nothing is created from fewer.`,
      });
      continue;
    }

    const agreed = answerValues[0]!;
    const confidence = minedConfidence(samples.length, minAgreeing);
    const name = candidatePatternName(group);
    const rule = buildRule(group, patternId, name, agreed, confidence, decisionIds);

    try {
      if (store.patterns.getById(patternId) !== null) {
        skipped.push({
          ...base,
          reason: 'already_mined',
          message:
            `A pattern with this id is already stored, so mining this group again would ` +
            `duplicate it. This card does not revise an existing candidate.`,
        });
        continue;
      }

      const pattern = store.patterns.create({
        id: patternId,
        pack_id: null,
        name,
        domain: group.domain,
        url_pattern: group.path,
        // The engine's typed Rule has no selector matcher, so a candidate that recorded
        // a selector would read as narrower than what it can match.
        selector: null,
        decision_type: group.decision_type,
        rules: JSON.stringify(rule),
        status: 'shadow',
        confidence,
        is_safety: false,
      });

      created.push({
        pattern_id: patternId,
        group,
        samples: samples.length,
        decision_ids: decisionIds,
        answer_value: agreed,
        confidence,
        pattern,
        rule,
      });
    } catch (error) {
      skipped.push({
        ...base,
        reason: 'write_failed',
        message: `The candidate could not be stored: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  const rows_skipped: MiningRowSkip[] = [...rowSkipCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => a.reason.localeCompare(b.reason));

  return {
    created,
    skipped,
    rows_read: rows.length,
    rows_used: rowsUsed,
    rows_skipped,
    groups: created.length + skipped.length,
    truncated: rowsAvailable > rows.length,
    min_agreeing: minAgreeing,
  };
}
