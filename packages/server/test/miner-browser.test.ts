/**
 * The browser miner: one candidate per group of agreeing browser decisions.
 *
 * Every value here is invented. Two tests are the ones the card asks to be saboted:
 * *creates nothing from fewer than MIN_AGREEING decisions* holds the threshold, and
 * *creates nothing from a group where one decision disagrees* holds the
 * no-disagreement rule. Both were sabotaged and both failed; see the commit message.
 *
 * Most cases write decisions straight through the repository and then run capture,
 * so the row the miner reads is a row capture really wrote. The headline case goes
 * through `decide` and `submit_answers` instead, to show that a candidate comes out
 * of the loop as the server actually runs it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_MINED_CONFIDENCE,
  MIN_AGREEING,
  answerValueOf,
  candidatePatternId,
  mineBrowserCandidates,
  minedConfidence,
} from '../src/learning/miners/browser.js';
import { captureDecisionSignals } from '../src/learning/capture.js';
import { createPatternEngine } from '../src/patterns/index.js';
import { validatePackObject } from '../src/patterns/loader.js';
import type { Rule } from '../src/patterns/types.js';
import { executeDecide } from '../src/tools/decide.js';
import { executeFeedback } from '../src/tools/feedback.js';
import { executeSubmitAnswers } from '../src/tools/submit_answers.js';
import { createStore, type DatabaseStore, type DecisionSignal } from '../src/store/index.js';
import { DEFAULT_THRESHOLDS } from '../src/core/thresholds.js';
import { validateAnswer, type Question } from '../src/core/schema.js';

const POPUP_URL = 'https://shop.example.com/cart';
const POPUP_QUESTION = 'What kind of dialog is visible?';

interface SlowDecision {
  readonly answer?: string;
  readonly role?: string | null;
  readonly text?: string | null;
  readonly url?: string | null;
  readonly domain?: string | null;
  readonly question?: string;
  readonly decisionType?: 'choice' | 'score' | 'check';
  readonly isSafety?: boolean;
  readonly elementSource?: 'target' | 'first_snapshot_element';
  readonly target?: Record<string, unknown> | null;
}

/**
 * Stores one slow decision the way the tools do: a row with path `ai`, its signals
 * captured, and nothing in the signals that the decision row does not also hold.
 */
function recordSlowDecision(store: DatabaseStore, spec: SlowDecision = {}): string {
  const url = spec.url === undefined ? POPUP_URL : spec.url;
  const domain = spec.domain === undefined ? 'shop.example.com' : spec.domain;
  const role = spec.role === undefined ? 'dialog' : spec.role;
  const text = spec.text === undefined ? 'Subscribe to our newsletter' : spec.text;
  const context: Record<string, unknown> = {};
  if (url !== null) context.url = url;
  if (spec.target !== undefined) {
    context.target = spec.target;
  } else if (role !== null || text !== null) {
    context.target = { ...(role !== null ? { role } : {}), ...(text !== null ? { text } : {}) };
  }

  const decision = store.decisions.create({
    url,
    domain,
    decision_type: spec.decisionType ?? 'choice',
    question: spec.question ?? POPUP_QUESTION,
    context: JSON.stringify(context),
    answer: spec.answer ?? 'promo',
    confidence: 0.9,
    path: 'ai',
    is_safety: spec.isSafety ?? false,
  });

  const outcome = captureDecisionSignals({ store, decision, source: 'slow_path_answer' });
  expect(outcome.stored).toBe(true);

  if (spec.elementSource !== undefined) {
    store.db
      .prepare('UPDATE decision_signals SET element_source = ? WHERE decision_id = ?')
      .run(spec.elementSource, decision.id);
  }

  return decision.id;
}

/** The rules JSON of a stored candidate, read back as the engine's typed rule. */
function storedRule(store: DatabaseStore, patternId: string): Rule {
  const row = store.patterns.getById(patternId);
  expect(row).not.toBeNull();
  return JSON.parse(row!.rules) as Rule;
}

describe('browser miner', () => {
  let tempDir: string;
  let store: DatabaseStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-miner-'));
    store = createStore(join(tempDir, 'test.db'));
  });

  afterEach(() => {
    if (store) {
      store.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates one candidate with status shadow from three agreeing decisions', async () => {
    // The card's headline case, run through the tools: three slow answers to the same
    // question about the same element on the same page.
    const question = {
      id: 'q_popup',
      type: 'choice',
      text: POPUP_QUESTION,
      options: [{ id: 'cookie_banner' }, { id: 'promo' }, { id: 'login_wall' }, { id: 'none' }],
    };
    const state = (round: number) => ({
      url: POPUP_URL,
      // Three visits to the same popup. The selector differs each time, so exact-match
      // memory does not answer the second and third call from the first: the point is
      // three slow answers, and the selector is not part of the group or the match.
      target: { role: 'Dialog', text: 'Subscribe to our newsletter', selector: `#modal-${round}` },
    });

    for (let round = 0; round < MIN_AGREEING; round += 1) {
      const routed = await executeDecide({ questions: [question], state: state(round) }, { store });
      expect(routed.needs_ai).toHaveLength(1);
      const submitted = await executeSubmitAnswers(
        {
          answers: [
            { decision_id: routed.needs_ai[0]!.decision_id, value: 'promo', confidence: 0.9 },
          ],
        },
        { store },
      );
      expect(submitted.answers).toHaveLength(1);
    }

    expect(store.decisions.count()).toBe(3);
    expect(store.signals.count()).toBe(3);
    expect(store.patterns.list()).toHaveLength(0);

    const report = mineBrowserCandidates(store);

    expect(report.rows_read).toBe(3);
    expect(report.rows_used).toBe(3);
    expect(report.rows_skipped).toEqual([]);
    expect(report.groups).toBe(1);
    expect(report.skipped).toEqual([]);
    expect(report.truncated).toBe(false);
    expect(report.min_agreeing).toBe(MIN_AGREEING);
    expect(report.created).toHaveLength(1);

    const candidate = report.created[0]!;
    expect(candidate.samples).toBe(MIN_AGREEING);
    expect(candidate.decision_ids).toHaveLength(MIN_AGREEING);
    expect(candidate.answer_value).toBe('promo');

    // The row itself, read back from the table the miner wrote to.
    const row = store.patterns.getById(candidate.pattern_id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('shadow');
    expect(row!.is_safety).toBe(0);
    expect(row!.pack_id).toBeNull();
    expect(row!.domain).toBe('shop.example.com');
    expect(row!.url_pattern).toBe('/cart');
    expect(row!.decision_type).toBe('choice');
    expect(row!.confidence).toBe(minedConfidence(MIN_AGREEING));

    // Three agreeing decisions at the base of the formula, and nothing else.
    expect(row!.confidence).toBe(0.5);
  });

  it('records what the candidate matched and which decisions it came from', () => {
    const ids = [recordSlowDecision(store), recordSlowDecision(store), recordSlowDecision(store)];

    const report = mineBrowserCandidates(store);
    expect(report.created).toHaveLength(1);

    const candidate = report.created[0]!;
    expect(candidate.group).toEqual({
      decision_type: 'choice',
      domain: 'shop.example.com',
      path: '/cart',
      element_role: 'dialog',
      element_text: 'Subscribe to our newsletter',
      question: POPUP_QUESTION,
    });

    // Every decision in the group, so the record can be checked against the store.
    const rule = storedRule(store, candidate.pattern_id);
    const minedFrom = rule.mined_from as {
      samples: number;
      decision_ids: string[];
      answer_value: string;
      question: string;
    };
    expect(minedFrom.decision_ids).toEqual([...ids].sort());
    expect(minedFrom.samples).toBe(ids.length);
    expect(minedFrom.answer_value).toBe('promo');
    expect(minedFrom.question).toBe(POPUP_QUESTION);

    // The kind travels in the rule JSON: the patterns table has no kind column, so a
    // reader must not infer it from status.
    expect(rule.kind).toBe('learned');
    expect(rule.safety).toBe(false);
    expect(rule.is_safety).toBe(false);
    // A candidate is not from a pack, so the rule does not name one and the column is
    // where that fact is recorded.
    expect(rule.pack_id).toBeUndefined();
    expect(candidate.pattern.pack_id).toBeNull();

    // The match is the group's own signals and nothing wider.
    expect(rule.matchers).toEqual({
      url_domain: 'shop.example.com',
      url_path: '/cart',
      role: 'dialog',
      text_any: ['Subscribe to our newsletter'],
    });
    expect(rule.output).toEqual({
      type: 'choice',
      decision_type: 'choice',
      value: 'promo',
      confidence: 0.5,
    });

    // One confidence in two places, so they cannot drift apart.
    expect(rule.output.confidence).toBe(candidate.pattern.confidence);

    // The question is part of the key, not a matcher: the store keeps question text,
    // and the engine's only question matchers take a question id.
    expect(rule.matchers.question_id).toBeUndefined();
    expect(rule.matchers.target_question_id).toBeUndefined();

    // The record states its own status and where it came from, so nobody has to infer
    // it from the column.
    expect(rule.description).toContain('3 agreeing choice decisions');
    expect(rule.description).toContain('shop.example.com/cart');
    expect(rule.description).toContain('Shadow status');

    // No selector matcher exists in the engine, so the column stays empty rather than
    // describing the candidate as narrower than it is.
    expect(candidate.pattern.selector).toBeNull();
    expect(candidate.pattern.name).toBe(
      'learned: shop.example.com /cart dialog "Subscribe to our newsletter"',
    );
  });

  it('creates nothing from fewer than MIN_AGREEING decisions', () => {
    recordSlowDecision(store);
    recordSlowDecision(store);

    const report = mineBrowserCandidates(store);

    expect(report.rows_used).toBe(2);
    expect(report.created).toEqual([]);
    expect(store.patterns.list()).toEqual([]);

    expect(report.skipped).toHaveLength(1);
    const skipped = report.skipped[0]!;
    expect(skipped.reason).toBe('below_threshold');
    expect(skipped.samples).toBe(2);
    expect(skipped.answer_values).toEqual(['promo']);
    expect(skipped.message).toContain('2 agreeing decisions');
    expect(skipped.message).toContain(`${MIN_AGREEING} are needed`);

    // One more agreeing decision is what it takes, and then it is created.
    recordSlowDecision(store);
    const second = mineBrowserCandidates(store);
    expect(second.created).toHaveLength(1);
    expect(second.created[0]!.samples).toBe(3);
  });

  it('creates nothing from a group where one decision disagrees', () => {
    recordSlowDecision(store, { answer: 'promo' });
    recordSlowDecision(store, { answer: 'promo' });
    // The model answered promo twice and the third time something else. A group like
    // this is the one the shadow test exists to measure, and this card does not get to
    // decide the answer in advance: no candidate, not even one for the majority value.
    recordSlowDecision(store, { answer: 'none' });

    const report = mineBrowserCandidates(store);

    expect(report.rows_used).toBe(3);
    expect(report.created).toEqual([]);
    expect(store.patterns.list()).toEqual([]);
    expect(report.skipped).toHaveLength(1);

    const skipped = report.skipped[0]!;
    expect(skipped.reason).toBe('disagreement');
    expect(skipped.samples).toBe(3);
    expect(skipped.answer_values).toEqual(['none', 'promo']);
    expect(skipped.message).toContain('2 different answer values');
    expect(skipped.message).toContain('No candidate is created for a group that disagrees');

    // A group that is both below the threshold and disagrees is reported as a
    // disagreement, which is the more useful thing to read. This fourth decision is on
    // the same element with a third answer value.
    recordSlowDecision(store, { answer: 'cookie_banner' });
    const second = mineBrowserCandidates(store);
    const disagreeing = second.skipped.filter((entry) => entry.reason === 'disagreement');
    expect(disagreeing).toHaveLength(1);
    expect(disagreeing[0]!.samples).toBe(4);
    expect(disagreeing[0]!.answer_values).toEqual(['cookie_banner', 'none', 'promo']);

    // Three of those four answers agree, and a majority is still not a candidate.
    // Lowering the threshold does not make one either: the no-disagreement rule is
    // checked before the count.
    const lowered = mineBrowserCandidates(store, { minAgreeing: 1 });
    expect(lowered.created).toEqual([]);
    expect(lowered.skipped.every((entry) => entry.reason === 'disagreement')).toBe(true);
  });

  it('mines the same group twice without writing a second row', () => {
    for (let round = 0; round < MIN_AGREEING; round += 1) {
      recordSlowDecision(store);
    }

    const first = mineBrowserCandidates(store);
    expect(first.created).toHaveLength(1);
    const patternId = first.created[0]!.pattern_id;

    // The id comes from the group alone, so a second run over the same rows is the
    // same candidate rather than a near-duplicate of it.
    expect(patternId).toBe(candidatePatternId(first.created[0]!.group));
    expect(patternId.startsWith('learned-browser-')).toBe(true);

    const second = mineBrowserCandidates(store);
    expect(second.created).toEqual([]);
    expect(store.patterns.list()).toHaveLength(1);
    expect(store.patterns.getById(patternId)?.status).toBe('shadow');

    expect(second.skipped).toHaveLength(1);
    expect(second.skipped[0]!.reason).toBe('already_mined');
    expect(second.skipped[0]!.pattern_id).toBe(patternId);
  });

  it('writes a match the pattern engine can run as a typed rule', () => {
    for (let round = 0; round < MIN_AGREEING; round += 1) {
      recordSlowDecision(store);
    }
    const candidate = mineBrowserCandidates(store).created[0]!;

    // Exactly what the shadow card will do: read the rules JSON and hand it to the
    // engine, with no translation in between.
    const rule = storedRule(store, candidate.pattern_id);
    const engine = createPatternEngine([rule]);

    const hit = engine.match({
      url: POPUP_URL,
      target: { role: 'Dialog', text: 'Subscribe to our newsletter' },
      elements: [{ role: 'dialog', text: 'Subscribe to our newsletter' }],
    });

    expect(hit).not.toBeNull();
    expect(hit!.pattern_id).toBe(candidate.pattern_id);
    expect(hit!.is_safety).toBe(false);
    expect(hit!.output.value).toBe('promo');

    // The same page with a different role does not match: the match is a conjunction.
    const otherRole = engine.match({
      url: POPUP_URL,
      elements: [{ role: 'banner', text: 'Subscribe to our newsletter' }],
    });
    expect(otherRole).toBeNull();

    // And another site's identical popup does not match either.
    const otherSite = engine.match({
      url: 'https://other.example.org/cart',
      elements: [{ role: 'dialog', text: 'Subscribe to our newsletter' }],
    });
    expect(otherSite).toBeNull();

    // The same path on the same host with the same element matches, which is what the
    // group was built from and the whole of what it claims.
    const sameAgain = engine.match({
      url: POPUP_URL,
      elements: [{ role: 'dialog', text: 'Subscribe to our newsletter' }],
    });
    expect(sameAgain?.pattern_id).toBe(candidate.pattern_id);

    // The rule also passes the shipped pack schema, so a candidate is validated the
    // way a pack rule is. `pack_id` is left out of the rule for exactly this reason.
    const errors = validatePackObject(
      {
        id: candidate.pattern_id,
        name: candidate.pattern.name,
        version: '0.0.1',
        rules: [rule],
      },
      'learned-candidate.yaml',
    );
    expect(errors).toEqual([]);
  });

  it('answers a check question through matchForQuestion and not a choice one', () => {
    // Two groups on the same page: a check about the Pay button and a choice about the
    // newsletter dialog. Different decision type, role, text and question, so they are
    // two candidates and not one group with a disagreement in it.
    for (let round = 0; round < MIN_AGREEING; round += 1) {
      recordSlowDecision(store, {
        decisionType: 'check',
        answer: 'true',
        role: 'button',
        text: 'Pay',
        question: 'Is this button safe to click?',
      });
      recordSlowDecision(store, { role: 'dialog', text: 'Subscribe to our newsletter' });
    }

    const report = mineBrowserCandidates(store);
    expect(report.created).toHaveLength(2);
    const checkCandidate = report.created.find((entry) => entry.answer_value === true)!;
    const choiceCandidate = report.created.find((entry) => entry.answer_value === 'promo')!;
    expect(checkCandidate.group.decision_type).toBe('check');
    expect(choiceCandidate.group.decision_type).toBe('choice');

    const engine = createPatternEngine([
      storedRule(store, checkCandidate.pattern_id),
      storedRule(store, choiceCandidate.pattern_id),
    ]);
    const buttonSnapshot = { url: POPUP_URL, elements: [{ role: 'button', text: 'Pay' }] };
    const dialogSnapshot = {
      url: POPUP_URL,
      elements: [{ role: 'dialog', text: 'Subscribe to our newsletter' }],
    };
    const checkQuestion: Question = {
      id: 'q_pay',
      type: 'check',
      text: 'Is this button safe to click?',
    };
    const choiceQuestion: Question = {
      id: 'q_popup',
      type: 'choice',
      text: POPUP_QUESTION,
      options: [{ id: 'promo' }, { id: 'none' }],
    };

    // A check answer needs no distribution, so the candidate is returned by the same
    // call core/router.ts makes. threshold 0 is what the router passes: it compares
    // the confidence against the thresholds itself.
    const checkHit = engine.matchForQuestion(buttonSnapshot, checkQuestion, { threshold: 0 });
    expect(checkHit).not.toBeNull();
    expect(checkHit!.pattern_id).toBe(checkCandidate.pattern_id);
    expect(checkHit!.is_safety).toBe(false);
    expect(checkHit!.output.value).toBe(true);

    // The check candidate does not answer the choice question, and the choice candidate
    // does not answer the check: a candidate is typed to the question it was mined for.
    expect(engine.matchForQuestion(buttonSnapshot, choiceQuestion, { threshold: 0 })).toBeNull();

    // A choice answer does need a distribution, over every option of the question, and
    // the store keeps question text and no options. So a mined choice candidate is
    // rejected by this call, and the reason is exactly the distribution: the same
    // candidate passes validation the moment a distribution is not demanded.
    const choiceHit = engine.matchForQuestion(dialogSnapshot, choiceQuestion, { threshold: 0 });
    expect(choiceHit).toBeNull();

    const choiceAnswer = {
      value: choiceCandidate.answer_value,
      confidence: choiceCandidate.confidence,
      path: 'pattern' as const,
      pattern_id: choiceCandidate.pattern_id,
    };
    const rejected = validateAnswer(choiceQuestion, choiceAnswer);
    expect(rejected.success).toBe(false);
    expect(rejected.success === false && rejected.reason).toContain('distribution');
    expect(
      validateAnswer(choiceQuestion, choiceAnswer, { requireDistribution: false }).success,
    ).toBe(true);

    // Nothing invents that distribution here: a spread over options no decision in the
    // group ever answered would be a fabricated claim. Where it comes from is the
    // shadow and promotion cards' decision, and this test is the record that the
    // candidate does not answer a choice question until then.
    expect(choiceCandidate.rule.output.distribution).toBeUndefined();
  });

  it('reads a check answer back as the boolean the tool stored', () => {
    recordSlowDecision(store, {
      decisionType: 'check',
      answer: 'true',
      role: 'button',
      text: 'Pay',
    });
    recordSlowDecision(store, {
      decisionType: 'check',
      answer: 'true',
      role: 'button',
      text: 'Pay',
    });
    // The same answer stored with a distribution, the way submit_answers writes one
    // when the agent supplies it. It agreed on the value; the distribution is
    // confidence detail and is not agreement.
    recordSlowDecision(store, {
      decisionType: 'check',
      answer: JSON.stringify({ value: true, distribution: { true: 1, false: 0 } }),
      role: 'button',
      text: 'Pay',
    });

    const report = mineBrowserCandidates(store);

    expect(report.created).toHaveLength(1);
    expect(report.created[0]!.answer_value).toBe(true);
    expect(report.skipped).toEqual([]);
    expect(storedRule(store, report.created[0]!.pattern_id).output.value).toBe(true);

    // The answer value is typed from the declared decision type, and nothing is
    // coerced: a word is not a score and a number is not a check. One stored `7` is the
    // number 7 under `score` and the option id "7" under `choice`.
    const typed = store.decisions.create({
      decision_type: 'score',
      question: 'How risky is this?',
      answer: '7',
      confidence: 0.9,
      path: 'ai',
    });
    expect(answerValueOf(typed)).toBe(7);
    expect(answerValueOf({ ...typed, decision_type: 'check' })).toBeNull();
    expect(answerValueOf({ ...typed, decision_type: 'choice' })).toBe('7');
    expect(answerValueOf({ ...typed, answer: 'pending' })).toBeNull();
    expect(answerValueOf({ ...typed, answer: '' })).toBeNull();
    expect(answerValueOf({ ...typed, decision_type: 'score', answer: 'quite risky' })).toBeNull();
    // A stored object with no value says nothing about which value was answered.
    expect(answerValueOf({ ...typed, answer: '{"confidence":0.9}' })).toBeNull();
  });

  it('reads the yes and no spellings of a check as the boolean they mean', () => {
    const base = store.decisions.create({
      decision_type: 'check',
      question: 'Is this button safe to click?',
      answer: 'true',
      confidence: 0.9,
      path: 'ai',
    });

    // The four spellings the answer validator accepts as a yes or no are one answer.
    for (const spelling of ['true', 'yes', 'TRUE', ' Yes ']) {
      expect(answerValueOf({ ...base, answer: spelling })).toBe(true);
    }
    for (const spelling of ['false', 'no', 'FALSE', ' No ']) {
      expect(answerValueOf({ ...base, answer: spelling })).toBe(false);
    }

    // A number for a check is not read: the validator accepts a probability there and
    // the store does not say which the agent meant, so nothing is guessed.
    expect(answerValueOf({ ...base, answer: '0.8' })).toBeNull();
    expect(answerValueOf({ ...base, answer: 'maybe' })).toBeNull();
  });

  it('does not learn from a corrected decision or from a fast path', async () => {
    // Two of three decisions a person disagreed with. feedback leaves the decision row
    // exactly as it was written and stores the correction in feedback.correct_value,
    // so the answer the decision row holds is the one that was corrected. Mining it
    // would count a disputed answer as agreement.
    const decisionIds = [recordSlowDecision(store), recordSlowDecision(store)];
    recordSlowDecision(store);

    for (const id of decisionIds) {
      const feedback = await executeFeedback({ decision_id: id, correct_value: 'none' }, { store });
      expect(feedback.status).toBe('recorded');
    }

    // One row per decision: the correction rewrites the row rather than adding a
    // second sample of the same decision.
    expect(store.signals.count()).toBe(3);
    const corrected = store.signals.list().filter((row) => row.source === 'human_correction');
    expect(corrected).toHaveLength(2);

    const afterCorrection = mineBrowserCandidates(store);
    expect(afterCorrection.created).toEqual([]);
    expect(afterCorrection.rows_used).toBe(1);
    expect(afterCorrection.rows_skipped).toEqual([{ reason: 'correction_row', count: 2 }]);
    expect(afterCorrection.skipped).toHaveLength(1);
    expect(afterCorrection.skipped[0]!.reason).toBe('below_threshold');
    expect(store.patterns.list()).toEqual([]);

    // A row that says the slow path answered it while its decision row carries a fast
    // path is a row that misdescribes itself. Capture refuses to write one (it skips a
    // `slow_path_answer` capture of a decision the slow path did not answer), so the
    // test writes the row directly to prove nothing is learned from it.
    for (let round = 0; round < 3; round += 1) {
      const fast = store.decisions.create({
        url: POPUP_URL,
        domain: 'shop.example.com',
        decision_type: 'choice',
        question: POPUP_QUESTION,
        context: JSON.stringify({
          url: POPUP_URL,
          target: { role: 'dialog', text: 'Subscribe to our newsletter' },
        }),
        answer: 'promo',
        confidence: 0.9,
        path: 'pattern',
      });
      const refused = captureDecisionSignals({ store, decision: fast, source: 'slow_path_answer' });
      expect(refused.stored).toBe(false);

      store.signals.upsert({
        decision_id: fast.id,
        domain: 'shop.example.com',
        path: '/cart',
        element_role: 'dialog',
        element_text: 'Subscribe to our newsletter',
        element_source: 'target',
        selector: null,
        tokens: ['dialog'],
        source: 'slow_path_answer',
      });
    }

    const report = mineBrowserCandidates(store);
    expect(report.created).toEqual([]);
    expect(report.rows_used).toBe(1);
    expect(report.rows_skipped).toEqual([
      { reason: 'correction_row', count: 2 },
      { reason: 'not_slow_path', count: 3 },
    ]);
    expect(store.patterns.list()).toEqual([]);
  });

  it('skips a row that cannot name what a candidate would match', () => {
    // The signals are the first element of the snapshot, which capture itself says is
    // not necessarily the element the decision was about.
    recordSlowDecision(store, { elementSource: 'first_snapshot_element' });
    recordSlowDecision(store, { elementSource: 'first_snapshot_element' });
    recordSlowDecision(store, { elementSource: 'first_snapshot_element' });

    // A row with no domain would produce a candidate matching every site.
    recordSlowDecision(store, { domain: null, url: null, target: { role: 'dialog' } });
    recordSlowDecision(store, { domain: null, url: null, target: { role: 'dialog' } });
    recordSlowDecision(store, { domain: null, url: null, target: { role: 'dialog' } });

    // A row whose element carried no role.
    for (let round = 0; round < 3; round += 1) {
      recordSlowDecision(store, { role: null, text: 'Subscribe to our newsletter' });
    }

    // A decision still waiting for an answer has nothing to agree with.
    for (let round = 0; round < 3; round += 1) {
      recordSlowDecision(store, { answer: 'pending' });
    }

    // A decision a safety rule answered. A learned candidate never carries the safety
    // flag, so one mined from here would record a safety answer as an ordinary one.
    for (let round = 0; round < 3; round += 1) {
      recordSlowDecision(store, { answer: 'ask_user', isSafety: true });
    }

    // A signals row whose decision row is gone. Foreign keys are switched off for the
    // delete so the row survives, because the join has to survive it: the report says
    // the row was not mined rather than mining a group with no answer behind it.
    store.db.pragma('foreign_keys = OFF');
    for (let round = 0; round < 3; round += 1) {
      const id = recordSlowDecision(store);
      store.decisions.delete(id);
    }
    store.db.pragma('foreign_keys = ON');

    const report = mineBrowserCandidates(store);

    expect(report.created).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.groups).toBe(0);
    expect(report.rows_read).toBe(18);
    expect(report.rows_used).toBe(0);
    expect(report.rows_skipped).toEqual([
      { reason: 'decision_missing', count: 3 },
      { reason: 'element_not_targeted', count: 3 },
      { reason: 'no_answer_value', count: 3 },
      { reason: 'no_domain', count: 3 },
      { reason: 'no_element_role', count: 3 },
      { reason: 'safety_flagged', count: 3 },
    ]);
  });

  it('keeps a candidate under the automatic threshold while it is in shadow', () => {
    for (let round = 0; round < 10; round += 1) {
      recordSlowDecision(store);
    }

    const candidate = mineBrowserCandidates(store).created[0]!;

    // Ten agreeing decisions is the strongest evidence this card can act on, and it is
    // still under the default auto_at_or_above: the confidence is agreement, not a
    // measured accuracy, and the shadow test is what measures that.
    expect(candidate.samples).toBe(10);
    expect(candidate.confidence).toBe(MAX_MINED_CONFIDENCE);
    expect(candidate.confidence).toBeLessThan(DEFAULT_THRESHOLDS.choice.auto_at_or_above);
    expect(minedConfidence(3)).toBe(0.5);
    expect(minedConfidence(4)).toBe(0.6);
    expect(minedConfidence(5)).toBe(0.7);
    expect(minedConfidence(6)).toBe(0.7);
    expect(minedConfidence(99)).toBe(0.7);
    expect(storedRule(store, candidate.pattern_id).output.confidence).toBe(0.7);
  });

  it('omits the optional matchers when the group had no path or no text', () => {
    for (let round = 0; round < MIN_AGREEING; round += 1) {
      recordSlowDecision(store, { url: null, text: null });
    }

    const candidate = mineBrowserCandidates(store).created[0]!;
    expect(candidate.group.path).toBeNull();
    expect(candidate.group.element_text).toBeNull();
    expect(storedRule(store, candidate.pattern_id).matchers).toEqual({
      url_domain: 'shop.example.com',
      role: 'dialog',
    });
  });

  it('reports a truncated read instead of claiming the whole store', () => {
    for (let round = 0; round < 6; round += 1) {
      recordSlowDecision(store);
    }
    expect(store.signals.count()).toBe(6);

    const full = mineBrowserCandidates(store);
    expect(full.truncated).toBe(false);
    expect(full.rows_read).toBe(6);
    expect(full.created).toHaveLength(1);

    const limited = mineBrowserCandidates(store, { limit: 2 });
    expect(limited.truncated).toBe(true);
    expect(limited.rows_read).toBe(2);

    // A limit that happens to equal the number of rows there are cut nothing, so the
    // report does not say it did.
    const exact = mineBrowserCandidates(store, { limit: 6 });
    expect(exact.rows_read).toBe(6);
    expect(exact.truncated).toBe(false);
  });

  it('reports a failed write instead of a candidate that is not there', () => {
    for (let round = 0; round < MIN_AGREEING; round += 1) {
      recordSlowDecision(store);
    }

    store.db.exec('DROP TABLE patterns');

    const report = mineBrowserCandidates(store);

    expect(report.created).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]!.reason).toBe('write_failed');
    expect(report.skipped[0]!.message).toContain('could not be stored');
    expect(report.skipped[0]!.samples).toBe(3);
  });

  it('keeps a candidate for one question separate from another on the same page', () => {
    for (let round = 0; round < MIN_AGREEING; round += 1) {
      recordSlowDecision(store, { question: POPUP_QUESTION });
      recordSlowDecision(store, { question: 'Is this button safe to click?', answer: 'true' });
    }

    const report = mineBrowserCandidates(store);

    // Same domain, same path, same element, different question: two groups, two
    // candidates. Neither is a disagreement with the other.
    expect(report.groups).toBe(2);
    expect(report.created).toHaveLength(2);
    expect(report.skipped).toEqual([]);

    const ids = report.created.map((candidate) => candidate.pattern_id);
    expect(new Set(ids).size).toBe(2);
    expect(report.created.map((candidate) => candidate.answer_value).sort()).toEqual([
      'promo',
      'true',
    ]);
  });

  it('reads the signals row it groups by as the row capture wrote', () => {
    recordSlowDecision(store);
    recordSlowDecision(store);
    recordSlowDecision(store);

    const rows = store.signals.list();
    expect(rows).toHaveLength(3);
    const first = rows[0] as DecisionSignal;
    expect(first.domain).toBe('shop.example.com');
    expect(first.path).toBe('/cart');
    expect(first.element_role).toBe('dialog');
    expect(first.element_source).toBe('target');
  });
});
