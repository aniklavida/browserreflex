import type Database from 'better-sqlite3';

/**
 * Adds `decision_signals`: one row per decision, holding the features a miner
 * needs (domain, URL path, element role, element text, selector and normalised
 * tokens) so a candidate pattern can be looked up by domain and path.
 *
 * Migration 001 is applied and is never edited. This is a new migration, so an
 * existing database gains the table and a new one starts with it.
 *
 * Why a table rather than a JSON column on `decisions`: the miner queries by
 * domain and path. Those are indexed columns here, so the query is an index
 * lookup instead of a scan with a JSON extraction step, and a row can carry a
 * column that says where its element signals came from.
 */
export const migration002 = {
  version: 2,
  name: '002_decision_signals',
  up: (db: Database.Database): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS decision_signals (
        decision_id TEXT PRIMARY KEY REFERENCES decisions(id) ON DELETE CASCADE,
        domain TEXT,
        path TEXT,
        element_role TEXT,
        element_text TEXT,
        element_source TEXT NOT NULL DEFAULT 'none',
        selector TEXT,
        tokens TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_decision_signals_domain ON decision_signals(domain);
      CREATE INDEX IF NOT EXISTS idx_decision_signals_path ON decision_signals(path);
      CREATE INDEX IF NOT EXISTS idx_decision_signals_created_at ON decision_signals(created_at);
    `);
  },
};
