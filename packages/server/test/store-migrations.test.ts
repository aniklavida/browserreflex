import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/store/connection.js';
import { runMigrations } from '../src/store/migrations/index.js';
import type Database from 'better-sqlite3';

describe('store migrations', () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-mig-'));
    dbPath = join(tempDir, 'sub', 'test.db');
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('runs migrations idempotently without error when executed multiple times', () => {
    const firstCount = runMigrations(db);
    expect(firstCount).toBeGreaterThan(0);

    const secondCount = runMigrations(db);
    expect(secondCount).toBe(0);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC",
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('schema_migrations');
    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('packs');
    expect(tableNames).toContain('patterns');
    expect(tableNames).toContain('pattern_stats');
    expect(tableNames).toContain('decisions');
    expect(tableNames).toContain('feedback');
    expect(tableNames).toContain('settings');
  });
});
