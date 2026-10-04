import type Database from 'better-sqlite3';

/**
 * Adds `promotion_events`: audit record of candidate patterns promoted to active.
 *
 * Migration 001, 002, 003 are applied and are never edited.
 * This is migration 004, so an existing database gains the table and a new one starts with it.
 *
 * Promotion is atomic: the pattern row update and the promotion event insert happen
 * in the same transaction.
 *
 * Columns:
 * - id: unique event identifier
 * - pattern_id: candidate pattern promoted
 * - sample_count: number of shadow samples at time of promotion
 * - agreement: measured agreement ratio at time of promotion
 * - threshold_samples: minimum samples required by the threshold used
 * - threshold_agreement: minimum agreement required by the threshold used
 * - thresholds: JSON serialized threshold settings used for evaluation
 * - is_safety: whether safety-related thresholds applied (always 0 on the pattern itself)
 * - created_at: timestamp of promotion
 */
export const migration004 = {
  version: 4,
  name: '004_promotion_events',
  up: (db: Database.Database): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS promotion_events (
        id TEXT PRIMARY KEY,
        pattern_id TEXT NOT NULL,
        sample_count INTEGER NOT NULL,
        agreement REAL NOT NULL,
        threshold_samples INTEGER NOT NULL,
        threshold_agreement REAL NOT NULL,
        thresholds TEXT NOT NULL,
        is_safety INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_promotion_events_pattern_id ON promotion_events(pattern_id);
      CREATE INDEX IF NOT EXISTS idx_promotion_events_created_at ON promotion_events(created_at);
    `);
  },
};
