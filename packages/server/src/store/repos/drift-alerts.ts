import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { DriftAlert, DriftAlertFilter, InsertDriftAlert } from '../types.js';

export class DriftAlertRepo {
  constructor(private readonly db: Database.Database) {}

  create(data: InsertDriftAlert): DriftAlert {
    const id = data.id ?? randomUUID();
    const createdAt = data.created_at ?? new Date().toISOString();
    const status = data.status ?? 'active';

    this.db
      .prepare(
        `INSERT INTO drift_alerts (
          id, pattern_id, sample_count, agreed_count, disagreed_count,
          accuracy, threshold, status, message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.pattern_id,
        data.sample_count,
        data.agreed_count,
        data.disagreed_count,
        data.accuracy,
        data.threshold,
        status,
        data.message,
        createdAt,
      );

    return {
      id,
      pattern_id: data.pattern_id,
      sample_count: data.sample_count,
      agreed_count: data.agreed_count,
      disagreed_count: data.disagreed_count,
      accuracy: data.accuracy,
      threshold: data.threshold,
      status,
      message: data.message,
      created_at: createdAt,
    };
  }

  getById(id: string): DriftAlert | null {
    const row = this.db.prepare('SELECT * FROM drift_alerts WHERE id = ?').get(id) as
      DriftAlert | undefined;
    return row ?? null;
  }

  /** Returns the most recent active drift alert for a pattern, or null if none. */
  getActiveByPatternId(patternId: string): DriftAlert | null {
    const row = this.db
      .prepare(
        `SELECT * FROM drift_alerts
         WHERE pattern_id = ? AND status = 'active'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(patternId) as DriftAlert | undefined;
    return row ?? null;
  }

  list(filter: DriftAlertFilter = {}): DriftAlert[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.pattern_id !== undefined) {
      conditions.push('pattern_id = ?');
      params.push(filter.pattern_id);
    }
    if (filter.status !== undefined) {
      conditions.push('status = ?');
      params.push(filter.status);
    }

    let query = 'SELECT * FROM drift_alerts';
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

    return this.db.prepare(query).all(...params) as DriftAlert[];
  }
}
