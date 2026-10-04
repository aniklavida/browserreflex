import { Link } from 'react-router-dom';
import { api, type Decision } from '../api';
import { Card } from '../components/Card';
import { Confidence } from '../components/Confidence';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { MetricGrid } from '../components/MetricGrid';
import { PathBadge } from '../components/PathBadge';
import { percent, shortTime } from '../format';
import { useApi } from '../useApi';

const TRY_PROMPTS = [
  'Open the checkout page and tell me which button places the order, but ask me before you click it.',
  'Go to this site and dismiss the cookie banner, then tell me what kind of popup it was.',
  'Search for the login form on this page and tell me whether a login wall is in the way.',
] as const;

export function Dashboard() {
  const stats = useApi(() => api.stats());
  const recent = useApi(() => api.decisions({ limit: 6 }));

  if (stats.error !== null) {
    return (
      <div className="page">
        <ErrorNote message={stats.error} />
      </div>
    );
  }
  if (stats.data === null) {
    return <div className="page muted">Loading…</div>;
  }

  const { decisions, patterns, drift_alerts: drift } = stats.data;

  if (decisions.total === 0) {
    return (
      <div className="page">
        <div className="cols-2">
          <Card label="Day one">
            <h2 style={{ margin: '0 0 8px', textTransform: 'uppercase' }}>
              Waiting for your first decision
            </h2>
            <ol className="stack muted">
              <li>Run the setup wizard so your agent knows about BrowserReflex.</li>
              <li>Ask your agent to do a browser task that has a popup, a login or a payment.</li>
              <li>Come back here: each answer it asks BrowserReflex for appears on this page.</li>
            </ol>
            <Link to="/setup" className="btn btn-primary" style={{ textDecoration: 'none' }}>
              Run setup
            </Link>
          </Card>
          <Card label="Try this in your agent">
            <div className="stack">
              {TRY_PROMPTS.map((prompt) => (
                <div className="codeblock" key={prompt} style={{ whiteSpace: 'pre-wrap' }}>
                  {prompt}
                </div>
              ))}
              <span className="muted">
                Nothing has been measured yet. These numbers fill in as your agent uses the tools.
              </span>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      {drift !== undefined && drift.active > 0 ? (
        <div className="warn row" role="alert" style={{ justifyContent: 'space-between' }}>
          <span>
            <strong>Drift alert.</strong> {drift.active} learned pattern
            {drift.active === 1 ? ' was' : 's were'} disabled after its re-checks fell under 90%.
          </span>
          <Link to="/learned" className="btn" style={{ textDecoration: 'none' }}>
            Inspect
          </Link>
        </div>
      ) : null}
      <div className="cols-hero">
        <Card label="Fast-path share, all recorded decisions">
          <div className="hero-number">{percent(decisions.fast_path_share)}</div>
          <p className="muted">
            {decisions.fast} of {decisions.total} answers came from memory, a pattern or a direct
            check. A measurement of this log, not a promise.
          </p>
        </Card>
        <div className="stack">
          <Card label="Needs review">
            <div className="card-value" style={{ color: 'var(--aiT)' }}>
              {decisions.pending_review}
            </div>
            <Link to="/review" className="btn btn-primary" style={{ textDecoration: 'none' }}>
              Start review
            </Link>
          </Card>
          <Card label="Safety records" safety>
            <div className="card-value">{decisions.safety_stops}</div>
            <span className="muted">
              Decisions a safety rule flagged. The safety check is advisory: these are records of
              requests to you, not blocks.
            </span>
          </Card>
        </div>
      </div>
      <MetricGrid
        metrics={[
          { label: 'Decisions', value: decisions.total },
          { label: 'Answered by a model', value: decisions.ai },
          { label: 'Answered by a person', value: decisions.human },
          { label: 'Active patterns', value: patterns.active, note: `${patterns.total} stored` },
        ]}
      />
      <Card label="Recent decisions">
        {recent.error !== null ? <ErrorNote message={recent.error} /> : null}
        {recent.data !== null && recent.data.items.length === 0 ? (
          <EmptyState title="No decisions yet">Decisions appear here as they are made.</EmptyState>
        ) : null}
        {recent.data !== null && recent.data.items.length > 0 ? (
          <RecentTable rows={recent.data.items} />
        ) : null}
      </Card>
    </div>
  );
}

function RecentTable({ rows }: { rows: Decision[] }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Question</th>
          <th>Answer</th>
          <th>Path</th>
          <th>Conf</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td className="mono">{shortTime(row.created_at)}</td>
            <td>{row.question}</td>
            <td className="mono">{row.answer}</td>
            <td>
              <PathBadge path={row.path} />
            </td>
            <td>
              <Confidence value={row.confidence} path={row.path} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
