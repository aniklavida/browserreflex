import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDefaultDatabasePath, openDatabase } from '../src/store/connection.js';

describe('store connection and path injection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-conn-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.BROWSERREFLEX_DB_PATH;
  });

  it('creates database file at injected path and creates parent directory', () => {
    const dbPath = join(tempDir, 'nested', 'dir', 'custom.db');
    expect(existsSync(join(tempDir, 'nested', 'dir'))).toBe(false);

    const db = openDatabase(dbPath);
    try {
      expect(existsSync(dbPath)).toBe(true);
      const row = db.prepare('SELECT 1 as alive').get() as { alive: number };
      expect(row.alive).toBe(1);
    } finally {
      db.close();
    }
  });

  it('resolves database path from environment variable when not specified', () => {
    const customEnvPath = join(tempDir, 'env-configured.db');
    process.env.BROWSERREFLEX_DB_PATH = customEnvPath;

    expect(getDefaultDatabasePath()).toBe(customEnvPath);

    const db = openDatabase();
    try {
      expect(existsSync(customEnvPath)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('supports in-memory databases without writing files', () => {
    const db = openDatabase(':memory:');
    try {
      const row = db.prepare('SELECT 42 as num').get() as { num: number };
      expect(row.num).toBe(42);
    } finally {
      db.close();
    }
  });

  it('supports read-only connection without modifying the database or allowing writes', () => {
    const dbPath = join(tempDir, 'readonly-test.db');
    const writer = openDatabase(dbPath);
    writer.exec("CREATE TABLE test_data (val TEXT); INSERT INTO test_data VALUES ('hello');");
    writer.close();

    const reader = openDatabase(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = reader.prepare('SELECT val FROM test_data').get() as { val: string };
      expect(row.val).toBe('hello');
      expect(() => {
        reader.exec("INSERT INTO test_data VALUES ('blocked')");
      }).toThrow(/readonly/);
    } finally {
      reader.close();
    }
  });
});
