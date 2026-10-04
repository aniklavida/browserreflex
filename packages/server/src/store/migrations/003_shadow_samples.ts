import type Database from 'better-sqlite3';

/**
 * Adds `shadow_samples`: the record of which shadow candidate was compared with which
 * decision, and whether it agreed.
 *
 * Migration 001 is applied and is never edited, and neither is 002. This is a new
 * migration, so an existing database gains the table and a new one starts with it.
 *
 * Why a table and not a column on `pattern_stats`: `pattern_stats` is a count per
 * candidate, and a count cannot say which decisions produced it. The shadow test
 * compares each candidate with each completed slow answer, and the same decision
 * reaching the same candidate twice must not be counted twice, so the pair itself has
 * to be storable. `PRIMARY KEY (decision_id, pattern_id)` is the key that makes a
 * second evaluation of the same pair a no-op, and the row is written and the sample
 * counted inside one transaction, so a failure in between leaves neither.
 *
 * `source` says which recorded answer the candidate's value was compared with: the
 * slow path's own answer, or a human correction in `feedback`. A row that says
 * nothing about that would read as the same comparison twice it was not.
 *
 * `agreed` is stored rather than derived from `pattern_stats`, so one row describes
 * one comparison on its own and can be read without adding the counts up.
 *
 * There is no foreign key to `patterns`: a sample is evidence about a candidate, and
 * evidence should survive the candidate being deleted or demoted. The decision is
 * referenced with a cascade, because the signals and answers a sample was derived
 * from are deleted with it and a sample without them could not be explained.
 */
export const migration003 = {
  version: 3,
  name: '003_shadow_samples',
  up: (db: Database.Database): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS shadow_samples (
        decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
        pattern_id TEXT NOT NULL,
        source TEXT NOT NULL,
        agreed INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (decision_id, pattern_id)
      );

      CREATE INDEX IF NOT EXISTS idx_shadow_samples_pattern_id ON shadow_samples(pattern_id);
      CREATE INDEX IF NOT EXISTS idx_shadow_samples_created_at ON shadow_samples(created_at);
    `);
  },
};
