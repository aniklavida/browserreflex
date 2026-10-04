/**
 * Advisory safety suite: test coverage for the action_guard tool across all covered families.
 *
 * Status: **implemented and tested**.
 *
 * Verifies that:
 * 1. Payment actions (English, Bangla, continue checkout steps, wallet/Pay buttons) always yield ask_user.
 * 2. Destructive actions (delete account, wipe, remove all, drop, rm -rf, force push, reset --hard, clear data) yield ask_user or block.
 * 3. Outbound actions (send, post, publish, share, email, submit message) always yield ask_user.
 * 4. Secrets (credentials, card numbers, tokens) yield block, and are verified to be redacted in SQLite records.
 * 5. Prompt injection pages change nothing about the verdict in both directions (cannot lower caution, cannot invent caution).
 * 6. Benign controls stay allow so false positives are measured and minimized.
 *
 * The safety check is advisory: it reports caution and never prevents an agent from acting.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeActionGuard } from '../../src/tools/action_guard.js';
import { createStore, type DatabaseStore } from '../../src/store/index.js';
import {
  createPatternEngine,
  loadPacksFromDirectory,
  type PatternEngine,
} from '../../src/patterns/index.js';
import {
  BENIGN_CASES,
  DESTRUCTIVE_CASES,
  KNOWN_GAPS,
  OUTBOUND_CASES,
  PAYMENT_CASES,
  PROMPT_INJECTION_CASES,
  SAFETY_CASES,
  SECRET_CASES,
} from './cases.js';

const PACKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packs/browser');

describe('action_guard safety test suite', () => {
  let tempDir: string;
  let store: DatabaseStore;
  let patternEngine: PatternEngine;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-safety-action-guard-'));
    store = createStore(join(tempDir, 'safety-test.db'));

    const loaded = loadPacksFromDirectory(PACKS_DIR);
    expect(loaded.errors).toEqual([]);
    patternEngine = createPatternEngine(loaded.rules);
  });

  afterEach(() => {
    if (store) {
      store.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('payment family (English, Bangla, checkout step continue, wallet and pay buttons)', () => {
    it.each(PAYMENT_CASES)('$id: $description', async (tc) => {
      const result = await executeActionGuard(tc.input, { store, patternEngine });
      expect(result.verdict).toBe('ask_user');
      expect(result.advisory).toBe(true);
      expect(result.reason).toContain('payment');
    });

    it('guarantees payment caution holds on a server with no pack loaded (built-in rules alone)', async () => {
      const emptyEngine = createPatternEngine([]);
      for (const tc of PAYMENT_CASES) {
        const result = await executeActionGuard(tc.input, { store, patternEngine: emptyEngine });
        expect(result.verdict).toBe('ask_user');
        expect(result.advisory).toBe(true);
        expect(result.path).toBe('check');
        expect(result.pattern_id).toBeNull();
      }
    });
  });

  describe('destructive family (delete account, wipe, remove all, drop, commands, clear data)', () => {
    it.each(DESTRUCTIVE_CASES)('$id: $description', async (tc) => {
      const result = await executeActionGuard(tc.input, { store, patternEngine });
      expect(result.verdict).toBe(tc.expectedVerdict);
      expect(result.advisory).toBe(true);
      if (result.verdict === 'block') {
        expect(result.reason).toContain('rewrites history or destroys data');
      } else {
        expect(result.reason).toContain('destructive action');
      }
    });

    it('guarantees destructive caution holds on a server with no pack loaded (built-in rules alone)', async () => {
      const emptyEngine = createPatternEngine([]);
      for (const tc of DESTRUCTIVE_CASES) {
        const result = await executeActionGuard(tc.input, { store, patternEngine: emptyEngine });
        expect(result.verdict).toBe(tc.expectedVerdict);
        expect(result.advisory).toBe(true);
        expect(result.path).toBe('check');
        expect(result.pattern_id).toBeNull();
      }
    });
  });

  describe('outbound family (send, post, publish, share, email, submit message)', () => {
    it.each(OUTBOUND_CASES)('$id: $description', async (tc) => {
      const result = await executeActionGuard(tc.input, { store, patternEngine });
      expect(result.verdict).toBe('ask_user');
      expect(result.advisory).toBe(true);
      expect(result.rule_ids.length).toBeGreaterThan(0);
      expect(result.rule_ids.some((id) => id.includes('outbound'))).toBe(true);
    });
  });

  describe('secrets family (credentials, tokens, cards, keys typed by action: verdict block and redacted in logs)', () => {
    it.each(SECRET_CASES)('$id: $description', async (tc) => {
      const result = await executeActionGuard(tc.input, { store, patternEngine });
      expect(result.verdict).toBe('block');
      expect(result.advisory).toBe(true);
      expect(result.reason).toContain('credential or a card number');

      if (tc.secretPayload) {
        expect(result.reason).not.toContain(tc.secretPayload);

        const decision = store.decisions.getById(result.decision_id);
        expect(decision).not.toBeNull();
        if (decision?.context) {
          expect(decision.context).not.toContain(tc.secretPayload);
          expect(decision.context).toContain('[REDACTED:');
        }
      }
    });
  });

  describe('prompt-injection pages (cannot lower caution, cannot invent caution on harmless pages)', () => {
    it.each(PROMPT_INJECTION_CASES)('$id: $description', async (tc) => {
      const result = await executeActionGuard(tc.input, { store, patternEngine });
      expect(result.verdict).toBe(tc.expectedVerdict);
      expect(result.advisory).toBe(true);
    });
  });

  describe('benign controls (must stay allow to prevent false positives)', () => {
    it.each(BENIGN_CASES)('$id: $description', async (tc) => {
      const result = await executeActionGuard(tc.input, { store, patternEngine });
      expect(result.verdict).toBe('allow');
      expect(result.advisory).toBe(true);
      expect(result.rule_ids).toHaveLength(0);
    });
  });

  it('summary: proves zero safety misses and zero benign false positives across the suite', async () => {
    let misses = 0;
    let falsePositives = 0;
    const totalCases = SAFETY_CASES.length;

    for (const tc of SAFETY_CASES) {
      const result = await executeActionGuard(tc.input, { store, patternEngine });
      if (tc.expectedVerdict !== 'allow' && result.verdict === 'allow') {
        misses += 1;
      }
      if (tc.family === 'benign' && result.verdict !== 'allow') {
        falsePositives += 1;
      }
    }

    // Report metric counts in test output
    console.log(
      `Safety test suite action_guard summary: total_cases=${totalCases}, misses=${misses}, false_positives=${falsePositives}`,
    );

    expect(misses).toBe(0);
    expect(falsePositives).toBe(0);
    expect(KNOWN_GAPS).toHaveLength(0);
    expect(totalCases).toBeGreaterThanOrEqual(100);
  });
});
