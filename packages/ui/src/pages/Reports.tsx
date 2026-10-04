import { api, ApiError, type Decision } from '../api';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { MetricGrid } from '../components/MetricGrid';
import { useToast } from '../components/Toast';
import { percent } from '../format';
import { useApi } from '../useApi';

export const WEEK_DAYS = 7;

export interface WeekSummary {
  total: number;
  fast: number;
  ai: number;
  human: number;
  safety: number;
  fastShare: number | null;
}

/** Counts the decisions of the last `days` days from a list that may hold older ones. */
export function summariseWeek(
  decisions: readonly Decision[],
  now: Date = new Date(),
  days = WEEK_DAYS,
): WeekSummary {
  const cutoff = now.getTime() - days * 86_400_000;
  const week = decisions.filter((decision) => new Date(decision.created_at).getTime() >= cutoff);
  const fast = week.filter((d) => ['memory', 'pattern', 'check'].includes(d.path)).length;
  return {
    total: week.length,
    fast,
    ai: week.filter((d) => d.path === 'ai').length,
    human: week.filter((d) => d.path === 'human').length,
    safety: week.filter((d) => d.is_safety).length,
    fastShare: week.length === 0 ? null : fast / week.length,
  };
}

export function Reports() {
  const decisions = useApi(() => api.decisions({ limit: 500 }));
  const quality = useApi(() => api.quality());
  const notify = useToast();

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

  const week = summariseWeek(decisions.data.items);
  const from = new Date(Date.now() - WEEK_DAYS * 86_400_000).toISOString();

  const disable = async (id: string) => {
    try {
      await api.setPattern(id, 'disabled');
      notify('Pattern switched off', 'auto');
      quality.reload();
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'Could not switch the pattern', 'human');
    }
  };

  if (decisions.data.total === 0) {
    return (
      <div className="page">
        <EmptyState title="No report yet">
          A weekly summary appears once your agent has made decisions through BrowserReflex.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="page">
      <Card label="This week">
        <h2 style={{ margin: '0 0 8px', fontSize: 30, textTransform: 'uppercase' }}>
          {week.total} decisions, {percent(week.fastShare)} answered without a model or a person
        </h2>
        <p className="muted" style={{ margin: 0 }}>
          The last {WEEK_DAYS} days of the newest {decisions.data.items.length} decisions. A
          measurement, not a promise: it says nothing about time or tokens saved, because neither is
          measured here.
        </p>
      </Card>
      <MetricGrid
        metrics={[
          { label: 'Decisions', value: week.total },
          { label: 'Fast path', value: week.fast },
          { label: 'Model', value: week.ai },
          { label: 'Person', value: week.human },
          { label: 'Safety records', value: week.safety },
        ]}
      />
      <Card label="Patterns that were wrong most">
        {quality.data === null || quality.data.wrong_most.length === 0 ? (
          <span className="muted">
            No corrected decision names a pattern that was wrong. Corrections come from the review
            queue and from your agent&apos;s feedback.
          </span>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Pattern</th>
                <th>Wrong</th>
                <th>Corrected</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {quality.data.wrong_most.map((row) => (
                <tr key={row.pattern_id}>
                  <td className="mono">{row.pattern_id}</td>
                  <td>{row.wrong}</td>
                  <td>{row.total}</td>
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
      <Card label="Export">
        <div className="row">
          <a
            className="btn"
            style={{ textDecoration: 'none' }}
            href={`/api/export/decisions.csv?from=${encodeURIComponent(from)}`}
            download
          >
            This week as CSV
          </a>
          <a
            className="btn"
            style={{ textDecoration: 'none' }}
            href="/api/export/decisions.csv"
            download
          >
            All decisions as CSV
          </a>
          <span className="muted">PDF export is planned.</span>
        </div>
      </Card>
    </div>
  );
}
