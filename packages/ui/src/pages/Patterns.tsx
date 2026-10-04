import { useState } from 'react';
import { api, ApiError, type Pattern, type PatternStat } from '../api';
import { Card } from '../components/Card';
import { Drawer } from '../components/Drawer';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { ProbabilityBar } from '../components/ProbabilityBar';
import { SegmentedControl } from '../components/SegmentedControl';
import { TableRow } from '../components/TableRow';
import { useToast } from '../components/Toast';
import { percent, shortTime } from '../format';
import { useApi } from '../useApi';
import { isLearned } from './Learned';

type Filter = 'all' | 'active' | 'shadow' | 'disabled' | 'safety';

export const PROMOTE_SAMPLES = 20;
export const PROMOTE_AGREEMENT = 0.95;

export function kindOf(pattern: Pattern): 'learned' | 'pack rule' {
  return isLearned(pattern) ? 'learned' : 'pack rule';
}

export function accuracyOf(stat: PatternStat | undefined): number | null {
  if (stat === undefined || stat.sample_count === 0) return null;
  return stat.agreed_count / stat.sample_count;
}

export function applyFilter(patterns: readonly Pattern[], filter: Filter): Pattern[] {
  if (filter === 'all') return [...patterns];
  if (filter === 'safety') return patterns.filter((pattern) => pattern.is_safety);
  return patterns.filter((pattern) => pattern.status === filter);
}

export function Patterns() {
  const patterns = useApi(() => api.patterns());
  const stats = useApi(() => api.patternStats());
  const notify = useToast();
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

  const byId = new Map((stats.data?.items ?? []).map((stat) => [stat.pattern_id, stat]));
  const rows = applyFilter(patterns.data.items, filter);

  const toggle = async (pattern: Pattern, status: 'active' | 'disabled') => {
    try {
      const result = await api.setPattern(pattern.id, status);
      setOpen(result.pattern);
      notify(status === 'active' ? 'Pattern switched on' : 'Pattern switched off', 'auto');
      patterns.reload();
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'Could not switch the pattern', 'human');
    }
  };

  return (
    <div className="page">
      <Card>
        <span className="muted">
          A shadow pattern runs silently and is promoted at {PROMOTE_SAMPLES} samples and{' '}
          {percent(PROMOTE_AGREEMENT)} agreement (50 samples and 99% for safety related ones). A
          promoted pattern is re-checked and disabled if its re-checks fall under 90%.
        </span>
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
          { value: 'safety', label: 'Safety' },
        ]}
      />
      {rows.length === 0 ? (
        <EmptyState title="No patterns here">
          Patterns appear after your agent has made the same kind of decision a few times, and as
          rules answer.
        </EmptyState>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Id</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Accuracy</th>
              <th>Uses</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((pattern) => {
              const stat = byId.get(pattern.id);
              const accuracy = accuracyOf(stat);
              return (
                <TableRow key={pattern.id} onOpen={() => setOpen(pattern)}>
                  <td className="mono">
                    {pattern.id}{' '}
                    {pattern.is_safety ? <span className="chip chip-drift">safety</span> : null}
                  </td>
                  <td>{kindOf(pattern)}</td>
                  <td>
                    <span className="chip">{pattern.status}</span>
                  </td>
                  <td style={{ width: 160 }}>
                    {accuracy === null ? (
                      <span className="muted">no samples</span>
                    ) : (
                      <ProbabilityBar value={accuracy} />
                    )}
                  </td>
                  <td className="mono">{stat?.sample_count ?? 0}</td>
                  <td>Open →</td>
                </TableRow>
              );
            })}
          </tbody>
        </table>
      )}
      <Drawer
        open={open !== null}
        title={open?.name ?? open?.id ?? ''}
        onClose={() => setOpen(null)}
      >
        {open !== null ? (
          <PatternDetail pattern={open} stat={byId.get(open.id)} onToggle={toggle} />
        ) : null}
      </Drawer>
    </div>
  );
}

function PatternDetail({
  pattern,
  stat,
  onToggle,
}: {
  pattern: Pattern;
  stat: PatternStat | undefined;
  onToggle: (pattern: Pattern, status: 'active' | 'disabled') => Promise<void>;
}) {
  const accuracy = accuracyOf(stat);
  const samples = stat?.sample_count ?? 0;
  return (
    <div className="stack">
      <div className="row">
        <span className="chip">{pattern.status}</span>
        <span className="chip">{kindOf(pattern)}</span>
        {pattern.is_safety ? <span className="chip chip-drift">safety</span> : null}
      </div>
      <div className="mono">{pattern.id}</div>
      <div>
        Samples {samples}
        {accuracy === null ? '' : ` · ${percent(accuracy, 1)} agree`}
      </div>
      {pattern.status === 'shadow' ? (
        <div className="empty">
          <strong>Shadow progress</strong>
          <span>
            {samples} of {PROMOTE_SAMPLES} samples · needs {percent(PROMOTE_AGREEMENT)} agreement
          </span>
          <ProbabilityBar value={Math.min(1, samples / PROMOTE_SAMPLES)} />
        </div>
      ) : null}
      <div>Updated {shortTime(pattern.updated_at)}</div>
      {isLearned(pattern) && pattern.rules ? (
        <div className="codeblock">{prettyRules(pattern.rules)}</div>
      ) : null}
      {pattern.is_safety ? (
        <div className="warn">A safety rule. It cannot be switched from this page.</div>
      ) : !isLearned(pattern) ? (
        <span className="muted">
          A rule written in a pack. Switch its pack on or off from the Packs page; a safety rule
          stays on either way.
        </span>
      ) : pattern.status === 'active' ? (
        <button type="button" className="btn" onClick={() => void onToggle(pattern, 'disabled')}>
          Disable
        </button>
      ) : pattern.status === 'disabled' ? (
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void onToggle(pattern, 'active')}
        >
          Enable
        </button>
      ) : (
        <span className="muted">A shadow candidate earns its promotion from samples.</span>
      )}
    </div>
  );
}

function prettyRules(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
