import { useEffect, useState } from 'react';
import { api, type Decision } from '../api';
import { Card } from '../components/Card';
import { DecisionDrawer, DecisionTable } from '../components/DecisionTable';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { useApi } from '../useApi';

export const MAX_LIVE_ROWS = 200;

/** Adds a loaded decision to the end of the list, once. */
export function addTail(rows: readonly Decision[], loaded: Decision): Decision[] {
  if (rows.some((row) => row.id === loaded.id)) return [...rows];
  return [...rows, loaded].slice(0, MAX_LIVE_ROWS);
}

/** Adds a streamed decision to the front of the list, once, and keeps the list bounded. */
export function addLive(rows: readonly Decision[], incoming: Decision): Decision[] {
  if (rows.some((row) => row.id === incoming.id)) return [...rows];
  return [incoming, ...rows].slice(0, MAX_LIVE_ROWS);
}

export function Live() {
  const initial = useApi(() => api.decisions({ limit: 30 }));
  const sessions = useApi(() => api.sessions());
  const [rows, setRows] = useState<Decision[]>([]);
  const [flash, setFlash] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState<Decision | null>(null);
  const [connected, setConnected] = useState(false);
  const reloadSessions = sessions.reload;

  useEffect(() => {
    if (initial.data !== null) {
      const loaded = initial.data.items;
      // A decision streamed in before the first page arrived is kept.
      setRows((previous) => loaded.reduce((rows, row) => addTail(rows, row), previous));
    }
  }, [initial.data]);

  useEffect(() => {
    if (typeof EventSource === 'undefined') return undefined;
    const source = new EventSource('/api/stream');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener('decision', (event) => {
      try {
        const decision = JSON.parse((event as MessageEvent<string>).data) as Decision;
        setRows((previous) => addLive(previous, decision));
        setFlash(decision.id);
        reloadSessions();
      } catch {
        // A malformed event is skipped; the stream goes on.
      }
    });
    return () => source.close();
  }, [reloadSessions]);

  if (initial.error !== null) {
    return (
      <div className="page">
        <ErrorNote message={initial.error} />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="row">
        <span className={`status-box`}>
          <span className={`status-dot${connected ? '' : ' off'}`} />
          {connected ? 'Live' : 'Not connected'}
        </span>
        <span className="muted">New decisions appear here within a second of being recorded.</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '300px minmax(0, 1fr)', gap: 20 }}>
        <Card label="Sessions">
          {sessions.data === null || sessions.data.items.length === 0 ? (
            <span className="muted">No session has made a decision yet.</span>
          ) : (
            <ul className="stack" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {sessions.data.items.map((session) => (
                <li key={session.id}>
                  <strong>{session.agent_name ?? 'unknown agent'}</strong>
                  <div className="mono muted">
                    {session.decisions} decisions · {session.fast} fast
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {rows.length === 0 ? (
          <EmptyState title="Waiting for decisions">
            Ask your agent to do a browser task. Each decision it asks BrowserReflex for streams in
            here.
          </EmptyState>
        ) : (
          <DecisionTable rows={rows} onOpen={setOpen} flashId={flash} />
        )}
      </div>
      <DecisionDrawer decision={open} onClose={() => setOpen(null)} />
    </div>
  );
}
