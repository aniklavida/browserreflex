/**
 * Signal extraction on capture: the signals stored with every slow decision.
 *
 * Every value here is invented. The credential-shaped one is assembled from two
 * pieces at run time, because the repository's own credential check fails on any
 * literal shaped like a live token however it was produced.
 *
 * The redaction test writes its decision straight through the repository with
 * unredacted page text on purpose. The decision log redacts before it stores, so
 * a test that went through `executeDecide` would pass on the log's redaction and
 * would prove nothing about this module. Bypassing the log is what makes the
 * assertion here a claim about capture.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_ELEMENT_TEXT_LENGTH,
  captureDecisionSignals,
  extractBrowserSignals,
  extractTextSignals,
  normalizeElementText,
  normalizeTokens,
} from '../src/learning/capture.js';
import { createStore, type DatabaseStore } from '../src/store/index.js';
import { executeDecide } from '../src/tools/decide.js';
import { executeFeedback } from '../src/tools/feedback.js';
import { executeSubmitAnswers } from '../src/tools/submit_answers.js';

/** Joins a prefix to its body so no tracked file holds a whole token-shaped literal. */
function token(prefix: string, body: string): string {
  return `${prefix}${body}`;
}

const SECRET_PREFIX = 'glpat-';
const SECRET_BODY = 'A1b2C3d4E5f6G7h8I9j0Kl';
const SECRET = token(SECRET_PREFIX, SECRET_BODY);

describe('signal extraction on capture', () => {
  let tempDir: string;
  let store: DatabaseStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-capture-'));
    store = createStore(join(tempDir, 'test.db'));
  });

  afterEach(() => {
    if (store) {
      store.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('extracts browser signals from a page snapshot: domain, path, role, text and selector', () => {
    const signals = extractBrowserSignals({
      url: 'https://shop.example.com/checkout/step-2',
      elements: [
        { role: 'Button', text: '  Place\n  order  ', selector: '#place-order' },
        { role: 'heading', text: 'Checkout' },
      ],
    });

    expect(signals.domain).toBe('shop.example.com');
    expect(signals.path).toBe('/checkout/step-2');
    expect(signals.element_role).toBe('button');
    expect(signals.element_text).toBe('Place order');
    expect(signals.selector).toBe('#place-order');
    expect(signals.element_source).toBe('first_snapshot_element');
  });

  it('strips the query string and the fragment from the path it stores', () => {
    const signals = extractBrowserSignals({
      url: `https://shop.example.com/cart?utm_source=news&email=a.person@example.com#step-3`,
    });

    expect(signals.path).toBe('/cart');
    expect(signals.path).not.toContain('@');
    expect(signals.path).not.toContain('step-3');
  });

  it('stores no path when the URL is neither a path nor a URL it can parse', () => {
    expect(extractBrowserSignals({ url: 'not a url at all' }).path).toBeNull();
    expect(extractBrowserSignals({}).path).toBeNull();
  });

  it('caps element text and marks the cut with an ellipsis', () => {
    const text = normalizeElementText(`${'x'.repeat(MAX_ELEMENT_TEXT_LENGTH + 40)} tail`);

    expect(text).not.toBeNull();
    expect(text?.endsWith('…')).toBe(true);
    expect([...(text ?? '')].length).toBe(MAX_ELEMENT_TEXT_LENGTH + 1);
    expect(normalizeElementText('   \n  ')).toBeNull();
    expect(normalizeElementText(42)).toBeNull();
  });

  it('normalises tokens: lower-cased, punctuation split off, stop tokens and duplicates dropped', () => {
    const tokens = normalizeTokens('Risk-management: RISK management, the sign-in form!');

    expect(tokens).toEqual(['risk', 'management', 'sign', 'form']);
  });

  it('takes the question text before the page text into the tokens', () => {
    const signals = extractTextSignals(
      { text: 'Newsletter signup dialog' },
      'What kind of dialog is visible?',
    );

    expect(signals.tokens).toEqual(['what', 'kind', 'dialog', 'visible', 'newsletter', 'signup']);
  });

  it('records which element the element signals came from', () => {
    const named = extractBrowserSignals({
      url: 'https://example.com/',
      target: { role: 'dialog', text: 'Cookie notice', selector: '#cookie-notice' },
      elements: [{ role: 'link', text: 'Home' }],
    });

    expect(named.element_source).toBe('target');
    expect(named.element_role).toBe('dialog');
    expect(named.element_text).toBe('Cookie notice');

    const withoutElements = extractBrowserSignals({ url: 'https://example.com/' });

    expect(withoutElements.element_source).toBe('none');
    expect(withoutElements.element_role).toBeNull();
    expect(withoutElements.element_text).toBeNull();
    expect(withoutElements.selector).toBeNull();
  });

  it('redacts page text before signals are stored', () => {
    const decision = store.decisions.create({
      url: 'https://shop.example.com/checkout',
      domain: 'shop.example.com',
      decision_type: 'check',
      question: 'Is this button safe to click?',
      context: JSON.stringify({
        url: 'https://shop.example.com/checkout',
        target: { role: 'button', text: `Pay with ${SECRET}` },
        text: `Paste your token ${SECRET} to continue`,
      }),
      answer: 'pending',
      confidence: 0,
      path: 'ai',
    });

    const outcome = captureDecisionSignals({ store, decision, source: 'slow_path_answer' });
    expect(outcome.stored).toBe(true);

    // Read the stored row as it sits in the table, not through the repository: the claim
    // is about what is on disk, not about what a typed getter hands back.
    const row = store.db
      .prepare('SELECT * FROM decision_signals WHERE decision_id = ?')
      .get(decision.id) as Record<string, unknown>;
    const asText = JSON.stringify(row);

    expect(asText).not.toContain(SECRET_PREFIX);
    expect(asText).not.toContain(SECRET_BODY);
    expect(row.element_text).toContain('[REDACTED:API_KEY]');
    expect(String(row.tokens)).not.toContain(SECRET_BODY.toLowerCase());
  });

  it('redacts element text a decision row already holds in the clear', () => {
    const decision = store.decisions.create({
      decision_type: 'check',
      question: 'Is this button safe to click?',
      context: JSON.stringify({
        target: { role: 'button', text: `Send invoice ${SECRET}` },
      }),
      answer: 'pending',
      confidence: 0,
      path: 'ai',
    });

    captureDecisionSignals({ store, decision, source: 'slow_path_answer' });

    const row = store.signals.getByDecisionId(decision.id);
    expect(row).not.toBeNull();
    expect(row?.element_text ?? '').not.toContain(SECRET_BODY);
    expect(row?.element_text ?? '').toContain('[REDACTED:API_KEY]');
  });

  it('captures nothing for a fast-path decision', () => {
    const decision = store.decisions.create({
      url: 'https://shop.example.com/cart',
      domain: 'shop.example.com',
      decision_type: 'check',
      question: 'Is this button safe to click?',
      context: JSON.stringify({
        url: 'https://shop.example.com/cart',
        target: { role: 'button', text: 'Pay now' },
      }),
      answer: 'true',
      confidence: 0.95,
      path: 'memory',
    });

    const outcome = captureDecisionSignals({ store, decision, source: 'slow_path_answer' });

    expect(outcome.stored).toBe(false);
    expect(outcome.status).toBe('skipped_path');
    expect(store.signals.getByDecisionId(decision.id)).toBeNull();
    expect(store.signals.count()).toBe(0);
  });

  it('stores no signals while a decision is still waiting for an answer', async () => {
    const result = await executeDecide(
      {
        questions: [{ id: 'q_safe', type: 'check', text: 'Is this button safe to click?' }],
        state: {
          url: 'https://shop.example.com/checkout',
          target: { role: 'button', text: 'Place order' },
        },
      },
      { store },
    );

    expect(result.needs_ai).toHaveLength(1);
    expect(store.signals.count()).toBe(0);
  });

  it('stores signals when submit_answers records the slow-path answer', async () => {
    const question = { id: 'q_safe', type: 'check', text: 'Is this button safe to click?' };
    const routed = await executeDecide(
      {
        questions: [question],
        state: {
          url: 'https://shop.example.com/checkout/step-2',
          target: { role: 'Button', text: 'Place order', selector: '#place-order' },
        },
      },
      { store },
    );

    const decisionId = routed.needs_ai[0]!.decision_id;
    const submitted = await executeSubmitAnswers(
      { answers: [{ decision_id: decisionId, value: true, confidence: 0.9 }] },
      { store },
    );

    expect(submitted.answers).toHaveLength(1);

    const row = store.signals.getByDecisionId(decisionId);
    expect(row).not.toBeNull();
    expect(row?.source).toBe('slow_path_answer');
    expect(row?.domain).toBe('shop.example.com');
    expect(row?.path).toBe('/checkout/step-2');
    expect(row?.element_role).toBe('button');
    expect(row?.element_text).toBe('Place order');
    expect(row?.selector).toBe('#place-order');
    expect(row?.element_source).toBe('target');
    expect(row?.tokens).toContain('button');
    expect(row?.tokens).toContain('click');
  });

  it('stores signals when feedback records a human correction', async () => {
    // The decision came from the fast path. A correction is captured whatever path
    // produced the original answer, because the disagreement is the signal.
    const decision = store.decisions.create({
      url: 'https://shop.example.com/cart',
      domain: 'shop.example.com',
      decision_type: 'choice',
      question: 'What kind of dialog is visible?',
      context: JSON.stringify({
        url: 'https://shop.example.com/cart',
        target: { role: 'dialog', text: 'Subscribe to our newsletter', selector: '#modal' },
      }),
      answer: JSON.stringify({ value: 'none' }),
      confidence: 0.95,
      path: 'pattern',
    });

    const result = await executeFeedback(
      { decision_id: decision.id, correct_value: 'promo' },
      { store },
    );

    expect(result.status).toBe('recorded');

    const row = store.signals.getByDecisionId(decision.id);
    expect(row).not.toBeNull();
    expect(row?.source).toBe('human_correction');
    expect(row?.domain).toBe('shop.example.com');
    expect(row?.path).toBe('/cart');
    expect(row?.element_role).toBe('dialog');
    expect(row?.selector).toBe('#modal');
  });

  it('lists stored signals by domain and path for the miner', () => {
    const decisions = [
      {
        url: 'https://shop.example.com/checkout/step-2',
        domain: 'shop.example.com',
      },
      {
        url: 'https://shop.example.com/cart',
        domain: 'shop.example.com',
      },
      {
        url: 'https://news.example.org/subscribe',
        domain: 'news.example.org',
      },
    ].map((page) =>
      store.decisions.create({
        url: page.url,
        domain: page.domain,
        decision_type: 'choice',
        question: 'What kind of dialog is visible?',
        context: JSON.stringify({ url: page.url }),
        answer: 'pending',
        confidence: 0,
        path: 'ai',
      }),
    );

    for (const decision of decisions) {
      expect(captureDecisionSignals({ store, decision, source: 'slow_path_answer' }).stored).toBe(
        true,
      );
    }

    expect(store.signals.count()).toBe(3);
    expect(store.signals.count({ domain: 'shop.example.com' })).toBe(2);

    const byDomain = store.signals.list({ domain: 'shop.example.com' });
    expect(byDomain).toHaveLength(2);

    const byPath = store.signals.list({ domain: 'shop.example.com', path: '/checkout/step-2' });
    expect(byPath).toHaveLength(1);
    expect(byPath[0]?.path).toBe('/checkout/step-2');

    expect(store.signals.list({ domain: 'nowhere.example.com' })).toEqual([]);
  });

  it('keeps one signals row per decision when the same decision is corrected twice', () => {
    const decision = store.decisions.create({
      url: 'https://shop.example.com/cart',
      domain: 'shop.example.com',
      decision_type: 'choice',
      question: 'What kind of dialog is visible?',
      context: JSON.stringify({ url: 'https://shop.example.com/cart' }),
      answer: JSON.stringify({ value: 'none' }),
      confidence: 0.9,
      path: 'pattern',
    });

    const first = captureDecisionSignals({ store, decision, source: 'human_correction' });
    const second = captureDecisionSignals({ store, decision, source: 'human_correction' });

    expect(first.stored).toBe(true);
    expect(second.stored).toBe(true);
    expect(store.signals.count()).toBe(1);
    if (first.stored && second.stored) {
      expect(second.row.created_at).toBe(first.row.created_at);
    }
  });

  it('reports a failed write instead of a row that is not there', () => {
    const decision = store.decisions.create({
      decision_type: 'choice',
      question: 'What kind of dialog is visible?',
      context: JSON.stringify({ url: 'https://shop.example.com/cart' }),
      answer: 'pending',
      confidence: 0,
      path: 'ai',
    });

    store.db.exec('DROP TABLE decision_signals');

    const outcome = captureDecisionSignals({ store, decision, source: 'slow_path_answer' });

    expect(outcome.stored).toBe(false);
    expect(outcome.status).toBe('write_failed');
    if (outcome.status === 'write_failed') {
      expect(outcome.message.length).toBeGreaterThan(0);
    }
    expect(outcome.signals.domain).toBe('shop.example.com');
  });
});
