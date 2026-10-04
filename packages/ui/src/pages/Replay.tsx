import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type Decision } from '../api';
import { Card } from '../components/Card';
import { Confidence } from '../components/Confidence';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { MetricGrid } from '../components/MetricGrid';
import { PathBadge } from '../components/PathBadge';
import { useToast } from '../components/Toast';
import { shortTime } from '../format';
import { useApi } from '../useApi';

const FAST = ['memory', 'pattern', 'check'];

/** The path mix of a run, in order, as a share of each path. */
export function pathMix(steps: readonly Decision[]): Record<string, number> {
  const counts: Record<string, number> = { fast: 0, ai: 0, human: 0 };
  for (const step of steps) {
    const key = FAST.includes(step.path) ? 'fast' : step.path;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function Replay() {
  const [params, setParams] = useSearchParams();
  const sessions = useApi(() => api.sessions());
  const selected = params.get('session') ?? sessions.data?.items[0]?.id ?? '';
  const steps = useApi(
    () =>
      selected === ''
        ? Promise.resolve({ items: [], total: 0, limit: 0, offset: 0 })
        : api.decisions({ session_id: selected, limit: 500 }),
    [selected],
  );
  const [index, setIndex] = useState(0);
  const notify = useToast();

  // The API lists newest first; a replay reads oldest first.
  const ordered = [...(steps.data?.items ?? [])].reverse();
  const step: Decision | undefined = ordered[Math.min(index, Math.max(0, ordered.length - 1))];

  useEffect(() => {
    setIndex(0);
  }, [selected]);

  if (sessions.error !== null) {
    return (
      <div className="page">
        <ErrorNote message={sessions.error} />
      </div>
    );
  }
  if (sessions.data !== null && sessions.data.items.length === 0) {
    return (
      <div className="page">
        <EmptyState title="No task to replay">
          A replay shows one agent session step by step. It appears after an agent has made
          decisions through BrowserReflex.
        </EmptyState>
      </div>
    );
  }

  const correct = async (value: string) => {
    if (step === undefined) return;
    try {
      await api.answerReview(step.id, step.decision_type === 'check' ? value === 'true' : value);
      notify('Correction recorded', 'auto');
      steps.reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not record the correction', 'human');
    }
  };

  const mix = pathMix(ordered);

  return (
    <div className="page">
      <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr) 310px', gap: 20 }}>
        <Card label="Tasks">
          <ul className="stack" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {sessions.data?.items.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  className="btn"
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    ...(session.id === selected
                      ? { background: 'var(--ink)', color: 'var(--bg)' }
                      : {}),
                  }}
                  onClick={() => setParams({ session: session.id })}
                >
                  {session.agent_name ?? 'unknown agent'} · {session.decisions}
                </button>
              </li>
            ))}
          </ul>
        </Card>
        <div className="stack">
          <MetricGrid
            metrics={[
              { label: 'Fast', value: mix.fast ?? 0 },
              { label: 'Model', value: mix.ai ?? 0 },
              { label: 'Person', value: mix.human ?? 0 },
            ]}
          />
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Time</th>
                <th>Answer</th>
                <th>Path</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((row, position) => (
                <tr
                  key={row.id}
                  className={row.id === step?.id ? 'selected' : undefined}
                  tabIndex={0}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setIndex(position)}
                >
                  <td className="mono">{position + 1}</td>
                  <td className="mono">{shortTime(row.created_at)}</td>
                  <td className="mono">{row.answer}</td>
                  <td>
                    <PathBadge path={row.path} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Card label={step ? `Step ${index + 1} · why` : 'Why'}>
          {step === undefined ? (
            <span className="muted">Pick a step to see why it was answered that way.</span>
          ) : (
            <div className="stack">
              <h3 style={{ margin: 0 }}>{step.question}</h3>
              <div>
                Answer <strong className="mono">{step.answer}</strong>
              </div>
              <MetricGrid
                metrics={[
                  { label: 'Path', value: step.path },
                  { label: 'Conf', value: <Confidence value={step.confidence} path={step.path} /> },
                  {
                    label: 'Latency',
                    value: step.latency_ms === null ? '—' : `${step.latency_ms} ms`,
                  },
                ]}
              />
              {step.pattern_id ? (
                <div className="mono muted">Answered by {step.pattern_id}</div>
              ) : (
                <div className="muted">Not answered by a stored rule.</div>
              )}
              <div className="card-label">Wrong? Correct it</div>
              {step.decision_type === 'check' ? (
                <div className="row">
                  <button type="button" className="btn" onClick={() => void correct('true')}>
                    → true
                  </button>
                  <button type="button" className="btn" onClick={() => void correct('false')}>
                    → false
                  </button>
                </div>
              ) : (
                <span className="muted">
                  Correct a choice or a score from the review queue, which takes a typed value.
                </span>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
