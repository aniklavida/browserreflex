/**
 * The `get_stats` tool: what the decision log holds for a range, for a chat user who
 * has no dashboard.
 *
 * Status: **implemented and tested**. The tests behind that claim are
 * `packages/server/test/stats-tool.test.ts`, including a run over a real MCP client.
 *
 * What is measured and what is assumed, kept apart on purpose:
 *
 * - **Measured**, because every row in `decisions` was written by the router or by
 *   memory with the path that produced the answer and the time it took:
 *   `total_decisions`, `counts_by_path`, `fast_path_share`, `median_latency_ms` and
 *   `p95_latency_ms`.
 * - **Assumed**: `time_saved_estimate`. This server never calls a model in chat mode,
 *   so it has no measurement of what a model call costs in time and does not make one
 *   up silently. The estimate is the number of fast-path answers multiplied by
 *   `ASSUMED_MODEL_CALL_SECONDS_PER_FAST_ANSWER`, a named constant set to a round
 *   number so that it is easy to find and to replace with a measurement. The output
 *   carries the constant, the number of answers it was applied to, and `is_estimate:
 *   true`, so no reader can mistake it for something this server observed.
 *
 * Invariants:
 * - A record that misdescribes itself is worse than no record: the fast-path share is
 *   the share of rows whose path is `memory`, `pattern` or `check`, over every row in
 *   range. A slow-path answer is never counted as fast.
 * - With no decisions in range there is no share and no percentile. Both are `null`,
 *   not zero, because zero would claim a measurement that was not made.
 * - Percentiles come from the stored `latency_ms` of every decision in range, not from
 *   the fast-path rows alone.
 * - Timestamps are stored as ISO-8601 UTC text, so range boundaries are compared as
 *   text; every write path formats them the same way.
 *
 * The queries live here rather than in the store repositories because their shape is
 * set by this tool's output: the ranges, the path mix and the latency set are the
 * answer, and a repository method per tool would be a repository that knows about
 * tools. `store.db` is the same handle the typed repositories are built on.
 */

import { z } from 'zod';
import type { ZodRawShape } from 'zod';
import { DECISION_PATHS, type DecisionPath } from '../core/schema.js';
import { getDefaultStore } from '../core/log.js';
import type { DatabaseStore } from '../store/index.js';

/** Ranges this tool can report on. */
export const STATS_RANGES = ['today', '7d', '30d'] as const;
export type StatsRange = (typeof STATS_RANGES)[number];

/**
 * What the filter selects.
 *
 * - `all`: every decision in range.
 * - `browser`: decisions that carry a page URL or a domain, which is the closest
 *   honest reading of "browser" today: the `decisions` table has no column naming the
 *   pack or the decision kind a row belongs to, so the tool cannot separate browser
 *   decisions from coding decisions. It reports the rows that recorded a page, and the
 *   README says so. When a pack column exists this filter is the thing that has to
 *   change, and the note here is what a reader is told today.
 */
export const STATS_FILTERS = ['all', 'browser'] as const;
export type StatsFilter = (typeof STATS_FILTERS)[number];

/**
 * The paths that answer without a model call: memory (an input seen before), pattern
 * (a matching rule or learned pattern) and check (a direct evaluation of the supplied
 * page data). `ai` and `human` are not fast, however quick the answer arrived.
 */
export const FAST_PATHS = ['memory', 'pattern', 'check'] as const;
export type FastPath = (typeof FAST_PATHS)[number];

/**
 * Assumption behind `time_saved_estimate`, in seconds: how long one model call is
 * taken to take when a fast answer avoids it.
 *
 * **This is a round number chosen to be replaced, not a measurement.** This server
 * does not call a model, so it cannot time one. It exists because "time saved" is the
 * number people ask for, and reporting nothing would hide the question; reporting it
 * without this constant would present an assumption as a measurement. Replace it with
 * a measured figure, or drop the estimate entirely, rather than tuning it to make the
 * result look better.
 *
 * The same value and the same caveat are recorded in `src/tools/README.md`.
 */
export const ASSUMED_MODEL_CALL_SECONDS_PER_FAST_ANSWER = 3;

/** The sentence the output carries with every estimate, so the label travels with it. */
export const TIME_SAVED_ESTIMATE_NOTE =
  'Estimate, not measured: fast-path answers in range multiplied by an assumed ' +
  'model-call time. This server did not run a model to compare against.';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rounds for output only. Nothing in the database is rounded. */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** True when a path answered without a model call. `ai` and `human` are never fast. */
export function isFastPath(path: DecisionPath): boolean {
  return (FAST_PATHS as readonly string[]).includes(path);
}

/**
 * The first instant of a range, inclusive.
 *
 * `today` is local midnight of the current day, so the range follows the user's day
 * rather than a rolling 24 hours. `7d` and `30d` are rolling windows ending at `now`.
 */
export function rangeStart(range: StatsRange, now: Date): Date {
  switch (range) {
    case 'today': {
      const start = new Date(now.getTime());
      start.setHours(0, 0, 0, 0);
      return start;
    }
    case '7d':
      return new Date(now.getTime() - 7 * DAY_MS);
    case '30d':
      return new Date(now.getTime() - 30 * DAY_MS);
  }
}

export interface LatencyPercentiles {
  /** Median of the supplied values, or `null` when there are none. */
  readonly median: number | null;
  /** 95th percentile, nearest rank, or `null` when there are none. */
  readonly p95: number | null;
}

/**
 * Median and 95th percentile of a latency set.
 *
 * The median is the middle value for an odd count and the mean of the two middle
 * values for an even one. The 95th percentile is nearest rank: the value at index
 * `ceil(0.95 * n) - 1` of the ascending values, which needs no interpolation and so
 * always returns a latency that was actually recorded.
 */
export function computeLatencyPercentiles(values: readonly number[]): LatencyPercentiles {
  if (values.length === 0) {
    return { median: null, p95: null };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] as number)
      : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;

  const p95Index = Math.min(Math.ceil(0.95 * sorted.length) - 1, sorted.length - 1);

  return { median: round(median, 3), p95: round(sorted[p95Index] as number, 3) };
}

export interface TimeSavedEstimate {
  /** Fast-path answers multiplied by the assumed model-call time. Never measured. */
  readonly seconds: number;
  /** Always true. Present so a reader cannot take the number as measured. */
  readonly is_estimate: true;
  readonly basis: 'fast_path_answers_times_assumed_model_call_time';
  /** The fast-path answers the estimate was applied to. */
  readonly fast_answers_counted: number;
  /** The constant the estimate assumed, so the arithmetic can be checked. */
  readonly assumed_model_call_seconds: number;
  readonly note: string;
}

export interface GetStatsOutput {
  readonly range: StatsRange;
  readonly filter: StatsFilter;
  /** Inclusive first instant of the range, ISO-8601 UTC. */
  readonly range_start: string;
  /** Inclusive last instant, the clock reading this call used. */
  readonly range_end: string;
  readonly total_decisions: number;
  /** Share of rows on a fast path, 0 to 1, or `null` when nothing was recorded. */
  readonly fast_path_share: number | null;
  readonly counts_by_path: Record<DecisionPath, number>;
  readonly fast_path_counts: Record<FastPath, number>;
  /** Over every decision in range, not only the fast-path ones. `null` when empty. */
  readonly median_latency_ms: number | null;
  /** Nearest rank over every decision in range. `null` when empty. */
  readonly p95_latency_ms: number | null;
  readonly time_saved_estimate: TimeSavedEstimate;
  /** Learned patterns the monitor disabled. A current state, not limited to the range. */
  readonly drift_alerts: DriftAlertSummary;
}

/** The most recent active drift alerts reported by `get_stats`. */
export const DRIFT_ALERT_LIST_LIMIT = 10;

export interface DriftAlertSummary {
  /** Active alerts, however many there are. */
  readonly active: number;
  /** The newest `DRIFT_ALERT_LIST_LIMIT` active alerts. */
  readonly items: readonly {
    readonly id: string;
    readonly pattern_id: string;
    readonly accuracy: number;
    readonly threshold: number;
    readonly message: string;
    readonly created_at: string;
  }[];
}

export const getStatsInputSchema: ZodRawShape = {
  range: z
    .enum(STATS_RANGES)
    .optional()
    .describe('Window to report on: today (local midnight), 7d or 30d. Defaults to 7d.'),
  filter: z
    .enum(STATS_FILTERS)
    .optional()
    .describe(
      'all (default) counts every decision in range; browser counts only decisions that recorded a page URL or domain.',
    ),
};

export const getStatsOutputSchema: ZodRawShape = {
  range: z.enum(STATS_RANGES),
  filter: z.enum(STATS_FILTERS),
  range_start: z.string(),
  range_end: z.string(),
  total_decisions: z.number().int().min(0),
  fast_path_share: z
    .number()
    .min(0)
    .max(1)
    .nullable()
    .describe(
      'Share of decisions in range on a fast path (memory, pattern or check), 0 to 1. Null when nothing was recorded.',
    ),
  counts_by_path: z.object({
    memory: z.number().int().min(0),
    pattern: z.number().int().min(0),
    check: z.number().int().min(0),
    ai: z.number().int().min(0),
    human: z.number().int().min(0),
  }),
  fast_path_counts: z.object({
    memory: z.number().int().min(0),
    pattern: z.number().int().min(0),
    check: z.number().int().min(0),
  }),
  median_latency_ms: z
    .number()
    .min(0)
    .nullable()
    .describe(
      'Median recorded latency over every decision in range. Null when nothing was recorded.',
    ),
  p95_latency_ms: z
    .number()
    .min(0)
    .nullable()
    .describe(
      'Nearest-rank 95th percentile of recorded latency in range. Null when nothing was recorded.',
    ),
  time_saved_estimate: z.object({
    seconds: z.number().min(0),
    is_estimate: z.literal(true),
    basis: z.literal('fast_path_answers_times_assumed_model_call_time'),
    fast_answers_counted: z.number().int().min(0),
    assumed_model_call_seconds: z.number().positive(),
    note: z.string(),
  }),
  drift_alerts: z.object({
    active: z.number().int().min(0),
    items: z.array(
      z.object({
        id: z.string(),
        pattern_id: z.string(),
        accuracy: z.number(),
        threshold: z.number(),
        message: z.string(),
        created_at: z.string(),
      }),
    ),
  }),
};

export interface GetStatsContext {
  readonly store?: DatabaseStore | undefined;
  /** Clock reading for this call. Injected by tests; production passes nothing. */
  readonly now?: Date | undefined;
}

/** Builds the shared WHERE clause for both queries over the range and filter. */
function rangeFilter(
  range: StatsRange,
  filter: StatsFilter,
  now: Date,
): {
  clause: string;
  params: Record<string, unknown>;
} {
  const start = rangeStart(range, now);
  const clause = ['created_at >= :range_start', 'created_at <= :range_end'];
  const params: Record<string, unknown> = {
    range_start: start.toISOString(),
    range_end: now.toISOString(),
  };

  if (filter === 'browser') {
    clause.push("(COALESCE(url, '') <> '' OR COALESCE(domain, '') <> '')");
  }

  return { clause: clause.join(' AND '), params };
}

interface PathCountRow {
  path: DecisionPath;
  total: number;
}

interface LatencyRow {
  latency_ms: number;
}

/**
 * Builds the time-saved estimate, with the assumption attached to it.
 *
 * Kept separate from the query so the estimate is one function reading one constant,
 * and so a test can hold the tool to the number it publishes.
 */
export function buildTimeSavedEstimate(fastAnswersCounted: number): TimeSavedEstimate {
  return {
    seconds: round(fastAnswersCounted * ASSUMED_MODEL_CALL_SECONDS_PER_FAST_ANSWER, 2),
    is_estimate: true,
    basis: 'fast_path_answers_times_assumed_model_call_time',
    fast_answers_counted: fastAnswersCounted,
    assumed_model_call_seconds: ASSUMED_MODEL_CALL_SECONDS_PER_FAST_ANSWER,
    note: TIME_SAVED_ESTIMATE_NOTE,
  };
}

/**
 * Executes the `get_stats` tool logic: the decision mix, latency percentiles and the
 * labelled time-saved estimate for one range and filter.
 *
 * Arguments that name a range or filter the tool does not have are refused rather
 * than quietly replaced with a default: a caller that asked for `90d` and received
 * `30d` would be reading a report about a window it never chose.
 */
export function executeGetStats(
  args: Record<string, unknown>,
  context: GetStatsContext = {},
): GetStatsOutput {
  const store = context.store ?? getDefaultStore();
  const now = context.now ?? new Date();

  const range = readRange(args.range);
  const filter = readFilter(args.filter);

  const { clause, params } = rangeFilter(range, filter, now);

  const pathRows = store.db
    .prepare(`SELECT path, COUNT(*) AS total FROM decisions WHERE ${clause} GROUP BY path`)
    .all(params) as PathCountRow[];

  const latencyRows = store.db
    .prepare(`SELECT latency_ms FROM decisions WHERE ${clause} ORDER BY latency_ms ASC`)
    .all(params) as LatencyRow[];

  // Every declared path is present with a zero, so a path nobody used reads as zero
  // rather than as missing.
  const countsByPath: Record<DecisionPath, number> = {
    memory: 0,
    pattern: 0,
    check: 0,
    ai: 0,
    human: 0,
  };

  let totalDecisions = 0;
  let fastPathDecisions = 0;

  for (const row of pathRows) {
    const path = row.path;
    const total = Number(row.total);
    // A row carrying a path this build does not know is still counted in the total
    // rather than dropped, so the reported total matches the rows in range.
    totalDecisions += total;
    if ((DECISION_PATHS as readonly string[]).includes(path)) {
      countsByPath[path] += total;
    }
    if (isFastPath(path)) {
      fastPathDecisions += total;
    }
  }

  const fastPathCounts: Record<FastPath, number> = {
    memory: countsByPath.memory,
    pattern: countsByPath.pattern,
    check: countsByPath.check,
  };

  const { median, p95 } = computeLatencyPercentiles(latencyRows.map((row) => row.latency_ms));

  return {
    range,
    filter,
    range_start: rangeStart(range, now).toISOString(),
    range_end: now.toISOString(),
    total_decisions: totalDecisions,
    fast_path_share: totalDecisions === 0 ? null : round(fastPathDecisions / totalDecisions, 4),
    counts_by_path: countsByPath,
    fast_path_counts: fastPathCounts,
    median_latency_ms: median,
    p95_latency_ms: p95,
    time_saved_estimate: buildTimeSavedEstimate(fastPathDecisions),
    drift_alerts: summariseDriftAlerts(store),
  };
}

function summariseDriftAlerts(store: DatabaseStore): DriftAlertSummary {
  const active = store.driftAlerts.list({ status: 'active' });
  return {
    active: active.length,
    items: active.slice(0, DRIFT_ALERT_LIST_LIMIT).map((alert) => ({
      id: alert.id,
      pattern_id: alert.pattern_id,
      accuracy: alert.accuracy,
      threshold: alert.threshold,
      message: alert.message,
      created_at: alert.created_at,
    })),
  };
}

function readRange(value: unknown): StatsRange {
  if (value === undefined) {
    return '7d';
  }
  if (typeof value === 'string' && (STATS_RANGES as readonly string[]).includes(value)) {
    return value as StatsRange;
  }
  throw new Error(
    `Unknown range ${JSON.stringify(value)}. This tool reports ${STATS_RANGES.join(', ')}.`,
  );
}

function readFilter(value: unknown): StatsFilter {
  if (value === undefined) {
    return 'all';
  }
  if (typeof value === 'string' && (STATS_FILTERS as readonly string[]).includes(value)) {
    return value as StatsFilter;
  }
  throw new Error(
    `Unknown filter ${JSON.stringify(value)}. This tool reports ${STATS_FILTERS.join(', ')}.`,
  );
}
