import type Database from 'better-sqlite3';
import { openDatabase, type DatabaseConnectionOptions } from './connection.js';
import { runMigrations } from './migrations/index.js';
import {
  DecisionRepo,
  FeedbackRepo,
  PackRepo,
  PatternRepo,
  PatternStatsRepo,
  SessionRepo,
  SettingsRepo,
  ShadowSampleRepo,
  SignalRepo,
} from './repos/index.js';

export * from './types.js';
export {
  getDefaultDatabasePath,
  openDatabase,
  type DatabaseConnectionOptions,
} from './connection.js';
export { runMigrations, MIGRATIONS, type Migration } from './migrations/index.js';
export * from './repos/index.js';

export class DatabaseStore {
  public readonly db: Database.Database;
  public readonly sessions: SessionRepo;
  public readonly decisions: DecisionRepo;
  public readonly signals: SignalRepo;
  public readonly feedback: FeedbackRepo;
  public readonly packs: PackRepo;
  public readonly patterns: PatternRepo;
  public readonly patternStats: PatternStatsRepo;
  public readonly shadowSamples: ShadowSampleRepo;
  public readonly settings: SettingsRepo;

  constructor(dbPath?: string, options?: DatabaseConnectionOptions) {
    this.db = openDatabase(dbPath, options);
    runMigrations(this.db);
    this.sessions = new SessionRepo(this.db);
    this.decisions = new DecisionRepo(this.db);
    this.signals = new SignalRepo(this.db);
    this.feedback = new FeedbackRepo(this.db);
    this.packs = new PackRepo(this.db);
    this.patterns = new PatternRepo(this.db);
    this.patternStats = new PatternStatsRepo(this.db);
    this.shadowSamples = new ShadowSampleRepo(this.db);
    this.settings = new SettingsRepo(this.db);
  }

  runMigrations(): number {
    return runMigrations(this.db);
  }

  close(): void {
    this.db.close();
  }
}

export function createStore(dbPath?: string, options?: DatabaseConnectionOptions): DatabaseStore {
  return new DatabaseStore(dbPath, options);
}
