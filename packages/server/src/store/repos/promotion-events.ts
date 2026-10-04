import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { InsertPromotionEvent, PromotionEvent, PromotionEventFilter } from '../types.js';

export class PromotionEventRepo {
  constructor(private readonly db: Database.Database) {}

  create(data: InsertPromotionEvent): PromotionEvent {
    const id = data.id ?? randomUUID();
    const createdAt = data.created_at ?? new Date().toISOString();
    const thresholdsJson =
      typeof data.thresholds === 'string' ? data.thresholds : JSON.stringify(data.thresholds);
    const isSafety =
      typeof data.is_safety === 'boolean' ? (data.is_safety ? 1 : 0) : (data.is_safety ?? 0);

    const stmt = this.db.prepare(`
      INSERT INTO promotion_events (
        id, pattern_id, sample_count, agreement,
        threshold_samples, threshold_agreement, thresholds,
        is_safety, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.pattern_id,
      data.sample_count,
      data.agreement,
      data.threshold_samples,
      data.threshold_agreement,
      thresholdsJson,
      isSafety,
      createdAt,
    );

    return {
      id,
      pattern_id: data.pattern_id,
      sample_count: data.sample_count,
      agreement: data.agreement,
      threshold_samples: data.threshold_samples,
      threshold_agreement: data.threshold_agreement,
      thresholds: thresholdsJson,
      is_safety: isSafety,
      created_at: createdAt,
    };
  }

  getById(id: string): PromotionEvent | null {
    const row = this.db.prepare('SELECT * FROM promotion_events WHERE id = ?').get(id) as
      PromotionEvent | undefined;
    return row ?? null;
  }

  listByPatternId(patternId: string): PromotionEvent[] {
    return this.db
      .prepare('SELECT * FROM promotion_events WHERE pattern_id = ? ORDER BY created_at DESC')
      .all(patternId) as PromotionEvent[];
  }

  list(filter: PromotionEventFilter = {}): PromotionEvent[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.pattern_id !== undefined) {
      conditions.push('pattern_id = ?');
      params.push(filter.pattern_id);
    }

    let query = 'SELECT * FROM promotion_events';
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

    return this.db.prepare(query).all(...params) as PromotionEvent[];
  }
}
