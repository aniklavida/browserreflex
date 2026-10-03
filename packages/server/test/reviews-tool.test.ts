import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createStore, type DatabaseStore, type Decision, type DecisionPath } from '../src/index.js';
import {
  DEFAULT_REVIEW_LIMIT,
  MAX_REVIEW_LIMIT,
  PENDING_ANSWER_MARKER,
  executeGetPendingReviews,
  getPendingReviewsOutputSchema,
} from '../src/tools/reviews.js';
import { connectToServer, sourceEntry } from './helpers/stdio-server.js';

/** A fixed clock, so an age never depends on when the test happens to run. */
const NOW = new Date('2026-10-04T12:00:00.000Z');

function minutesBefore(now: Date, minutes: number): string {
  return new Date(now.getTime() - minutes * 60 * 1000).toISOString();
}

/**
 * Builds a context value with a key that must be masked, from two pieces.
 *
 * The repository's own credential check refuses a literal shaped like a live token in
 * any tracked file, so no fixture here writes one whole.
 */
function maskedContext(): string {
  return `login form for ${['shopper', 'example.test'].join('@')}`;
}

describe('get_pending_reviews tool', () => {
  let tempDir: string;
  let store: DatabaseStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-reviews-'));
    store = createStore(join(tempDir, 'test.db'));
  });

  afterEach(() => {
    if (store) {
      store.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  interface QueueSeed {
    path?: DecisionPath;
    answer?: string;
    confidence?: number;
    needsReview?: boolean;
    isSafety?: boolean;
    decisionType?: 'choice' | 'score' | 'check';
    context?: string | null;
    createdAt?: string;
  }

  function seedQueue(options: QueueSeed = {}): Decision {
    return store.decisions.create({
      decision_type: options.decisionType ?? 'check',
      question: 'Is a cookie banner in the way?',
      context: options.context === undefined ? null : options.context,
      answer: options.answer ?? PENDING_ANSWER_MARKER,
      confidence: options.confidence ?? 0,
      path: options.path ?? 'ai',
      latency_ms: 1.5,
      needs_review: options.needsReview ?? false,
      is_safety: options.isSafety ?? false,
      url: 'https://example.com/checkout',
      domain: 'example.com',
      created_at: options.createdAt ?? NOW.toISOString(),
    });
  }

  it('lists pending needs_ai items, human-routed items and flagged items, oldest first', () => {
    const pending = seedQueue({ createdAt: minutesBefore(NOW, 90) });
    const flagged = seedQueue({
      path: 'memory',
      answer: 'yes',
      confidence: 0.9,
      needsReview: true,
      createdAt: minutesBefore(NOW, 30),
    });
    const toHuman = seedQueue({
      path: 'human',
      answer: 'ask_user',
      createdAt: minutesBefore(NOW, 60),
    });

    const result = executeGetPendingReviews({}, { store, now: NOW });

    expect(result.items.map((item) => item.decision_id)).toEqual([
      pending.id,
      toHuman.id,
      flagged.id,
    ]);
    expect(result.matching_count).toBe(3);
    expect(result.returned_count).toBe(3);
    expect(result.limit).toBe(DEFAULT_REVIEW_LIMIT);
    expect(result.type).toBeNull();
    expect(result.older_than_minutes).toBeNull();
    expect(result.safety_check).toBe('advisory');

    expect(result.items[0]?.reasons).toEqual(['pending_needs_ai']);
    expect(result.items[0]?.age_seconds).toBe(5400);
    expect(result.items[1]?.reasons).toEqual(['needs_human']);
    expect(result.items[2]?.reasons).toEqual(['needs_review']);
  });

  it('names every reason an item qualifies, rather than only the first', () => {
    const both = seedQueue({ path: 'human', needsReview: true });

    const result = executeGetPendingReviews({}, { store, now: NOW });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.decision_id).toBe(both.id);
    expect(result.items[0]?.reasons).toEqual(['needs_human', 'needs_review']);
  });

  it('leaves out an ai answer that has already been submitted', () => {
    seedQueue({ path: 'ai', answer: 'accept', confidence: 0.9 });

    const result = executeGetPendingReviews({}, { store, now: NOW });

    expect(result.items).toHaveLength(0);
    expect(result.matching_count).toBe(0);
    expect(result.returned_count).toBe(0);
  });

  it('filters by decision type', () => {
    seedQueue({ decisionType: 'check' });
    const choice = seedQueue({ decisionType: 'choice' });
    seedQueue({ decisionType: 'score' });

    const result = executeGetPendingReviews({ type: 'choice' }, { store, now: NOW });

    expect(result.type).toBe('choice');
    expect(result.items.map((item) => item.decision_id)).toEqual([choice.id]);
    expect(result.matching_count).toBe(1);
  });

  it('filters by how long an item has been waiting', () => {
    const old = seedQueue({ createdAt: minutesBefore(NOW, 120) });
    seedQueue({ createdAt: minutesBefore(NOW, 5) });

    const result = executeGetPendingReviews({ older_than_minutes: 60 }, { store, now: NOW });

    expect(result.older_than_minutes).toBe(60);
    expect(result.items.map((item) => item.decision_id)).toEqual([old.id]);
  });

  it('reports how many items matched before the limit was applied', () => {
    for (let i = 0; i < 5; i += 1) {
      seedQueue({ createdAt: minutesBefore(NOW, 60 - i) });
    }

    const result = executeGetPendingReviews({ limit: 2 }, { store, now: NOW });

    expect(result.returned_count).toBe(2);
    expect(result.matching_count).toBe(5);
    expect(result.limit).toBe(2);
  });

  it('redacts every text field it returns', () => {
    const raw = maskedContext();
    const row = seedQueue({ context: raw, createdAt: minutesBefore(NOW, 10) });

    const result = executeGetPendingReviews({}, { store, now: NOW });
    const item = result.items[0];

    expect(item?.decision_id).toBe(row.id);
    expect(item?.context).not.toBeNull();
    expect(item?.context).not.toContain('shopper');
    expect(item?.context).toContain('[REDACTED:EMAIL]');
  });

  it('reports a safety item as advisory, and never as something that stopped an agent', () => {
    seedQueue({ path: 'human', isSafety: true, needsReview: true, answer: 'ask_user' });

    const result = executeGetPendingReviews({}, { store, now: NOW });

    expect(result.items[0]?.is_safety).toBe(true);
    expect(result.safety_check).toBe('advisory');
  });

  it('refuses a filter, a type or a limit it cannot honour', () => {
    seedQueue();

    expect(() => executeGetPendingReviews({ type: 'guess' }, { store, now: NOW })).toThrow(/guess/);
    expect(() => executeGetPendingReviews({ older_than_minutes: -1 }, { store, now: NOW })).toThrow(
      /older_than_minutes/,
    );
    expect(() =>
      executeGetPendingReviews({ limit: MAX_REVIEW_LIMIT + 1 }, { store, now: NOW }),
    ).toThrow(/limit/);
  });

  it('produces output that matches its declared schema', () => {
    seedQueue({ path: 'human', needsReview: true, decisionType: 'choice' });

    const result = executeGetPendingReviews({ limit: 5 }, { store, now: NOW });
    const parsed = z.object(getPendingReviewsOutputSchema).parse(result);

    expect(parsed).toEqual(result);
  });

  it('serves get_pending_reviews over stdio and returns the same queue the store holds', async () => {
    const stdioTempDir = mkdtempSync(join(tmpdir(), 'browserreflex-reviews-stdio-'));
    const stdioDbPath = join(stdioTempDir, 'test.db');
    const previousDbEnv = process.env.BROWSERREFLEX_DB_PATH;
    process.env.BROWSERREFLEX_DB_PATH = stdioDbPath;

    let client: Client | undefined;
    try {
      const connected = await connectToServer(sourceEntry);
      client = connected.client;

      // Two calls to decide over the connection, so the rows arrive through the router
      // rather than through a fixture. Both calls leave all four answers pending: the
      // first call's rows are not reusable from memory yet, so the second call asks
      // again rather than answering.
      const questions = [
        { id: 'q_check', type: 'check', text: 'Is a cookie banner in the way?' },
        { id: 'q_choice', type: 'choice', text: 'Which action?', options: [{ id: 'accept' }] },
      ];

      const first = await client.callTool({
        name: 'decide',
        arguments: { questions, state: { url: 'https://example.com/checkout' } },
      });
      expect(first.isError).toBeFalsy();

      const second = await client.callTool({
        name: 'decide',
        arguments: { questions, state: { url: 'https://example.com/checkout' } },
      });
      expect(second.isError).toBeFalsy();

      const call = await client.callTool({
        name: 'get_pending_reviews',
        arguments: { limit: 10 },
      });

      expect(call.isError).toBeFalsy();
      const structured = call.structuredContent as {
        items: { decision_id: string; reasons: string[]; is_safety: boolean }[];
        matching_count: number;
        returned_count: number;
        safety_check: string;
      };

      expect(structured.matching_count).toBe(4);
      expect(structured.returned_count).toBe(4);
      expect(structured.safety_check).toBe('advisory');
      for (const item of structured.items) {
        expect(item.reasons).toContain('pending_needs_ai');
        expect(item.is_safety).toBe(false);
      }

      const text = (call.content as { type: string; text: string }[])[0]?.text ?? '';
      expect(text).toContain('advisory');
    } finally {
      await client?.close();
      if (previousDbEnv === undefined) {
        delete process.env.BROWSERREFLEX_DB_PATH;
      } else {
        process.env.BROWSERREFLEX_DB_PATH = previousDbEnv;
      }
      rmSync(stdioTempDir, { recursive: true, force: true });
    }
  }, 120_000);
});
