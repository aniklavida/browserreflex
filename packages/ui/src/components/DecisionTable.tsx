import { Link } from 'react-router-dom';
import type { Decision } from '../api';
import { shortTime } from '../format';
import { Confidence } from './Confidence';
import { Drawer } from './Drawer';
import { PathBadge, toneForPath } from './PathBadge';
import { TableRow } from './TableRow';

export function DecisionTable({
  rows,
  onOpen,
  selectedId,
  flashId,
}: {
  rows: readonly Decision[];
  onOpen: (decision: Decision) => void;
  selectedId?: string | undefined;
  flashId?: string | undefined;
}) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Type</th>
          <th>Question</th>
          <th>Answer</th>
          <th>Path</th>
          <th>Conf</th>
          <th>Latency</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <TableRow
            key={row.id}
            selected={row.id === selectedId || row.id === flashId}
            onOpen={() => onOpen(row)}
          >
            <td className="mono">{shortTime(row.created_at)}</td>
            <td>{row.decision_type}</td>
            <td>
              {row.question}{' '}
              {row.is_safety ? <span className="chip chip-drift">safety</span> : null}
            </td>
            <td className="mono">{row.answer}</td>
            <td>
              <PathBadge path={row.path} />
            </td>
            <td>
              <Confidence value={row.confidence} path={row.path} />
            </td>
            <td className="mono">{row.latency_ms === null ? '—' : `${row.latency_ms} ms`}</td>
          </TableRow>
        ))}
      </tbody>
    </table>
  );
}

/** The detail of one decision: the question, the answer in its tone, and the record itself. */
export function DecisionDrawer({
  decision,
  onClose,
}: {
  decision: Decision | null;
  onClose: () => void;
}) {
  return (
    <Drawer open={decision !== null} title="Decision" onClose={onClose}>
      {decision !== null ? (
        <div className="stack">
          <div className="row">
            <PathBadge path={decision.path} />
            <Confidence value={decision.confidence} path={decision.path} />
          </div>
          <h3 style={{ margin: 0 }}>{decision.question}</h3>
          <div className={`tone-${toneForPath(decision.path)}`}>
            Answer: <strong style={{ color: 'var(--toneT)' }}>{decision.answer}</strong>
          </div>
          {decision.pattern_id ? (
            <div className="mono muted">Answered by {decision.pattern_id}</div>
          ) : null}
          <div className="codeblock">{JSON.stringify(decision, null, 2)}</div>
          {decision.session_id ? (
            <Link
              className="btn"
              style={{ textDecoration: 'none', width: 'fit-content' }}
              to={`/replay?session=${encodeURIComponent(decision.session_id)}`}
            >
              Open in task replay
            </Link>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}
