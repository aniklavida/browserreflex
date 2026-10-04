import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Decision } from '../api';
import { Card } from '../components/Card';
import { Confidence } from '../components/Confidence';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { PathBadge } from '../components/PathBadge';
import { useToast } from '../components/Toast';
import { useApi } from '../useApi';

/** The values a check question can take. Other types take typed text. */
const CHECK_VALUES = ['true', 'false'] as const;

export function Review() {
  const reviews = useApi(() => api.reviews(100));
  const notify = useToast();
  const [index, setIndex] = useState(0);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const items = (reviews.data?.items ?? []).filter((item) => !skipped.has(item.id));
  const current: Decision | undefined = items[Math.min(index, Math.max(0, items.length - 1))];

  useEffect(() => {
    setValue(current?.answer === 'pending' ? '' : (current?.answer ?? ''));
    setNote('');
  }, [current?.id, current?.answer]);

  const accept = useCallback(
    async (chosen: string) => {
      if (current === undefined || busy || chosen.trim() === '') return;
      setBusy(true);
      try {
        const result = await api.answerReview(current.id, coerce(current, chosen), note);
        const status = result.recorded?.status ?? 'recorded';
        notify(`Answer ${String(status)}`, 'auto');
        reviews.reload();
      } catch (error) {
        notify(error instanceof ApiError ? error.message : 'Could not save the answer', 'human');
      } finally {
        setBusy(false);
      }
    },
    [current, busy, note, notify, reviews],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target !== null && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.key === 'j') setIndex((i) => Math.min(i + 1, items.length - 1));
      if (event.key === 'k') setIndex((i) => Math.max(i - 1, 0));
      if (event.key === 's' && current !== undefined) {
        setSkipped((previous) => new Set(previous).add(current.id));
      }
      if (current?.decision_type === 'check') {
        if (event.key === '1') void accept('true');
        if (event.key === '2') void accept('false');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [accept, current, items.length]);

  if (reviews.error !== null) {
    return (
      <div className="page">
        <ErrorNote message={reviews.error} />
      </div>
    );
  }
  if (reviews.data === null) {
    return <div className="page muted">Loading…</div>;
  }
  if (items.length === 0) {
    return (
      <div className="page">
        <EmptyState title="Nothing to review">
          Answers that fall below your confidence thresholds, and the small share BrowserReflex
          re-checks, wait here. Ask your agent to work a browser task and come back.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="muted mono">
        {reviews.data.total} waiting · J / K move · S skip · 1 / 2 answer a yes-no question
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '280px minmax(0, 1fr)', gap: 20 }}>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, border: '1.5px solid var(--line)' }}>
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="btn"
                aria-current={item.id === current?.id}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  border: 0,
                  borderBottom: '1px solid var(--hair)',
                  ...(item.id === current?.id
                    ? { background: 'var(--ink)', color: 'var(--bg)' }
                    : {}),
                }}
                onClick={() => setIndex(items.indexOf(item))}
              >
                {item.question}
              </button>
            </li>
          ))}
        </ul>
        {current !== undefined ? (
          <Card>
            <div className="row">
              <span className="chip">{current.decision_type}</span>
              <PathBadge path={current.path} />
              <Confidence value={current.confidence} path={current.path} />
              {current.is_safety ? <span className="chip chip-drift">safety</span> : null}
            </div>
            <h2 style={{ fontSize: 22, margin: '12px 0' }}>{current.question}</h2>
            <div className="muted">
              {current.answer === 'pending'
                ? 'No answer was recorded yet.'
                : `Recorded answer: ${current.answer}`}
              {current.domain ? ` · ${current.domain}` : ''}
            </div>
            {current.context ? <div className="codeblock">{current.context}</div> : null}
            <div className="stack" style={{ marginTop: 14 }}>
              {current.decision_type === 'check' ? (
                <div className="row">
                  {CHECK_VALUES.map((option, position) => (
                    <button
                      key={option}
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => void accept(option)}
                    >
                      {position + 1} · {option === 'true' ? 'Yes' : 'No'}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="row">
                  <input
                    type={current.decision_type === 'score' ? 'number' : 'text'}
                    aria-label="Correct value"
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    style={{ maxWidth: 320 }}
                  />
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy || value.trim() === ''}
                    onClick={() => void accept(value)}
                  >
                    Accept
                  </button>
                </div>
              )}
              <input
                type="text"
                aria-label="Note"
                placeholder="Note (optional)"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <button
                type="button"
                className="btn"
                onClick={() => setSkipped((previous) => new Set(previous).add(current.id))}
              >
                Skip · S
              </button>
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

/** The value sent to the API, in the type the decision holds. */
export function coerce(decision: Decision, chosen: string): string | number | boolean {
  if (decision.decision_type === 'check') return chosen === 'true';
  if (decision.decision_type === 'score') return Number(chosen);
  return chosen;
}
