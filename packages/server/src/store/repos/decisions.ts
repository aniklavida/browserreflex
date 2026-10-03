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

  list(filter: DecisionFilter = {}): Decision[] {
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

    let query = 'SELECT * FROM decisions';
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

    return this.db.prepare(query).all(...params) as Decision[];
  }

  count(filter: DecisionFilter = {}): number {
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

    let query = 'SELECT COUNT(*) as total FROM decisions';
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    const row = this.db.prepare(query).get(...params) as { total: number };
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
