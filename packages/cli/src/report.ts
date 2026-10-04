/**
 * The `report` command: reads the local decision log and prints a measurement report.
 *
 * What is measured and what is assumed:
 * - Measured: total decisions, path breakdown, fast-path share, daily trend,
 *   pending reviews, shadow candidates.
 * - Assumed: time saved estimate, using the shared get_stats formula and constant.
 *
 * Invariants:
 * - A decision record that misdescribes itself is worse than no record: a model answer
 *   is never fast; fast paths are memory, pattern, check.
 * - Read-only: this command never writes to the database. If the file does not exist,
 *   it reports an honest empty report and creates no files.
 * - Sample size guard: when total decisions are under 30, it states that the sample
 *   is too small to read rather than printing a trend.
 * - Output carries the sentence "a measurement, not a promise".
 */

import { existsSync } from 'node:fs';
import {
  buildTimeSavedEstimate,
  isFastPath,
  openDatabase,
  type DecisionPath,
  type FastPath,
  type TimeSavedEstimate,
} from '@browserreflex/server';
import type { CliStreams } from './cli.js';

export interface ReportOptions {
  readonly databasePath: string;
  readonly since?: number | undefined;
  readonly json?: boolean | undefined;
  readonly now?: Date | undefined;
  readonly streams: CliStreams;
}

export interface DailyFastPath {
  readonly date: string;
  readonly total: number;
  readonly fast: number;
  readonly fast_path_share: number | null;
}

export interface MeasurementReport {
  readonly database_path: string;
  readonly range: string;
  readonly since_days: number | null;
  readonly total_decisions: number;
  readonly fast_path_decisions: number;
  readonly fast_path_share: number | null;
  readonly counts_by_path: Record<DecisionPath, number>;
  readonly shares_by_path: Record<DecisionPath, number>;
  readonly fast_path_counts: Record<FastPath, number>;
  readonly time_saved_estimate: TimeSavedEstimate;
  readonly pending_reviews: number;
  readonly shadow_candidates: number;
  readonly sample_size: number;
  readonly sample_too_small: boolean;
  readonly sample_note: string | null;
  readonly note: 'a measurement, not a promise';
  readonly per_day: readonly DailyFastPath[];
}

/** Rounds a floating number for display/JSON without modifying stored data. */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Formats a fraction into a percentage string, or 'none' when null. */
function formatPercent(value: number | null): string {
  if (value === null) {
    return 'none';
  }
  return `${(value * 100).toFixed(1)}%`;
}

/** Generates a measurement report from the local database. */
export function generateReport(params: {
  databasePath: string;
  since?: number | undefined;
  now?: Date | undefined;
}): MeasurementReport {
  const { databasePath, since } = params;
  const now = params.now ?? new Date();

  const emptyReport: MeasurementReport = {
    database_path: databasePath,
    range:
      since !== undefined ? `last ${since} day${since === 1 ? '' : 's'}` : 'all recorded decisions',
    since_days: since ?? null,
    total_decisions: 0,
    fast_path_decisions: 0,
    fast_path_share: null,
    counts_by_path: {
      memory: 0,
      pattern: 0,
      check: 0,
      ai: 0,
      human: 0,
    },
    shares_by_path: {
      memory: 0,
      pattern: 0,
      check: 0,
      ai: 0,
      human: 0,
    },
    fast_path_counts: {
      memory: 0,
      pattern: 0,
      check: 0,
    },
    time_saved_estimate: buildTimeSavedEstimate(0),
    pending_reviews: 0,
    shadow_candidates: 0,
    sample_size: 0,
    sample_too_small: true,
    sample_note: 'Sample is too small to read (under 30 decisions).',
    note: 'a measurement, not a promise',
    per_day: [],
  };

  if (!existsSync(databasePath)) {
    return emptyReport;
  }

  const db = openDatabase(databasePath, { readonly: true, fileMustExist: true });

  try {
    const hasDecisions = Boolean(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decisions'").get(),
    );
    const hasPatterns = Boolean(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='patterns'").get(),
    );

    if (!hasDecisions) {
      return emptyReport;
    }

    let whereClause = '';
    const paramsList: unknown[] = [];

    if (since !== undefined) {
      const cutoff = new Date(now.getTime() - since * 24 * 60 * 60 * 1000).toISOString();
      whereClause = 'WHERE created_at >= ?';
      paramsList.push(cutoff);
    }

    interface PathRow {
      path: string;
      count: number;
    }

    const pathRows = db
      .prepare(`SELECT path, COUNT(*) as count FROM decisions ${whereClause} GROUP BY path`)
      .all(...paramsList) as PathRow[];

    let totalDecisions = 0;
    let fastPathDecisions = 0;

    const countsByPath: Record<DecisionPath, number> = {
      memory: 0,
      pattern: 0,
      check: 0,
      ai: 0,
      human: 0,
    };

    for (const row of pathRows) {
      const count = Number(row.count);
      totalDecisions += count;
      if (row.path in countsByPath) {
        countsByPath[row.path as DecisionPath] += count;
      }
      if (isFastPath(row.path as DecisionPath)) {
        fastPathDecisions += count;
      }
    }

    const sharesByPath: Record<DecisionPath, number> = {
      memory: totalDecisions === 0 ? 0 : round(countsByPath.memory / totalDecisions, 4),
      pattern: totalDecisions === 0 ? 0 : round(countsByPath.pattern / totalDecisions, 4),
      check: totalDecisions === 0 ? 0 : round(countsByPath.check / totalDecisions, 4),
      ai: totalDecisions === 0 ? 0 : round(countsByPath.ai / totalDecisions, 4),
      human: totalDecisions === 0 ? 0 : round(countsByPath.human / totalDecisions, 4),
    };

    const fastPathCounts: Record<FastPath, number> = {
      memory: countsByPath.memory,
      pattern: countsByPath.pattern,
      check: countsByPath.check,
    };

    const fastPathShare =
      totalDecisions === 0 ? null : round(fastPathDecisions / totalDecisions, 4);

    const timeSavedEstimate = buildTimeSavedEstimate(fastPathDecisions);

    const pendingRow = db
      .prepare(
        `SELECT COUNT(*) as count FROM decisions WHERE ((path = 'ai' AND answer = 'pending') OR path = 'human' OR needs_review = 1)`,
      )
      .get() as { count: number } | undefined;
    const pendingReviews = Number(pendingRow?.count ?? 0);

    let shadowCandidates = 0;
    if (hasPatterns) {
      const shadowRow = db
        .prepare(
          `SELECT COUNT(*) as count FROM patterns WHERE status = 'shadow' OR status = 'candidate'`,
        )
        .get() as { count: number } | undefined;
      shadowCandidates = Number(shadowRow?.count ?? 0);
    }

    interface DayPathRow {
      day: string;
      path: string;
      count: number;
    }

    const dayRows = db
      .prepare(
        `SELECT substr(created_at, 1, 10) as day, path, COUNT(*) as count FROM decisions ${whereClause} GROUP BY day, path ORDER BY day ASC`,
      )
      .all(...paramsList) as DayPathRow[];

    const dayMap = new Map<string, { total: number; fast: number }>();
    for (const row of dayRows) {
      const entry = dayMap.get(row.day) ?? { total: 0, fast: 0 };
      const count = Number(row.count);
      entry.total += count;
      if (isFastPath(row.path as DecisionPath)) {
        entry.fast += count;
      }
      dayMap.set(row.day, entry);
    }

    const perDay: DailyFastPath[] = [];
    for (const [day, stats] of dayMap.entries()) {
      perDay.push({
        date: day,
        total: stats.total,
        fast: stats.fast,
        fast_path_share: stats.total === 0 ? null : round(stats.fast / stats.total, 4),
      });
    }

    const sampleTooSmall = totalDecisions < 30;
    const sampleNote = sampleTooSmall ? 'Sample is too small to read (under 30 decisions).' : null;

    return {
      database_path: databasePath,
      range:
        since !== undefined
          ? `last ${since} day${since === 1 ? '' : 's'}`
          : 'all recorded decisions',
      since_days: since ?? null,
      total_decisions: totalDecisions,
      fast_path_decisions: fastPathDecisions,
      fast_path_share: fastPathShare,
      counts_by_path: countsByPath,
      shares_by_path: sharesByPath,
      fast_path_counts: fastPathCounts,
      time_saved_estimate: timeSavedEstimate,
      pending_reviews: pendingReviews,
      shadow_candidates: shadowCandidates,
      sample_size: totalDecisions,
      sample_too_small: sampleTooSmall,
      sample_note: sampleNote,
      note: 'a measurement, not a promise',
      per_day: perDay,
    };
  } finally {
    db.close();
  }
}

/** Formats the measurement report into readable human-facing lines. */
export function renderReportText(report: MeasurementReport): string[] {
  const lines: string[] = [
    'BrowserReflex measurement report: a measurement, not a promise.',
    '',
    `Database: ${report.database_path}`,
    `Range:    ${report.range}`,
    '',
    'Decisions:',
    `  Total decisions:    ${report.total_decisions}`,
    `  Fast-path share:    ${formatPercent(report.fast_path_share)}${report.total_decisions > 0 ? ` (${report.fast_path_decisions}/${report.total_decisions})` : ''}`,
    '',
    'Path breakdown:',
    `  memory:             ${report.counts_by_path.memory}${report.total_decisions > 0 ? ` (${formatPercent(report.shares_by_path.memory)})` : ''}`,
    `  pattern:            ${report.counts_by_path.pattern}${report.total_decisions > 0 ? ` (${formatPercent(report.shares_by_path.pattern)})` : ''}`,
    `  check:              ${report.counts_by_path.check}${report.total_decisions > 0 ? ` (${formatPercent(report.shares_by_path.check)})` : ''}`,
    `  ai:                 ${report.counts_by_path.ai}${report.total_decisions > 0 ? ` (${formatPercent(report.shares_by_path.ai)})` : ''}`,
    `  human:              ${report.counts_by_path.human}${report.total_decisions > 0 ? ` (${formatPercent(report.shares_by_path.human)})` : ''}`,
    '',
    'Fast-path breakdown:',
    `  memory:             ${report.fast_path_counts.memory}`,
    `  pattern:            ${report.fast_path_counts.pattern}`,
    `  check:              ${report.fast_path_counts.check}`,
    '',
    'Time saved estimate:',
    `  Seconds saved:      ${report.time_saved_estimate.seconds}s`,
    `  Basis:              ${report.time_saved_estimate.fast_answers_counted} fast-path answers × ${report.time_saved_estimate.assumed_model_call_seconds}s assumed model call`,
    `  Note:               ${report.time_saved_estimate.note}`,
    '',
    'Queue & Learning:',
    `  Pending reviews:    ${report.pending_reviews}`,
    `  Shadow candidates:  ${report.shadow_candidates}`,
    '',
    'Daily fast-path trend:',
  ];

  if (report.sample_too_small) {
    lines.push(`  Sample is too small to read (under 30 decisions).`);
  } else {
    for (const day of report.per_day) {
      lines.push(
        `  ${day.date}:  ${formatPercent(day.fast_path_share)} (${day.fast}/${day.total})`,
      );
    }
  }

  return lines;
}

/** Executes the report command and writes to the configured stdout stream. */
export async function runReport(options: ReportOptions): Promise<number> {
  const report = generateReport({
    databasePath: options.databasePath,
    since: options.since,
    now: options.now,
  });

  if (options.json) {
    options.streams.stdout(JSON.stringify(report, null, 2));
  } else {
    for (const line of renderReportText(report)) {
      options.streams.stdout(line);
    }
  }

  return 0;
}
