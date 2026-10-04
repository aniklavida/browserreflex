import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DatabaseStore,
  type PatternEngine,
  type Question,
  createPatternEngine,
  createStore,
  executeDecide,
  loadActivePatternsIntoEngine,
  syncEngineWithStore,
} from '../src/index.js';

describe('keeping the live engine in step with the store (learning/sync.ts)', () => {
  let tempDir: string;
  let store: DatabaseStore;
  let engine: PatternEngine;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-sync-'));
    store = createStore(join(tempDir, 'test.db'));
    engine = createPatternEngine();
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const QUESTION: Question = { id: 'q-promo', type: 'check', text: 'Is dialog dismissible?' };

  function addPackRule(packId: string, id: string, safety = false) {
    engine.addRule({
      id,
      pack_id: packId,
      safety,
      is_safety: safety,
      matchers: { role: 'button', text_any: 'Close promo banner' },
      output: { decision_type: 'check', value: true, confidence: 0.97 },
    });
  }

  function storeLearned(id: string, promoted: boolean, status = 'active') {
    store.patterns.create({
      id,
      name: id,
      decision_type: 'check',
      rules: JSON.stringify({
        id,
        matchers: { role: 'button', text_any: 'Close promo banner' },
        output: { decision_type: 'check', value: true, confidence: 0.97 },
      }),
      status: status as 'active',
      confidence: 0.97,
      is_safety: false,
      pack_id: null,
    });
    if (promoted) {
      store.promotionEvents.create({
        pattern_id: id,
        sample_count: 25,
        agreement: 1,
        threshold_samples: 20,
        threshold_agreement: 0.95,
        thresholds: {},
      });
    }
  }

  function stubRow(id: string) {
    // What the decision log writes for every rule that answers.
    store.patterns.create({
      id,
      name: id,
      decision_type: 'check',
      rules: '{}',
      status: 'active',
      confidence: 0.9,
      is_safety: false,
      pack_id: null,
    });
  }

  // Each call is a different page, so memory never answers it.
  let page = 0;
  const decide = () => {
    page += 1;
    return executeDecide(
      {
        questions: [QUESTION],
        state: { elements: [{ role: 'button', text: `Close promo banner ${page}` }] },
      },
      { store, patternEngine: engine },
    );
  };

  describe('loading learned patterns at start-up', () => {
    it('never replaces a pack rule with the stub row the decision log wrote for it', async () => {
      addPackRule('browser', 'browser.popup.close');
      stubRow('browser.popup.close');

      loadActivePatternsIntoEngine(engine, store);

      const rule = engine.getRules().find((candidate) => candidate.id === 'browser.popup.close');
      expect(rule?.pack_id).toBe('browser');
      expect(Object.keys(rule?.matchers ?? {})).not.toHaveLength(0);
      const result = await decide();
      expect(result.answers[0]?.value).toBe(true);
    });

    it('does not load an active row that promotion never made active', () => {
      storeLearned('hand-written', false);
      expect(loadActivePatternsIntoEngine(engine, store)).toHaveLength(0);
      expect(engine.getRules()).toHaveLength(0);
    });

    it('does not load a rule that matches on nothing', () => {
      store.patterns.create({
        id: 'empty',
        name: 'empty',
        decision_type: 'check',
        rules: JSON.stringify({ id: 'empty', matchers: {}, output: { value: true } }),
        status: 'active',
        confidence: 0.9,
        is_safety: false,
        pack_id: null,
      });
      store.promotionEvents.create({
        pattern_id: 'empty',
        sample_count: 25,
        agreement: 1,
        threshold_samples: 20,
        threshold_agreement: 0.95,
        thresholds: {},
      });
      expect(loadActivePatternsIntoEngine(engine, store)).toHaveLength(0);
    });
  });

  describe('pack switches', () => {
    it('stops serving a switched-off pack non-safety rule and falls back to needs_ai', async () => {
      addPackRule('browser', 'browser.popup.close');
      store.packs.create({ id: 'browser', name: 'Browser', version: '1', is_active: 1 });

      expect((await decide()).answers).toHaveLength(1);

      store.packs.update('browser', { is_active: 0 });
      syncEngineWithStore(store, engine);

      const result = await decide();
      expect(result.answers).toHaveLength(0);
      expect(result.needs_ai).toHaveLength(1);

      store.packs.update('browser', { is_active: 1 });
      syncEngineWithStore(store, engine);
      expect((await decide()).answers).toHaveLength(1);
    });

    it('keeps serving the safety rules of a switched-off pack', async () => {
      addPackRule('browser', 'browser.risky.payment.pay_control', true);
      store.packs.create({ id: 'browser', name: 'Browser', version: '1', is_active: 0 });
      syncEngineWithStore(store, engine);

      expect((await decide()).answers).toHaveLength(1);
    });
  });

  describe('learned patterns', () => {
    it('adds a pattern promoted since start-up and removes one disabled in the store', async () => {
      syncEngineWithStore(store, engine);
      expect((await decide()).answers).toHaveLength(0);

      storeLearned('learned-a', true);
      const added = syncEngineWithStore(store, engine);
      expect(added.added).toEqual(['learned-a']);
      expect((await decide()).answers).toHaveLength(1);

      store.patterns.update('learned-a', { status: 'disabled' });
      const removed = syncEngineWithStore(store, engine);
      expect(removed.removed).toEqual(['learned-a']);
      const after = await decide();
      expect(after.answers).toHaveLength(0);
    });

    it('does not remove a rule that was written straight into the engine', () => {
      addPackRule('browser', 'direct.rule');
      engine.addRule({
        id: 'direct-learned',
        matchers: { role: 'button' },
        output: { decision_type: 'check', value: true, confidence: 0.9 },
      });
      syncEngineWithStore(store, engine);
      expect(engine.getRules().some((rule) => rule.id === 'direct-learned')).toBe(true);
    });
  });
});
