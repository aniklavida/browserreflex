import { useState } from 'react';
import { api, type Pattern } from '../api';
import { Card } from '../components/Card';
import { Drawer } from '../components/Drawer';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { SegmentedControl } from '../components/SegmentedControl';
import { TableRow } from '../components/TableRow';
import { dayKey, shortTime } from '../format';
import { useApi } from '../useApi';

type Filter = 'all' | 'active' | 'shadow' | 'disabled';

export function filterPatterns(patterns: readonly Pattern[], filter: Filter): Pattern[] {
  const rows = filter === 'all' ? [...patterns] : patterns.filter((p) => p.status === filter);
  return rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function changedToday(pattern: Pattern, now: Date = new Date()): boolean {
  return dayKey(pattern.updated_at) === dayKey(now.toISOString());
}

export function Learned() {
  const patterns = useApi(() => api.patterns());
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<Pattern | null>(null);

  if (patterns.error !== null) {
    return (
      <div className="page">
        <ErrorNote message={patterns.error} />
      </div>
    );
  }
  if (patterns.data === null) {
    return <div className="page muted">Loading…</div>;
  }

  const rows = filterPatterns(patterns.data.items, filter);
  const today = patterns.data.items.filter((pattern) => changedToday(pattern));

  return (
    <div className="page">
      <Card label="Changed today">
        {today.length === 0 ? (
          <span className="muted">No pattern was written or changed today.</span>
        ) : (
          <ul className="stack" style={{ margin: 0, paddingLeft: 18 }}>
            {today.map((pattern) => (
              <li key={pattern.id}>
                <span className="mono">{pattern.id}</span> is {pattern.status}
              </li>
            ))}
          </ul>
        )}
        <p className="muted" style={{ marginBottom: 0 }}>
          A shadow pattern is promoted at 20 samples and 95% agreement (50 and 99% for safety
          related ones). A promoted pattern is re-checked and disabled if its re-checks fall under
          90%.
        </p>
      </Card>
      <SegmentedControl<Filter>
        label="Status"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'All' },
          { value: 'active', label: 'Active' },
          { value: 'shadow', label: 'Shadow' },
          { value: 'disabled', label: 'Disabled' },
        ]}
      />
      {rows.length === 0 ? (
        <EmptyState title="No patterns yet">
          Patterns appear after your agent has made the same kind of decision a few times. Shadow
          patterns run silently until they have earned a promotion.
        </EmptyState>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Id</th>
              <th>Type</th>
              <th>Status</th>
              <th>Confidence</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((pattern) => (
              <TableRow key={pattern.id} onOpen={() => setOpen(pattern)}>
                <td className="mono">
                  {pattern.id}{' '}
                  {pattern.is_safety ? <span className="chip chip-drift">safety</span> : null}
                </td>
                <td>{pattern.decision_type}</td>
                <td>
                  <span className="chip">{pattern.status}</span>
                </td>
                <td className="mono">{pattern.confidence?.toFixed(2) ?? '—'}</td>
                <td className="mono">{shortTime(pattern.updated_at)}</td>
              </TableRow>
            ))}
          </tbody>
        </table>
      )}
      <Drawer
        open={open !== null}
        title={open?.name ?? open?.id ?? ''}
        onClose={() => setOpen(null)}
      >
        {open !== null ? (
          <div className="stack">
            <div className="mono">{open.id}</div>
            <div>Status: {open.status}</div>
            <div>Type: {open.decision_type}</div>
            <div>Created: {shortTime(open.created_at)}</div>
            <div>Updated: {shortTime(open.updated_at)}</div>
            {open.pack_id ? (
              <div>Pack: {open.pack_id}</div>
            ) : (
              <div>Learned from your decisions</div>
            )}
            {open.is_safety ? (
              <div className="warn">A safety rule. It cannot be changed from this page.</div>
            ) : null}
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
