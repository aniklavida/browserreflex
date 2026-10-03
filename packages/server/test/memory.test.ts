import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeMemoryKey,
  createMemory,
  createStore,
  type DatabaseStore,
  isAnswerReusable,
  Memory,
  normalizeInput,
  normalizeOptions,
  normalizeQuestionText,
  type Question,
  validateAnswer,
} from '../src/index.js';

describe('memory exact match', () => {
  let tempDir: string;
  let dbPath: string;
  let store: DatabaseStore;
  let memory: Memory;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-memory-'));
    dbPath = join(tempDir, 'test.db');
    store = createStore(dbPath);
    memory = createMemory(store);
  });

  afterEach(() => {
    if (store) {
      store.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('key hashing and normalization', () => {
    it('generates deterministic SHA-256 hash for identical normalized inputs', () => {
      const inputA = { url: 'https://example.com', tag: 'button', id: 'submit-btn' };
      const inputB = { id: 'submit-btn', url: 'https://example.com', tag: 'button' };
      const question = 'Is this button safe to click?';

      const keyA = computeMemoryKey(inputA, question);
      const keyB = computeMemoryKey(inputB, question);

      expect(keyA).toBe(keyB);
      expect(keyA).toMatch(/^[0-9a-f]{64}$/);
    });

    it('normalizes question text whitespace so formatting differences do not change the key', () => {
      const input = { role: 'dialog' };
      const key1 = computeMemoryKey(input, 'What  popup is   this?');
      const key2 = computeMemoryKey(input, '  What popup is this?\n');

      expect(key1).toBe(key2);
    });

    it('normalizes input, question text, and options with helper functions', () => {
      expect(normalizeInput(null)).toBeNull();
      expect(normalizeInput('  hello world  ')).toBe('hello world');
      expect(normalizeInput('{"b":2,"a":1}')).toEqual({ a: 1, b: 2 });
      expect(normalizeInput({ b: 2, a: 1 })).toEqual({ a: 1, b: 2 });

      expect(normalizeQuestionText('  What   popup  is\nthis?  ')).toBe('What popup is this?');

      expect(normalizeOptions(['  opt1 ', 'opt2'])).toEqual([{ id: 'opt1' }, { id: 'opt2' }]);
      expect(
        normalizeOptions([{ id: ' opt_a ', label: ' Option A ', description: ' First opt ' }]),
      ).toEqual([{ id: 'opt_a', label: 'Option A', description: 'First opt' }]);
    });

    it('normalizes stringified JSON inputs with different key orders', () => {
      const str1 = JSON.stringify({ a: 1, b: 2 });
      const str2 = JSON.stringify({ b: 2, a: 1 });

      const key1 = computeMemoryKey(str1, 'Test question?');
      const key2 = computeMemoryKey(str2, 'Test question?');

      expect(key1).toBe(key2);
    });

    it('changing any option changes the key', () => {
      const input = { tag: 'modal' };
      const questionText = 'What kind of popup is this?';

      const baseOptions = [
        { id: 'cookie_banner', description: 'Cookie consent' },
        { id: 'newsletter', description: 'Email signup' },
        { id: 'none', description: 'No popup' },
      ];

      const baseKey = computeMemoryKey({
        input,
        question: questionText,
        options: baseOptions,
      });

      // 1. Changing an option id
      const changedIdOptions = [
        { id: 'consent_banner', description: 'Cookie consent' },
        { id: 'newsletter', description: 'Email signup' },
        { id: 'none', description: 'No popup' },
      ];
      expect(
        computeMemoryKey({
          input,
          question: questionText,
          options: changedIdOptions,
        }),
      ).not.toBe(baseKey);

      // 2. Changing an option description
      const changedDescOptions = [
        { id: 'cookie_banner', description: 'Updated cookie notice' },
        { id: 'newsletter', description: 'Email signup' },
        { id: 'none', description: 'No popup' },
      ];
      expect(
        computeMemoryKey({
          input,
          question: questionText,
          options: changedDescOptions,
        }),
      ).not.toBe(baseKey);

      // 3. Adding an option
      const addedOptions = [...baseOptions, { id: 'promo_deal', description: 'Special promotion' }];
      expect(
        computeMemoryKey({
          input,
          question: questionText,
          options: addedOptions,
        }),
      ).not.toBe(baseKey);

      // 4. Removing an option
      const removedOptions = baseOptions.slice(0, 2);
      expect(
        computeMemoryKey({
          input,
          question: questionText,
          options: removedOptions,
        }),
      ).not.toBe(baseKey);
    });

    it('changing question text or input changes the key', () => {
      const input1 = { role: 'alert' };
      const input2 = { role: 'banner' };
      const q1 = 'Is this a cookie banner?';
      const q2 = 'Is this a promotional dialog?';

      expect(computeMemoryKey(input1, q1)).not.toBe(computeMemoryKey(input2, q1));
      expect(computeMemoryKey(input1, q1)).not.toBe(computeMemoryKey(input1, q2));
    });

    it('extracts text and options automatically from Question objects', () => {
      const choiceQ: Question = {
        id: 'q_popup',
        type: 'choice',
        text: 'What type of popup is present?',
        options: [
          { id: 'cookie', description: 'Cookie banner' },
          { id: 'promo', description: 'Promo popup' },
        ],
      };

      const keyFromQuestion = computeMemoryKey({ input: { dom: 'modal' }, question: choiceQ });
      const keyFromParts = computeMemoryKey({
        input: { dom: 'modal' },
        question: choiceQ.text,
        options: choiceQ.options,
      });

      expect(keyFromQuestion).toBe(keyFromParts);
    });
  });

  describe('reuse rules and predicate', () => {
    it('isAnswerReusable evaluates confidence threshold and feedback presence', () => {
      const lowConfDecision = {
        id: 'dec-1',
        session_id: null,
        url: null,
        domain: null,
        decision_type: 'check' as const,
        question: 'Is safe?',
        context: null,
        input_hash: 'hash-1',
        answer: 'true',
        confidence: 0.65,
        path: 'check' as const,
        pattern_id: null,
        latency_ms: 10,
        is_safety: 0,
        needs_review: 0,
        created_at: new Date().toISOString(),
      };

      const highConfDecision = {
        ...lowConfDecision,
        id: 'dec-2',
        confidence: 0.95,
      };

      const mockFeedback = {
        id: 'fb-1',
        decision_id: 'dec-1',
        correct_value: 'true',
        note: 'Confirmed',
        source: 'human',
        created_at: new Date().toISOString(),
      };

      // Unconfirmed low-confidence: not reusable
      expect(isAnswerReusable(lowConfDecision, [], 0.8)).toBe(false);

      // Confirmed low-confidence (has feedback): reusable
      expect(isAnswerReusable(lowConfDecision, [mockFeedback], 0.8)).toBe(true);

      // High-confidence without feedback: reusable
      expect(isAnswerReusable(highConfDecision, [], 0.8)).toBe(true);

      // High-confidence with feedback: reusable
      expect(isAnswerReusable(highConfDecision, [mockFeedback], 0.8)).toBe(true);
    });
  });

  describe('done-when criteria', () => {
    it('hit returns in under 2ms with path: "memory"', () => {
      const input = { selector: '#accept-all-btn', text: 'Accept all cookies' };
      const question: Question = {
        id: 'q_cookie_btn',
        type: 'check',
        text: 'Does clicking this accept all cookies?',
      };

      // Save initial decision with high confidence
      const decision = memory.save({
        input,
        question,
        answer: true,
        confidence: 0.98,
        path: 'ai',
      });

      expect(decision.id).toBeDefined();

      // Measure lookup latency
      const hit = memory.lookup({
        input,
        question,
        threshold: 0.85,
      });

      expect(hit).not.toBeNull();
      expect(hit?.hit).toBe(true);
      expect(hit?.path).toBe('memory');
      expect(hit?.answer.path).toBe('memory');
      expect(hit?.answer.value).toBe(true);
      expect(hit?.confidence).toBe(0.98);
      expect(hit?.latencyMs).toBeLessThan(2);

      // Verify repeated lookups stay well under 2ms
      const iterations = 50;
      let totalLatency = 0;
      for (let i = 0; i < iterations; i++) {
        const repeatHit = memory.lookup({
          input,
          question,
          threshold: 0.85,
        });
        expect(repeatHit).not.toBeNull();
        expect(repeatHit?.path).toBe('memory');
        expect(repeatHit!.latencyMs).toBeLessThan(2);
        totalLatency += repeatHit!.latencyMs;
      }
      const avgLatency = totalLatency / iterations;
      expect(avgLatency).toBeLessThan(1);
    });

    it('unconfirmed low-confidence answers are never reused', () => {
      const input = { element: 'input[name="coupon"]', form: 'checkout' };
      const question: Question = {
        id: 'q_coupon',
        type: 'check',
        text: 'Is this input field a coupon code entry?',
      };

      // 1. Decision with confidence 0.60 when threshold is 0.80, without feedback
      const decision = memory.save({
        input,
        question,
        answer: true,
        confidence: 0.6,
        path: 'ai',
      });

      // Must NOT be reused
      const missLowConf = memory.lookup({
        input,
        question,
        threshold: 0.8,
      });
      expect(missLowConf).toBeNull();

      // 2. Decision with confidence 0.79 when threshold is 0.80, without feedback
      const input2 = { element: 'input[name="promo"]' };
      memory.save({
        input: input2,
        question,
        answer: true,
        confidence: 0.79,
        path: 'ai',
      });
      expect(memory.lookup({ input: input2, question, threshold: 0.8 })).toBeNull();

      // 3. Confirm the low-confidence decision with user feedback
      store.feedback.create({
        decision_id: decision.id,
        correct_value: 'true',
        note: 'User confirmed coupon field',
        source: 'human',
      });

      // Now it WAS confirmed by feedback -> MUST be reused with path "memory"
      const hitConfirmed = memory.lookup({
        input,
        question,
        threshold: 0.8,
      });
      expect(hitConfirmed).not.toBeNull();
      expect(hitConfirmed?.hit).toBe(true);
      expect(hitConfirmed?.path).toBe('memory');
      expect(hitConfirmed?.confirmed).toBe(true);
      expect(hitConfirmed?.source).toBe('feedback');
      expect(hitConfirmed?.answer.value).toBe(true);

      // 4. Stored decision with confidence >= threshold (0.90 >= 0.80) without feedback
      const input3 = { element: 'input[name="voucher"]' };
      memory.save({
        input: input3,
        question,
        answer: true,
        confidence: 0.9,
        path: 'pattern',
      });

      const hitHighConf = memory.lookup({
        input: input3,
        question,
        threshold: 0.8,
      });
      expect(hitHighConf).not.toBeNull();
      expect(hitHighConf?.hit).toBe(true);
      expect(hitHighConf?.path).toBe('memory');
      expect(hitHighConf?.confirmed).toBe(false);
      expect(hitHighConf?.source).toBe('high_confidence');
      expect(hitHighConf?.confidence).toBe(0.9);
    });
  });

  describe('feedback correction and schema compliance', () => {
    it('returns corrected answer value when feedback overrides stored answer', () => {
      const input = { bannerId: 'gdpr-modal' };
      const question: Question = {
        id: 'q_choice_popup',
        type: 'choice',
        text: 'What type of popup is present?',
        options: [
          { id: 'cookie_banner', description: 'Cookie banner' },
          { id: 'promo_modal', description: 'Promo modal' },
          { id: 'login_wall', description: 'Login wall' },
        ],
      };

      // Initially saved as promo_modal with low confidence
      const decision = memory.save({
        input,
        question,
        answer: 'promo_modal',
        confidence: 0.5,
        path: 'ai',
      });

      // Feedback confirms the actual correct answer was cookie_banner
      store.feedback.create({
        decision_id: decision.id,
        correct_value: 'cookie_banner',
        note: 'Corrected by user review',
        source: 'human',
      });

      const hit = memory.lookup({
        input,
        question,
        threshold: 0.8,
      });

      expect(hit).not.toBeNull();
      expect(hit?.answer.value).toBe('cookie_banner');
      expect(hit?.confirmed).toBe(true);
      expect(hit?.source).toBe('feedback');

      // The returned answer must strictly conform to the declared Question schema
      const valResult = validateAnswer(question, hit!.answer);
      expect(valResult.success).toBe(true);
    });

    it('produces valid distributions for choice answers on memory hits', () => {
      const input = { modalText: 'Sign in to access your account' };
      const question: Question = {
        id: 'q_login',
        type: 'choice',
        text: 'What is this dialog?',
        options: [
          { id: 'login_wall', description: 'Login wall' },
          { id: 'cookie_banner', description: 'Cookie banner' },
        ],
      };

      memory.save({
        input,
        question,
        answer: 'login_wall',
        confidence: 0.95,
        path: 'ai',
      });

      const hit = memory.lookup({
        input,
        question,
        threshold: 0.8,
      });

      expect(hit).not.toBeNull();
      expect(hit?.answer.value).toBe('login_wall');
      expect(hit?.answer.distribution).toEqual({
        login_wall: 1.0,
        cookie_banner: 0.0,
      });

      const val = validateAnswer(question, hit!.answer);
      expect(val.success).toBe(true);
    });

    it('returns score answer conforming to score scale', () => {
      const input = { element: 'payment-iframe' };
      const question: Question = {
        id: 'q_risk',
        type: 'score',
        text: 'Risk level 1 to 5',
        scale: { min: 1, max: 5, step: 1 },
      };

      memory.save({
        input,
        question,
        answer: 4,
        confidence: 0.92,
        path: 'check',
      });

      const hit = memory.lookup({
        input,
        question,
        threshold: 0.8,
      });

      expect(hit).not.toBeNull();
      expect(hit?.answer.value).toBe(4);
      const val = validateAnswer(question, hit!.answer);
      expect(val.success).toBe(true);
    });
  });
});
