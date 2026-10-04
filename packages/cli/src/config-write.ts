/**
 * Writing a configuration file, with a backup of what was there before.
 *
 * The backup happens before the write and it is the reason this command can be
 * pointed at a file it does not fully understand. The name carries the time, so a
 * second run in the same second does not overwrite the first run's backup.
 *
 * Status: **implemented and tested** in `packages/cli/test/config-write.test.ts`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const realWriteFileSystem: WriteFileSystem = {
  mkdir: (path) => {
    mkdirSync(path, { recursive: true });
  },
  write: (path, text) => {
    writeFileSync(path, text, 'utf8');
  },
};

export interface WriteConfigFileOptions {
  /** Absolute path of the file to write. */
  readonly configPath: string;
  /** The whole file as it should be on disk. */
  readonly text: string;
  /** The file as it was on disk, or undefined when it did not exist. */
  readonly previousText: string | undefined;
  /** Injected clock, so the backup name is predictable in a test. */
  readonly now?: Date | undefined;
  /**
   * Injected writes. Omit it and the real filesystem is used. A caller that wants
   * to assert that nothing was written injects a writer that records, or refuses.
   */
  readonly fs?: WriteFileSystem | undefined;
}

/** The writes this module performs. Declared so a test can stand in for them. */
export interface WriteFileSystem {
  mkdir(path: string): void;
  write(path: string, text: string): void;
}

export interface WriteConfigFileResult {
  /** Where the previous content was written, or undefined when there was none. */
  readonly backupPath: string | undefined;
  /** False when the file already held exactly what was about to be written. */
  readonly wroteFile: boolean;
}

/** The backup name for a configuration file at a moment in time. */
export function backupPathFor(configPath: string, now: Date): string {
  const stamp = now.toISOString().replaceAll(':', '').replaceAll('.', '-');
  return `${configPath}.browserreflex-backup-${stamp}`;
}

/**
 * Writes `text` to `configPath`, keeping the previous content in a timestamped
 * sibling file when there was any.
 *
 * A missing parent directory is created: the agent's configuration directory is
 * not always there, and refusing to create it would make a first installation
 * impossible.
 *
 * Writing a file that already holds exactly `text` is a no-op: no write, and no
 * backup either. That is what makes a second run leave one copy of the previous
 * content rather than a new one every time.
 */
export function writeConfigFile(options: WriteConfigFileOptions): WriteConfigFileResult {
  const now = options.now ?? new Date();
  const fs: WriteFileSystem = options.fs ?? realWriteFileSystem;

  if (options.previousText !== undefined && options.previousText === options.text) {
    return { backupPath: undefined, wroteFile: false };
  }

  fs.mkdir(dirname(options.configPath));

  let backupPath: string | undefined;
  if (options.previousText !== undefined) {
    backupPath = backupPathFor(options.configPath, now);
    fs.write(backupPath, options.previousText);
  }

  fs.write(options.configPath, options.text);
  return { backupPath, wroteFile: true };
}
