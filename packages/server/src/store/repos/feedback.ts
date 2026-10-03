import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Feedback, InsertFeedback } from '../types.js';

export class FeedbackRepo {
  constructor(private readonly db: Database.Database) {}

  create(data: InsertFeedback): Feedback {
    const id = data.id ?? randomUUID();
    const createdAt = data.created_at ?? new Date().toISOString();
    const note = data.note ?? null;
    const source = data.source ?? 'human';

    const stmt = this.db.prepare(`
      INSERT INTO feedback (id, decision_id, correct_value, note, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, data.decision_id, data.correct_value, note, source, createdAt);

    return {
      id,
      decision_id: data.decision_id,
      correct_value: data.correct_value,
      note,
      source,
      created_at: createdAt,
    };
  }

  getById(id: string): Feedback | null {
    const stmt = this.db.prepare('SELECT * FROM feedback WHERE id = ?');
    const row = stmt.get(id) as Feedback | undefined;
    return row ?? null;
  }

  getByDecisionId(decisionId: string): Feedback[] {
    const stmt = this.db.prepare(
      'SELECT * FROM feedback WHERE decision_id = ? ORDER BY created_at DESC',
    );
    return stmt.all(decisionId) as Feedback[];
  }

  list(filter: { limit?: number; offset?: number } = {}): Feedback[] {
    let query = 'SELECT * FROM feedback ORDER BY created_at DESC';
    const params: unknown[] = [];

    if (filter.limit !== undefined) {
      query += ' LIMIT ?';
      params.push(filter.limit);
      if (filter.offset !== undefined) {
        query += ' OFFSET ?';
        params.push(filter.offset);
      }
    }

    return this.db.prepare(query).all(...params) as Feedback[];
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM feedback WHERE id = ?').run(id);
    return result.changes > 0;
  }
}
