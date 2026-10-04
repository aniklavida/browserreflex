import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type Decision, type DecisionPath } from '../api';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { MetricGrid } from '../components/MetricGrid';
import { ProbabilityBar } from '../components/ProbabilityBar';
import { SegmentedControl } from '../components/SegmentedControl';
import { useToast } from '../components/Toast';
import { dayKey, lastDays, percent } from '../format';
import { useApi } from '../useApi';

type Range = '7' | '30' | '90';
type Tab = 'overview' | 'quality' | 'safety' | 'agents' | 'drift';

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

/** The first moment of the day `days` ago, as an ISO timestamp, for the `from` query. */
export function sinceIso(days: number, now: Date = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1).toISOString();
}

export function Analytics() {
  const [tab, setTab] = useState<Tab>('overview');
  const [range, setRange] = useState<Range>('30');

  return (
    <div className="page">
      <div className="row">
        <SegmentedControl<Tab>
          label="Section"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'overview', label: 'Overview' },
            { value: 'quality', label: 'Quality' },
            { value: 'safety', label: 'Safety' },
            { value: 'agents', label: 'Agents + projects' },
            { value: 'drift', label: 'Drift' },
          ]}
        />
        {tab !== 'drift' ? (
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
        ) : null}
      </div>
      {tab === 'overview' ? <Overview range={range} /> : null}
      {tab === 'quality' ? <QualityTab range={range} /> : null}
      {tab === 'safety' ? <SafetyTab range={range} /> : null}
      {tab === 'agents' ? <AgentsTab range={range} /> : null}
      {tab === 'drift' ? <DriftTab /> : null}
    </div>
  );
}

function Overview({ range }: { range: Range }) {
  const decisions = useApi(() => api.decisions({ limit: SAMPLE_LIMIT }));
  const [selected, setSelected] = useState<string | null>(null);

  if (decisions.error !== null) return <ErrorNote message={decisions.error} />;
  if (decisions.data === null) return <div className="muted">Loading…</div>;
  if (decisions.data.total === 0) {
    return (
      <EmptyState title="No decisions to chart">
        Once your agent has made decisions, the fast-path share per day appears here. Run the setup
        wizard if you have not connected an agent yet.
      </EmptyState>
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
    <>
      {truncated ? (
        <div className="muted">
          Based on the newest {rows.length} of {decisions.data.total} decisions.
        </div>
      ) : null}
      <Card label="Fast-path share per day">
        <div className="bars" role="group" aria-label="Fast-path share per day">
          {bars.map((bar) => (
            <button
              key={bar.day}
              type="button"
              aria-label={`${bar.day}: ${bar.share === null ? 'no decisions' : `${percent(bar.share)} of ${bar.total}`}`}
              aria-pressed={bar.day === selected}
              className={`bar${bar.day === today || bar.day === selected ? ' today' : ''}`}
              style={{ height: `${Math.max(2, (bar.share ?? 0) * 100)}%`, border: 0, padding: 0 }}
              onClick={() => setSelected(bar.day === selected ? null : bar.day)}
            />
          ))}
        </div>
        {selected !== null ? (
          <div className="row" style={{ marginTop: 12 }}>
            <span className="mono">
              {selected}: {percent(bars.find((bar) => bar.day === selected)?.share ?? null)} of{' '}
              {bars.find((bar) => bar.day === selected)?.total ?? 0}
            </span>
            <Link className="btn" style={{ textDecoration: 'none' }} to={`/logs?day=${selected}`}>
              Open decisions →
            </Link>
          </div>
        ) : null}
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
      <p className="muted">No token count is stored, so no token figure is shown.</p>
    </>
  );
}

function QualityTab({ range }: { range: Range }) {
  const quality = useApi(() => api.quality(sinceIso(Number(range))), [range]);
  const notify = useToast();

  if (quality.error !== null) return <ErrorNote message={quality.error} />;
  if (quality.data === null) return <div className="muted">Loading…</div>;
  if (quality.data.corrected_decisions === 0) {
    return (
      <EmptyState title="Nothing corrected yet">
        Quality compares what BrowserReflex said it was sure of with what turned out right. It needs
        decisions that a person or your agent corrected: use the review queue and feedback.
      </EmptyState>
    );
  }

  const disable = async (id: string) => {
    try {
      await api.setPattern(id, 'disabled');
      notify('Pattern switched off', 'auto');
      quality.reload();
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'Could not switch the pattern', 'human');
    }
  };

  return (
    <>
      <Card label="Stated confidence against what was right">
        <table className="table">
          <thead>
            <tr>
              <th>Confidence</th>
              <th>Corrected</th>
              <th>Stated</th>
              <th>Actually right</th>
            </tr>
          </thead>
          <tbody>
            {quality.data.bins
              .filter((bin) => bin.count > 0)
              .map((bin) => (
                <tr key={bin.lower}>
                  <td className="mono">
                    {percent(bin.lower)}–{percent(bin.upper)}
                  </td>
                  <td>{bin.count}</td>
                  <td style={{ width: 200 }}>
                    <ProbabilityBar value={bin.stated ?? 0} />
                  </td>
                  <td style={{ width: 200 }}>
                    <ProbabilityBar value={bin.actual ?? 0} suggested />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        <p className="muted" style={{ marginBottom: 0 }}>
          Only {quality.data.corrected_decisions} corrected decisions: a bin with few of them says
          little.
        </p>
      </Card>
      <Card label="Wrong most often">
        {quality.data.wrong_most.length === 0 ? (
          <span className="muted">No corrected decision was wrong.</span>
        ) : (
          <table className="table">
            <tbody>
              {quality.data.wrong_most.map((row) => (
                <tr key={row.pattern_id}>
                  <td className="mono">{row.pattern_id}</td>
                  <td>
                    {row.wrong} of {row.total}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void disable(row.pattern_id)}
                    >
                      Disable
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

function SafetyTab({ range }: { range: Range }) {
  const safety = useApi(() => api.safety(sinceIso(Number(range))), [range]);

  if (safety.error !== null) return <ErrorNote message={safety.error} />;
  if (safety.data === null) return <div className="muted">Loading…</div>;

  const families = Object.entries(safety.data.by_family);
  const total = families.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) {
    return (
      <EmptyState title="No safety records in this range">
        When a safety rule flags a payment, a deletion or an outgoing message, the record appears
        here. The safety check is advisory.
      </EmptyState>
    );
  }

  return (
    <>
      <div className="warn">{safety.data.note}</div>
      <Card label="Records by type">
        <table className="table">
          <tbody>
            {families.map(([family, count]) => (
              <tr key={family}>
                <td>{family}</td>
                <td style={{ width: 240 }}>
                  <ProbabilityBar value={count / total} />
                </td>
                <td className="mono">{count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <MetricGrid
        metrics={Object.entries(safety.data.by_answer).map(([answer, count]) => ({
          label: answer,
          value: count,
        }))}
      />
      <Card label="Risky places">
        <table className="table">
          <tbody>
            {safety.data.risky_places.map((place) => (
              <tr key={place.domain}>
                <td className="mono">{place.domain}</td>
                <td className="mono">{place.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function AgentsTab({ range }: { range: Range }) {
  const agents = useApi(() => api.agents(sinceIso(Number(range))), [range]);

  if (agents.error !== null) return <ErrorNote message={agents.error} />;
  if (agents.data === null) return <div className="muted">Loading…</div>;
  if (agents.data.agents.length === 0) {
    return (
      <EmptyState title="No agent has made a decision in this range">
        Agents and projects appear here after your agent has used BrowserReflex.
      </EmptyState>
    );
  }

  return (
    <div className="cols-2">
      <Card label="Agents">
        <table className="table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Decisions</th>
              <th>Fast</th>
            </tr>
          </thead>
          <tbody>
            {agents.data.agents.map((row) => (
              <tr key={row.agent}>
                <td>{row.agent}</td>
                <td>{row.decisions}</td>
                <td>{percent(row.decisions === 0 ? null : row.fast / row.decisions)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card label="Projects (by site)">
        <table className="table">
          <thead>
            <tr>
              <th>Site</th>
              <th>Decisions</th>
              <th>Fast</th>
            </tr>
          </thead>
          <tbody>
            {agents.data.projects.map((row) => (
              <tr key={row.project}>
                <td className="mono">{row.project}</td>
                <td>{row.decisions}</td>
                <td>{percent(row.decisions === 0 ? null : row.fast / row.decisions)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function DriftTab() {
  const drift = useApi(() => api.drift());
  const notify = useToast();

  if (drift.error !== null) return <ErrorNote message={drift.error} />;
  if (drift.data === null) return <div className="muted">Loading…</div>;

  const threshold = drift.data.threshold;
  const active = drift.data.alerts.filter((alert) => alert.status === 'active');

  const setStatus = async (id: string, status: 'acknowledged' | 'resolved') => {
    try {
      await api.setDrift(id, status);
      notify('Alert updated', 'auto');
      drift.reload();
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'Could not update the alert', 'human');
    }
  };

  if (drift.data.patterns.length === 0 && drift.data.alerts.length === 0) {
    return (
      <EmptyState title="Nothing to watch yet">
        About 2% of the answers a learned pattern gives are re-checked. Their accuracy and any drift
        alert appear here once a promoted pattern has been used.
      </EmptyState>
    );
  }

  return (
    <>
      <Card label={`Re-check accuracy · limit ${percent(threshold)}`}>
        <table className="table">
          <tbody>
            {drift.data.patterns.map((row) => (
              <tr key={row.pattern_id}>
                <td className="mono">{row.pattern_id}</td>
                <td style={{ width: 240 }}>
                  <ProbabilityBar
                    value={row.accuracy ?? 0}
                    suggested={(row.accuracy ?? 1) < threshold}
                  />
                </td>
                <td className="mono">
                  {percent(row.accuracy, 0)} of {row.rechecks}
                </td>
                <td>
                  {(row.accuracy ?? 1) < threshold ? (
                    <span className="chip chip-drift">below limit</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card label="Drift alerts">
        {drift.data.alerts.length === 0 ? (
          <span className="muted">No drift alert.</span>
        ) : (
          <div className="stack">
            {drift.data.alerts.map((alert) => (
              <div key={alert.id} className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <span className="mono">{alert.pattern_id}</span>{' '}
                  <span className="chip">{alert.status}</span>
                  <div className="muted">{alert.message}</div>
                </div>
                {alert.status === 'active' ? (
                  <div className="row">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void setStatus(alert.id, 'acknowledged')}
                    >
                      Acknowledge
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void setStatus(alert.id, 'resolved')}
                    >
                      Resolved
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {active.length > 0 ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            A disabled pattern stays off until you switch it on from the Patterns page.
          </p>
        ) : null}
      </Card>
    </>
  );
}
