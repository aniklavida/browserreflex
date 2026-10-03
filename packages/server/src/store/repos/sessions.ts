import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { InsertSession, Session, UpdateSession } from '../types.js';

export class SessionRepo {
  constructor(private readonly db: Database.Database) {}

  create(data: InsertSession): Session {
    const id = data.id ?? randomUUID();
    const now = new Date().toISOString();
    const createdAt = data.created_at ?? now;
    const updatedAt = data.updated_at ?? now;
    const status = data.status ?? 'active';
    const metadata = data.metadata ?? null;

    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, agent_name, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, data.agent_name, status, metadata, createdAt, updatedAt);

    return {
      id,
      agent_name: data.agent_name,
      status,
      metadata,
      created_at: createdAt,
      updated_at: updatedAt,
    };
  }

  getById(id: string): Session | null {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    const row = stmt.get(id) as Session | undefined;
    return row ?? null;
  }

  list(filter: { status?: string; limit?: number; offset?: number } = {}): Session[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.status !== undefined) {
      conditions.push('status = ?');
      params.push(filter.status);
    }

    let query = 'SELECT * FROM sessions';
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

    return this.db.prepare(query).all(...params) as Session[];
  }

  update(id: string, updates: UpdateSession): Session | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const updatedAt = updates.updated_at ?? new Date().toISOString();
    const status = updates.status ?? existing.status;
    const metadata = updates.metadata !== undefined ? updates.metadata : existing.metadata;

    const stmt = this.db.prepare(`
      UPDATE sessions
      SET status = ?, metadata = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(status, metadata, updatedAt, id);

    return {
      ...existing,
      status,
      metadata,
      updated_at: updatedAt,
    };
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return result.changes > 0;
  }
}
