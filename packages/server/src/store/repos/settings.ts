import type Database from 'better-sqlite3';
import type { Setting } from '../types.js';

export class SettingsRepo {
  constructor(private readonly db: Database.Database) {}

  set(key: string, value: string): Setting {
    const updatedAt = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);

    stmt.run(key, value, updatedAt);

    return {
      key,
      value,
      updated_at: updatedAt,
    };
  }

  setJson<T>(key: string, value: T): Setting {
    return this.set(key, JSON.stringify(value));
  }

  get(key: string): Setting | null {
    const stmt = this.db.prepare('SELECT * FROM settings WHERE key = ?');
    const row = stmt.get(key) as Setting | undefined;
    return row ?? null;
  }

  getValue(key: string): string | null {
    const setting = this.get(key);
    return setting ? setting.value : null;
  }

  getJson<T>(key: string): T | null {
    const val = this.getValue(key);
    if (val === null) return null;
    try {
      return JSON.parse(val) as T;
    } catch {
      return null;
    }
  }

  list(): Setting[] {
    const stmt = this.db.prepare('SELECT * FROM settings ORDER BY key ASC');
    return stmt.all() as Setting[];
  }

  delete(key: string): boolean {
    const result = this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return result.changes > 0;
  }
}
