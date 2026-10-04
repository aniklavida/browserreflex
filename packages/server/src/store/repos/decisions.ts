import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Decision, DecisionFilter, InsertDecision, UpdateDecision } from '../types.js';

export class DecisionRepo {
  constructor(private readonly db: Database.Database) {}

  create(data: InsertDecision): Decision {
    const id = data.id ?? randomUUID();
    const createdAt = data.created_at ?? new Date().toISOString();
    const sessionId = data.session_id ?? null;
    const url = data.url ?? null;
    const domain = data.domain ?? null;
    const context = data.context ?? null;
    const inputHash = data.input_hash ?? null;
    const patternId = data.pattern_id ?? null;
    const latencyMs = data.latency_ms ?? 0;
    const isSafety =
      typeof data.is_safety === 'boolean' ? (data.is_safety ? 1 : 0) : (data.is_safety ?? 0);
    const needsReview =
      typeof data.needs_review === 'boolean'
        ? data.needs_review
          ? 1
          : 0
        : (data.needs_review ?? 0);

    const stmt = this.db.prepare(`
      INSERT INTO decisions (
        id, session_id, url, domain, decision_type, question, context,
        input_hash, answer, confidence, path, pattern_id, latency_ms,
        is_safety, needs_review, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      sessionId,
      url,
      domain,
      data.decision_type,
      data.question,
      context,
      inputHash,
      data.answer,
      data.confidence,
      data.path,
      patternId,
      latencyMs,
      isSafety,
      needsReview,
      createdAt,
    );

    return {
      id,
      session_id: sessionId,
      url,
      domain,
      decision_type: data.decision_type,
      question: data.question,
      context,
      input_hash: inputHash,
      answer: data.answer,
      confidence: data.confidence,
      path: data.path,
      pattern_id: patternId,
      latency_ms: latencyMs,
      is_safety: isSafety,
      needs_review: needsReview,
      created_at: createdAt,
    };
  }

  getById(id: string): Decision | null {
    const stmt = this.db.prepare('SELECT * FROM decisions WHERE id = ?');
    const row = stmt.get(id) as Decision | undefined;
    return row ?? null;
  }

  findByInputHash(inputHash: string): Decision | null {
    const stmt = this.db.prepare(
      'SELECT * FROM decisions WHERE input_hash = ? ORDER BY created_at DESC LIMIT 1',
    );
    const row = stmt.get(inputHash) as Decision | undefined;
    return row ?? null;
  }

  /** The WHERE clause and parameters for a filter, shared by `list` and `count`. */
  private where(filter: DecisionFilter): { clause: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.session_id !== undefined) {
      conditions.push('session_id = ?');
      params.push(filter.session_id);
    }
    if (filter.domain !== undefined) {
      conditions.push('domain = ?');
      params.push(filter.domain);
    }
    if (filter.path !== undefined) {
      conditions.push('path = ?');
      params.push(filter.path);
    }
    if (filter.needs_review !== undefined) {
      conditions.push('needs_review = ?');
      params.push(filter.needs_review ? 1 : 0);
    }
    if (filter.is_safety !== undefined) {
      conditions.push('is_safety = ?');
      params.push(filter.is_safety ? 1 : 0);
    }
    if (filter.input_hash !== undefined) {
      conditions.push('input_hash = ?');
      params.push(filter.input_hash);
    }
    if (filter.pattern_id !== undefined) {
      conditions.push('pattern_id = ?');
      params.push(filter.pattern_id);
    }
    if (filter.created_from !== undefined) {
      conditions.push('created_at >= ?');
      params.push(filter.created_from);
    }
    if (filter.created_to !== undefined) {
      conditions.push('created_at < ?');
      params.push(filter.created_to);
    }
    if (filter.search !== undefined && filter.search !== '') {
      // A literal search: the wildcard characters in the text are escaped, so a search for
      // "50%" finds "50%" and not everything.
      const like = `%${filter.search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
      conditions.push("(question LIKE ? ESCAPE '\\' OR answer LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }

    return {
      clause: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '',
      params,
    };
  }

  list(filter: DecisionFilter = {}): Decision[] {
    const { clause, params } = this.where(filter);
    let query = `SELECT * FROM decisions${clause} ORDER BY created_at DESC`;

    if (filter.limit !== undefined) {
      query += ' LIMIT ?';
      params.push(filter.limit);
      if (filter.offset !== undefined) {
        query += ' OFFSET ?';
        params.push(filter.offset);
      }
    }

    return this.db.prepare(query).all(...params) as Decision[];
  }

  count(filter: DecisionFilter = {}): number {
    const { clause, params } = this.where(filter);
    const row = this.db
      .prepare(`SELECT COUNT(*) as total FROM decisions${clause}`)
      .get(...params) as { total: number };
    return row.total;
  }

  update(id: string, updates: UpdateDecision): Decision | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const answer = updates.answer !== undefined ? updates.answer : existing.answer;
    const confidence = updates.confidence !== undefined ? updates.confidence : existing.confidence;
    const path = updates.path !== undefined ? updates.path : existing.path;
    const patternId = updates.pattern_id !== undefined ? updates.pattern_id : existing.pattern_id;
    const latencyMs = updates.latency_ms !== undefined ? updates.latency_ms : existing.latency_ms;
    const isSafety =
      updates.is_safety !== undefined
        ? typeof updates.is_safety === 'boolean'
          ? updates.is_safety
            ? 1
            : 0
          : updates.is_safety
        : existing.is_safety;
    const needsReview =
      updates.needs_review !== undefined
        ? typeof updates.needs_review === 'boolean'
          ? updates.needs_review
            ? 1
            : 0
          : updates.needs_review
        : existing.needs_review;

    const stmt = this.db.prepare(`
      UPDATE decisions
      SET answer = ?, confidence = ?, path = ?, pattern_id = ?, latency_ms = ?, is_safety = ?, needs_review = ?
      WHERE id = ?
    `);

    stmt.run(answer, confidence, path, patternId, latencyMs, isSafety, needsReview, id);

    return {
      ...existing,
      answer,
      confidence,
      path,
      pattern_id: patternId,
      latency_ms: latencyMs,
      is_safety: isSafety,
      needs_review: needsReview,
    };
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM decisions WHERE id = ?').run(id);
    return result.changes > 0;
  }
}
