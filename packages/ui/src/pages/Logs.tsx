import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type Decision, type DecisionPath } from '../api';
import { DecisionDrawer, DecisionTable } from '../components/DecisionTable';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { SegmentedControl } from '../components/SegmentedControl';
import { useApi } from '../useApi';

type PathFilter = 'all' | DecisionPath;

export const PAGE_SIZE = 50;

/** The ISO range that covers one local calendar day, end exclusive. */
export function dayRange(day: string): { from: string; to: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) return null;
  const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function Logs() {
  const [params, setParams] = useSearchParams();
  const day = params.get('day') ?? '';
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [path, setPath] = useState<PathFilter>('all');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<Decision | null>(null);

  const range = day === '' ? null : dayRange(day);

  const filters = (): Record<string, string | number> => {
    const result: Record<string, string | number> = { limit: PAGE_SIZE, offset: page * PAGE_SIZE };
    if (query !== '') result.q = query;
    if (path !== 'all') result.path = path;
    if (range !== null) {
      result.from = range.from;
      result.to = range.to;
    }
    return result;
  };

  const logs = useApi(() => api.decisions(filters()), [query, path, day, page]);

  const exportHref = (() => {
    const parts: string[] = [];
    if (query !== '') parts.push(`q=${encodeURIComponent(query)}`);
    if (range !== null)
      parts.push(`from=${encodeURIComponent(range.from)}`, `to=${encodeURIComponent(range.to)}`);
    return `/api/export/decisions.csv${parts.length ? `?${parts.join('&')}` : ''}`;
  })();

  const submit = () => {
    setPage(0);
    setQuery(search.trim());
  };

  return (
    <div className="page">
      <div className="row">
        <input
          type="text"
          aria-label="Search"
          placeholder="Search the question or the answer"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
          style={{ maxWidth: 360 }}
        />
        <button type="button" className="btn" onClick={submit}>
          Search
        </button>
        <SegmentedControl<PathFilter>
          label="Path"
          value={path}
          onChange={(value) => {
            setPage(0);
            setPath(value);
          }}
          options={[
            { value: 'all', label: 'All' },
            { value: 'memory', label: 'Memory' },
            { value: 'pattern', label: 'Pattern' },
            { value: 'check', label: 'Check' },
            { value: 'ai', label: 'Model' },
            { value: 'human', label: 'Person' },
          ]}
        />
        {day !== '' ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setPage(0);
              setParams({});
            }}
          >
            Day {day} ×
          </button>
        ) : null}
        <a className="btn" style={{ textDecoration: 'none' }} href={exportHref} download>
          Export CSV
        </a>
      </div>
      {logs.error !== null ? <ErrorNote message={logs.error} /> : null}
      {logs.data !== null && logs.data.items.length === 0 ? (
        <EmptyState title="No decisions match">
          Decisions appear here as they are made. Clear the search or the filters to see more.
        </EmptyState>
      ) : null}
      {logs.data !== null && logs.data.items.length > 0 ? (
        <>
          <DecisionTable rows={logs.data.items} onOpen={setOpen} />
          <div className="row">
            <button
              type="button"
              className="btn"
              disabled={page === 0}
              onClick={() => setPage((value) => value - 1)}
            >
              Newer
            </button>
            <span className="mono muted">
              {page * PAGE_SIZE + 1}–{page * PAGE_SIZE + logs.data.items.length} of{' '}
              {logs.data.total}
            </span>
            <button
              type="button"
              className="btn"
              disabled={(page + 1) * PAGE_SIZE >= logs.data.total}
              onClick={() => setPage((value) => value + 1)}
            >
              Older
            </button>
          </div>
        </>
      ) : null}
      <DecisionDrawer decision={open} onClose={() => setOpen(null)} />
    </div>
  );
}
