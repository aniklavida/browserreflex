/**
 * Shadow testing: candidate rules evaluated silently against slow answers and feedback.
 *
 * Status: **implemented and tested**.
 *
 * Invariants tested:
 * - Candidate patterns with status 'shadow' run silently while AI/human still answers.
 * - Comparing candidate output value with recorded answer writes one shadow_samples row
 *   (source = 'slow_answer' or 'feedback') and updates pattern_stats in one atomic transaction.
 * - The same (decision, pattern) pair evaluated twice is a no-op.
 * - Shadow rules NEVER change the returned answer and never answer in decide.
 * - The pattern engine does not serve shadow candidates.
 * - A shadow candidate never carries the safety flag and cannot touch safety rules.
 * - Hooked into submit_answers and feedback end to end; a failure inside shadow evaluation
 *   does not fail the tool call (logs and continues).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateShadowCandidates, parseAnswerToken } from '../src/learning/shadow.js';
import { createStore, type DatabaseStore } from '../src/store/index.js';
import { createPatternEngine } from '../src/patterns/engine.js';
import type { Rule } from '../src/patterns/types.js';
import { executeDecide } from '../src/tools/decide.js';
import { executeSubmitAnswers } from '../src/tools/submit_answers.js';
import { executeFeedback } from '../src/tools/feedback.js';
import type { CheckQuestion } from '../src/core/schema.js';

describe('shadow candidate testing', () => {
  let tempDir: string;
  let store: DatabaseStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-shadow-'));
    store = createStore(join(tempDir, 'test.db'));
  });

  afterEach(() => {
    if (store) {
      store.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('shadow_samples repository and atomic transactions', () => {
    it('records a sample and updates pattern_stats in one atomic transaction', () => {
      const decision = store.decisions.create({
        decision_type: 'check',
        question: 'Is this a cookie banner?',
        answer: 'true',
        confidence: 0.9,
        path: 'ai',
      });

      const pattern = store.patterns.create({
        id: 'candidate-banner-1',
        name: 'Cookie Banner Candidate',
        decision_type: 'check',
        rules: JSON.stringify({
          id: 'candidate-banner-1',
          matchers: { text_any: ['accept cookies'] },
          output: { decision_type: 'check', value: true, confidence: 0.7 },
        }),
        status: 'shadow',
        confidence: 0.7,
      });

      const result = store.shadowSamples.recordSample({
        decision_id: decision.id,
        pattern_id: pattern.id,
        source: 'slow_answer',
        agreed: true,
      });

      expect(result.recorded).toBe(true);
      expect(result.sample).not.toBeNull();
      expect(result.sample?.decision_id).toBe(decision.id);
      expect(result.sample?.pattern_id).toBe(pattern.id);
      expect(result.sample?.source).toBe('slow_answer');
      expect(result.sample?.agreed).toBe(1);

      // Verify row in shadow_samples table
      const stored = store.shadowSamples.getByPair(decision.id, pattern.id);
      expect(stored).not.toBeNull();
      expect(stored?.agreed).toBe(1);

      // Verify atomic update in pattern_stats table
      const stats = store.patternStats.getById(pattern.id);
      expect(stats).not.toBeNull();
      expect(stats?.sample_count).toBe(1);
      expect(stats?.agreed_count).toBe(1);
      expect(stats?.disagreed_count).toBe(0);
      expect(stats?.last_evaluated_at).toBeDefined();
    });

    it('evaluating the same (decision, pattern) pair a second time is a no-op', () => {
      const decision = store.decisions.create({
        decision_type: 'check',
        question: 'Is this a popup?',
        answer: 'true',
        confidence: 0.85,
        path: 'ai',
      });

      const pattern = store.patterns.create({
        id: 'candidate-popup-1',
        name: 'Popup Candidate',
        decision_type: 'check',
        rules: JSON.stringify({
          id: 'candidate-popup-1',
          matchers: { role: 'dialog' },
          output: { decision_type: 'check', value: true, confidence: 0.6 },
        }),
        status: 'shadow',
        confidence: 0.6,
      });

      // First evaluation
      const first = store.shadowSamples.recordSample({
        decision_id: decision.id,
        pattern_id: pattern.id,
        source: 'slow_answer',
        agreed: true,
      });
      expect(first.recorded).toBe(true);

      const statsAfterFirst = store.patternStats.getById(pattern.id);
      expect(statsAfterFirst?.sample_count).toBe(1);
      expect(statsAfterFirst?.agreed_count).toBe(1);

      // Second evaluation of the same pair: must be a no-op
      const second = store.shadowSamples.recordSample({
        decision_id: decision.id,
        pattern_id: pattern.id,
        source: 'feedback',
        agreed: false,
      });
      expect(second.recorded).toBe(false);

      // pattern_stats must remain unchanged
      const statsAfterSecond = store.patternStats.getById(pattern.id);
      expect(statsAfterSecond?.sample_count).toBe(1);
      expect(statsAfterSecond?.agreed_count).toBe(1);
      expect(statsAfterSecond?.disagreed_count).toBe(0);

      // Exactly one row exists in shadow_samples
      const allSamples = store.shadowSamples.listByDecisionId(decision.id);
      expect(allSamples).toHaveLength(1);
      expect(allSamples[0]!.source).toBe('slow_answer');
    });

    it('records disagreements and increments disagreed_count in pattern_stats', () => {
      const decision = store.decisions.create({
        decision_type: 'score',
        question: 'Risk rating',
        answer: '3',
        confidence: 0.9,
        path: 'ai',
      });

      const pattern = store.patterns.create({
        id: 'candidate-score-1',
        name: 'Score Candidate',
        decision_type: 'score',
        rules: JSON.stringify({
          id: 'candidate-score-1',
          matchers: { role: 'button' },
          output: { decision_type: 'score', value: 8, confidence: 0.5 },
        }),
        status: 'shadow',
        confidence: 0.5,
      });

      const res = store.shadowSamples.recordSample({
        decision_id: decision.id,
        pattern_id: pattern.id,
        source: 'slow_answer',
        agreed: false,
      });

      expect(res.recorded).toBe(true);
      expect(res.sample?.agreed).toBe(0);

      const stats = store.patternStats.getById(pattern.id);
      expect(stats?.sample_count).toBe(1);
      expect(stats?.agreed_count).toBe(0);
      expect(stats?.disagreed_count).toBe(1);
    });

    it('cascades deletion when a decision is deleted', () => {
      const decision = store.decisions.create({
        decision_type: 'check',
        question: 'Check',
        answer: 'true',
        confidence: 0.9,
        path: 'ai',
      });

      store.patterns.create({
        id: 'candidate-cascade-1',
        name: 'Cascade Candidate',
        decision_type: 'check',
        status: 'shadow',
        rules: JSON.stringify({
          id: 'candidate-cascade-1',
          matchers: {},
          output: { decision_type: 'check', value: true, confidence: 0.5 },
        }),
      });

      store.shadowSamples.recordSample({
        decision_id: decision.id,
        pattern_id: 'candidate-cascade-1',
        source: 'slow_answer',
        agreed: true,
      });

      expect(store.shadowSamples.listByDecisionId(decision.id)).toHaveLength(1);

      // Delete the decision
      store.decisions.delete(decision.id);

      // Shadow sample must be cascade-deleted
      expect(store.shadowSamples.listByDecisionId(decision.id)).toHaveLength(0);
    });
  });

  describe('answer parsing and comparison', () => {
    it('normalizes check values (boolean, string true/false, yes/no, 0/1)', () => {
      expect(parseAnswerToken(true, 'check')).toEqual({ ok: true, value: true, token: 'true' });
      expect(parseAnswerToken('true', 'check')).toEqual({ ok: true, value: true, token: 'true' });
      expect(parseAnswerToken('yes', 'check')).toEqual({ ok: true, value: true, token: 'true' });
      expect(parseAnswerToken(1, 'check')).toEqual({ ok: true, value: true, token: 'true' });

      expect(parseAnswerToken(false, 'check')).toEqual({ ok: true, value: false, token: 'false' });
      expect(parseAnswerToken('false', 'check')).toEqual({
        ok: true,
        value: false,
        token: 'false',
      });
      expect(parseAnswerToken('no', 'check')).toEqual({ ok: true, value: false, token: 'false' });
      expect(parseAnswerToken(0, 'check')).toEqual({ ok: true, value: false, token: 'false' });
    });

    it('normalizes score values and rejects booleans for score', () => {
      expect(parseAnswerToken(7, 'score')).toEqual({ ok: true, value: 7, token: '7' });
      expect(parseAnswerToken('7', 'score')).toEqual({ ok: true, value: 7, token: '7' });
      expect(parseAnswerToken(true, 'score').ok).toBe(false);
      expect(parseAnswerToken('not-a-number', 'score').ok).toBe(false);
    });

    it('normalizes choice values and rejects empty string', () => {
      expect(parseAnswerToken('cookie_banner', 'choice')).toEqual({
        ok: true,
        value: 'cookie_banner',
        token: 'cookie_banner',
      });
      expect(parseAnswerToken('', 'choice').ok).toBe(false);
    });

    it('parses JSON formatted answers holding value', () => {
      const serialized = JSON.stringify({ value: true, distribution: { true: 0.9, false: 0.1 } });
      expect(parseAnswerToken(serialized, 'check')).toEqual({
        ok: true,
        value: true,
        token: 'true',
      });
    });
  });

  describe('shadow candidate evaluation against stored signals', () => {
    it('evaluates matching candidate and records agreement when values match', () => {
      const decision = store.decisions.create({
        decision_type: 'check',
        question: 'Is this a cookie banner?',
        answer: 'true',
        confidence: 0.9,
        path: 'ai',
        domain: 'example.com',
        url: 'https://example.com/shop',
      });

      store.signals.upsert({
        decision_id: decision.id,
        domain: 'example.com',
        path: '/shop',
        element_role: 'button',
        element_text: 'Accept all cookies',
        element_source: 'target',
        source: 'slow_path_answer',
        tokens: ['accept', 'all', 'cookies'],
      });

      const pattern = store.patterns.create({
        id: 'candidate-agree',
        name: 'Cookie Banner Button',
        decision_type: 'check',
        domain: 'example.com',
        status: 'shadow',
        confidence: 0.6,
        rules: JSON.stringify({
          id: 'candidate-agree',
          matchers: {
            url_domain: 'example.com',
            role: 'button',
            text_any: ['Accept all cookies'],
          },
          output: { decision_type: 'check', value: true, confidence: 0.6 },
        }),
      });

      const outcome = evaluateShadowCandidates({
        store,
        decision,
        source: 'slow_answer',
      });

      expect(outcome.evaluated_count).toBe(1);
      expect(outcome.matched_count).toBe(1);
      expect(outcome.samples).toHaveLength(1);
      expect(outcome.samples[0]!.pattern_id).toBe(pattern.id);
      expect(outcome.samples[0]!.agreed).toBe(true);
      expect(outcome.samples[0]!.recorded).toBe(true);

      const stats = store.patternStats.getById(pattern.id);
      expect(stats?.sample_count).toBe(1);
      expect(stats?.agreed_count).toBe(1);
      expect(stats?.disagreed_count).toBe(0);
    });

    it('records disagreement when candidate value differs from recorded answer', () => {
      const decision = store.decisions.create({
        decision_type: 'check',
        question: 'Is this a promo popup?',
        answer: 'false',
        confidence: 0.8,
        path: 'ai',
        domain: 'store.test',
      });

      store.signals.upsert({
        decision_id: decision.id,
        domain: 'store.test',
        path: '/items',
        element_role: 'dialog',
        element_text: 'Special newsletter offer',
        element_source: 'target',
        source: 'slow_path_answer',
        tokens: ['special', 'newsletter', 'offer'],
      });

      const pattern = store.patterns.create({
        id: 'candidate-disagree',
        name: 'Promo Candidate',
        decision_type: 'check',
        domain: 'store.test',
        status: 'shadow',
        confidence: 0.6,
        rules: JSON.stringify({
          id: 'candidate-disagree',
          matchers: {
            url_domain: 'store.test',
            role: 'dialog',
            text_any: ['newsletter'],
          },
          output: { decision_type: 'check', value: true, confidence: 0.6 },
        }),
      });

      const outcome = evaluateShadowCandidates({
        store,
        decision,
        source: 'slow_answer',
      });

      expect(outcome.evaluated_count).toBe(1);
      expect(outcome.matched_count).toBe(1);
      expect(outcome.samples[0]!.agreed).toBe(false);

      const stats = store.patternStats.getById(pattern.id);
      expect(stats?.sample_count).toBe(1);
      expect(stats?.agreed_count).toBe(0);
      expect(stats?.disagreed_count).toBe(1);
    });

    it('ignores non-matching candidates (domain, path, role or text)', () => {
      const decision = store.decisions.create({
        decision_type: 'check',
        question: 'Is this a login wall?',
        answer: 'true',
        confidence: 0.9,
        path: 'ai',
        domain: 'example.com',
      });

      store.signals.upsert({
        decision_id: decision.id,
        domain: 'example.com',
        path: '/login',
        element_role: 'button',
        element_text: 'Sign In',
        element_source: 'target',
        source: 'slow_path_answer',
        tokens: ['sign', 'in'],
      });

      // Pattern requires different domain
      store.patterns.create({
        id: 'candidate-diff-domain',
        name: 'Other Domain Candidate',
        decision_type: 'check',
        domain: 'other.com',
        status: 'shadow',
        confidence: 0.6,
        rules: JSON.stringify({
          id: 'candidate-diff-domain',
          matchers: { url_domain: 'other.com', role: 'button' },
          output: { decision_type: 'check', value: true, confidence: 0.6 },
        }),
      });

      const outcome = evaluateShadowCandidates({
        store,
        decision,
        source: 'slow_answer',
      });

      expect(outcome.evaluated_count).toBe(1);
      expect(outcome.matched_count).toBe(0);
      expect(outcome.samples).toHaveLength(0);
      expect(store.shadowSamples.listByDecisionId(decision.id)).toHaveLength(0);
    });
  });

  describe('shadow candidates isolation from active routing and decide', () => {
    it('pattern engine does not serve shadow candidates in match, matchAll, or matchForQuestion', () => {
      const shadowRule: Rule = {
        id: 'shadow-rule-1',
        name: 'Shadow Rule',
        status: 'shadow',
        matchers: {
          url_domain: 'example.com',
          role: 'button',
        },
        output: {
          decision_type: 'check',
          value: true,
          confidence: 0.95,
        },
      };

      const activeRule: Rule = {
        id: 'active-rule-1',
        name: 'Active Rule',
        status: 'active',
        matchers: {
          url_domain: 'example.com',
          role: 'button',
        },
        output: {
          decision_type: 'check',
          value: false,
          confidence: 0.95,
        },
      };

      const engine = createPatternEngine([shadowRule]);

      const snapshot = {
        domain: 'example.com',
        elements: [{ role: 'button', text: 'Click me' }],
      };

      const checkQuestion: CheckQuestion = {
        id: 'q1',
        type: 'check',
        text: 'Is this safe?',
      };

      // 1. match() must ignore shadow rule
      expect(engine.match(snapshot)).toBeNull();

      // 2. matchAll() must ignore shadow rule
      expect(engine.matchAll(snapshot)).toHaveLength(0);

      // 3. matchForQuestion() must ignore shadow rule
      expect(engine.matchForQuestion(snapshot, checkQuestion)).toBeNull();

      // 4. Loading active rule allows it to match normally
      engine.addRule(activeRule);
      const matchResult = engine.match(snapshot);
      expect(matchResult).not.toBeNull();
      expect(matchResult?.pattern_id).toBe('active-rule-1');
      expect(matchResult?.output.value).toBe(false);
    });

    it('a matching shadow candidate does not alter the decide tool result', async () => {
      const shadowRule: Rule = {
        id: 'shadow-cookie-rule',
        name: 'Shadow Cookie Rule',
        status: 'shadow',
        matchers: {
          url_domain: 'shop.example.com',
          role: 'button',
          text_any: ['Accept all cookies'],
        },
        output: {
          decision_type: 'check',
          value: true,
          confidence: 0.99,
        },
      };

      const engine = createPatternEngine([shadowRule]);

      const checkQuestion: CheckQuestion = {
        id: 'check-1',
        type: 'check',
        text: 'Is this a cookie banner?',
      };

      const snapshot = {
        url: 'https://shop.example.com/checkout',
        domain: 'shop.example.com',
        elements: [{ role: 'button', text: 'Accept all cookies' }],
      };

      const result = await executeDecide(
        {
          questions: [checkQuestion],
          state: snapshot,
        },
        { store, patternEngine: engine },
      );

      // Must NOT answer via the shadow pattern! Must route to needs_ai
      expect(result.answers).toHaveLength(0);
      expect(result.needs_ai).toHaveLength(1);
      expect(result.needs_ai[0]!.id).toBe('check-1');
    });
  });

  describe('safety rules invariant', () => {
    it('a shadow candidate never carries the safety flag and is skipped if flagged', () => {
      const decision = store.decisions.create({
        decision_type: 'check',
        question: 'Is this an action?',
        answer: 'true',
        confidence: 0.9,
        path: 'ai',
      });

      store.signals.upsert({
        decision_id: decision.id,
        domain: 'example.com',
        element_role: 'button',
        source: 'slow_path_answer',
        tokens: ['pay'],
      });

      // Pattern carrying is_safety = 1
      store.patterns.create({
        id: 'candidate-safety-row',
        name: 'Safety Candidate Row',
        decision_type: 'check',
        status: 'shadow',
        is_safety: 1,
        rules: JSON.stringify({
          id: 'candidate-safety-row',
          matchers: { role: 'button' },
          output: { decision_type: 'check', value: true, confidence: 0.8 },
        }),
      });

      // Pattern whose rule JSON carries safety: true
      store.patterns.create({
        id: 'candidate-safety-rule',
        name: 'Safety Candidate Rule',
        decision_type: 'check',
        status: 'shadow',
        is_safety: 0,
        rules: JSON.stringify({
          id: 'candidate-safety-rule',
          safety: true,
          matchers: { role: 'button' },
          output: { decision_type: 'check', value: true, confidence: 0.8 },
        }),
      });

      const outcome = evaluateShadowCandidates({
        store,
        decision,
        source: 'slow_answer',
      });

      expect(outcome.evaluated_count).toBe(0);
      expect(outcome.samples).toHaveLength(0);
      expect(store.shadowSamples.listByDecisionId(decision.id)).toHaveLength(0);
    });

    it('a shadow candidate cannot touch safety rules (is_safety decisions)', () => {
      // Decision marked as is_safety = 1
      const safetyDecision = store.decisions.create({
        decision_type: 'check',
        question: 'Confirm payment?',
        answer: 'true',
        confidence: 1.0,
        path: 'pattern',
        is_safety: 1,
      });

      store.signals.upsert({
        decision_id: safetyDecision.id,
        domain: 'payment.example.com',
        element_role: 'button',
        source: 'slow_path_answer',
        tokens: ['pay', 'now'],
      });

      store.patterns.create({
        id: 'candidate-pay',
        name: 'Pay Candidate',
        decision_type: 'check',
        status: 'shadow',
        confidence: 0.6,
        rules: JSON.stringify({
          id: 'candidate-pay',
          matchers: { role: 'button' },
          output: { decision_type: 'check', value: true, confidence: 0.6 },
        }),
      });

      const outcome = evaluateShadowCandidates({
        store,
        decision: safetyDecision,
        source: 'slow_answer',
        // A valid answer, so only the safety guard can stop this evaluation.
        recordedAnswer: true,
      });

      expect(outcome.evaluated_count).toBe(0);
      expect(outcome.samples).toHaveLength(0);
      expect(store.shadowSamples.listByDecisionId(safetyDecision.id)).toHaveLength(0);
    });
  });

  describe('end-to-end integration through real tools', () => {
    it('submit_answers triggers shadow evaluation for matching candidates', async () => {
      // 1. Initial decide call returns needs_ai
      const question: CheckQuestion = {
        id: 'q-login',
        type: 'check',
        text: 'Is this a login wall?',
      };

      const snapshot = {
        url: 'https://app.example.com/login',
        domain: 'app.example.com',
        elements: [{ role: 'form', text: 'Enter password to continue' }],
      };

      const decideResult = await executeDecide(
        {
          questions: [question],
          state: snapshot,
        },
        { store },
      );

      expect(decideResult.needs_ai).toHaveLength(1);
      const decisionId = decideResult.needs_ai[0]!.decision_id;

      // 2. Insert shadow candidate matching this page
      const shadowPattern = store.patterns.create({
        id: 'candidate-login-wall',
        name: 'Login Wall Candidate',
        decision_type: 'check',
        domain: 'app.example.com',
        status: 'shadow',
        confidence: 0.7,
        rules: JSON.stringify({
          id: 'candidate-login-wall',
          matchers: {
            url_domain: 'app.example.com',
            text_any: ['password to continue'],
          },
          output: { decision_type: 'check', value: true, confidence: 0.7 },
        }),
      });

      // 3. Agent submits answers
      const submitResult = await executeSubmitAnswers(
        {
          answers: [
            {
              decision_id: decisionId,
              value: true,
              confidence: 0.95,
            },
          ],
        },
        { store },
      );

      expect(submitResult.answers).toHaveLength(1);

      // 4. Verify shadow sample was recorded automatically
      const samples = store.shadowSamples.listByDecisionId(decisionId);
      expect(samples).toHaveLength(1);
      expect(samples[0]!.pattern_id).toBe(shadowPattern.id);
      expect(samples[0]!.source).toBe('slow_answer');
      expect(samples[0]!.agreed).toBe(1);

      // 5. Verify pattern_stats updated
      const stats = store.patternStats.getById(shadowPattern.id);
      expect(stats?.sample_count).toBe(1);
      expect(stats?.agreed_count).toBe(1);
      expect(stats?.disagreed_count).toBe(0);
    });

    it('feedback triggers shadow evaluation for human corrections', async () => {
      // Create decision with initial answer false
      const decision = store.decisions.create({
        decision_type: 'check',
        question: 'Is this an advertisement?',
        answer: 'false',
        confidence: 0.85,
        path: 'ai',
        domain: 'news.example.com',
        url: 'https://news.example.com/article',
        context: JSON.stringify({
          url: 'https://news.example.com/article',
          domain: 'news.example.com',
          elements: [{ role: 'banner', text: 'sponsored content' }],
        }),
      });

      // Store a shadow candidate that predicted true
      const shadowPattern = store.patterns.create({
        id: 'candidate-ad',
        name: 'Ad Candidate',
        decision_type: 'check',
        domain: 'news.example.com',
        status: 'shadow',
        confidence: 0.65,
        rules: JSON.stringify({
          id: 'candidate-ad',
          matchers: {
            url_domain: 'news.example.com',
            text_any: ['sponsored content'],
          },
          output: { decision_type: 'check', value: true, confidence: 0.65 },
        }),
      });

      // User corrects the decision to true, providing snapshot context
      store.signals.upsert({
        decision_id: decision.id,
        domain: 'news.example.com',
        path: '/article',
        element_role: 'banner',
        element_text: 'sponsored content',
        element_source: 'target',
        source: 'slow_path_answer',
        tokens: ['sponsored', 'content'],
      });

      const feedbackResult = await executeFeedback(
        {
          decision_id: decision.id,
          correct_value: true,
          note: 'This is definitely an ad banner',
        },
        { store },
      );

      expect(feedbackResult.status).toBe('recorded');

      // Shadow candidate should have been evaluated against the feedback correction (true)
      const samples = store.shadowSamples.listByDecisionId(decision.id);
      expect(samples).toHaveLength(1);
      expect(samples[0]!.pattern_id).toBe(shadowPattern.id);
      expect(samples[0]!.source).toBe('feedback');
      expect(samples[0]!.agreed).toBe(1); // candidate predicted true, correction was true!

      const stats = store.patternStats.getById(shadowPattern.id);
      expect(stats?.sample_count).toBe(1);
      expect(stats?.agreed_count).toBe(1);
    });

    it('fault tolerance: failure inside shadow evaluation does not fail tool call', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const decision = store.decisions.create({
        decision_type: 'check',
        question: 'Check?',
        answer: 'pending',
        confidence: 0,
        path: 'ai',
      });

      // Intentionally close the database to simulate an unexpected error during shadow evaluation
      // But wait: closing db will cause submit_answers to fail earlier when updating log!
      // Instead, spy on store.shadowSamples.recordSample to throw an error!
      vi.spyOn(store.shadowSamples, 'recordSample').mockImplementation(() => {
        throw new Error('Simulated shadow storage failure');
      });

      // Create a matching shadow candidate
      store.patterns.create({
        id: 'candidate-fail-test',
        name: 'Fail Test Candidate',
        decision_type: 'check',
        status: 'shadow',
        rules: JSON.stringify({
          id: 'candidate-fail-test',
          matchers: {},
          output: { decision_type: 'check', value: true, confidence: 0.5 },
        }),
      });

      // submit_answers should succeed despite shadow evaluation error
      const submitRes = await executeSubmitAnswers(
        {
          answers: [
            {
              decision_id: decision.id,
              value: true,
              confidence: 0.9,
            },
          ],
        },
        { store },
      );

      expect(submitRes.answers).toHaveLength(1);
      expect(consoleErrorSpy).toHaveBeenCalled();

      // feedback should also succeed despite shadow evaluation error
      const feedbackRes = await executeFeedback(
        {
          decision_id: decision.id,
          correct_value: false,
        },
        { store },
      );

      expect(feedbackRes.status).toBe('recorded');
      expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
    });
  });
});
