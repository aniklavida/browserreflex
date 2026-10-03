import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { InsertPattern, Pattern, PatternFilter, UpdatePattern } from '../types.js';

export class PatternRepo {
  constructor(private readonly db: Database.Database) {}

  create(data: InsertPattern): Pattern {
    const id = data.id ?? randomUUID();
    const now = new Date().toISOString();
    const createdAt = data.created_at ?? now;
    const updatedAt = data.updated_at ?? now;
    const packId = data.pack_id ?? null;
    const domain = data.domain ?? null;
    const urlPattern = data.url_pattern ?? null;
    const selector = data.selector ?? null;
    const status = data.status ?? 'candidate';
    const confidence = data.confidence ?? 0.0;
    const isSafety =
      typeof data.is_safety === 'boolean' ? (data.is_safety ? 1 : 0) : (data.is_safety ?? 0);

    const stmt = this.db.prepare(`
      INSERT INTO patterns (
        id, pack_id, name, domain, url_pattern, selector,
        decision_type, rules, status, confidence, is_safety,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      packId,
      data.name,
      domain,
      urlPattern,
      selector,
      data.decision_type,
      data.rules,
      status,
      confidence,
      isSafety,
      createdAt,
      updatedAt,
    );

    return {
      id,
      pack_id: packId,
      name: data.name,
      domain,
      url_pattern: urlPattern,
      selector,
      decision_type: data.decision_type,
      rules: data.rules,
      status,
      confidence,
      is_safety: isSafety,
      created_at: createdAt,
      updated_at: updatedAt,
    };
  }

  getById(id: string): Pattern | null {
    const stmt = this.db.prepare('SELECT * FROM patterns WHERE id = ?');
    const row = stmt.get(id) as Pattern | undefined;
    return row ?? null;
  }

  list(filter: PatternFilter = {}): Pattern[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.pack_id !== undefined) {
      conditions.push('pack_id = ?');
      params.push(filter.pack_id);
    }
    if (filter.domain !== undefined) {
      conditions.push('domain = ?');
      params.push(filter.domain);
    }
    if (filter.status !== undefined) {
      conditions.push('status = ?');
      params.push(filter.status);
    }
    if (filter.decision_type !== undefined) {
      conditions.push('decision_type = ?');
      params.push(filter.decision_type);
    }
    if (filter.is_safety !== undefined) {
      conditions.push('is_safety = ?');
      params.push(filter.is_safety ? 1 : 0);
    }

    let query = 'SELECT * FROM patterns';
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

    return this.db.prepare(query).all(...params) as Pattern[];
  }

  update(id: string, updates: UpdatePattern): Pattern | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const updatedAt = updates.updated_at ?? new Date().toISOString();
    const name = updates.name ?? existing.name;
    const domain = updates.domain !== undefined ? updates.domain : existing.domain;
    const urlPattern =
      updates.url_pattern !== undefined ? updates.url_pattern : existing.url_pattern;
    const selector = updates.selector !== undefined ? updates.selector : existing.selector;
    const decisionType = updates.decision_type ?? existing.decision_type;
    const rules = updates.rules ?? existing.rules;
    const status = updates.status ?? existing.status;
    const confidence = updates.confidence !== undefined ? updates.confidence : existing.confidence;
    const isSafety =
      updates.is_safety !== undefined
        ? typeof updates.is_safety === 'boolean'
          ? updates.is_safety
            ? 1
            : 0
          : updates.is_safety
        : existing.is_safety;

    const stmt = this.db.prepare(`
      UPDATE patterns
      SET name = ?, domain = ?, url_pattern = ?, selector = ?,
          decision_type = ?, rules = ?, status = ?, confidence = ?,
          is_safety = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      name,
      domain,
      urlPattern,
      selector,
      decisionType,
      rules,
      status,
      confidence,
      isSafety,
      updatedAt,
      id,
    );

    return {
      id,
      pack_id: existing.pack_id,
      name,
      domain,
      url_pattern: urlPattern,
      selector,
      decision_type: decisionType,
      rules,
      status,
      confidence,
      is_safety: isSafety,
      created_at: existing.created_at,
      updated_at: updatedAt,
    };
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM patterns WHERE id = ?').run(id);
    return result.changes > 0;
  }
}
