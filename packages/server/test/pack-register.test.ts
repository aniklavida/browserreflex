import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, type DatabaseStore } from '../src/index.js';
import { createMcpServer, registerLoadedPacks } from '../src/mcp/server.js';
import { resolveBrowserPackDirectory } from '../src/tools/page_check.js';

describe('registering the loaded packs in the store', () => {
  let tempDir: string;
  let store: DatabaseStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-packreg-'));
    store = createStore(join(tempDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes one switched-on row per loaded pack, and a restart keeps a switch made in the UI', async () => {
    const first = await createMcpServer({ store, packsDirectory: resolveBrowserPackDirectory() });
    const rows = store.packs.list();
    expect(rows.length).toBe(first.loadedPacks.length);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.is_active === 1)).toBe(true);

    const id = rows[0]!.id;
    store.packs.update(id, { is_active: 0 });

    registerLoadedPacks(store, first.loadedPacks);
    await createMcpServer({ store, packsDirectory: resolveBrowserPackDirectory() });

    expect(store.packs.getById(id)?.is_active).toBe(0);
    expect(store.packs.list()).toHaveLength(rows.length);
  });
});
