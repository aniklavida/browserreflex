import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { InsertRecheck, Recheck, RecheckFilter } from '../types.js';

export class RecheckRepo {
  constructor(private readonly db: Database.Database) {}

  create(data: InsertRecheck): Recheck {
    const id = data.id ?? randomUUID();
    const now = new Date().toISOString();
    const createdAt = data.created_at ?? now;
    const status = data.status ?? 'pending';
    const agreed = data.agreed === true ? 1 : data.agreed === false ? 0 : null;
    const recheckAnswer = data.recheck_answer ?? null;
    const source = data.source ?? null;
    const completedAt = data.completed_at ?? null;

    this.db
      .prepare(
        `INSERT INTO rechecks (
          id, decision_id, pattern_id, pattern_answer,
          status, agreed, recheck_answer, source, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.decision_id,
        data.pattern_id,
        data.pattern_answer,
        status,
        agreed,
        recheckAnswer,
        source,
        createdAt,
        completedAt,
      );

    return {
      id,
      decision_id: data.decision_id,
      pattern_id: data.pattern_id,
      pattern_answer: data.pattern_answer,
      status,
      agreed: agreed,
      recheck_answer: recheckAnswer,
      source,
      created_at: createdAt,
      completed_at: completedAt,
    };
  }

  getById(id: string): Recheck | null {
    const row = this.db.prepare('SELECT * FROM rechecks WHERE id = ?').get(id) as
      Recheck | undefined;
    return row ?? null;
  }

  getByDecisionId(decisionId: string): Recheck | null {
    const row = this.db
      .prepare('SELECT * FROM rechecks WHERE decision_id = ? LIMIT 1')
      .get(decisionId) as Recheck | undefined;
    return row ?? null;
  }

  complete(id: string, agreed: boolean, recheckAnswer: string, source: string): Recheck | null {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE rechecks
         SET status = 'completed', agreed = ?, recheck_answer = ?, source = ?, completed_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(agreed ? 1 : 0, recheckAnswer, source, now, id);

    if (result.changes === 0) {
      return this.getById(id);
    }

    return this.getById(id);
  }

  list(filter: RecheckFilter = {}): Recheck[] {
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
    if (filter.status !== undefined) {
      conditions.push('status = ?');
      params.push(filter.status);
    }

    let query = 'SELECT * FROM rechecks';
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

    return this.db.prepare(query).all(...params) as Recheck[];
  }

  /** Returns the N most recent completed re-checks for a pattern, newest first. */
  listRecentCompleted(patternId: string, limit: number): Recheck[] {
    return this.db
      .prepare(
        `SELECT * FROM rechecks
         WHERE pattern_id = ? AND status = 'completed'
         ORDER BY completed_at DESC
         LIMIT ?`,
      )
      .all(patternId, limit) as Recheck[];
  }
}
