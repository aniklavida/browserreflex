/**
 * Confidence calibration: what a rule states about its own certainty, against what
 * feedback found.
 *
 * The values here are invented. Every store is a fresh file in a temporary directory, so
 * nothing in this file reads or writes the real home directory, a real database or any
 * agent configuration.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CALIBRATION_BINS,
  CALIBRATION_HISTORY_LIMIT,
  MIN_SAMPLES,
  calibrate,
  calibrationError,
  confidenceBin,
  readCalibrationHistory,
  summarizeCalibration,
  type CalibrationSample,
  type CalibrationScope,
} from '../src/learning/calibrate.js';
import { createMemory } from '../src/core/memory.js';
import { routeQuestion } from '../src/core/router.js';
import type { DecisionType, Question } from '../src/core/schema.js';
import { createPatternEngine, type Rule } from '../src/patterns/index.js';
import { createStore, type DatabaseStore } from '../src/store/index.js';

const PATTERN_ID = 'pattern-cookie-consent-check';

const CHECK_QUESTION: Question = {
  id: 'q-cookie-banner',
  type: 'check',
  text: 'Is there a cookie banner on this page?',
};

const DIALOG_INPUT = {
  url: 'https://shop.example.com/welcome',
  elements: [{ role: 'dialog', text: 'We use cookies' }],
};

const SAFETY_RULE_ID = 'pattern-payment-ask';
const SAFETY_CHECK_RULE_ID = 'pattern-payment-check';

const PAY_INPUT = {
  url: 'https://shop.example.com/cart',
  elements: [{ role: 'button', text: 'Place order' }],
};

const PAY_QUESTION: Question = {
  id: 'q-pay',
  type: 'choice',
  text: 'Approve payment?',
  options: [
    { id: 'ask_user', description: 'Ask the user to confirm' },
    { id: 'proceed', description: 'Proceed' },
  ],
};

const PAY_CHECK_QUESTION: Question = {
  id: 'q-pay-check',
  type: 'check',
  text: 'Is this a payment action?',
};

/** A safety rule whose answer is a question for the user. */
const SAFETY_ASK_RULE: Rule = {
  id: SAFETY_RULE_ID,
  safety: true,
  matchers: { role: 'button', text_any: ['Place order'] },
  output: {
    decision_type: 'choice',
    value: 'ask_user',
    distribution: { ask_user: 0.99, proceed: 0.01 },
    confidence: 0.99,
  },
};

/** A safety rule whose answer is a verdict of its own, with no user question in it. */
const SAFETY_CHECK_RULE: Rule = {
  id: SAFETY_CHECK_RULE_ID,
  safety: true,
  matchers: { role: 'button', text_any: ['Place order'] },
  output: { decision_type: 'check', value: true, confidence: 0.95 },
};

/** The scope a router question for this rule calibrates within. */
function checkScope(overrides: Partial<CalibrationScope> = {}): CalibrationScope {
  return {
    pattern_id: PATTERN_ID,
    decision_type: 'check',
    ...overrides,
  };
}

/** A history of one rule at one stated confidence, all of it feedback-confirmed. */
function history(params: {
  stated: number;
  correct: number;
  wrong: number;
  pattern_id?: string | null;
  decision_type?: DecisionType;
  path?: string | null;
}): CalibrationSample[] {
  const samples: CalibrationSample[] = [];
  for (let index = 0; index < params.correct + params.wrong; index += 1) {
    samples.push({
      pattern_id: params.pattern_id === undefined ? PATTERN_ID : params.pattern_id,
      decision_type: params.decision_type ?? 'check',
      stated_confidence: params.stated,
      correct: index < params.correct,
      ...(params.path !== undefined ? { path: params.path } : {}),
    });
  }
  return samples;
}

/** A history that lies in one direction, in equal parts, so the error is easy to predict. */
function overconfidentHistory(stated: number, correct: number, wrong: number): CalibrationSample[] {
  return history({ stated, correct, wrong });
}

interface SeedParams {
  patternId?: string;
  decisionType?: DecisionType;
  stated: number;
  correct: number;
  wrong: number;
  /** The stored answer of each seeded decision. */
  answer?: string;
  /** The value the corrections on the wrong ones report. */
  wrongValue?: string;
  isSafety?: boolean;
  /** URL path captured with each seeded decision, for the path-scoped read. */
  capturedPath?: string;
}

/**
 * Writes the feedback-confirmed history of one rule straight through the repositories.
 *
 * The decision log is bypassed on purpose: the rows are the history this card calibrates
 * against, and going through the log would let the log's own redaction and confidence
 * handling stand in for the reader's.
 */
function seedConfirmedHistory(store: DatabaseStore, params: SeedParams): void {
  const patternId = params.patternId ?? PATTERN_ID;
  const decisionType = params.decisionType ?? 'check';
  const answer = params.answer ?? 'true';
  const wrongValue = params.wrongValue ?? 'false';

  if (store.patterns.getById(patternId) === null) {
    store.patterns.create({
      id: patternId,
      name: patternId,
      decision_type: decisionType,
      rules: JSON.stringify({}),
      status: 'active',
      confidence: params.stated,
      is_safety: params.isSafety === true ? 1 : 0,
    });
  }

  const total = params.correct + params.wrong;
  for (let index = 0; index < total; index += 1) {
    const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    const decision = store.decisions.create({
      url: `https://shop.example.com${params.capturedPath ?? '/welcome'}`,
      domain: 'shop.example.com',
      decision_type: decisionType,
      question: CHECK_QUESTION.text,
      answer,
      confidence: params.stated,
      path: 'pattern',
      pattern_id: patternId,
      is_safety: params.isSafety === true ? 1 : 0,
      created_at: createdAt,
    });

    if (params.capturedPath !== undefined) {
      store.signals.upsert({
        decision_id: decision.id,
        domain: 'shop.example.com',
        path: params.capturedPath,
        source: 'human_correction',
      });
    }

    store.feedback.create({
      decision_id: decision.id,
      correct_value: index < params.correct ? answer : wrongValue,
      source: 'user',
      created_at: createdAt,
    });
  }
}

function engineWith(rule: Rule) {
  return createPatternEngine([rule]);
}

const COOKIE_RULE: Rule = {
  id: PATTERN_ID,
  matchers: { role: 'dialog' },
  output: { decision_type: 'check', value: true, confidence: 0.95 },
};

describe('confidence calibration', () => {
  describe('binning and grouping', () => {
    it('bins a stated confidence into one of ten bins, with the edges on the right side', () => {
      expect(CALIBRATION_BINS).toBe(10);
      expect(confidenceBin(0)).toBe(0);
      expect(confidenceBin(0.05)).toBe(0);
      expect(confidenceBin(0.1)).toBe(1);
      expect(confidenceBin(0.55)).toBe(5);
      expect(confidenceBin(0.9)).toBe(9);
      expect(confidenceBin(1)).toBe(9);
      expect(confidenceBin(-1)).toBe(0);
      expect(confidenceBin(4)).toBe(9);
    });

    it('groups by pattern id or path and by decision type', () => {
      const mixed: CalibrationSample[] = [
        ...history({ stated: 0.9, correct: 8, wrong: 2 }),
        ...history({ stated: 0.9, correct: 1, wrong: 9, pattern_id: 'pattern-other' }),
        ...history({ stated: 0.9, correct: 5, wrong: 5, pattern_id: null, path: '/cart' }),
        ...history({ stated: 0.9, correct: 3, wrong: 3, decision_type: 'choice' }),
      ];

      const ruleScope: CalibrationScope = { pattern_id: PATTERN_ID, decision_type: 'check' };
      expect(summarizeCalibration(mixed, ruleScope).samples).toBe(10);

      const pathScope: CalibrationScope = { path: '/cart', decision_type: 'check' };
      expect(summarizeCalibration(mixed, pathScope).samples).toBe(10);

      // No group named pools every sample of the decision type.
      expect(summarizeCalibration(mixed, { decision_type: 'check' }).samples).toBe(30);

      // A pattern id wins over a path when a scope names both.
      const bothScope: CalibrationScope = { ...ruleScope, path: '/cart' };
      expect(summarizeCalibration(mixed, bothScope).samples).toBe(10);
    });

    it('reports each bin with its samples, its accuracy and its mean stated confidence', () => {
      const summary = summarizeCalibration(overconfidentHistory(0.9, 3, 7), checkScope());

      expect(summary.bins).toHaveLength(CALIBRATION_BINS);
      expect(summary.samples).toBe(10);
      expect(summary.correct).toBe(3);

      const bin = summary.bins[9];
      expect(bin).not.toBeUndefined();
      expect(bin?.samples).toBe(10);
      expect(bin?.lower).toBe(0.9);
      expect(bin?.upper).toBe(1);
      expect(bin?.accuracy).toBe(0.3);
      expect(bin?.mean_stated).toBe(0.9);

      const empty = summary.bins[0];
      expect(empty?.samples).toBe(0);
      expect(empty?.accuracy).toBeNull();
    });
  });

  describe('the claim this card makes: "says 90%" meets "right 90%"', () => {
    it('drops the expected calibration error on a replayed overconfident history', () => {
      const samples = overconfidentHistory(0.9, 30, 70);

      const before = calibrationError(samples);
      const after = calibrationError(samples, { calibrated: true });

      // The history states 0.9 in the 0.9 bin and is right 30% of the time, so it is
      // overconfident by 0.6 before anything is done about it.
      expect(before).toBeCloseTo(0.6, 4);
      expect(before).toBeGreaterThan(0.5);

      // The bin holds 100 confirmed answers, so its own accuracy is what it is read as.
      expect(after).toBeLessThan(before / 2);
      expect(after).toBeCloseTo(0, 4);
      expect(calibrate(0.9, samples, { scope: checkScope() })).toBeCloseTo(0.3, 4);
    });

    it('leaves a well calibrated history where it is', () => {
      // Ten bins, twenty answers in each, every bin stating exactly what it is:
      // bin `n` states `n / 10 + 0.05` and is right `2n + 1` times out of twenty.
      const samples: CalibrationSample[] = [];
      for (let bin = 0; bin < CALIBRATION_BINS; bin += 1) {
        const stated = Number((bin / CALIBRATION_BINS + 0.05).toFixed(2));
        samples.push(...history({ stated, correct: 2 * bin + 1, wrong: 20 - (2 * bin + 1) }));
      }

      const before = calibrationError(samples);
      const after = calibrationError(samples, { calibrated: true });

      // A full bin is read as its own accuracy, so there is nothing left to correct.
      expect(before).toBeLessThan(0.001);
      expect(after).toBeLessThan(0.001);
    });

    it('never makes an underconfident history worse', () => {
      // States 0.2 in the 0.2 bin and is right every time: the error is understated doubt.
      const samples = overconfidentHistory(0.2, 100, 0);

      const before = calibrationError(samples);
      const after = calibrationError(samples, { calibrated: true });

      expect(before).toBeCloseTo(0.8, 4);
      expect(after).toBeLessThan(before);
      expect(calibrate(0.2, samples, { scope: checkScope() })).toBeCloseTo(1, 4);
    });
  });

  describe('minimum samples and smoothing', () => {
    it('moves a thin bin only part of the way to its observed accuracy', () => {
      // Ten confirmed answers, two of them right: 0.2 observed, half the weight of a full bin.
      const thin = overconfidentHistory(0.9, 2, 8);
      const calibrated = calibrate(0.9, thin, { scope: checkScope() });

      expect(MIN_SAMPLES).toBe(20);
      expect(calibrated).toBeGreaterThan(0.2);
      expect(calibrated).toBeLessThan(0.9);
      expect(calibrated).toBeCloseTo(0.5 * 0.2 + 0.5 * 0.9, 4);
    });

    it('leaves the stated confidence unchanged when no sample lands in its bin', () => {
      const elsewhere = overconfidentHistory(0.5, 30, 70);

      expect(calibrate(0.95, elsewhere, { scope: checkScope() })).toBe(0.95);
      expect(calibrationError([], { calibrated: true })).toBe(0);
      expect(summarizeCalibration([]).samples).toBe(0);
    });

    it('gives a bin exactly its observed accuracy once it holds MIN_SAMPLES answers', () => {
      const full = overconfidentHistory(0.9, 12, 8);

      expect(full).toHaveLength(MIN_SAMPLES);
      expect(calibrate(0.9, full, { scope: checkScope() })).toBeCloseTo(0.6, 4);

      // A caller that names its own minimum moves the point the bin stops needing help.
      expect(calibrate(0.9, overconfidentHistory(0.9, 2, 8), { minSamples: 10 })).toBeCloseTo(
        0.2,
        4,
      );
      // A minimum that is not a positive number means the named constant, not a divide by 0.
      expect(calibrate(0.9, full, { minSamples: 0 })).toBeCloseTo(0.6, 4);
    });

    it('keeps every calibrated confidence inside 0 to 1', () => {
      const never = overconfidentHistory(0.99, 0, 100);
      const always = overconfidentHistory(0.05, 100, 0);

      expect(calibrate(0.99, never, { scope: checkScope() })).toBe(0);
      expect(calibrate(0.05, always, { scope: checkScope() })).toBe(1);

      for (let stated = 0; stated <= 1.0001; stated += 0.05) {
        const value = calibrate(stated, never, { scope: checkScope() });
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }

      // A stated confidence outside the range cannot be stored and does not survive here:
      // it is read as the edge it is nearest, never as a probability above one.
      expect(calibrate(1.4, always, { scope: checkScope() })).toBe(1);
      expect(calibrate(-0.2, never, { scope: checkScope() })).toBe(0);
    });
  });

  describe('reading the confirmed history out of the store', () => {
    let tempDir: string;
    let store: DatabaseStore;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-calibrate-'));
      store = createStore(join(tempDir, 'test.db'));
    });

    afterEach(() => {
      if (store) {
        store.close();
      }
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('reads one sample per checked decision, from the latest correction', () => {
      seedConfirmedHistory(store, { stated: 0.9, correct: 3, wrong: 2 });

      const decision = store.decisions.create({
        decision_type: 'check',
        question: CHECK_QUESTION.text,
        answer: 'true',
        confidence: 0.9,
        path: 'pattern',
        pattern_id: PATTERN_ID,
        created_at: '2026-01-01T00:10:00.000Z',
      });
      store.feedback.create({
        decision_id: decision.id,
        correct_value: 'false',
        created_at: '2026-01-02T00:00:00.000Z',
      });
      // A second correction on the same decision is the current verdict, not another sample.
      // It carries its own timestamp: two corrections written in the same millisecond would
      // be ordered by their ids, which are random, and the newest one would be a coin toss.
      store.feedback.create({
        decision_id: decision.id,
        correct_value: 'true',
        created_at: '2026-01-03T00:00:00.000Z',
      });

      const samples = readCalibrationHistory(store, { scope: checkScope() });

      expect(samples).toHaveLength(6);
      expect(samples.filter((sample) => sample.correct)).toHaveLength(4);
      expect(samples.every((sample) => sample.stated_confidence === 0.9)).toBe(true);
      expect(samples.every((sample) => sample.decision_type === 'check')).toBe(true);
    });

    it('leaves out what it cannot read: unchecked decisions, other rules, other types', () => {
      seedConfirmedHistory(store, { stated: 0.9, correct: 2, wrong: 2 });
      seedConfirmedHistory(store, {
        patternId: 'pattern-other',
        stated: 0.9,
        correct: 5,
        wrong: 5,
      });
      // A decision nobody checked is not a sample: absence of feedback is not confirmation.
      store.decisions.create({
        decision_type: 'check',
        question: CHECK_QUESTION.text,
        answer: 'true',
        confidence: 0.9,
        path: 'pattern',
        pattern_id: PATTERN_ID,
      });
      // An answer and a correction that cannot be read as a check value are not a verdict.
      const unreadable = store.decisions.create({
        decision_type: 'check',
        question: CHECK_QUESTION.text,
        answer: '{"value":"a cookie banner"}',
        confidence: 0.9,
        path: 'pattern',
        pattern_id: PATTERN_ID,
      });
      store.feedback.create({ decision_id: unreadable.id, correct_value: 'false' });
      // A different decision type is a different group, whatever the rule is called.
      const choice = store.decisions.create({
        decision_type: 'choice',
        question: 'Which dialog is visible?',
        answer: 'cookie_banner',
        confidence: 0.9,
        path: 'pattern',
        pattern_id: PATTERN_ID,
      });
      store.feedback.create({ decision_id: choice.id, correct_value: 'promo' });

      const samples = readCalibrationHistory(store, { scope: checkScope() });

      expect(samples).toHaveLength(4);
      expect(samples.every((sample) => sample.pattern_id === PATTERN_ID)).toBe(true);
    });

    it('reads a group by URL path when no rule named the answer', () => {
      seedConfirmedHistory(store, {
        stated: 0.9,
        correct: 2,
        wrong: 2,
        capturedPath: '/welcome',
      });
      seedConfirmedHistory(store, {
        patternId: 'pattern-cart',
        stated: 0.9,
        correct: 5,
        wrong: 5,
        capturedPath: '/cart',
      });

      const byPath = readCalibrationHistory(store, {
        scope: { path: '/welcome', decision_type: 'check' },
      });
      expect(byPath).toHaveLength(4);
      expect(byPath.every((sample) => sample.path === '/welcome')).toBe(true);

      // A scope naming neither a rule nor a path names no group, and nothing is read.
      expect(readCalibrationHistory(store, { scope: { decision_type: 'check' } })).toEqual([]);
    });

    it('reads at most the newest rows of the history, in the order they were corrected', () => {
      seedConfirmedHistory(store, { stated: 0.9, correct: 4, wrong: 4 });

      expect(readCalibrationHistory(store, { scope: checkScope() })).toHaveLength(8);

      const limited = readCalibrationHistory(store, { scope: checkScope(), limit: 3 });
      expect(limited).toHaveLength(3);
      // The newest three corrections are the last three seeded, all of them wrong answers.
      expect(limited.every((sample) => sample.correct === false)).toBe(true);

      expect(CALIBRATION_HISTORY_LIMIT).toBeGreaterThanOrEqual(MIN_SAMPLES);
    });
  });

  describe('the router, through the pure function it calls', () => {
    let tempDir: string;
    let store: DatabaseStore;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-calibrate-router-'));
      store = createStore(join(tempDir, 'test.db'));
    });

    afterEach(() => {
      if (store) {
        store.close();
      }
      rmSync(tempDir, { recursive: true, force: true });
    });

    function route(
      rule: Rule = COOKIE_RULE,
      question: Question = CHECK_QUESTION,
      input: unknown = DIALOG_INPUT,
    ) {
      return routeQuestion({
        question,
        input,
        threshold: 0.8,
        memory: createMemory(store),
        store,
        patternEngine: engineWith(rule),
      });
    }

    it('returns the calibrated confidence for a pattern answer, and records that same confidence', () => {
      // The rule states 0.95 and is right 90% of the time: still above the automatic
      // threshold, but not as sure as it says.
      seedConfirmedHistory(store, { stated: 0.95, correct: 90, wrong: 10 });

      const result = route();

      expect(result.status).toBe('answered');
      if (result.status !== 'answered') return;
      expect(result.path).toBe('pattern');
      expect(result.answer.confidence).toBeCloseTo(0.9, 4);
      expect(result.answer.pattern_id).toBe(PATTERN_ID);
      expect(result.answer.latency_ms).toBeGreaterThanOrEqual(0);

      const row = store.decisions.getById(result.decision.id);
      expect(row?.path).toBe('pattern');
      expect(row?.pattern_id).toBe(PATTERN_ID);
      expect(row?.confidence).toBeCloseTo(0.9, 4);
    });

    it('never changes an answer value, only its confidence', () => {
      seedConfirmedHistory(store, { stated: 0.95, correct: 90, wrong: 10 });

      const result = route();

      expect(result.status).toBe('answered');
      if (result.status !== 'answered') return;
      // The rule's own answer, with the same id, type, path and pattern as before.
      expect(result.answer.value).toBe(true);
      expect(result.answer.type).toBe('check');
      expect(result.answer.path).toBe('pattern');
    });

    it('leaves the stated confidence unchanged when there is no confirmed history', () => {
      const result = route();

      expect(result.status).toBe('answered');
      if (result.status !== 'answered') return;
      expect(result.answer.confidence).toBe(0.95);
      expect(store.decisions.getById(result.decision.id)?.confidence).toBe(0.95);
    });

    it('sends an overconfident pattern to the slow path, at the calibrated confidence', () => {
      // Right 30% of the time, so 0.3: above the human threshold, below the automatic one.
      seedConfirmedHistory(store, { stated: 0.95, correct: 30, wrong: 70 });

      const result = route();

      expect(result.status).toBe('needs_ai');
      if (result.status !== 'needs_ai') return;

      const row = store.decisions.getById(result.needsAi.decision_id);
      expect(row?.path).toBe('ai');
      expect(row?.answer).toBe('pending');
      expect(row?.confidence).toBeCloseTo(0.3, 4);
      expect(row?.pattern_id).toBe(PATTERN_ID);
    });

    it('keeps a safety rule at its stated confidence, and its verdict', () => {
      // The same poor history as the overconfident rule above, on a rule marked safety.
      seedConfirmedHistory(store, {
        patternId: SAFETY_RULE_ID,
        decisionType: 'choice',
        stated: 0.99,
        correct: 30,
        wrong: 70,
        answer: 'ask_user',
        wrongValue: 'proceed',
        isSafety: true,
      });

      // A safety rule that asks the user: the verdict is its answer, not its confidence.
      const asked = route(SAFETY_ASK_RULE, PAY_QUESTION, PAY_INPUT);
      expect(asked.status).toBe('needs_human');
      if (asked.status !== 'needs_human') return;
      expect(asked.needsHuman.reason).toContain('ask_user');
      // Calibration would have moved this to 0.3. The row states what the answer carried.
      expect(asked.decision.confidence).toBe(0.99);
      expect(asked.decision.is_safety).toBe(1);
    });

    it('answers a safety rule at its stated confidence, whatever its history says', () => {
      seedConfirmedHistory(store, {
        patternId: SAFETY_CHECK_RULE_ID,
        stated: 0.95,
        correct: 30,
        wrong: 70,
        isSafety: true,
      });

      // The same poor history on a non-safety rule sends the answer to the slow path above.
      // On a safety rule the answer and its confidence both stay where the rule put them.
      const answered = route(SAFETY_CHECK_RULE, PAY_CHECK_QUESTION, PAY_INPUT);

      expect(answered.status).toBe('answered');
      if (answered.status !== 'answered') return;
      expect(answered.answer.value).toBe(true);
      expect(answered.answer.confidence).toBe(0.95);
      expect(store.decisions.getById(answered.decision.id)?.is_safety).toBe(1);
    });

    it('leaves a memory answer alone: only a pattern answer is calibrated', () => {
      // The same poor history as the overconfident rule, on the same input, so a pattern
      // answer for it would come back at 0.3.
      seedConfirmedHistory(store, { stated: 0.95, correct: 30, wrong: 70 });

      const memory = createMemory(store);
      memory.save({
        question: CHECK_QUESTION,
        input: DIALOG_INPUT,
        answer: { value: false },
        confidence: 0.99,
        path: 'memory',
      });

      const result = routeQuestion({
        question: CHECK_QUESTION,
        input: DIALOG_INPUT,
        threshold: 0.8,
        memory,
        store,
        patternEngine: engineWith(COOKIE_RULE),
      });

      expect(result.status).toBe('answered');
      if (result.status !== 'answered') return;
      expect(result.path).toBe('memory');
      expect(result.answer.confidence).toBe(0.99);
    });
  });
});
