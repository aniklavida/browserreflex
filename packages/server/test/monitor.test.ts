import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DatabaseStore,
  type PatternEngine,
  type Question,
  type Rule,
  completeRecheck,
  createPatternEngine,
  createStore,
  demotePattern,
  executeDecide,
  executeFeedback,
  executeGetStats,
  getMonitorSettings,
  loadActivePatternsIntoEngine,
  sampleForRecheck,
} from '../src/index.js';

const ALWAYS = () => 0;
const NEVER = () => 0.99;

describe('re-check, demote and drift alert (learning/monitor.ts)', () => {
  let tempDir: string;
  let store: DatabaseStore;
  let engine: PatternEngine;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-monitor-'));
    store = createStore(join(tempDir, 'test.db'));
    engine = createPatternEngine();
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const QUESTION: Question = { id: 'q-promo', type: 'check', text: 'Is dialog dismissible?' };

  function createActivePattern(id: string, isSafety = false) {
    const rule: Rule = {
      id,
      name: `Learned ${id}`,
      matchers: { role: 'button', text_any: 'Close promo banner' },
      output: { decision_type: 'check', value: true, confidence: 0.97 },
      safety: false,
      is_safety: false,
    };
    const created = store.patterns.create({
      id,
      name: `Learned ${id}`,
      decision_type: 'check',
      rules: JSON.stringify(rule),
      status: 'active',
      confidence: 0.97,
      is_safety: isSafety ? 1 : 0,
      pack_id: null,
    });
    // A learned pattern is one that promotion made active, so it has a promotion event.
    store.promotionEvents.create({
      pattern_id: id,
      sample_count: 25,
      agreement: 1,
      threshold_samples: 20,
      threshold_agreement: 0.95,
      thresholds: {},
      is_safety: isSafety ? 1 : 0,
    });
    return created;
  }

  /** One decide call on a distinct page, so memory never answers it. */
  async function decideOnPage(page: number, random: () => number = ALWAYS) {
    const result = await executeDecide(
      {
        questions: [QUESTION],
        state: { elements: [{ role: 'button', text: `Close promo banner ${page}` }] },
      },
      { store, patternEngine: engine, random },
    );
    return result;
  }

  async function sampledDecision(page: number) {
    const result = await decideOnPage(page);
    const answer = result.answers[0]!;
    expect(answer.path).toBe('pattern');
    return answer.decision_id;
  }

  async function correct(decisionId: string, value: boolean) {
    return executeFeedback(
      { decision_id: decisionId, correct_value: String(value), source: 'user' },
      { store, patternEngine: engine },
    );
  }

  describe('settings', () => {
    it('defaults to a 2% re-check rate, a window of 20 and a 90% demotion threshold', () => {
      expect(getMonitorSettings(store)).toEqual({
        recheckRate: 0.02,
        recheckWindow: 20,
        demotionThreshold: 0.9,
      });
    });

    it('never accepts a demotion threshold weaker than 90%', () => {
      store.settings.set('monitor.demotion_threshold', '0.5');
      expect(getMonitorSettings(store).demotionThreshold).toBe(0.9);
    });
  });

  describe('re-check sampling', () => {
    it('records a pending re-check and flags the decision for review when the random draw is under the rate', async () => {
      createActivePattern('learned-a');
      loadActivePatternsIntoEngine(engine, store);

      const decisionId = await sampledDecision(1);

      const recheck = store.rechecks.getByDecisionId(decisionId);
      expect(recheck?.status).toBe('pending');
      expect(recheck?.pattern_id).toBe('learned-a');
      expect(store.decisions.getById(decisionId)?.needs_review).toBe(1);
    });

    it('does not sample when the random draw is over the rate', async () => {
      createActivePattern('learned-a');
      loadActivePatternsIntoEngine(engine, store);

      const result = await decideOnPage(1, NEVER);
      const decisionId = result.answers[0]!.decision_id;

      expect(store.rechecks.getByDecisionId(decisionId)).toBeNull();
    });

    it('returns the pattern answer unchanged when a re-check is sampled', async () => {
      createActivePattern('learned-a');
      loadActivePatternsIntoEngine(engine, store);

      const sampled = await decideOnPage(1, ALWAYS);
      const unsampled = await decideOnPage(2, NEVER);

      expect(sampled.answers[0]!.value).toBe(unsampled.answers[0]!.value);
      expect(sampled.answers[0]!.confidence).toBe(unsampled.answers[0]!.confidence);
      expect(sampled.answers[0]!.path).toBe('pattern');
    });

    it('does not sample an answer from a rule that is not a learned pattern in the store', async () => {
      engine.addRule({
        id: 'pack.rule',
        matchers: { role: 'button', text_any: 'Close promo banner' },
        output: { decision_type: 'check', value: true, confidence: 0.97 },
      });

      const result = await decideOnPage(1, ALWAYS);

      expect(result.answers[0]!.path).toBe('pattern');
      expect(store.rechecks.list({}).length).toBe(0);
    });

    it('does not sample a safety-flagged pattern', () => {
      createActivePattern('safety-flagged', true);
      const decision = store.decisions.create({
        decision_type: 'check',
        question: 'q',
        answer: 'true',
        confidence: 0.9,
        path: 'pattern',
      });

      const outcome = sampleForRecheck(
        {
          store,
          decisionId: decision.id,
          patternId: 'safety-flagged',
          patternAnswer: 'true',
        },
        ALWAYS,
      );

      expect(outcome.sampled).toBe(false);
    });

    it('samples a decision once', async () => {
      createActivePattern('learned-a');
      loadActivePatternsIntoEngine(engine, store);
      const decisionId = await sampledDecision(1);

      const again = sampleForRecheck(
        { store, decisionId, patternId: 'learned-a', patternAnswer: 'true' },
        ALWAYS,
      );

      expect(again.sampled).toBe(false);
      expect(store.rechecks.list({}).length).toBe(1);
    });
  });

  describe('completing a re-check through feedback', () => {
    it('records an agreement when the correct value matches the pattern answer', async () => {
      createActivePattern('learned-a');
      loadActivePatternsIntoEngine(engine, store);
      const decisionId = await sampledDecision(1);

      const result = await correct(decisionId, true);

      expect(result.status).toBe('recorded');
      const recheck = store.rechecks.getByDecisionId(decisionId)!;
      expect(recheck.status).toBe('completed');
      expect(recheck.agreed).toBe(1);
      expect(store.patterns.getById('learned-a')!.status).toBe('active');
    });

    it('records a disagreement when the correct value differs', async () => {
      createActivePattern('learned-a');
      loadActivePatternsIntoEngine(engine, store);
      const decisionId = await sampledDecision(1);

      await correct(decisionId, false);

      expect(store.rechecks.getByDecisionId(decisionId)!.agreed).toBe(0);
    });

    it('does not count a re-check twice in pattern_stats', async () => {
      createActivePattern('learned-a');
      loadActivePatternsIntoEngine(engine, store);
      const decisionId = await sampledDecision(1);

      await correct(decisionId, false);

      const stats = store.patternStats.getById('learned-a');
      expect(stats?.sample_count ?? 0).toBeLessThanOrEqual(1);
    });

    it('does not fail the feedback call when the monitor throws', async () => {
      createActivePattern('learned-a');
      loadActivePatternsIntoEngine(engine, store);
      const decisionId = await sampledDecision(1);
      const spy = vi.spyOn(store.rechecks, 'getByDecisionId').mockImplementation(() => {
        throw new Error('monitor storage failure');
      });
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await correct(decisionId, false);

      expect(result.status).toBe('recorded');
      expect(logged).toHaveBeenCalled();
      spy.mockRestore();
      logged.mockRestore();
    });
  });

  describe('demotion after a simulated site change', () => {
    it('disables the rule within 20 disagreeing re-checks, stops serving it, and raises a drift alert', async () => {
      createActivePattern('learned-a');
      loadActivePatternsIntoEngine(engine, store);

      for (let page = 1; page <= 19; page += 1) {
        await correct(await sampledDecision(page), false);
      }
      expect(store.patterns.getById('learned-a')!.status).toBe('active');
      expect(store.driftAlerts.list({}).length).toBe(0);

      await correct(await sampledDecision(20), false);

      expect(store.patterns.getById('learned-a')!.status).toBe('disabled');

      const afterwards = await decideOnPage(21, NEVER);
      expect(afterwards.answers).toHaveLength(0);
      expect(afterwards.needs_ai).toHaveLength(1);

      const events = store.demotionEvents.list({ pattern_id: 'learned-a' });
      expect(events).toHaveLength(1);
      expect(events[0]!.accuracy).toBe(0);

      const alerts = store.driftAlerts.list({ status: 'active' });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.pattern_id).toBe('learned-a');
    });

    it('reports the drift alert in get_stats', async () => {
      createActivePattern('learned-a');
      loadActivePatternsIntoEngine(engine, store);
      for (let page = 1; page <= 20; page += 1) {
        await correct(await sampledDecision(page), false);
      }

      const stats = executeGetStats({}, { store });

      expect(stats.drift_alerts.active).toBe(1);
      expect(stats.drift_alerts.items[0]!.pattern_id).toBe('learned-a');
    });

    it('keeps a pattern whose re-checks agree', async () => {
      createActivePattern('learned-a');
      loadActivePatternsIntoEngine(engine, store);

      for (let page = 1; page <= 20; page += 1) {
        await correct(await sampledDecision(page), true);
      }

      expect(store.patterns.getById('learned-a')!.status).toBe('active');
      expect(store.driftAlerts.list({}).length).toBe(0);
      const still = await decideOnPage(21, NEVER);
      expect(still.answers[0]!.path).toBe('pattern');
    });

    it('keeps a pattern at exactly the threshold (18 of 20 agree is 90%)', async () => {
      createActivePattern('learned-a');
      loadActivePatternsIntoEngine(engine, store);

      for (let page = 1; page <= 20; page += 1) {
        await correct(await sampledDecision(page), page > 2);
      }

      expect(store.patterns.getById('learned-a')!.status).toBe('active');
    });

    it('demotes a pattern at 17 of 20 (85%)', async () => {
      createActivePattern('learned-a');
      loadActivePatternsIntoEngine(engine, store);

      for (let page = 1; page <= 20; page += 1) {
        await correct(await sampledDecision(page), page > 3);
      }

      expect(store.patterns.getById('learned-a')!.status).toBe('disabled');
    });

    it('is idempotent: demoting twice writes one event and one alert', () => {
      createActivePattern('learned-a');
      const args = {
        store,
        patternId: 'learned-a',
        sampleCount: 20,
        agreedCount: 0,
        disagreedCount: 20,
        accuracy: 0,
        threshold: 0.9,
        reason: 'test',
      };

      const first = demotePattern(args);
      const second = demotePattern(args);

      expect(first.demoted).toBe(true);
      expect(second.demoted).toBe(false);
      expect(store.demotionEvents.list({ pattern_id: 'learned-a' })).toHaveLength(1);
      expect(store.driftAlerts.list({ pattern_id: 'learned-a' })).toHaveLength(1);
    });
  });

  describe('only promoted learned patterns are monitored', () => {
    it('does not demote a rule that has a stub pattern row but no promotion event', () => {
      // The decision log writes this stub for every rule that answers, pack rules included.
      store.patterns.create({
        id: 'browser.cookie.accept',
        name: 'browser.cookie.accept',
        decision_type: 'check',
        rules: '{}',
        status: 'active',
        confidence: 0.9,
        is_safety: 0,
        pack_id: null,
      });

      const outcome = demotePattern({
        store,
        patternId: 'browser.cookie.accept',
        sampleCount: 20,
        agreedCount: 0,
        disagreedCount: 20,
        accuracy: 0,
        threshold: 0.9,
        reason: 'test',
      });

      expect(outcome.demoted).toBe(false);
      expect(outcome.reason).toBe('not_learned');
      expect(store.patterns.getById('browser.cookie.accept')!.status).toBe('active');
      expect(store.driftAlerts.list({})).toHaveLength(0);
    });
  });

  describe('safety rules are not touched', () => {
    it('never demotes a safety-flagged pattern, whatever its re-checks say', () => {
      createActivePattern('safety-flagged', true);

      for (let index = 0; index < 25; index += 1) {
        const decision = store.decisions.create({
          decision_type: 'check',
          question: `q${index}`,
          answer: 'true',
          confidence: 0.9,
          path: 'pattern',
        });
        store.rechecks.create({
          decision_id: decision.id,
          pattern_id: 'safety-flagged',
          pattern_answer: 'true',
        });
        completeRecheck({
          store,
          decisionId: decision.id,
          slowAnswer: 'false',
          source: 'feedback',
          engine,
        });
      }

      expect(store.patterns.getById('safety-flagged')!.status).toBe('active');
      expect(store.demotionEvents.list({})).toHaveLength(0);
      expect(
        demotePattern({
          store,
          patternId: 'safety-flagged',
          sampleCount: 20,
          agreedCount: 0,
          disagreedCount: 20,
          accuracy: 0,
          threshold: 0.9,
          reason: 'direct',
        }).demoted,
      ).toBe(false);
    });

    it('does not remove a safety rule from the engine', () => {
      engine.addRule({
        id: 'browser.risky.payment.pay_control',
        safety: true,
        matchers: { role: 'button', text_any: 'Pay now' },
        output: { decision_type: 'check', value: 'ask_user', confidence: 0.95 },
      });
      createActivePattern('learned-a');

      demotePattern({
        store,
        patternId: 'learned-a',
        sampleCount: 20,
        agreedCount: 0,
        disagreedCount: 20,
        accuracy: 0,
        threshold: 0.9,
        reason: 'test',
        engine,
      });

      expect(
        engine.getRules().some((rule) => rule.id === 'browser.risky.payment.pay_control'),
      ).toBe(true);
    });
  });
});
