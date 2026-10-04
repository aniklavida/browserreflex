import type Database from 'better-sqlite3';
import type {
  CaptureSource,
  DecisionSignal,
  DecisionSignalFilter,
  SignalElementSource,
  UpsertDecisionSignal,
} from '../types.js';

const ELEMENT_SOURCES: readonly SignalElementSource[] = [
  'target',
  'first_snapshot_element',
  'none',
];
const CAPTURE_SOURCES: readonly CaptureSource[] = ['slow_path_answer', 'human_correction'];

function isElementSource(value: unknown): value is SignalElementSource {
  return typeof value === 'string' && (ELEMENT_SOURCES as readonly string[]).includes(value);
}

function isCaptureSource(value: unknown): value is CaptureSource {
  return typeof value === 'string' && (CAPTURE_SOURCES as readonly string[]).includes(value);
}

/**
 * Reads the stored tokens column back as a list.
 *
 * The column is written by this repository and only ever holds a JSON array of
 * strings. A row that does not parse is reported as an empty list rather than
 * throwing, so one unreadable row cannot take down a miner's query; an empty
 * list describes a row with no tokens, which is the truth for a row written
 * before tokens existed.
 */
function readTokens(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((token): token is string => typeof token === 'string');
  } catch {
    return [];
  }
}

function toSignalRow(row: Record<string, unknown>): DecisionSignal {
  return {
    decision_id: String(row.decision_id),
    domain: typeof row.domain === 'string' ? row.domain : null,
    path: typeof row.path === 'string' ? row.path : null,
    element_role: typeof row.element_role === 'string' ? row.element_role : null,
    element_text: typeof row.element_text === 'string' ? row.element_text : null,
    element_source: isElementSource(row.element_source) ? row.element_source : 'none',
    selector: typeof row.selector === 'string' ? row.selector : null,
    tokens: readTokens(row.tokens),
    source: isCaptureSource(row.source) ? row.source : 'slow_path_answer',
    created_at: typeof row.created_at === 'string' ? row.created_at : new Date(0).toISOString(),
  };
}

interface SignalWhere {
  readonly clause: string;
  readonly params: unknown[];
}

/**
 * Builds the WHERE clause the miner queries with. `domain` and `path` are the
 * two the learning loop names, and both are indexed columns.
 */
function buildWhere(filter: DecisionSignalFilter): SignalWhere {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.domain !== undefined) {
    conditions.push('domain = ?');
    params.push(filter.domain);
  }
  if (filter.path !== undefined) {
    conditions.push('path = ?');
    params.push(filter.path);
  }
  if (filter.element_role !== undefined) {
    conditions.push('element_role = ?');
    params.push(filter.element_role);
  }
  if (filter.source !== undefined) {
    conditions.push('source = ?');
    params.push(filter.source);
  }

  return { clause: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '', params };
}

/**
 * The captured signals of decisions: one row per decision, written by
 * `learning/capture.ts` when the slow path completes or a human corrects an
 * answer. Read it back with `list`, filtered by domain and path.
 */
export class SignalRepo {
  constructor(private readonly db: Database.Database) {}

  /**
   * Writes the signals of one decision, replacing any row already stored for it.
   *
   * One row per decision: a second correction to the same decision rewrites this
   * row rather than adding another, because the signals of a decision do not
   * change with the correction. The corrections themselves stay separate rows in
   * `feedback`, and `created_at` is left at the first capture so it keeps
   * meaning when these signals were captured.
   */
  upsert(data: UpsertDecisionSignal): DecisionSignal {
    const createdAt = data.created_at ?? new Date().toISOString();
    const tokens = JSON.stringify(data.tokens ?? []);

    this.db
      .prepare(
        `
        INSERT INTO decision_signals (
          decision_id, domain, path, element_role, element_text, element_source,
          selector, tokens, source, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(decision_id) DO UPDATE SET
          domain = excluded.domain,
          path = excluded.path,
          element_role = excluded.element_role,
          element_text = excluded.element_text,
          element_source = excluded.element_source,
          selector = excluded.selector,
          tokens = excluded.tokens,
          source = excluded.source
      `,
      )
      .run(
        data.decision_id,
        data.domain ?? null,
        data.path ?? null,
        data.element_role ?? null,
        data.element_text ?? null,
        data.element_source ?? 'none',
        data.selector ?? null,
        tokens,
        data.source,
        createdAt,
      );

    return this.getByDecisionId(data.decision_id)!;
  }

  getByDecisionId(decisionId: string): DecisionSignal | null {
    const stmt = this.db.prepare('SELECT * FROM decision_signals WHERE decision_id = ?');
    const row = stmt.get(decisionId) as Record<string, unknown> | undefined;
    return row === undefined ? null : toSignalRow(row);
  }

  /**
   * Lists stored signals, newest capture first, filtered by domain, path, element
   * role and source. This is the read the pattern miner uses.
   */
  list(filter: DecisionSignalFilter = {}): DecisionSignal[] {
    const { clause, params } = buildWhere(filter);

    let query = `SELECT * FROM decision_signals${clause} ORDER BY created_at DESC`;
    if (filter.limit !== undefined) {
      query += ' LIMIT ?';
      params.push(filter.limit);
      if (filter.offset !== undefined) {
        query += ' OFFSET ?';
        params.push(filter.offset);
      }
    }

    return (this.db.prepare(query).all(...params) as Record<string, unknown>[]).map(toSignalRow);
  }

  /** How many rows a filter matches, so a limited page cannot read as the whole set. */
  count(filter: DecisionSignalFilter = {}): number {
    const { clause, params } = buildWhere(filter);
    const row = this.db
      .prepare(`SELECT COUNT(*) as total FROM decision_signals${clause}`)
      .get(...params) as { total: number };
    return row.total;
  }

  delete(decisionId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM decision_signals WHERE decision_id = ?')
      .run(decisionId);
    return result.changes > 0;
  }
}
