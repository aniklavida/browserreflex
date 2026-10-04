/**
 * Tests for the bridge into the server package.
 *
 * This is the only place in the CLI package that loads another package, and the
 * claim it carries is that `init` starts the local API the server package
 * already exports, on loopback, over a database this process opens and closes.
 *
 * The store is a SQLite file inside a temporary directory and the port is one the
 * operating system assigns, so nothing here reaches a real installation or a
 * port someone is using.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, startApiForDatabase, startLocalApi } from '../src/api-bridge.js';

describe('the bridge into the server package', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'browserreflex-cli-bridge-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('opens a store at the path it is given, and closes it', async () => {
    const databasePath = join(workDir, 'decisions.db');

    const store = await openStore(databasePath);

    expect(existsSync(databasePath)).toBe(true);
    store.close();
  }, 30_000);

  it('starts the local API on loopback and closes the listener and the store', async () => {
    const databasePath = join(workDir, 'decisions.db');

    const handle = await startApiForDatabase(databasePath, { port: 0 });

    try {
      expect(handle.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(handle.port).toBeGreaterThan(0);
      expect(existsSync(databasePath)).toBe(true);
    } finally {
      await handle.stop();
    }

    // The port is free again, which is what stopping the listener means.
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(handle.port, '127.0.0.1', () => {
        probe.close(() => resolve());
      });
    });
  }, 30_000);

  it('refuses a port that is already taken, and closes the store it opened', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => resolve());
    });
    const taken = (blocker.address() as AddressInfo).port;

    try {
      await expect(
        startApiForDatabase(join(workDir, 'decisions.db'), { port: taken }),
      ).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await new Promise<void>((resolve) => {
        blocker.close(() => resolve());
      });
    }

    // The database file was opened and then closed again rather than left locked:
    // a fresh store on the same file proves it.
    const reopened = await openStore(join(workDir, 'decisions.db'));
    reopened.close();
  }, 30_000);

  it('starts the API against a store the caller opened', async () => {
    const store = await openStore(join(workDir, 'decisions.db'));

    const handle = await startLocalApi(store, { port: 0 });
    try {
      expect(handle.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await handle.stop();
      store.close();
    }
  }, 30_000);
});
