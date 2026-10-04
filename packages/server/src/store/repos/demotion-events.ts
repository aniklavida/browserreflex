import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { DemotionEvent, DemotionEventFilter, InsertDemotionEvent } from '../types.js';

export class DemotionEventRepo {
  constructor(private readonly db: Database.Database) {}

  create(data: InsertDemotionEvent): DemotionEvent {
    const id = data.id ?? randomUUID();
    const createdAt = data.created_at ?? new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO demotion_events (
          id, pattern_id, sample_count, agreed_count, disagreed_count,
          accuracy, threshold, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.pattern_id,
        data.sample_count,
        data.agreed_count,
        data.disagreed_count,
        data.accuracy,
        data.threshold,
        data.reason,
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
      reason: data.reason,
      created_at: createdAt,
    };
  }

  getById(id: string): DemotionEvent | null {
    const row = this.db.prepare('SELECT * FROM demotion_events WHERE id = ?').get(id) as
      DemotionEvent | undefined;
    return row ?? null;
  }

  list(filter: DemotionEventFilter = {}): DemotionEvent[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.pattern_id !== undefined) {
      conditions.push('pattern_id = ?');
      params.push(filter.pattern_id);
    }

    let query = 'SELECT * FROM demotion_events';
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

    return this.db.prepare(query).all(...params) as DemotionEvent[];
  }
}
