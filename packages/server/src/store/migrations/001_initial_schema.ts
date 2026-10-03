import type Database from 'better-sqlite3';

export const migration001 = {
  version: 1,
  name: '001_initial_schema',
  up: (db: Database.Database): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);

      CREATE TABLE IF NOT EXISTS packs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        description TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        signature TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_packs_name ON packs(name);

      CREATE TABLE IF NOT EXISTS patterns (
        id TEXT PRIMARY KEY,
        pack_id TEXT REFERENCES packs(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        domain TEXT,
        url_pattern TEXT,
        selector TEXT,
        decision_type TEXT NOT NULL,
        rules TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'candidate',
        confidence REAL NOT NULL DEFAULT 0.0,
        is_safety INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_patterns_pack_id ON patterns(pack_id);
      CREATE INDEX IF NOT EXISTS idx_patterns_domain ON patterns(domain);
      CREATE INDEX IF NOT EXISTS idx_patterns_status ON patterns(status);

      CREATE TABLE IF NOT EXISTS pattern_stats (
        pattern_id TEXT PRIMARY KEY REFERENCES patterns(id) ON DELETE CASCADE,
        sample_count INTEGER NOT NULL DEFAULT 0,
        agreed_count INTEGER NOT NULL DEFAULT 0,
        disagreed_count INTEGER NOT NULL DEFAULT 0,
        last_evaluated_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        url TEXT,
        domain TEXT,
        decision_type TEXT NOT NULL,
        question TEXT NOT NULL,
        context TEXT,
        input_hash TEXT,
        answer TEXT NOT NULL,
        confidence REAL NOT NULL,
        path TEXT NOT NULL,
        pattern_id TEXT REFERENCES patterns(id) ON DELETE SET NULL,
        latency_ms REAL NOT NULL DEFAULT 0,
        is_safety INTEGER NOT NULL DEFAULT 0,
        needs_review INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_decisions_session_id ON decisions(session_id);
      CREATE INDEX IF NOT EXISTS idx_decisions_input_hash ON decisions(input_hash);
      CREATE INDEX IF NOT EXISTS idx_decisions_domain ON decisions(domain);
      CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions(created_at);
      CREATE INDEX IF NOT EXISTS idx_decisions_needs_review ON decisions(needs_review);
      CREATE INDEX IF NOT EXISTS idx_decisions_path ON decisions(path);

      CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
        correct_value TEXT NOT NULL,
        note TEXT,
        source TEXT NOT NULL DEFAULT 'human',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_feedback_decision_id ON feedback(decision_id);
      CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  },
};
