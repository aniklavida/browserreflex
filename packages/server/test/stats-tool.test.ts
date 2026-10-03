import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createStore, type DatabaseStore, type DecisionPath } from '../src/index.js';
import {
  ASSUMED_MODEL_CALL_SECONDS_PER_FAST_ANSWER,
  computeLatencyPercentiles,
  executeGetStats,
  getStatsOutputSchema,
  isFastPath,
  rangeStart,
} from '../src/tools/stats.js';
import { connectToServer, sourceEntry } from './helpers/stdio-server.js';

/** A fixed clock, so a range boundary never depends on when the test happens to run. */
const NOW = new Date('2026-10-04T12:00:00.000Z');

function hoursBefore(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}

describe('get_stats tool', () => {
  let tempDir: string;
  let store: DatabaseStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-stats-'));
    store = createStore(join(tempDir, 'test.db'));
  });

  afterEach(() => {
    if (store) {
      store.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  interface SeedOptions {
    path: DecisionPath;
    latencyMs?: number;
    url?: string | null;
    domain?: string | null;
    createdAt?: string;
  }

  function seed(options: SeedOptions): void {
    store.decisions.create({
      decision_type: 'check',
      question: 'Is a cookie banner in the way?',
      answer: options.path === 'ai' ? 'pending' : 'yes',
      confidence: options.path === 'memory' ? 0.95 : 0,
      path: options.path,
      latency_ms: options.latencyMs ?? 1,
      url: options.url === undefined ? 'https://example.com/checkout' : options.url,
      domain: options.domain === undefined ? 'example.com' : options.domain,
      created_at: options.createdAt ?? NOW.toISOString(),
    });
  }

  it('counts only memory, pattern and check decisions as the fast path, never an ai or human answer', () => {
    for (let i = 0; i < 4; i += 1) {
      seed({ path: 'memory', latencyMs: 1 + i });
    }
    seed({ path: 'check', latencyMs: 6 });
    for (let i = 0; i < 3; i += 1) {
      seed({ path: 'ai', latencyMs: 900 });
    }
    seed({ path: 'human', latencyMs: 400 });
    seed({ path: 'human', latencyMs: 400 });

    const result = executeGetStats({ range: 'today' }, { store, now: NOW });

    expect(result.total_decisions).toBe(10);
    expect(result.counts_by_path).toEqual({ memory: 4, pattern: 0, check: 1, ai: 3, human: 2 });
    expect(result.fast_path_counts).toEqual({ memory: 4, pattern: 0, check: 1 });
    // 5 of 10 rows are fast. Counting the 3 ai answers as fast would report 0.8.
    expect(result.fast_path_share).toBe(0.5);
    expect(result.fast_path_share).toBeLessThan(1);

    // An ai answer is not fast however fast its latency, and a human answer is not either.
    expect(isFastPath('memory')).toBe(true);
    expect(isFastPath('pattern')).toBe(true);
    expect(isFastPath('check')).toBe(true);
    expect(isFastPath('ai')).toBe(false);
    expect(isFastPath('human')).toBe(false);
  });

  it('reports the median and 95th percentile latency of every decision in range', () => {
    for (const latency of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      seed({ path: 'memory', latencyMs: latency });
    }

    const result = executeGetStats({ range: '7d' }, { store, now: NOW });

    expect(result.median_latency_ms).toBe(5.5);
    expect(result.p95_latency_ms).toBe(10);
  });

  it('labels the time saved figure as an estimate and publishes the constant it assumed', () => {
    for (let i = 0; i < 5; i += 1) {
      seed({ path: 'memory' });
    }
    for (let i = 0; i < 2; i += 1) {
      seed({ path: 'ai' });
    }

    const result = executeGetStats({ range: '30d' }, { store, now: NOW });

    const estimate = result.time_saved_estimate;
    expect(estimate.is_estimate).toBe(true);
    expect(estimate.fast_answers_counted).toBe(5);
    expect(estimate.assumed_model_call_seconds).toBe(ASSUMED_MODEL_CALL_SECONDS_PER_FAST_ANSWER);
    expect(estimate.seconds).toBe(5 * ASSUMED_MODEL_CALL_SECONDS_PER_FAST_ANSWER);
    expect(estimate.basis).toBe('fast_path_answers_times_assumed_model_call_time');
    expect(estimate.note).toMatch(/not measured/i);

    // The number is never presented as something this server observed.
    expect(Object.keys(estimate)).toContain('is_estimate');
  });

  it('reads only the requested range, with today starting at local midnight', () => {
    seed({ path: 'memory', createdAt: NOW.toISOString() });
    seed({ path: 'memory', createdAt: hoursBefore(NOW, 24) });
    seed({ path: 'memory', createdAt: hoursBefore(NOW, 24 * 8) });
    seed({ path: 'memory', createdAt: hoursBefore(NOW, 24 * 40) });

    const today = executeGetStats({ range: 'today' }, { store, now: NOW });
    const seven = executeGetStats({ range: '7d' }, { store, now: NOW });
    const thirty = executeGetStats({ range: '30d' }, { store, now: NOW });

    expect(today.total_decisions).toBe(1);
    expect(seven.total_decisions).toBe(2);
    expect(thirty.total_decisions).toBe(3);

    // today is local midnight, and it is never in the future.
    const todayStart = rangeStart('today', NOW);
    expect(todayStart.getHours()).toBe(0);
    expect(todayStart.getMinutes()).toBe(0);
    expect(todayStart.getSeconds()).toBe(0);
    expect(todayStart.getMilliseconds()).toBe(0);
    expect(todayStart.getTime()).toBeLessThanOrEqual(NOW.getTime());
    expect(today.range_start).toBe(todayStart.toISOString());
    expect(today.range_end).toBe(NOW.toISOString());
  });

  it('defaults to the last 7 days and every decision when no range or filter is given', () => {
    seed({ path: 'memory', createdAt: hoursBefore(NOW, 24 * 3) });
    seed({ path: 'ai', createdAt: hoursBefore(NOW, 24 * 6) });
    seed({ path: 'memory', createdAt: hoursBefore(NOW, 24 * 20) });

    const result = executeGetStats({}, { store, now: NOW });

    expect(result.range).toBe('7d');
    expect(result.filter).toBe('all');
    // The row from 20 days back is outside the default 7 day window.
    expect(result.total_decisions).toBe(2);
  });

  it('counts only decisions that recorded a page under the browser filter', () => {
    seed({ path: 'memory', url: 'https://example.com/a', domain: 'example.com' });
    seed({ path: 'memory', url: null, domain: null });
    seed({ path: 'memory', url: '', domain: '' });

    const all = executeGetStats({ range: '30d', filter: 'all' }, { store, now: NOW });
    const browser = executeGetStats({ range: '30d', filter: 'browser' }, { store, now: NOW });

    expect(all.total_decisions).toBe(3);
    expect(browser.total_decisions).toBe(1);
    expect(browser.filter).toBe('browser');
  });

  it('reports no share and no percentile, rather than zero, when nothing was recorded', () => {
    const result = executeGetStats({ range: '7d' }, { store, now: NOW });

    expect(result.total_decisions).toBe(0);
    expect(result.fast_path_share).toBeNull();
    expect(result.median_latency_ms).toBeNull();
    expect(result.p95_latency_ms).toBeNull();
    expect(result.counts_by_path).toEqual({ memory: 0, pattern: 0, check: 0, ai: 0, human: 0 });
    expect(result.time_saved_estimate.fast_answers_counted).toBe(0);
    expect(result.time_saved_estimate.seconds).toBe(0);
    expect(result.time_saved_estimate.is_estimate).toBe(true);
  });

  it('leaves out decisions dated after the clock reading the call used', () => {
    seed({ path: 'memory', createdAt: NOW.toISOString() });
    seed({ path: 'memory', createdAt: new Date(NOW.getTime() + 60_000).toISOString() });

    const result = executeGetStats({ range: 'today' }, { store, now: NOW });

    expect(result.total_decisions).toBe(1);
  });

  it('computes the median as the mean of the two middle values and p95 by nearest rank', () => {
    expect(computeLatencyPercentiles([])).toEqual({ median: null, p95: null });
    expect(computeLatencyPercentiles([7])).toEqual({ median: 7, p95: 7 });
    expect(computeLatencyPercentiles([9, 1, 5])).toEqual({ median: 5, p95: 9 });
    expect(computeLatencyPercentiles([1, 2, 3, 4])).toEqual({ median: 2.5, p95: 4 });
    // p95 of 1..100 is the 95th value, 95, and not an interpolation between two rows.
    const hundred = Array.from({ length: 100 }, (_unused, index) => index + 1);
    expect(computeLatencyPercentiles(hundred)).toEqual({ median: 50.5, p95: 95 });
  });

  it('refuses a range or filter it does not have instead of answering about another one', () => {
    seed({ path: 'memory' });

    expect(() => executeGetStats({ range: '90d' }, { store, now: NOW })).toThrow(/90d/);
    expect(() => executeGetStats({ filter: 'coding' }, { store, now: NOW })).toThrow(/coding/);
  });

  it('produces output that matches its declared schema', () => {
    for (let i = 0; i < 3; i += 1) {
      seed({ path: 'memory', latencyMs: i });
    }
    seed({ path: 'ai' });

    const result = executeGetStats({ range: '7d', filter: 'browser' }, { store, now: NOW });
    const parsed = z.object(getStatsOutputSchema).parse(result);

    expect(parsed).toEqual(result);
  });

  it('serves get_stats over stdio, and its text calls the time saved figure an estimate', async () => {
    const stdioTempDir = mkdtempSync(join(tmpdir(), 'browserreflex-stats-stdio-'));
    const stdioDbPath = join(stdioTempDir, 'test.db');
    const previousDbEnv = process.env.BROWSERREFLEX_DB_PATH;
    process.env.BROWSERREFLEX_DB_PATH = stdioDbPath;

    let client: Client | undefined;
    try {
      const connected = await connectToServer(sourceEntry);
      client = connected.client;

      const inspectStore = createStore(stdioDbPath);
      for (let i = 0; i < 4; i += 1) {
        inspectStore.decisions.create({
          decision_type: 'choice',
          question: 'Which cookie banner action?',
          answer: 'accept',
          confidence: 0.9,
          path: 'memory',
          latency_ms: 2,
          url: 'https://example.com/',
          domain: 'example.com',
        });
      }
      inspectStore.decisions.create({
        decision_type: 'choice',
        question: 'Which cookie banner action?',
        answer: 'pending',
        confidence: 0,
        path: 'ai',
        latency_ms: 800,
        url: 'https://example.com/',
        domain: 'example.com',
      });
      inspectStore.close();

      const call = await client.callTool({ name: 'get_stats', arguments: { range: '30d' } });

      expect(call.isError).toBeFalsy();
      const structured = call.structuredContent as {
        total_decisions: number;
        fast_path_share: number;
        counts_by_path: Record<string, number>;
        median_latency_ms: number;
        p95_latency_ms: number;
        time_saved_estimate: { is_estimate: boolean; seconds: number };
      };
      expect(structured.total_decisions).toBe(5);
      expect(structured.fast_path_share).toBe(0.8);
      expect(structured.counts_by_path.ai).toBe(1);
      expect(structured.median_latency_ms).toBe(2);
      expect(structured.time_saved_estimate.is_estimate).toBe(true);
      expect(structured.time_saved_estimate.seconds).toBe(
        4 * ASSUMED_MODEL_CALL_SECONDS_PER_FAST_ANSWER,
      );

      const text = (call.content as { type: string; text: string }[])[0]?.text ?? '';
      expect(text).toContain('estimate, not a measurement');
      expect(text).toContain('assumed');
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
