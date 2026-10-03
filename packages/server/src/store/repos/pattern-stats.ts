import type Database from 'better-sqlite3';
import type { PatternStats, UpsertPatternStats } from '../types.js';

export class PatternStatsRepo {
  constructor(private readonly db: Database.Database) {}

  upsert(data: UpsertPatternStats): PatternStats {
    const updatedAt = data.updated_at ?? new Date().toISOString();
    const sampleCount = data.sample_count ?? 0;
    const agreedCount = data.agreed_count ?? 0;
    const disagreedCount = data.disagreed_count ?? 0;
    const lastEvaluatedAt = data.last_evaluated_at ?? null;

    const stmt = this.db.prepare(`
      INSERT INTO pattern_stats (
        pattern_id, sample_count, agreed_count, disagreed_count, last_evaluated_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(pattern_id) DO UPDATE SET
        sample_count = excluded.sample_count,
        agreed_count = excluded.agreed_count,
        disagreed_count = excluded.disagreed_count,
        last_evaluated_at = excluded.last_evaluated_at,
        updated_at = excluded.updated_at
    `);

    stmt.run(data.pattern_id, sampleCount, agreedCount, disagreedCount, lastEvaluatedAt, updatedAt);

    return {
      pattern_id: data.pattern_id,
      sample_count: sampleCount,
      agreed_count: agreedCount,
      disagreed_count: disagreedCount,
      last_evaluated_at: lastEvaluatedAt,
      updated_at: updatedAt,
    };
  }

  getById(patternId: string): PatternStats | null {
    const stmt = this.db.prepare('SELECT * FROM pattern_stats WHERE pattern_id = ?');
    const row = stmt.get(patternId) as PatternStats | undefined;
    return row ?? null;
  }

  recordSample(patternId: string, agreed: boolean, evaluatedAt?: string): PatternStats {
    const now = evaluatedAt ?? new Date().toISOString();
    const agreedIncrement = agreed ? 1 : 0;
    const disagreedIncrement = agreed ? 0 : 1;

    const stmt = this.db.prepare(`
      INSERT INTO pattern_stats (
        pattern_id, sample_count, agreed_count, disagreed_count, last_evaluated_at, updated_at
      ) VALUES (?, 1, ?, ?, ?, ?)
      ON CONFLICT(pattern_id) DO UPDATE SET
        sample_count = sample_count + 1,
        agreed_count = agreed_count + excluded.agreed_count,
        disagreed_count = disagreed_count + excluded.disagreed_count,
        last_evaluated_at = excluded.last_evaluated_at,
        updated_at = excluded.updated_at
    `);

    stmt.run(patternId, agreedIncrement, disagreedIncrement, now, now);

    return this.getById(patternId)!;
  }

  list(): PatternStats[] {
    const stmt = this.db.prepare('SELECT * FROM pattern_stats ORDER BY sample_count DESC');
    return stmt.all() as PatternStats[];
  }

  delete(patternId: string): boolean {
    const result = this.db.prepare('DELETE FROM pattern_stats WHERE pattern_id = ?').run(patternId);
    return result.changes > 0;
  }
}
