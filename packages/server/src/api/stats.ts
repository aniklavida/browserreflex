/**
 * Counts for `GET /api/stats`, kept out of the handler so the endpoint stays a
 * thin wrapper over the store.
 *
 * What these numbers are: a count of rows in the local database, taken when the
 * endpoint is called, over every row the store holds. The fast-path share is the
 * share of decisions whose recorded path was memory, pattern or check, which is
 * the fast path as `SPEC.md` defines it.
 *
 * What they are not: no latency figure and no token difference is reported here.
 * No token count is stored anywhere yet, so any such number would be invented.
 * The statistics card owns those measures and will replace or extend this
 * function rather than have a second set of numbers served beside it.
 *
 * The safety check is advisory, so `safety_stops` counts the safety decisions in
 * the log; it counts records, not anything that was prevented.
 *
 * Status: **implemented and tested** in `packages/server/test/api.test.ts`.
 */

import type { DatabaseStore } from '../store/index.js';
import type { DecisionPath } from '../store/types.js';

/** The paths `SPEC.md` calls the fast path. */
const FAST_PATHS: readonly DecisionPath[] = ['memory', 'pattern', 'check'] as const;

export interface ApiStats {
  generated_at: string;
  decisions: {
    total: number;
    fast: number;
    ai: number;
    human: number;
    pending_review: number;
    safety_stops: number;
    fast_path_share: number;
  };
  patterns: {
    total: number;
    active: number;
  };
  packs: {
    total: number;
    active: number;
  };
  feedback: {
    total: number;
  };
  /** Learned patterns the monitor disabled and that nobody has dismissed. */
  drift_alerts: {
    active: number;
  };
}

/** Counts the rows the statistics endpoint reports. */
export function buildStats(store: DatabaseStore): ApiStats {
  const total = store.decisions.count();
  const fast = FAST_PATHS.reduce((sum, path) => sum + store.decisions.count({ path }), 0);
  const patterns = store.patterns.list();

  return {
    generated_at: new Date().toISOString(),
    decisions: {
      total,
      fast,
      ai: store.decisions.count({ path: 'ai' }),
      human: store.decisions.count({ path: 'human' }),
      pending_review: store.decisions.count({ needs_review: true }),
      safety_stops: store.decisions.count({ is_safety: true }),
      fast_path_share: total === 0 ? 0 : Math.round((fast / total) * 10000) / 10000,
    },
    patterns: {
      total: patterns.length,
      active: patterns.filter((pattern) => pattern.status === 'active').length,
    },
    packs: {
      total: store.packs.list().length,
      active: store.packs.list({ activeOnly: true }).length,
    },
    feedback: {
      total: store.feedback.list().length,
    },
    drift_alerts: {
      active: store.driftAlerts.list({ status: 'active' }).length,
    },
  };
}
