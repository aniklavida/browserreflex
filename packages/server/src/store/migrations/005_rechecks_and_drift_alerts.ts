import type Database from 'better-sqlite3';

/**
 * Adds `rechecks`, `demotion_events`, and `drift_alerts` tables.
 *
 * Migration 001, 002, 003, 004 are applied and are never edited.
 * This is migration 005, so an existing database gains the tables and a new one starts with them.
 *
 * Tables:
 * - rechecks: audit record of fast-path answers sampled for re-check and their verification outcomes.
 * - demotion_events: audit record of learned patterns disabled when recent accuracy drops below threshold.
 * - drift_alerts: actionable alerts raised when site drift disables a learned pattern.
 */
export const migration005 = {
  version: 5,
  name: '005_rechecks_and_drift_alerts',
  up: (db: Database.Database): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rechecks (
        id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
        pattern_id TEXT NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
        pattern_answer TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        agreed INTEGER,
        recheck_answer TEXT,
        source TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_rechecks_pattern_id ON rechecks(pattern_id);
      CREATE INDEX IF NOT EXISTS idx_rechecks_decision_id ON rechecks(decision_id);
      CREATE INDEX IF NOT EXISTS idx_rechecks_status ON rechecks(status);

      CREATE TABLE IF NOT EXISTS demotion_events (
        id TEXT PRIMARY KEY,
        pattern_id TEXT NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
        sample_count INTEGER NOT NULL,
        agreed_count INTEGER NOT NULL,
        disagreed_count INTEGER NOT NULL,
        accuracy REAL NOT NULL,
        threshold REAL NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_demotion_events_pattern_id ON demotion_events(pattern_id);
      CREATE INDEX IF NOT EXISTS idx_demotion_events_created_at ON demotion_events(created_at);

      CREATE TABLE IF NOT EXISTS drift_alerts (
        id TEXT PRIMARY KEY,
        pattern_id TEXT NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
        sample_count INTEGER NOT NULL,
        agreed_count INTEGER NOT NULL,
        disagreed_count INTEGER NOT NULL,
        accuracy REAL NOT NULL,
        threshold REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_drift_alerts_pattern_id ON drift_alerts(pattern_id);
      CREATE INDEX IF NOT EXISTS idx_drift_alerts_status ON drift_alerts(status);
      CREATE INDEX IF NOT EXISTS idx_drift_alerts_created_at ON drift_alerts(created_at);
    `);
  },
};
