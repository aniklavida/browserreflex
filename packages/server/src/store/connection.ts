import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function getDefaultDatabasePath(): string {
  if (process.env.BROWSERREFLEX_DB_PATH) {
    return process.env.BROWSERREFLEX_DB_PATH;
  }
  return join(homedir(), '.browserreflex', 'browserreflex.db');
}

export interface DatabaseConnectionOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
  timeout?: number;
  verbose?: (message?: unknown, ...additionalArgs: unknown[]) => void;
}

export function openDatabase(
  dbPath?: string,
  options: DatabaseConnectionOptions = {},
): Database.Database {
  const targetPath = dbPath ?? getDefaultDatabasePath();

  if (targetPath !== ':memory:') {
    const dir = dirname(targetPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(targetPath, {
    readonly: options.readonly ?? false,
    fileMustExist: options.fileMustExist ?? false,
    timeout: options.timeout ?? 5000,
    verbose: options.verbose,
  });

  if (targetPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  return db;
}
