import type Database from 'better-sqlite3';
import type { InsertPack, Pack, UpdatePack } from '../types.js';

export class PackRepo {
  constructor(private readonly db: Database.Database) {}

  create(data: InsertPack): Pack {
    const now = new Date().toISOString();
    const createdAt = data.created_at ?? now;
    const updatedAt = data.updated_at ?? now;
    const description = data.description ?? null;
    const signature = data.signature ?? null;
    const isActive =
      typeof data.is_active === 'boolean' ? (data.is_active ? 1 : 0) : (data.is_active ?? 1);

    const stmt = this.db.prepare(`
      INSERT INTO packs (id, name, version, description, is_active, signature, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      data.id,
      data.name,
      data.version,
      description,
      isActive,
      signature,
      createdAt,
      updatedAt,
    );

    return {
      id: data.id,
      name: data.name,
      version: data.version,
      description,
      is_active: isActive,
      signature,
      created_at: createdAt,
      updated_at: updatedAt,
    };
  }

  getById(id: string): Pack | null {
    const stmt = this.db.prepare('SELECT * FROM packs WHERE id = ?');
    const row = stmt.get(id) as Pack | undefined;
    return row ?? null;
  }

  list(filter: { activeOnly?: boolean; limit?: number; offset?: number } = {}): Pack[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.activeOnly) {
      conditions.push('is_active = 1');
    }

    let query = 'SELECT * FROM packs';
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ' ORDER BY name ASC';

    if (filter.limit !== undefined) {
      query += ' LIMIT ?';
      params.push(filter.limit);
      if (filter.offset !== undefined) {
        query += ' OFFSET ?';
        params.push(filter.offset);
      }
    }

    return this.db.prepare(query).all(...params) as Pack[];
  }

  update(id: string, updates: UpdatePack): Pack | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const updatedAt = updates.updated_at ?? new Date().toISOString();
    const name = updates.name ?? existing.name;
    const version = updates.version ?? existing.version;
    const description =
      updates.description !== undefined ? updates.description : existing.description;
    const isActive =
      updates.is_active !== undefined
        ? typeof updates.is_active === 'boolean'
          ? updates.is_active
            ? 1
            : 0
          : updates.is_active
        : existing.is_active;
    const signature = updates.signature !== undefined ? updates.signature : existing.signature;

    const stmt = this.db.prepare(`
      UPDATE packs
      SET name = ?, version = ?, description = ?, is_active = ?, signature = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(name, version, description, isActive, signature, updatedAt, id);

    return {
      id,
      name,
      version,
      description,
      is_active: isActive,
      signature,
      created_at: existing.created_at,
      updated_at: updatedAt,
    };
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM packs WHERE id = ?').run(id);
    return result.changes > 0;
  }
}
