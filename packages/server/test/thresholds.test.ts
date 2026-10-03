import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ChoiceQuestion,
  type DatabaseStore,
  type Decision,
  type Question,
  type Rule,
  createMemory,
  createPatternEngine,
  createStore,
  executeDecide,
  getThresholdForType,
  getThresholds,
  previewRouting,
  routeQuestion,
  setThresholdForType,
  setThresholds,
  validateThresholdConfig,
  DEFAULT_THRESHOLDS,
  MIN_HUMAN_BELOW,
  MAX_HUMAN_BELOW,
  MIN_AUTO_AT_OR_ABOVE,
  MAX_AUTO_AT_OR_ABOVE,
} from '../src/index.js';

describe('thresholds and routing', () => {
  let tempDir: string;
  let dbPath: string;
  let store: DatabaseStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-thresholds-'));
    dbPath = join(tempDir, 'test.db');
    store = createStore(dbPath);
  });

  afterEach(() => {
    if (store) {
      store.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('configuration and defaults', () => {
    it('provides sane defaults for choice, score, and check decision types', () => {
      const thresholds = getThresholds(store);

      expect(thresholds.choice).toEqual({ human_below: 0.2, auto_at_or_above: 0.8 });
      expect(thresholds.score).toEqual({ human_below: 0.2, auto_at_or_above: 0.8 });
      expect(thresholds.check).toEqual({ human_below: 0.2, auto_at_or_above: 0.8 });

      // Verify defaults are within the UI range bounds
      for (const type of ['choice', 'score', 'check'] as const) {
        expect(thresholds[type].human_below).toBeGreaterThanOrEqual(MIN_HUMAN_BELOW);
        expect(thresholds[type].human_below).toBeLessThanOrEqual(MAX_HUMAN_BELOW);
        expect(thresholds[type].auto_at_or_above).toBeGreaterThanOrEqual(MIN_AUTO_AT_OR_ABOVE);
        expect(thresholds[type].auto_at_or_above).toBeLessThanOrEqual(MAX_AUTO_AT_OR_ABOVE);
        expect(thresholds[type].human_below).toBeLessThanOrEqual(thresholds[type].auto_at_or_above);
      }
    });

    it('retrieves threshold for specific decision type with getThresholdForType', () => {
      const choiceT = getThresholdForType(store, 'choice');
      expect(choiceT).toEqual({ human_below: 0.2, auto_at_or_above: 0.8 });

      const checkT = getThresholdForType(store, 'check');
      expect(checkT).toEqual({ human_below: 0.2, auto_at_or_above: 0.8 });
    });
  });

  describe('validation rules', () => {
    it('rejects crossing thresholds where human_below is greater than auto_at_or_above', () => {
      // Crossing: human_below 0.70 > auto_at_or_above 0.60
      expect(() => {
        validateThresholdConfig({
          human_below: 0.7,
          auto_at_or_above: 0.6,
        });
      }).toThrow(/cannot cross/i);

      // Rejects setting crossing thresholds through setThresholds
      expect(() => {
        setThresholds(store, {
          choice: { human_below: 0.75, auto_at_or_above: 0.65 },
        });
      }).toThrow(/cannot cross/i);

      // Verify store was not corrupted
      expect(getThresholdForType(store, 'choice')).toEqual(DEFAULT_THRESHOLDS.choice);
    });

    it('rejects human_below outside the 10% to 80% range', () => {
      // Below minimum 10%
      expect(() => {
        validateThresholdConfig({ human_below: 0.05, auto_at_or_above: 0.8 });
      }).toThrow(/human_below/i);

      // Above maximum 80%
      expect(() => {
        validateThresholdConfig({ human_below: 0.85, auto_at_or_above: 0.9 });
      }).toThrow(/human_below/i);
    });

    it('rejects auto_at_or_above outside the 50% to 99% range', () => {
      // Below minimum 50%
      expect(() => {
        validateThresholdConfig({ human_below: 0.2, auto_at_or_above: 0.45 });
      }).toThrow(/auto_at_or_above/i);

      // Above maximum 99%
      expect(() => {
        validateThresholdConfig({ human_below: 0.2, auto_at_or_above: 1.0 });
      }).toThrow(/auto_at_or_above/i);
    });

    it('normalizes percentage inputs (> 1) into ratios', () => {
      const normalized = validateThresholdConfig({
        human_below: 25,
        auto_at_or_above: 85,
      });

      expect(normalized.human_below).toBe(0.25);
      expect(normalized.auto_at_or_above).toBe(0.85);
    });
  });

  describe('settings persistence and update', () => {
    it('updates thresholds per type and stores in settings table', () => {
      const updated = setThresholdForType(store, 'choice', {
        human_below: 0.3,
        auto_at_or_above: 0.85,
      });

      expect(updated).toEqual({ human_below: 0.3, auto_at_or_above: 0.85 });

      const fromRepo = getThresholdForType(store, 'choice');
      expect(fromRepo).toEqual({ human_below: 0.3, auto_at_or_above: 0.85 });

      // Other types remain default
      expect(getThresholdForType(store, 'check')).toEqual(DEFAULT_THRESHOLDS.check);
    });

    it('updates all thresholds with setThresholds', () => {
      setThresholds(store, {
        choice: { human_below: 0.25, auto_at_or_above: 0.85 },
        check: { human_below: 0.35, auto_at_or_above: 0.9 },
      });

      const all = getThresholds(store);
      expect(all.choice).toEqual({ human_below: 0.25, auto_at_or_above: 0.85 });
      expect(all.check).toEqual({ human_below: 0.35, auto_at_or_above: 0.9 });
      expect(all.score).toEqual(DEFAULT_THRESHOLDS.score);
    });
  });

  describe('routing with thresholds', () => {
    it('changing a threshold changes routing without restart', async () => {
      // Pattern rule for a choice question with confidence 0.75
      const rule: Rule = {
        id: 'pattern-dialog-choice',
        matchers: { role: 'dialog' },
        output: {
          decision_type: 'choice',
          value: 'dismiss',
          distribution: { dismiss: 0.75, confirm: 0.25 },
          confidence: 0.75,
        },
      };

      const engine = createPatternEngine([rule]);

      const question: ChoiceQuestion = {
        id: 'q-dialog',
        type: 'choice',
        text: 'What action to take for dialog?',
        options: [
          { id: 'dismiss', description: 'Dismiss' },
          { id: 'confirm', description: 'Confirm' },
        ],
      };

      const snapshot = {
        elements: [{ role: 'dialog', text: 'Cookie policy update' }],
      };

      // Call 1: Default thresholds (human_below: 0.20, auto_at_or_above: 0.80)
      // Confidence 0.75 is between 0.20 and 0.80 -> routes to needs_ai for confirmation
      const res1 = await executeDecide(
        {
          questions: [question],
          state: snapshot,
        },
        { store, patternEngine: engine },
      );

      expect(res1.answers).toHaveLength(0);
      expect(res1.needs_ai).toHaveLength(1);
      expect(res1.needs_human).toHaveLength(0);
      expect(res1.needs_ai[0]!.id).toBe('q-dialog');

      // Update threshold on the SAME process without restarting:
      // Lower auto_at_or_above to 0.70 so 0.75 qualifies for automatic execution
      setThresholds(store, {
        choice: { human_below: 0.2, auto_at_or_above: 0.7 },
      });

      // Call 2: Second call on same process with modified threshold
      // Confidence 0.75 >= 0.70 -> routes automatically to answers with path: 'pattern'
      const res2 = await executeDecide(
        {
          questions: [question],
          state: snapshot,
        },
        { store, patternEngine: engine },
      );

      expect(res2.needs_ai).toHaveLength(0);
      expect(res2.needs_human).toHaveLength(0);
      expect(res2.answers).toHaveLength(1);
      expect(res2.answers[0]!.id).toBe('q-dialog');
      expect(res2.answers[0]!.value).toBe('dismiss');
      expect(res2.answers[0]!.path).toBe('pattern');
      expect(res2.answers[0]!.confidence).toBe(0.75);

      // Update threshold again on the SAME process:
      // Raise human_below to 0.78 so 0.75 falls below human threshold
      setThresholds(store, {
        choice: { human_below: 0.78, auto_at_or_above: 0.9 },
      });

      // Call 3: Third call on same process with raised human threshold
      // Confidence 0.75 < 0.78 -> routes to needs_human
      const res3 = await executeDecide(
        {
          questions: [question],
          state: snapshot,
        },
        { store, patternEngine: engine },
      );

      expect(res3.answers).toHaveLength(0);
      expect(res3.needs_ai).toHaveLength(0);
      expect(res3.needs_human).toHaveLength(1);
      expect(res3.needs_human[0]!.id).toBe('q-dialog');
      expect(res3.needs_human[0]!.reason).toContain('below human threshold 0.78');
    });

    it('exact-match memory caller threshold takes precedence', () => {
      const memory = createMemory(store);

      const question: Question = {
        id: 'q-mem',
        type: 'check',
        text: 'Is navigation complete?',
      };

      const input = { url: 'https://example.com/done' };

      // Pre-seed an answer in memory with confidence 0.85
      memory.save({
        input,
        question,
        answer: true,
        confidence: 0.85,
        path: 'memory',
      });

      // Caller passes explicit high threshold of 0.90
      // 0.85 < 0.90, so memory does NOT reuse it
      const resHigh = routeQuestion({
        question,
        input,
        threshold: 0.9,
        memory,
        store,
      });

      expect(resHigh.status).toBe('needs_ai');

      // Caller passes threshold 0.80
      // 0.85 >= 0.80, so memory hit is returned
      const resLow = routeQuestion({
        question,
        input,
        threshold: 0.8,
        memory,
        store,
      });

      expect(resLow.status).toBe('answered');
      if (resLow.status === 'answered') {
        expect(resLow.path).toBe('memory');
        expect(resLow.answer.value).toBe(true);
      }
    });

    it('safety rules with ask_user are never auto-allowed past a human gate', () => {
      // Safety rule asking user for confirmation (e.g. payment action)
      const safetyRule: Rule = {
        id: 'safety-payment-guard',
        safety: true,
        matchers: { text_any: ['Place order', 'Pay now'] },
        output: {
          decision_type: 'choice',
          value: 'ask_user',
          distribution: { ask_user: 0.99, proceed: 0.01 },
          confidence: 0.99,
        },
      };

      const engine = createPatternEngine([safetyRule]);
      const memory = createMemory(store);

      // Even with a very low auto_at_or_above threshold (e.g. 0.50),
      // the safety rule's ask_user MUST route to needs_human
      setThresholds(store, {
        choice: { human_below: 0.2, auto_at_or_above: 0.5 },
      });

      const question: ChoiceQuestion = {
        id: 'q-pay',
        type: 'choice',
        text: 'Approve payment?',
        options: [
          { id: 'ask_user', description: 'Ask user for confirmation' },
          { id: 'proceed', description: 'Proceed' },
        ],
      };

      const result = routeQuestion({
        question,
        input: { text: 'Pay now' },
        memory,
        store,
        patternEngine: engine,
      });

      expect(result.status).toBe('needs_human');
      if (result.status === 'needs_human') {
        expect(result.needsHuman.id).toBe('q-pay');
        expect(result.needsHuman.reason).toContain('Safety rule');
        expect(result.needsHuman.reason).toContain('ask_user');
        expect(result.decision.is_safety).toBe(1);
        expect(result.decision.needs_review).toBe(1);
      }
    });
  });

  describe('previewRouting', () => {
    it('calculates the exact share that would go automatic, model and human', () => {
      const history: Decision[] = [
        // 1. High confidence choice -> auto
        {
          id: 'd1',
          session_id: null,
          url: null,
          domain: null,
          decision_type: 'choice',
          question: 'q1',
          context: null,
          input_hash: 'h1',
          answer: 'a',
          confidence: 0.95,
          path: 'memory',
          pattern_id: null,
          latency_ms: 1,
          is_safety: 0,
          needs_review: 0,
          created_at: new Date().toISOString(),
        },
        // 2. Medium confidence choice -> model
        {
          id: 'd2',
          session_id: null,
          url: null,
          domain: null,
          decision_type: 'choice',
          question: 'q2',
          context: null,
          input_hash: 'h2',
          answer: 'b',
          confidence: 0.65,
          path: 'ai',
          pattern_id: null,
          latency_ms: 200,
          is_safety: 0,
          needs_review: 0,
          created_at: new Date().toISOString(),
        },
        // 3. Low confidence choice -> human
        {
          id: 'd3',
          session_id: null,
          url: null,
          domain: null,
          decision_type: 'choice',
          question: 'q3',
          context: null,
          input_hash: 'h3',
          answer: 'c',
          confidence: 0.15,
          path: 'ai',
          pattern_id: null,
          latency_ms: 200,
          is_safety: 0,
          needs_review: 1,
          created_at: new Date().toISOString(),
        },
        // 4. High confidence check -> auto
        {
          id: 'd4',
          session_id: null,
          url: null,
          domain: null,
          decision_type: 'check',
          question: 'q4',
          context: null,
          input_hash: 'h4',
          answer: 'true',
          confidence: 0.9,
          path: 'pattern',
          pattern_id: 'p1',
          latency_ms: 2,
          is_safety: 0,
          needs_review: 0,
          created_at: new Date().toISOString(),
        },
        // 5. Safety rule with ask_user -> human (regardless of confidence)
        {
          id: 'd5',
          session_id: null,
          url: null,
          domain: null,
          decision_type: 'choice',
          question: 'q5',
          context: 'payment gate',
          input_hash: 'h5',
          answer: 'ask_user',
          confidence: 0.99,
          path: 'pattern',
          pattern_id: 'safety-rule',
          latency_ms: 2,
          is_safety: 1,
          needs_review: 1,
          created_at: new Date().toISOString(),
        },
      ];

      // Thresholds: human_below 0.20, auto_at_or_above 0.80
      const preview = previewRouting(history, {
        choice: { human_below: 0.2, auto_at_or_above: 0.8 },
        check: { human_below: 0.2, auto_at_or_above: 0.8 },
        score: { human_below: 0.2, auto_at_or_above: 0.8 },
      });

      // Total 5 items:
      // Automatic: d1 (0.95 >= 0.80), d4 (0.90 >= 0.80) -> 2 items (40% / 0.40)
      // Model: d2 (0.65 between 0.20 and 0.80) -> 1 item (20% / 0.20)
      // Human: d3 (0.15 < 0.20), d5 (safety ask_user) -> 2 items (40% / 0.40)
      expect(preview.total).toBe(5);
      expect(preview.counts).toEqual({
        automatic: 2,
        model: 1,
        human: 2,
        total: 5,
      });

      expect(preview.automatic).toBe(0.4);
      expect(preview.model).toBe(0.2);
      expect(preview.human).toBe(0.4);

      // Aliases
      expect(preview.auto).toBe(0.4);
      expect(preview.ai).toBe(0.2);

      // Percentages
      expect(preview.percentages.automatic).toBe(40);
      expect(preview.percentages.model).toBe(20);
      expect(preview.percentages.human).toBe(40);
      expect(preview.percentages.auto).toBe(40);
      expect(preview.percentages.ai).toBe(20);
    });

    it('handles empty history cleanly', () => {
      const preview = previewRouting([]);

      expect(preview.total).toBe(0);
      expect(preview.automatic).toBe(0);
      expect(preview.model).toBe(0);
      expect(preview.human).toBe(0);
      expect(preview.counts).toEqual({
        automatic: 0,
        model: 0,
        human: 0,
        total: 0,
      });
      expect(preview.percentages).toEqual({
        automatic: 0,
        model: 0,
        human: 0,
        auto: 0,
        ai: 0,
      });
    });

    it('works with single threshold config applied across all types', () => {
      const history: Decision[] = [
        {
          id: 'd1',
          session_id: null,
          url: null,
          domain: null,
          decision_type: 'score',
          question: 'Rate quality',
          context: null,
          input_hash: 'h1',
          answer: '4',
          confidence: 0.72,
          path: 'ai',
          pattern_id: null,
          latency_ms: 10,
          is_safety: 0,
          needs_review: 0,
          created_at: new Date().toISOString(),
        },
      ];

      // With auto_at_or_above 0.70, confidence 0.72 goes auto
      const autoRes = previewRouting(history, {
        human_below: 0.2,
        auto_at_or_above: 0.7,
      });
      expect(autoRes.automatic).toBe(1.0);
      expect(autoRes.model).toBe(0.0);

      // With auto_at_or_above 0.80, confidence 0.72 goes model
      const modelRes = previewRouting(history, {
        human_below: 0.2,
        auto_at_or_above: 0.8,
      });
      expect(modelRes.automatic).toBe(0.0);
      expect(modelRes.model).toBe(1.0);
    });
  });
});
