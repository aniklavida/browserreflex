import type Database from 'better-sqlite3';
import type { RecordShadowSampleResult, ShadowSample, ShadowSampleFilter } from '../types.js';

/**
 * Repository for shadow test samples.
 *
 * Records which shadow candidates were compared against which decisions and
 * whether their answers agreed, alongside atomic updates to candidate pattern statistics.
 */
export class ShadowSampleRepo {
  constructor(private readonly db: Database.Database) {}

  /**
   * Records one shadow comparison sample and updates pattern_stats in one atomic transaction.
   * If the (decision_id, pattern_id) pair was already evaluated, this operation is a no-op
   * and returns { recorded: false, sample: existing }.
   */
  recordSample(data: {
    decision_id: string;
    pattern_id: string;
    source: 'slow_answer' | 'feedback';
    agreed: boolean;
    created_at?: string;
  }): RecordShadowSampleResult {
    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM shadow_samples WHERE decision_id = ? AND pattern_id = ?')
        .get(data.decision_id, data.pattern_id) as ShadowSample | undefined;

      if (existing) {
        return {
          recorded: false,
          sample: existing,
        };
      }

      const createdAt = data.created_at ?? new Date().toISOString();
      const agreedInt = data.agreed ? 1 : 0;
      const disagreedInt = data.agreed ? 0 : 1;

      this.db
        .prepare(
          `INSERT INTO shadow_samples (decision_id, pattern_id, source, agreed, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(data.decision_id, data.pattern_id, data.source, agreedInt, createdAt);

      this.db
        .prepare(
          `INSERT INTO pattern_stats (
             pattern_id, sample_count, agreed_count, disagreed_count, last_evaluated_at, updated_at
           ) VALUES (?, 1, ?, ?, ?, ?)
           ON CONFLICT(pattern_id) DO UPDATE SET
             sample_count = sample_count + 1,
             agreed_count = agreed_count + excluded.agreed_count,
             disagreed_count = disagreed_count + excluded.disagreed_count,
             last_evaluated_at = excluded.last_evaluated_at,
             updated_at = excluded.updated_at`,
        )
        .run(data.pattern_id, agreedInt, disagreedInt, createdAt, createdAt);

      const sample: ShadowSample = {
        decision_id: data.decision_id,
        pattern_id: data.pattern_id,
        source: data.source,
        agreed: agreedInt,
        created_at: createdAt,
      };

      return {
        recorded: true,
        sample,
      };
    });

    return tx();
  }

  getByPair(decisionId: string, patternId: string): ShadowSample | null {
    const row = this.db
      .prepare('SELECT * FROM shadow_samples WHERE decision_id = ? AND pattern_id = ?')
      .get(decisionId, patternId) as ShadowSample | undefined;
    return row ?? null;
  }

  listByPatternId(patternId: string): ShadowSample[] {
    return this.db
      .prepare('SELECT * FROM shadow_samples WHERE pattern_id = ? ORDER BY created_at DESC')
      .all(patternId) as ShadowSample[];
  }

  listByDecisionId(decisionId: string): ShadowSample[] {
    return this.db
      .prepare('SELECT * FROM shadow_samples WHERE decision_id = ? ORDER BY created_at DESC')
      .all(decisionId) as ShadowSample[];
  }

  list(filter: ShadowSampleFilter = {}): ShadowSample[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.pattern_id !== undefined) {
      conditions.push('pattern_id = ?');
      params.push(filter.pattern_id);
    }
    if (filter.decision_id !== undefined) {
      conditions.push('decision_id = ?');
      params.push(filter.decision_id);
    }
    if (filter.source !== undefined) {
      conditions.push('source = ?');
      params.push(filter.source);
    }

    let query = 'SELECT * FROM shadow_samples';
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ' ORDER BY created_at DESC';

    if (filter.limit !== undefined) {
      query += ' LIMIT ?';
      params.push(filter.limit);
      if (filter.offset !== undefined) {
        query += ' OFFSET ?';
        params.push(filter.offset);
      }
    }

    return this.db.prepare(query).all(...params) as ShadowSample[];
  }

  count(filter: ShadowSampleFilter = {}): number {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.pattern_id !== undefined) {
      conditions.push('pattern_id = ?');
      params.push(filter.pattern_id);
    }
    if (filter.decision_id !== undefined) {
      conditions.push('decision_id = ?');
      params.push(filter.decision_id);
    }
    if (filter.source !== undefined) {
      conditions.push('source = ?');
      params.push(filter.source);
    }

    let query = 'SELECT COUNT(*) as total FROM shadow_samples';
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    const row = this.db.prepare(query).get(...params) as { total: number };
    return row.total;
  }

  deleteByDecisionId(decisionId: string): boolean {
    const res = this.db.prepare('DELETE FROM shadow_samples WHERE decision_id = ?').run(decisionId);
    return res.changes > 0;
  }

  deleteByPatternId(patternId: string): boolean {
    const res = this.db.prepare('DELETE FROM shadow_samples WHERE pattern_id = ?').run(patternId);
    return res.changes > 0;
  }
}
