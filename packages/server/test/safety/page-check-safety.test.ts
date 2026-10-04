/**
 * Advisory safety suite: test coverage for the page_check tool across covered families.
 *
 * Status: **implemented and tested**.
 *
 * Verifies that:
 * 1. Payment elements on a page are detected and flagged in risky_actions with risk 'payment'.
 * 2. Destructive elements on a page are detected and flagged in risky_actions with risk 'destructive'.
 * 3. Outbound elements on a page are detected and flagged in risky_actions with risk 'outbound'.
 * 4. Benign controls produce 0 risky_actions entries, measuring and validating zero false positives.
 * 5. Prompt injection text in snapshot does not lower caution on risky pages and does not invent caution on benign pages.
 *
 * The safety check is advisory: it reports caution and never prevents an agent from acting.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executePageCheck,
  resolveBrowserPackDirectory,
  type PageCheckOutput,
} from '../../src/tools/page_check.js';
import { createStore, type DatabaseStore } from '../../src/store/index.js';
import {
  BENIGN_CASES,
  DESTRUCTIVE_CASES,
  OUTBOUND_CASES,
  PAYMENT_CASES,
  PROMPT_INJECTION_CASES,
  type SafetyTestCase,
} from './cases.js';

const BROWSER_PACK_DIR = resolveBrowserPackDirectory();

function buildPageSnapshot(tc: SafetyTestCase): Record<string, unknown> {
  const input = tc.input;
  const rawSnapshot = input.snapshot as Record<string, unknown> | undefined;

  let elements: Array<{ role: string | null; text: string }> = [];
  if (rawSnapshot && Array.isArray(rawSnapshot.elements)) {
    elements = rawSnapshot.elements.map((e) => ({
      role: typeof e.role === 'string' ? e.role : null,
      text: typeof e.text === 'string' ? e.text : '',
    }));
  } else if (input.target) {
    if (typeof input.target === 'string') {
      elements = [{ role: 'button', text: input.target }];
    } else {
      const targetObj = input.target as { role?: string; text?: string; name?: string };
      elements = [
        {
          role: targetObj.role ?? 'button',
          text: targetObj.text ?? targetObj.name ?? '',
        },
      ];
    }
  }

  const url =
    typeof input.url === 'string'
      ? input.url
      : typeof rawSnapshot?.url === 'string'
        ? rawSnapshot.url
        : undefined;

  return {
    ...(url ? { url } : {}),
    elements,
  };
}

describe('page_check safety test suite', () => {
  let tempDir: string;
  let store: DatabaseStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-safety-page-check-'));
    store = createStore(join(tempDir, 'safety-page-check.db'));
  });

  afterEach(() => {
    if (store) {
      store.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('payment controls detection on page', () => {
    const paymentPageCases = PAYMENT_CASES.filter((tc) => tc.pageCheckExpectation !== undefined);

    it.each(paymentPageCases)('$id: $description', async (tc) => {
      const snapshot = buildPageSnapshot(tc);
      const result: PageCheckOutput = await executePageCheck(
        { snapshot, ...(snapshot.url ? { url: snapshot.url } : {}) },
        { store, packsDirectory: BROWSER_PACK_DIR },
      );

      expect(result.safety_check).toBe('advisory');
      expect(result.risky_actions.length).toBeGreaterThan(0);
      const paymentRisks = result.risky_actions.filter((a) => a.risk === 'payment');
      expect(paymentRisks.length).toBeGreaterThan(0);
      expect(paymentRisks[0]!.is_safety).toBe(true);
      expect(paymentRisks[0]!.action).toBe('ask_user');
    });
  });

  describe('destructive controls detection on page', () => {
    const destructivePageCases = DESTRUCTIVE_CASES.filter(
      (tc) => tc.pageCheckExpectation !== undefined,
    );

    it.each(destructivePageCases)('$id: $description', async (tc) => {
      const snapshot = buildPageSnapshot(tc);
      const result: PageCheckOutput = await executePageCheck(
        { snapshot, ...(snapshot.url ? { url: snapshot.url } : {}) },
        { store, packsDirectory: BROWSER_PACK_DIR },
      );

      expect(result.safety_check).toBe('advisory');
      expect(result.risky_actions.length).toBeGreaterThan(0);
      const destructiveRisks = result.risky_actions.filter((a) => a.risk === 'destructive');
      expect(destructiveRisks.length).toBeGreaterThan(0);
      expect(destructiveRisks[0]!.is_safety).toBe(true);
      expect(destructiveRisks[0]!.action).toBe('ask_user');
    });
  });

  describe('outbound controls detection on page', () => {
    const outboundPageCases = OUTBOUND_CASES.filter((tc) => tc.pageCheckExpectation !== undefined);

    it.each(outboundPageCases)('$id: $description', async (tc) => {
      const snapshot = buildPageSnapshot(tc);
      const result: PageCheckOutput = await executePageCheck(
        { snapshot, ...(snapshot.url ? { url: snapshot.url } : {}) },
        { store, packsDirectory: BROWSER_PACK_DIR },
      );

      expect(result.safety_check).toBe('advisory');
      expect(result.risky_actions.length).toBeGreaterThan(0);
      const outboundRisks = result.risky_actions.filter((a) => a.risk === 'outbound');
      expect(outboundRisks.length).toBeGreaterThan(0);
      expect(outboundRisks[0]!.is_safety).toBe(true);
      expect(outboundRisks[0]!.action).toBe('ask_user');
    });
  });

  describe('benign controls on page (must not be flagged as risky)', () => {
    const benignPageCases = BENIGN_CASES.filter((tc) => tc.pageCheckExpectation !== undefined);

    it.each(benignPageCases)('$id: $description', async (tc) => {
      const snapshot = buildPageSnapshot(tc);
      const result: PageCheckOutput = await executePageCheck(
        { snapshot, ...(snapshot.url ? { url: snapshot.url } : {}) },
        { store, packsDirectory: BROWSER_PACK_DIR },
      );

      expect(result.safety_check).toBe('advisory');
      expect(result.risky_actions).toHaveLength(0);
    });
  });

  describe('prompt injection immunity in page_check', () => {
    const promptInjectionCases = PROMPT_INJECTION_CASES.filter(
      (tc) => tc.pageCheckExpectation !== undefined,
    );

    it.each(promptInjectionCases)('$id: $description', async (tc) => {
      const snapshot = buildPageSnapshot(tc);
      const result: PageCheckOutput = await executePageCheck(
        { snapshot, ...(snapshot.url ? { url: snapshot.url } : {}) },
        { store, packsDirectory: BROWSER_PACK_DIR },
      );

      expect(result.safety_check).toBe('advisory');
      if (tc.pageCheckExpectation?.expectRisky) {
        expect(result.risky_actions.length).toBeGreaterThan(0);
        if (tc.pageCheckExpectation.expectedRiskFamily) {
          expect(
            result.risky_actions.some(
              (a) => a.risk === tc.pageCheckExpectation?.expectedRiskFamily,
            ),
          ).toBe(true);
        }
      } else {
        expect(result.risky_actions).toHaveLength(0);
      }
    });
  });

  it('summary: proves zero risky misses and zero benign false positives across page snapshots', async () => {
    const allPageCases = [
      ...PAYMENT_CASES,
      ...DESTRUCTIVE_CASES,
      ...OUTBOUND_CASES,
      ...BENIGN_CASES,
      ...PROMPT_INJECTION_CASES,
    ].filter((tc) => tc.pageCheckExpectation !== undefined);

    let pageMisses = 0;
    let pageFalsePositives = 0;

    for (const tc of allPageCases) {
      const snapshot = buildPageSnapshot(tc);
      const result: PageCheckOutput = await executePageCheck(
        { snapshot, ...(snapshot.url ? { url: snapshot.url } : {}) },
        { store, packsDirectory: BROWSER_PACK_DIR },
      );

      if (tc.pageCheckExpectation?.expectRisky) {
        if (result.risky_actions.length === 0) {
          pageMisses += 1;
        }
      } else {
        if (result.risky_actions.length > 0) {
          pageFalsePositives += 1;
        }
      }
    }

    console.log(
      `Safety test suite page_check summary: total_page_cases=${allPageCases.length}, misses=${pageMisses}, false_positives=${pageFalsePositives}`,
    );

    expect(pageMisses).toBe(0);
    expect(pageFalsePositives).toBe(0);
    expect(allPageCases.length).toBeGreaterThanOrEqual(100);
  });
});
