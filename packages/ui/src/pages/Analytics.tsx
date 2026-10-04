import { useState } from 'react';
import { api, type Decision, type DecisionPath } from '../api';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { MetricGrid } from '../components/MetricGrid';
import { SegmentedControl } from '../components/SegmentedControl';
import { dayKey, lastDays, percent } from '../format';
import { useApi } from '../useApi';

type Range = '7' | '30' | '90';

/** How many of the newest decisions are read. The page says so when the log holds more. */
export const SAMPLE_LIMIT = 500;

const FAST: readonly DecisionPath[] = ['memory', 'pattern', 'check'];

export interface DayBar {
  day: string;
  total: number;
  fast: number;
  share: number | null;
}

/** Fast-path share per local calendar day, for the last `days` days, oldest first. */
export function dailyFastPath(
  decisions: readonly Decision[],
  days: number,
  now: Date = new Date(),
): DayBar[] {
  const bars = new Map<string, DayBar>(
    lastDays(days, now).map((day) => [day, { day, total: 0, fast: 0, share: null }]),
  );
  for (const decision of decisions) {
    const bar = bars.get(dayKey(decision.created_at));
    if (bar === undefined) continue;
    bar.total += 1;
    if (FAST.includes(decision.path)) bar.fast += 1;
  }
  return [...bars.values()].map((bar) => ({
    ...bar,
    share: bar.total === 0 ? null : bar.fast / bar.total,
  }));
}

export function pathCounts(decisions: readonly Decision[]): Record<DecisionPath, number> {
  const counts: Record<DecisionPath, number> = { memory: 0, pattern: 0, check: 0, ai: 0, human: 0 };
  for (const decision of decisions) counts[decision.path] += 1;
  return counts;
}

/** Nearest-rank percentile of the recorded latencies, or null when none were recorded. */
export function latencyPercentile(decisions: readonly Decision[], fraction: number): number | null {
  const values = decisions
    .map((decision) => decision.latency_ms)
    .filter((value): value is number => typeof value === 'number')
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  const rank = Math.max(1, Math.ceil(fraction * values.length));
  return values[rank - 1] ?? null;
}

export function Analytics() {
  const [range, setRange] = useState<Range>('30');
  const decisions = useApi(() => api.decisions({ limit: SAMPLE_LIMIT }));

  if (decisions.error !== null) {
    return (
      <div className="page">
        <ErrorNote message={decisions.error} />
      </div>
    );
  }
  if (decisions.data === null) {
    return <div className="page muted">Loading…</div>;
  }
  if (decisions.data.total === 0) {
    return (
      <div className="page">
        <EmptyState title="No decisions to chart">
          Once your agent has made decisions, the fast-path share per day appears here. Run the
          setup wizard if you have not connected an agent yet.
        </EmptyState>
      </div>
    );
  }

  const rows = decisions.data.items;
  const bars = dailyFastPath(rows, Number(range));
  const counts = pathCounts(rows);
  const median = latencyPercentile(rows, 0.5);
  const p95 = latencyPercentile(rows, 0.95);
  const truncated = decisions.data.total > rows.length;
  const today = bars[bars.length - 1]?.day;

  return (
    <div className="page">
      <SegmentedControl<Range>
        label="Range"
        value={range}
        onChange={setRange}
        options={[
          { value: '7', label: '7D' },
          { value: '30', label: '30D' },
          { value: '90', label: '90D' },
        ]}
      />
      {truncated ? (
        <div className="muted">
          Based on the newest {rows.length} of {decisions.data.total} decisions.
        </div>
      ) : null}
      <Card label="Fast-path share per day">
        <div className="bars" role="img" aria-label="Fast-path share per day">
          {bars.map((bar) => (
            <div
              key={bar.day}
              className={`bar${bar.day === today ? ' today' : ''}`}
              style={{ height: `${Math.max(2, (bar.share ?? 0) * 100)}%` }}
              title={`${bar.day}: ${bar.share === null ? 'no decisions' : `${percent(bar.share)} of ${bar.total}`}`}
            />
          ))}
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          A day with no decisions shows a short bar and no percentage. A measurement of this log,
          not a promise.
        </p>
      </Card>
      <MetricGrid
        metrics={[
          { label: 'Median latency', value: median === null ? '—' : `${median} ms` },
          { label: 'p95 latency', value: p95 === null ? '—' : `${p95} ms` },
          { label: 'Memory', value: counts.memory },
          { label: 'Pattern', value: counts.pattern },
          { label: 'Check', value: counts.check },
          { label: 'Model', value: counts.ai },
          { label: 'Person', value: counts.human },
        ]}
      />
      <p className="muted">
        Quality, safety, agents and drift tabs are planned. No token count is stored, so no token
        figure is shown.
      </p>
    </div>
  );
}
