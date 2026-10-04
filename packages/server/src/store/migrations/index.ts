import type Database from 'better-sqlite3';
import { migration001 } from './001_initial_schema.js';
import { migration002 } from './002_decision_signals.js';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

export const MIGRATIONS: Migration[] = [migration001, migration002];

export function runMigrations(db: Database.Database): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
    .all() as { version: number }[];

  const appliedSet = new Set(appliedRows.map((r) => r.version));
  let count = 0;

  for (const migration of MIGRATIONS) {
    if (!appliedSet.has(migration.version)) {
      const applyMigration = db.transaction(() => {
        migration.up(db);
        db.prepare(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        ).run(migration.version, migration.name, new Date().toISOString());
      });

      applyMigration();
      count++;
    }
  }

  return count;
}
