/**
 * Keeps a live pattern engine in step with the store, so a switch made in the UI (a pack
 * turned off, a pattern disabled) and a promotion made while the server runs take effect on
 * the next call, with no restart. The UI writes through the REST API, which runs in another
 * process than the MCP server, so the store is the one place they meet.
 *
 * Status: **implemented and tested** in `packages/server/test/sync.test.ts`.
 *
 * What it does, in one line each:
 * - A pack whose row is switched off has its NON-safety rules skipped. Safety rules keep
 *   working: a pack switch is never a way to turn a safety rule off.
 * - A learned pattern (a rule with no pack) is served only while the store says `active`
 *   and a promotion event exists. One disabled in the store is removed from the engine.
 * - A learned pattern promoted since the last call is added.
 *
 * The safety check is advisory: this module changes which rules answer and does not stop an
 * agent from acting.
 */

import { loadActivePatternsIntoEngine } from '../patterns/loader.js';
import type { PatternEngine } from '../patterns/engine.js';
import type { DatabaseStore } from '../store/index.js';

export interface SyncResult {
  readonly disabled_packs: readonly string[];
  readonly removed: readonly string[];
  readonly added: readonly string[];
}

export function syncEngineWithStore(store: DatabaseStore, engine: PatternEngine): SyncResult {
  const disabledPacks = new Set(
    store.packs
      .list()
      .filter((pack) => !pack.is_active)
      .map((pack) => pack.id),
  );
  engine.setDisabledPacks(disabledPacks);

  const activeLearned = new Set(
    store.patterns
      .list({ status: 'active' })
      .filter(
        (pattern) =>
          !pattern.is_safety &&
          (pattern.pack_id === null || pattern.pack_id === undefined) &&
          store.promotionEvents.listByPatternId(pattern.id).length > 0,
      )
      .map((pattern) => pattern.id),
  );

  const removed: string[] = [];
  const loadedLearned = new Set<string>();
  for (const rule of engine.getRules()) {
    const isLearned = rule.pack_id === undefined || rule.pack_id === null;
    if (!isLearned || rule.is_safety || rule.safety) {
      continue;
    }
    // A rule written straight into the engine (not from the store) is not ours to remove.
    if (store.patterns.getById(rule.id) === null) {
      continue;
    }
    if (activeLearned.has(rule.id)) {
      loadedLearned.add(rule.id);
    } else if (store.promotionEvents.listByPatternId(rule.id).length > 0) {
      engine.removeRule(rule.id);
      removed.push(rule.id);
    }
  }

  const added: string[] = [];
  const missing = [...activeLearned].filter((id) => !loadedLearned.has(id));
  if (missing.length > 0) {
    for (const rule of loadActivePatternsIntoEngine(engine, store)) {
      if (missing.includes(rule.id)) {
        added.push(rule.id);
      }
    }
  }

  return { disabled_packs: [...disabledPacks], removed, added };
}
