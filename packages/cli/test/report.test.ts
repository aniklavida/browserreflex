/**
 * Tests for the `report` command.
 *
 * Verifies:
 * - Reads local decision log and outputs total decisions, path breakdown, fast-path share.
 * - Model answers are never fast; fast paths are memory, pattern, check.
 * - Time saved estimate reuses the get_stats formula and constants.
 * - Daily trend is displayed when sample >= 30, and suppressed with the required
 *   sentence when sample < 30 ("Sample is too small to read (under 30 decisions).").
 * - Carries the sentence "a measurement, not a promise".
 * - Empty database outputs an honest empty report and exits 0.
 * - Read-only guarantee: never writes to the database file, leaves it byte-identical,
 *   and operates successfully on read-only files (0o444).
 * - Counts pending reviews and shadow candidates accurately.
 * - Supports --json, --since <days>, and --db <path>.
 */

import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore, openDatabase } from '@browserreflex/server';
import { USAGE_ERROR_EXIT_CODE, USAGE_EXIT_CODE, runCli } from '../src/cli.js';
import { makeTempHome, type TempHome } from './helpers/temp-home.js';

const NOW = new Date('2026-10-04T12:00:00.000Z');

function dayIso(now: Date, daysAgo: number, hour = 12): string {
  const d = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

describe('report command', () => {
  let home: TempHome;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    home = makeTempHome('browserreflex-cli-report-');
    stdout = [];
    stderr = [];
  });

  afterEach(() => {
    home.remove();
  });

  it('prints an honest empty report when database does not exist, exit 0, and creates no files', async () => {
    const missingDb = join(home.path, 'does-not-exist.db');
    const exitCode = await runCli({
      argv: ['report', '--db', missingDb],
      streams: {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      now: NOW,
    });

    expect(exitCode).toBe(USAGE_EXIT_CODE);
    expect(existsSync(missingDb)).toBe(false);

    const fullOutput = stdout.join('\n');
    expect(fullOutput).toContain('BrowserReflex measurement report: a measurement, not a promise.');
    expect(fullOutput).toContain('Total decisions:    0');
    expect(fullOutput).toContain('Fast-path share:    none');
    expect(fullOutput).toContain('Seconds saved:      0s');
    expect(fullOutput).toContain('Pending reviews:    0');
    expect(fullOutput).toContain('Shadow candidates:  0');
    expect(fullOutput).toContain('Sample is too small to read (under 30 decisions).');
  });

  it('prints an honest empty report when database exists but has 0 decisions, exit 0', async () => {
    const dbPath = join(home.path, 'empty.db');
    const store = createStore(dbPath);
    store.close();

    const exitCode = await runCli({
      argv: ['report', '--db', dbPath],
      streams: {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      now: NOW,
    });

    expect(exitCode).toBe(USAGE_EXIT_CODE);

    const fullOutput = stdout.join('\n');
    expect(fullOutput).toContain('BrowserReflex measurement report: a measurement, not a promise.');
    expect(fullOutput).toContain('Total decisions:    0');
    expect(fullOutput).toContain('Fast-path share:    none');
    expect(fullOutput).toContain('Seconds saved:      0s');
    expect(fullOutput).toContain('Pending reviews:    0');
    expect(fullOutput).toContain('Shadow candidates:  0');
    expect(fullOutput).toContain('Sample is too small to read (under 30 decisions).');
  });

  it('when sample is under 30 decisions, states sample is too small to read instead of printing trend', async () => {
    const dbPath = join(home.path, 'small.db');
    const store = createStore(dbPath);

    // Seed 10 decisions (< 30)
    // 4 memory, 2 pattern, 1 check (7 fast)
    // 2 ai, 1 human (3 slow)
    for (let i = 0; i < 4; i++) {
      store.decisions.create({
        decision_type: 'check',
        question: 'cookie banner?',
        answer: 'true',
        confidence: 0.95,
        path: 'memory',
        created_at: dayIso(NOW, 1, 10 + i),
      });
    }
    for (let i = 0; i < 2; i++) {
      store.decisions.create({
        decision_type: 'check',
        question: 'promo banner?',
        answer: 'false',
        confidence: 0.9,
        path: 'pattern',
        created_at: dayIso(NOW, 2, 10 + i),
      });
    }
    store.decisions.create({
      decision_type: 'check',
      question: 'login wall?',
      answer: 'false',
      confidence: 0.99,
      path: 'check',
      created_at: dayIso(NOW, 3, 10),
    });
    for (let i = 0; i < 2; i++) {
      store.decisions.create({
        decision_type: 'choice',
        question: 'page type?',
        answer: 'article',
        confidence: 0.8,
        path: 'ai',
        created_at: dayIso(NOW, 1, 14 + i),
      });
    }
    store.decisions.create({
      decision_type: 'check',
      question: 'risky delete?',
      answer: 'ask_user',
      confidence: 0.5,
      path: 'human',
      created_at: dayIso(NOW, 2, 14),
    });

    store.close();

    const exitCode = await runCli({
      argv: ['report', '--db', dbPath],
      streams: {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      now: NOW,
    });

    expect(exitCode).toBe(USAGE_EXIT_CODE);

    const fullOutput = stdout.join('\n');
    expect(fullOutput).toContain('BrowserReflex measurement report: a measurement, not a promise.');
    expect(fullOutput).toContain('Total decisions:    10');
    expect(fullOutput).toContain('Fast-path share:    70.0% (7/10)');
    expect(fullOutput).toContain('memory:             4 (40.0%)');
    expect(fullOutput).toContain('pattern:            2 (20.0%)');
    expect(fullOutput).toContain('check:              1 (10.0%)');
    expect(fullOutput).toContain('ai:                 2 (20.0%)');
    expect(fullOutput).toContain('human:              1 (10.0%)');
    // Fast path is 7 answers * 3s = 21s
    expect(fullOutput).toContain('Seconds saved:      21s');
    expect(fullOutput).toContain('7 fast-path answers × 3s assumed model call');
    // Sample size guard: must say sample is too small instead of printing per-day lines
    expect(fullOutput).toContain('Sample is too small to read (under 30 decisions).');
    expect(fullOutput).not.toMatch(/\d{4}-\d{2}-\d{2}:/);
  });

  it('when sample is 30 or more decisions, prints per-day fast-path share so a rise can be read', async () => {
    const dbPath = join(home.path, 'large.db');
    const store = createStore(dbPath);

    // Seed 32 decisions across 3 days:
    // Day 3 (3 days ago): 10 decisions, 2 fast (20%)
    // Day 2 (2 days ago): 10 decisions, 5 fast (50%)
    // Day 1 (1 day ago): 12 decisions, 9 fast (75%)
    // Day 3:
    for (let i = 0; i < 2; i++) {
      store.decisions.create({
        decision_type: 'check',
        question: 'banner?',
        answer: 'true',
        confidence: 0.9,
        path: 'pattern',
        created_at: dayIso(NOW, 3, 10 + i),
      });
    }
    for (let i = 0; i < 8; i++) {
      store.decisions.create({
        decision_type: 'check',
        question: 'banner?',
        answer: 'true',
        confidence: 0.7,
        path: 'ai',
        created_at: dayIso(NOW, 3, 12 + i),
      });
    }

    // Day 2:
    for (let i = 0; i < 5; i++) {
      store.decisions.create({
        decision_type: 'check',
        question: 'banner?',
        answer: 'true',
        confidence: 0.9,
        path: 'memory',
        created_at: dayIso(NOW, 2, 10 + i),
      });
    }
    for (let i = 0; i < 5; i++) {
      store.decisions.create({
        decision_type: 'check',
        question: 'banner?',
        answer: 'true',
        confidence: 0.7,
        path: 'ai',
        created_at: dayIso(NOW, 2, 15 + i),
      });
    }

    // Day 1:
    for (let i = 0; i < 9; i++) {
      store.decisions.create({
        decision_type: 'check',
        question: 'banner?',
        answer: 'true',
        confidence: 0.95,
        path: 'check',
        created_at: dayIso(NOW, 1, 10 + i),
      });
    }
    for (let i = 0; i < 3; i++) {
      store.decisions.create({
        decision_type: 'check',
        question: 'banner?',
        answer: 'true',
        confidence: 0.7,
        path: 'ai',
        created_at: dayIso(NOW, 1, 19 + i),
      });
    }

    store.close();

    const exitCode = await runCli({
      argv: ['report', '--db', dbPath],
      streams: {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      now: NOW,
    });

    expect(exitCode).toBe(USAGE_EXIT_CODE);

    const fullOutput = stdout.join('\n');
    expect(fullOutput).toContain('BrowserReflex measurement report: a measurement, not a promise.');
    expect(fullOutput).toContain('Total decisions:    32');
    // Total fast: 2 + 5 + 9 = 16 out of 32 = 50.0%
    expect(fullOutput).toContain('Fast-path share:    50.0% (16/32)');
    expect(fullOutput).toContain('Seconds saved:      48s');
    expect(fullOutput).not.toContain('Sample is too small to read');

    // Daily breakdown shows the rise from 20.0% -> 50.0% -> 75.0%
    const day3Str = dayIso(NOW, 3).slice(0, 10);
    const day2Str = dayIso(NOW, 2).slice(0, 10);
    const day1Str = dayIso(NOW, 1).slice(0, 10);

    expect(fullOutput).toContain(`${day3Str}:  20.0% (2/10)`);
    expect(fullOutput).toContain(`${day2Str}:  50.0% (5/10)`);
    expect(fullOutput).toContain(`${day1Str}:  75.0% (9/12)`);
  });

  it('filters decisions accurately when --since <days> is specified', async () => {
    const dbPath = join(home.path, 'since.db');
    const store = createStore(dbPath);

    // 15 decisions within last 5 days
    for (let i = 0; i < 15; i++) {
      store.decisions.create({
        decision_type: 'check',
        question: 'banner?',
        answer: 'true',
        confidence: 0.9,
        path: 'memory',
        created_at: dayIso(NOW, 2, 10 + (i % 5)),
      });
    }

    // 20 decisions older than 10 days
    for (let i = 0; i < 20; i++) {
      store.decisions.create({
        decision_type: 'check',
        question: 'banner?',
        answer: 'true',
        confidence: 0.9,
        path: 'pattern',
        created_at: dayIso(NOW, 15, 10 + (i % 5)),
      });
    }

    store.close();

    // With --since 7, only the 15 decisions in the last 7 days are counted
    const exitCodeSince = await runCli({
      argv: ['report', '--db', dbPath, '--since', '7'],
      streams: {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      now: NOW,
    });

    expect(exitCodeSince).toBe(USAGE_EXIT_CODE);
    const outputSince = stdout.join('\n');
    expect(outputSince).toContain('Range:    last 7 days');
    expect(outputSince).toContain('Total decisions:    15');
    // Sample is 15 (< 30) under this filter
    expect(outputSince).toContain('Sample is too small to read (under 30 decisions).');

    // Without --since, all 35 decisions are counted (>= 30, shows trend)
    stdout = [];
    const exitCodeAll = await runCli({
      argv: ['report', '--db', dbPath],
      streams: {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      now: NOW,
    });

    expect(exitCodeAll).toBe(USAGE_EXIT_CODE);
    const outputAll = stdout.join('\n');
    expect(outputAll).toContain('Range:    all recorded decisions');
    expect(outputAll).toContain('Total decisions:    35');
    expect(outputAll).not.toContain('Sample is too small to read');
  });

  it('outputs valid JSON conforming to all requirements when --json is passed', async () => {
    const dbPath = join(home.path, 'json.db');
    const store = createStore(dbPath);

    store.decisions.create({
      decision_type: 'check',
      question: 'banner?',
      answer: 'true',
      confidence: 0.9,
      path: 'memory',
      created_at: dayIso(NOW, 1),
    });
    store.decisions.create({
      decision_type: 'check',
      question: 'promo?',
      answer: 'false',
      confidence: 0.9,
      path: 'ai',
      created_at: dayIso(NOW, 1),
    });

    store.close();

    const exitCode = await runCli({
      argv: ['report', '--db', dbPath, '--json'],
      streams: {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      now: NOW,
    });

    expect(exitCode).toBe(USAGE_EXIT_CODE);
    const parsed = JSON.parse(stdout.join('\n'));

    expect(parsed.note).toBe('a measurement, not a promise');
    expect(parsed.total_decisions).toBe(2);
    expect(parsed.fast_path_decisions).toBe(1);
    expect(parsed.fast_path_share).toBe(0.5);
    expect(parsed.counts_by_path).toEqual({
      memory: 1,
      pattern: 0,
      check: 0,
      ai: 1,
      human: 0,
    });
    expect(parsed.shares_by_path).toEqual({
      memory: 0.5,
      pattern: 0,
      check: 0,
      ai: 0.5,
      human: 0,
    });
    expect(parsed.time_saved_estimate).toEqual({
      seconds: 3,
      is_estimate: true,
      basis: 'fast_path_answers_times_assumed_model_call_time',
      fast_answers_counted: 1,
      assumed_model_call_seconds: 3,
      note: expect.stringContaining('Estimate, not measured'),
    });
    expect(parsed.sample_too_small).toBe(true);
    expect(parsed.sample_note).toContain('under 30 decisions');
    expect(parsed.per_day).toHaveLength(1);
    expect(parsed.per_day[0].total).toBe(2);
    expect(parsed.per_day[0].fast).toBe(1);
    expect(parsed.per_day[0].fast_path_share).toBe(0.5);
  });

  it('counts pending reviews and shadow candidates accurately', async () => {
    const dbPath = join(home.path, 'reviews-and-shadow.db');
    const store = createStore(dbPath);

    // Pending review item 1: path ai, answer 'pending'
    store.decisions.create({
      decision_type: 'check',
      question: 'q1',
      answer: 'pending',
      confidence: 0,
      path: 'ai',
      created_at: dayIso(NOW, 1),
    });

    // Pending review item 2: path human
    store.decisions.create({
      decision_type: 'check',
      question: 'q2',
      answer: 'ask_user',
      confidence: 0.5,
      path: 'human',
      created_at: dayIso(NOW, 1),
    });

    // Pending review item 3: needs_review = 1
    store.decisions.create({
      decision_type: 'check',
      question: 'q3',
      answer: 'true',
      confidence: 0.9,
      path: 'memory',
      needs_review: true,
      created_at: dayIso(NOW, 1),
    });

    // Not pending: path ai but already answered
    store.decisions.create({
      decision_type: 'check',
      question: 'q4',
      answer: 'true',
      confidence: 0.8,
      path: 'ai',
      needs_review: false,
      created_at: dayIso(NOW, 1),
    });

    // Shadow candidate patterns:
    store.patterns.create({
      name: 'candidate 1',
      decision_type: 'check',
      rules: '[]',
      status: 'shadow',
    });
    store.patterns.create({
      name: 'candidate 2',
      decision_type: 'check',
      rules: '[]',
      status: 'shadow',
    });
    // Active pattern (not a shadow candidate)
    store.patterns.create({
      name: 'active rule',
      decision_type: 'check',
      rules: '[]',
      status: 'active',
    });

    store.close();

    const exitCode = await runCli({
      argv: ['report', '--db', dbPath, '--json'],
      streams: {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      now: NOW,
    });

    expect(exitCode).toBe(USAGE_EXIT_CODE);
    const parsed = JSON.parse(stdout.join('\n'));

    expect(parsed.pending_reviews).toBe(3);
    expect(parsed.shadow_candidates).toBe(2);
  });

  it('guarantees read-only behavior: leaves database file byte-identical before and after', async () => {
    const dbPath = join(home.path, 'readonly.db');
    const store = createStore(dbPath);

    for (let i = 0; i < 5; i++) {
      store.decisions.create({
        decision_type: 'check',
        question: `q${i}`,
        answer: 'true',
        confidence: 0.9,
        path: 'memory',
        created_at: dayIso(NOW, 1),
      });
    }
    store.close();

    // Put the file in rollback-journal mode. A connection that is not read-only switches it
    // to write-ahead logging, which rewrites the file header, so a report that opened the
    // database for writing would change these bytes even though it wrote no row.
    const raw = openDatabase(dbPath);
    raw.pragma('journal_mode = DELETE');
    raw.close();

    const bytesBefore = readFileSync(dbPath);

    // Run report command multiple times (both text and json)
    await runCli({
      argv: ['report', '--db', dbPath],
      streams: { stdout: () => {}, stderr: () => {} },
      now: NOW,
    });

    await runCli({
      argv: ['report', '--db', dbPath, '--json'],
      streams: { stdout: () => {}, stderr: () => {} },
      now: NOW,
    });

    await runCli({
      argv: ['report', '--db', dbPath, '--since', '3'],
      streams: { stdout: () => {}, stderr: () => {} },
      now: NOW,
    });

    const bytesAfter = readFileSync(dbPath);
    expect(bytesAfter.equals(bytesBefore)).toBe(true);
  });

  it('runs successfully when database file has chmod 0o444 (read-only permissions)', async () => {
    const dbPath = join(home.path, 'chmod-readonly.db');
    const store = createStore(dbPath);
    store.decisions.create({
      decision_type: 'check',
      question: 'check banner',
      answer: 'true',
      confidence: 0.9,
      path: 'memory',
      created_at: dayIso(NOW, 1),
    });
    store.close();

    // Make database file read-only on disk
    chmodSync(dbPath, 0o444);

    try {
      const exitCode = await runCli({
        argv: ['report', '--db', dbPath, '--json'],
        streams: {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        },
        now: NOW,
      });

      expect(exitCode).toBe(USAGE_EXIT_CODE);
      const parsed = JSON.parse(stdout.join('\n'));
      expect(parsed.total_decisions).toBe(1);
    } finally {
      // Restore permissions so cleanup works
      chmodSync(dbPath, 0o644);
    }
  });

  it('returns usage error on invalid --since parameter', async () => {
    const exitCodeNegative = await runCli({
      argv: ['report', '--since', '-1'],
      streams: {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    });

    expect(exitCodeNegative).toBe(USAGE_ERROR_EXIT_CODE);
    expect(stderr.join('\n')).toContain('--since must be a positive integer');

    stderr = [];
    const exitCodeAlpha = await runCli({
      argv: ['report', '--since', 'abc'],
      streams: {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    });

    expect(exitCodeAlpha).toBe(USAGE_ERROR_EXIT_CODE);
    expect(stderr.join('\n')).toContain('--since must be a positive integer');
  });
});
