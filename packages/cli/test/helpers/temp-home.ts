/**
 * Temporary home directories for the tests in this package.
 *
 * Every test in this package resolves agent configuration paths under one of
 * these, so no test can read or write the real home directory or a real agent
 * configuration. Nothing here consults `os.homedir()`: the path always comes
 * from `mkdtemp`, so a test cannot pass by accident and fail on a developer's
 * machine.
 *
 * The directory is removed by the caller, usually in `afterEach`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempHome {
  /** The directory to pass as `--home`. */
  readonly path: string;
  /** Deletes the directory and everything in it. */
  remove(): void;
}

/** Creates an empty directory to act as a home directory for one test. */
export function makeTempHome(label = 'browserreflex-cli-'): TempHome {
  const path = mkdtempSync(join(tmpdir(), label));
  return {
    path,
    remove(): void {
      rmSync(path, { recursive: true, force: true });
    },
  };
}
