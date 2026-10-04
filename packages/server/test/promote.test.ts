import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DatabaseStore,
  type Question,
  type Rule,
  createStore,
  createPatternEngine,
  loadActivePatternsIntoEngine,
  evaluateShadowCandidates,
  promoteCandidate,
  promoteAllCandidates,
  isCandidateSafetyRelated,
  getPromotionThresholds,
  setPromotionThresholds,
  validatePromotionThresholds,
  executeDecide,
  executeSubmitAnswers,
  executeFeedback,
} from '../src/index.js';

describe('promotion rules (learning/promote.ts)', () => {
  let tempDir: string;
  let dbPath: string;
  let store: DatabaseStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-promote-'));
    dbPath = join(tempDir, 'test.db');
    store = createStore(dbPath);
  });

  afterEach(() => {
    if (store) {
      store.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createTestPattern(options: {
    id: string;
    decisionType?: 'check' | 'choice' | 'score';
    role?: string;
    text?: string;
    value?: string | number | boolean;
    confidence?: number;
    status?: 'candidate' | 'shadow' | 'active' | 'disabled';
    isSafety?: boolean | number;
    packId?: string | null;
  }) {
    const decisionType = options.decisionType ?? 'check';
    const rule: Rule = {
      id: options.id,
      name: `Test rule ${options.id}`,
      matchers: {
        ...(options.role ? { role: options.role } : {}),
        ...(options.text ? { text_any: options.text } : {}),
      },
      output: {
        decision_type: decisionType,
        value: options.value ?? true,
        confidence: options.confidence ?? 1.0,
      },
      safety: Boolean(options.isSafety),
      is_safety: Boolean(options.isSafety),
    };

    return store.patterns.create({
      id: options.id,
      name: `Candidate ${options.id}`,
      decision_type: decisionType,
      rules: JSON.stringify(rule),
      status: options.status ?? 'shadow',
      confidence: options.confidence ?? 1.0,
      is_safety: options.isSafety ? 1 : 0,
      pack_id: options.packId ?? null,
    });
  }

  function simulateSamples(patternId: string, total: number, agreed: number) {
    store.patternStats.upsert({
      pattern_id: patternId,
      sample_count: total,
      agreed_count: agreed,
      disagreed_count: total - agreed,
    });
  }

  describe('promotion thresholds and validation', () => {
    it('provides sane defaults: 20 samples / 95% agreement standard, 50 samples / 99% safety', () => {
      const thresholds = getPromotionThresholds(store);
      expect(thresholds.standard.min_samples).toBe(20);
      expect(thresholds.standard.min_agreement).toBe(0.95);
      expect(thresholds.safety.min_samples).toBe(50);
      expect(thresholds.safety.min_agreement).toBe(0.99);
    });

    it('rejects thresholds that would make safety promotion easier than defaults (< 50 samples or < 99%)', () => {
      // Safety min_samples < 50 rejected
      expect(() =>
        validatePromotionThresholds({
          safety: { min_samples: 49, min_agreement: 0.99 },
        }),
      ).toThrow(/Safety promotion threshold min_samples cannot be less than 50/i);

      // Safety min_agreement < 0.99 rejected
      expect(() =>
        validatePromotionThresholds({
          safety: { min_samples: 50, min_agreement: 0.98 },
        }),
      ).toThrow(/Safety promotion threshold min_agreement cannot be less than/i);
    });

    it('clamps safety minimums so they can never be lower than standard thresholds', () => {
      // If standard is raised above safety, safety must be at least standard
      expect(() =>
        validatePromotionThresholds({
          standard: { min_samples: 60, min_agreement: 0.95 },
          safety: { min_samples: 50, min_agreement: 0.99 },
        }),
      ).toThrow(/Safety min_samples .* cannot be lower than standard min_samples/i);
    });

    it('persists and retrieves custom valid thresholds from store settings without restart', () => {
      const updated = setPromotionThresholds(store, {
        standard: { min_samples: 30, min_agreement: 0.96 },
        safety: { min_samples: 60, min_agreement: 0.995 },
      });

      expect(updated.standard.min_samples).toBe(30);
      expect(updated.standard.min_agreement).toBe(0.96);
      expect(updated.safety.min_samples).toBe(60);
      expect(updated.safety.min_agreement).toBe(0.995);

      const reRead = getPromotionThresholds(store);
      expect(reRead.standard.min_samples).toBe(30);
      expect(reRead.standard.min_agreement).toBe(0.96);
      expect(reRead.safety.min_samples).toBe(60);
      expect(reRead.safety.min_agreement).toBe(0.995);
    });
  });

  describe('standard candidate promotion', () => {
    it('does not promote a candidate with fewer than 20 samples', () => {
      const pattern = createTestPattern({ id: 'pat-samples-19', role: 'button', text: 'Dismiss' });
      simulateSamples(pattern.id, 19, 19); // 19/19 = 100% agreement, but < 20 samples

      const result = promoteCandidate({ store, patternId: pattern.id });
      expect(result.promoted).toBe(false);
      expect(result.reason).toBe('insufficient_samples');
      expect(store.patterns.getById(pattern.id)!.status).toBe('shadow');
    });

    it('does not promote a candidate with agreement below 95%', () => {
      const pattern = createTestPattern({ id: 'pat-agree-90', role: 'button', text: 'Dismiss' });
      simulateSamples(pattern.id, 20, 18); // 18/20 = 90% agreement, < 95%

      const result = promoteCandidate({ store, patternId: pattern.id });
      expect(result.promoted).toBe(false);
      expect(result.reason).toBe('insufficient_agreement');
      expect(store.patterns.getById(pattern.id)!.status).toBe('shadow');
    });

    it('promotes a candidate with >= 20 samples and >= 95% agreement to status active', () => {
      const pattern = createTestPattern({
        id: 'pat-promote-ok',
        role: 'button',
        text: 'Dismiss banner',
      });
      simulateSamples(pattern.id, 20, 19); // 19/20 = 95% agreement

      const result = promoteCandidate({ store, patternId: pattern.id });
      expect(result.promoted).toBe(true);
      expect(result.status).toBe('active');

      const inDb = store.patterns.getById(pattern.id)!;
      expect(inDb.status).toBe('active');
      expect(inDb.is_safety).toBe(0);
    });

    it('caps a promoted pattern output confidence by its measured agreement', () => {
      // Initial confidence was 1.0, but measured agreement is 19/20 = 0.95
      const pattern = createTestPattern({
        id: 'pat-confidence-cap',
        role: 'button',
        text: 'Close modal',
        confidence: 1.0,
      });
      simulateSamples(pattern.id, 20, 19); // 95% agreement

      const result = promoteCandidate({ store, patternId: pattern.id });
      expect(result.promoted).toBe(true);

      const inDb = store.patterns.getById(pattern.id)!;
      expect(inDb.confidence).toBe(0.95);

      const rule = JSON.parse(inDb.rules) as Rule;
      expect(rule.output.confidence).toBe(0.95);
    });

    it('logs an atomic promotion EVENT with pattern id, samples, agreement, thresholds used, timestamp', () => {
      const pattern = createTestPattern({
        id: 'pat-event-log',
        role: 'button',
        text: 'Accept cookie',
      });
      simulateSamples(pattern.id, 25, 24); // 24/25 = 96% agreement

      const result = promoteCandidate({ store, patternId: pattern.id });
      expect(result.promoted).toBe(true);
      expect(result.event).toBeDefined();

      const events = store.promotionEvents.listByPatternId(pattern.id);
      expect(events).toHaveLength(1);
      const ev = events[0]!;
      expect(ev.pattern_id).toBe(pattern.id);
      expect(ev.sample_count).toBe(25);
      expect(ev.agreement).toBe(0.96);
      expect(ev.threshold_samples).toBe(20);
      expect(ev.threshold_agreement).toBe(0.95);
      expect(ev.thresholds).toContain('min_samples');
      expect(ev.created_at).toBeDefined();
    });

    it('is idempotent: evaluating an already promoted pattern does not re-promote or duplicate events', () => {
      const pattern = createTestPattern({ id: 'pat-idempotent', role: 'button', text: 'Dismiss' });
      simulateSamples(pattern.id, 20, 20);

      const res1 = promoteCandidate({ store, patternId: pattern.id });
      expect(res1.promoted).toBe(true);

      const res2 = promoteCandidate({ store, patternId: pattern.id });
      expect(res2.promoted).toBe(false);
      expect(res2.status).toBe('active');
      expect(res2.reason).toBe('not_shadow');

      const events = store.promotionEvents.listByPatternId(pattern.id);
      expect(events).toHaveLength(1);
    });
  });

  describe('safety-related candidate promotion', () => {
    it('detects safety-related candidates from text touching payment, destructive, or outbound families', () => {
      const paymentPat = createTestPattern({ id: 'p-pay', role: 'button', text: 'Buy now' });
      const destructivePat = createTestPattern({
        id: 'p-dest',
        role: 'button',
        text: 'Delete account',
      });
      const outboundPat = createTestPattern({ id: 'p-out', role: 'button', text: 'Send message' });
      const benignPat = createTestPattern({ id: 'p-benign', role: 'button', text: 'View profile' });

      expect(isCandidateSafetyRelated(store, paymentPat)).toBe(true);
      expect(isCandidateSafetyRelated(store, destructivePat)).toBe(true);
      expect(isCandidateSafetyRelated(store, outboundPat)).toBe(true);
      expect(isCandidateSafetyRelated(store, benignPat)).toBe(false);
    });

    it('detects safety-related candidates when samples come from decisions flagged is_safety', () => {
      const benignPat = createTestPattern({
        id: 'p-sampled-safety',
        role: 'button',
        text: 'Continue',
      });
      expect(isCandidateSafetyRelated(store, benignPat)).toBe(false);

      // Record a decision flagged is_safety = 1
      const safetyDecision = store.decisions.create({
        decision_type: 'check',
        question: 'Should the agent proceed?',
        answer: 'ask_user',
        confidence: 0.95,
        path: 'check',
        is_safety: 1,
      });

      // Add a shadow sample pointing to that safety decision
      store.shadowSamples.recordSample({
        decision_id: safetyDecision.id,
        pattern_id: benignPat.id,
        source: 'slow_answer',
        agreed: true,
      });

      expect(isCandidateSafetyRelated(store, benignPat)).toBe(true);
    });

    it('requires >= 50 samples and >= 99% agreement for safety-related candidates', () => {
      const safetyPat = createTestPattern({
        id: 'p-safety-thresh',
        role: 'button',
        text: 'Pay with card',
      });

      // 20 samples / 100% agreement is not enough for safety candidate
      simulateSamples(safetyPat.id, 20, 20);
      const res1 = promoteCandidate({ store, patternId: safetyPat.id });
      expect(res1.promoted).toBe(false);
      expect(res1.reason).toBe('insufficient_samples');
      expect(res1.required_samples).toBe(50);
      expect(res1.required_agreement).toBe(0.99);

      // 50 samples / 98% agreement (49/50) is not enough (needs 99%)
      simulateSamples(safetyPat.id, 50, 49); // 98%
      const res2 = promoteCandidate({ store, patternId: safetyPat.id });
      expect(res2.promoted).toBe(false);
      expect(res2.reason).toBe('insufficient_agreement');

      // 50 samples / 100% agreement qualifies for promotion
      simulateSamples(safetyPat.id, 50, 50);
      const res3 = promoteCandidate({ store, patternId: safetyPat.id });
      expect(res3.promoted).toBe(true);
      expect(res3.status).toBe('active');
    });

    it('promoted pattern NEVER carries the safety flag', () => {
      const safetyPat = createTestPattern({
        id: 'p-never-safety-flag',
        role: 'button',
        text: 'Place order',
        isSafety: true,
      });
      simulateSamples(safetyPat.id, 50, 50);

      const res = promoteCandidate({ store, patternId: safetyPat.id });
      expect(res.promoted).toBe(true);

      const inDb = store.patterns.getById(safetyPat.id)!;
      expect(inDb.is_safety).toBe(0);

      const parsedRule = JSON.parse(inDb.rules) as Rule;
      expect(parsedRule.safety).toBe(false);
      expect(parsedRule.is_safety).toBe(false);
    });
  });

  describe('safety precedence over promoted learned patterns', () => {
    it('promoted learned pattern loses to a safety rule that matches the same input', () => {
      // 1. Pack safety rule: matches button with 'Delete' and outputs ask_user with safety: true
      const safetyRule: Rule = {
        id: 'safety-rule-delete',
        safety: true,
        is_safety: true,
        matchers: { role: 'button', text_any: 'Delete' },
        output: {
          decision_type: 'choice',
          value: 'ask_user',
          confidence: 0.99,
          distribution: { allow: 0.01, ask_user: 0.99 },
        },
      };

      // 2. Learned pattern candidate promoted to active: matches same button but outputs allow
      const learnedRule: Rule = {
        id: 'learned-rule-delete',
        safety: false,
        is_safety: false,
        matchers: { role: 'button', text_any: 'Delete' },
        output: {
          decision_type: 'choice',
          value: 'allow',
          confidence: 0.95,
          distribution: { allow: 0.95, ask_user: 0.05 },
        },
      };

      // Pattern engine loads both
      const engine = createPatternEngine([safetyRule, learnedRule]);

      const question: Question = {
        id: 'q-action',
        type: 'choice',
        text: 'Is this action safe?',
        options: [
          { id: 'allow', description: 'Allow' },
          { id: 'ask_user', description: 'Ask User' },
        ],
      };

      const input = {
        elements: [{ role: 'button', text: 'Delete item' }],
      };

      // Match against input: safety rule MUST take precedence over the learned pattern
      const match = engine.matchForQuestion(input, question, { threshold: 0 });
      expect(match).not.toBeNull();
      expect(match!.pattern_id).toBe('safety-rule-delete');
      expect(match!.is_safety).toBe(true);
      expect(match!.output.value).toBe('ask_user');
    });
  });

  describe('promoteAllCandidates function', () => {
    it('promotes all eligible shadow candidates in one call', () => {
      const pat1 = createTestPattern({ id: 'all-pat-1', role: 'button', text: 'Banner 1' });
      const pat2 = createTestPattern({ id: 'all-pat-2', role: 'button', text: 'Banner 2' });
      const pat3 = createTestPattern({ id: 'all-pat-3', role: 'button', text: 'Banner 3' });

      simulateSamples(pat1.id, 20, 20); // eligible
      simulateSamples(pat2.id, 10, 10); // ineligible (<20)
      simulateSamples(pat3.id, 25, 25); // eligible

      const outcomes = promoteAllCandidates({ store });
      expect(outcomes).toHaveLength(3);

      const promotedIds = outcomes.filter((o) => o.promoted).map((o) => o.pattern_id);
      expect(promotedIds).toEqual(['all-pat-1', 'all-pat-3']);

      expect(store.patterns.getById(pat1.id)!.status).toBe('active');
      expect(store.patterns.getById(pat2.id)!.status).toBe('shadow');
      expect(store.patterns.getById(pat3.id)!.status).toBe('active');
    });
  });

  describe('engine loader and fast-path execution', () => {
    it('loads active patterns into the engine and answers decide from fast path pattern', async () => {
      const pattern = createTestPattern({
        id: 'pat-fast-path',
        role: 'button',
        text: 'Accept terms',
        value: true,
        confidence: 0.96,
        status: 'active', // already active
      });
      simulateSamples(pattern.id, 25, 24); // 96% agreement

      const engine = createPatternEngine();
      loadActivePatternsIntoEngine(engine, store);

      const question: Question = {
        id: 'q-terms',
        type: 'check',
        text: 'Did user accept terms?',
      };

      const result = await executeDecide(
        {
          questions: [question],
          state: { elements: [{ role: 'button', text: 'Accept terms and conditions' }] },
        },
        { store, patternEngine: engine },
      );

      expect(result.answers).toHaveLength(1);
      const answer = result.answers[0]!;
      expect(answer.path).toBe('pattern');
      expect(answer.pattern_id).toBe(pattern.id);
      expect(answer.value).toBe(true);
      expect(answer.confidence).toBe(0.96);
    });
  });

  describe('loader never carries a safety flag', () => {
    it('loads an active pattern whose stored rule claims the safety flag as a non-safety rule', () => {
      const pattern = createTestPattern({
        id: 'pat-claims-safety',
        role: 'button',
        text: 'Anything',
        value: true,
        confidence: 0.96,
        status: 'active',
      });
      store.patterns.update(pattern.id, {
        rules: JSON.stringify({
          id: pattern.id,
          safety: true,
          is_safety: true,
          matchers: { role: 'button', text: 'Anything' },
          output: { type: 'check', value: true, confidence: 0.96 },
        }),
      });

      const engine = createPatternEngine();
      const loaded = loadActivePatternsIntoEngine(engine, store);

      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.safety).toBe(false);
      expect(loaded[0]!.is_safety).toBe(false);
      expect(engine.getRules().find((rule) => rule.id === pattern.id)?.safety).toBe(false);
    });
  });

  describe('evaluation hook and fault tolerance', () => {
    it('evaluates promotion after recording shadow samples in evaluateShadowCandidates', () => {
      const pattern = createTestPattern({
        id: 'pat-hook-eval',
        role: 'button',
        text: 'Cookie consent',
        value: true,
      });

      // Pre-seed 19 samples in stats
      simulateSamples(pattern.id, 19, 19);

      // Create a 20th decision and run evaluateShadowCandidates
      const decision = store.decisions.create({
        decision_type: 'check',
        question: 'Is this consent banner?',
        answer: 'true',
        confidence: 0.9,
        path: 'ai',
        is_safety: 0,
        context: JSON.stringify({ elements: [{ role: 'button', text: 'Cookie consent' }] }),
      });

      const outcome = evaluateShadowCandidates({
        store,
        decision,
        source: 'slow_answer',
        recordedAnswer: true,
      });

      expect(outcome.samples).toHaveLength(1);
      expect(outcome.samples[0]!.agreed).toBe(true);

      // Now 20 samples recorded -> automatically promoted!
      const updatedPattern = store.patterns.getById(pattern.id)!;
      expect(updatedPattern.status).toBe('active');

      const events = store.promotionEvents.listByPatternId(pattern.id);
      expect(events).toHaveLength(1);
    });

    it('a failure in promotion never fails submit_answers or feedback', async () => {
      const pattern = createTestPattern({
        id: 'pat-fault-tolerant',
        role: 'button',
        text: 'Cookie consent',
        value: true,
      });
      simulateSamples(pattern.id, 20, 20);

      // Intentionally break promotion by sabotaging the store db transaction
      const origTransaction = store.db.transaction.bind(store.db);
      store.db.transaction = () => {
        throw new Error('Simulated promotion transaction failure');
      };

      const decision = store.decisions.create({
        decision_type: 'check',
        question: 'Is this popup?',
        answer: 'pending',
        confidence: 0.0,
        path: 'ai',
        is_safety: 0,
      });

      // executeSubmitAnswers must NOT throw even if promotion fails
      const submitRes = await executeSubmitAnswers(
        {
          decisions: [
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

      // executeFeedback must NOT throw even if promotion fails
      const feedbackRes = await executeFeedback(
        {
          decision_id: decision.id,
          correct_value: true,
        },
        { store },
      );

      expect(feedbackRes.status).toBe('recorded');

      // Restore transaction
      store.db.transaction = origTransaction;
    });
  });

  describe('end-to-end promotion through tools', () => {
    it('promotes candidate through shadow testing and answers subsequent decide call from pattern fast path', async () => {
      // 1. Candidate pattern exists in status shadow
      const pattern = createTestPattern({
        id: 'pat-e2e-dialog',
        role: 'button',
        text: 'Close promo banner',
        value: true,
      });

      // 2. Pre-seed 19 agreeing samples
      simulateSamples(pattern.id, 19, 19);

      // 3. 20th sample arrives via submit_answers
      const decision = store.decisions.create({
        decision_type: 'check',
        question: 'Is dialog dismissible?',
        answer: 'pending',
        confidence: 0.0,
        path: 'ai',
        is_safety: 0,
        context: JSON.stringify({ elements: [{ role: 'button', text: 'Close promo banner' }] }),
      });

      const submitRes = await executeSubmitAnswers(
        {
          decisions: [
            {
              decision_id: decision.id,
              value: true,
              confidence: 0.95,
            },
          ],
        },
        { store },
      );
      expect(submitRes.answers).toHaveLength(1);

      // 4. Pattern should now be promoted to active
      const promoted = store.patterns.getById(pattern.id)!;
      expect(promoted.status).toBe('active');

      // 5. Engine loads active patterns and serves subsequent decide call via fast path
      const engine = createPatternEngine();
      loadActivePatternsIntoEngine(engine, store);

      const question: Question = {
        id: 'q-promo',
        type: 'check',
        text: 'Is dialog dismissible?',
      };

      const decideRes = await executeDecide(
        {
          questions: [question],
          state: { elements: [{ role: 'button', text: 'Close promo banner' }] },
        },
        { store, patternEngine: engine },
      );

      expect(decideRes.answers).toHaveLength(1);
      expect(decideRes.answers[0]!.path).toBe('pattern');
      expect(decideRes.answers[0]!.pattern_id).toBe(pattern.id);
      expect(decideRes.answers[0]!.value).toBe(true);
    });
  });
});
