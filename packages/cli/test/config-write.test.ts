/**
 * Tests for writing a configuration file with a backup of what was there.
 *
 * Every path in this file is inside a temporary directory. Nothing here can
 * reach a real agent configuration, because nothing here computes a path: the
 * caller passes one and the test passes a directory it made.
 *
 * The two claims worth a named test are that the previous content survives in a
 * backup, and that a file which already holds the wanted text is not written
 * again at all.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupPathFor, writeConfigFile } from '../src/config-write.js';
import { makeTempHome } from './helpers/temp-home.js';

const NOW = new Date('2026-10-04T09:30:15.250Z');

describe('backupPathFor', () => {
  it('puts the time in the name, without characters a filename resents', () => {
    const backup = backupPathFor('/opt/fakehome/.claude.json', NOW);

    expect(backup).toBe('/opt/fakehome/.claude.json.browserreflex-backup-2026-10-04T093015-250Z');
    expect(backup).not.toContain(':');
  });

  it('gives two moments in the same second different names', () => {
    const first = backupPathFor('/tmp/a.json', new Date('2026-10-04T09:30:15.250Z'));
    const second = backupPathFor('/tmp/a.json', new Date('2026-10-04T09:30:15.750Z'));

    expect(first).not.toBe(second);
  });
});

describe('writeConfigFile', () => {
  let home: ReturnType<typeof makeTempHome>;
  let configPath: string;

  beforeEach(() => {
    home = makeTempHome('browserreflex-cli-write-');
    configPath = join(home.path, '.claude.json');
  });

  afterEach(() => {
    home.remove();
  });

  it('writes the file when there was none, and backs up nothing', () => {
    const result = writeConfigFile({
      configPath,
      text: 'new\n',
      previousText: undefined,
      now: NOW,
    });

    expect(result.wroteFile).toBe(true);
    expect(result.backupPath).toBeUndefined();
    expect(readFileSync(configPath, 'utf8')).toBe('new\n');
    expect(readdirSync(home.path)).toEqual(['.claude.json']);
  });

  it('creates the parent directory when the agent has none yet', () => {
    const nested = join(home.path, '.gemini', 'settings.json');

    writeConfigFile({ configPath: nested, text: '{}\n', previousText: undefined, now: NOW });

    expect(readFileSync(nested, 'utf8')).toBe('{}\n');
  });

  it('keeps the previous content in a timestamped backup before writing', () => {
    const previous = '{\n  "theme": "dark"\n}\n';
    writeFileSync(configPath, previous, 'utf8');

    const result = writeConfigFile({
      configPath,
      text: '{\n  "theme": "light"\n}\n',
      previousText: previous,
      now: NOW,
    });

    expect(result.backupPath).toBe(backupPathFor(configPath, NOW));
    expect(readFileSync(result.backupPath as string, 'utf8')).toBe(previous);
    expect(readFileSync(configPath, 'utf8')).toBe('{\n  "theme": "light"\n}\n');
  });

  it('writes nothing and backs up nothing when the file already holds that text', () => {
    const text = '{\n  "a": 1\n}\n';
    writeFileSync(configPath, text, 'utf8');

    const result = writeConfigFile({ configPath, text, previousText: text, now: NOW });

    expect(result.wroteFile).toBe(false);
    expect(result.backupPath).toBeUndefined();
    // One file in the directory: the configuration itself, and no backup of it.
    expect(readdirSync(home.path)).toEqual(['.claude.json']);
  });

  it('does not touch the file at all when nothing changes', () => {
    const text = '{\n  "a": 1\n}\n';
    writeFileSync(configPath, text, 'utf8');
    const before = statSync(configPath).mtimeMs;

    writeConfigFile({ configPath, text, previousText: text, now: NOW });

    expect(readFileSync(configPath, 'utf8')).toBe(text);
    expect(statSync(configPath).mtimeMs).toBe(before);
    expect(readdirSync(home.path)).toEqual(['.claude.json']);
  });

  it('keeps the previous content of a second run in its own backup', () => {
    const first = '{"version":1}\n';
    const second = '{"version":2}\n';
    writeFileSync(configPath, first, 'utf8');

    const firstRun = writeConfigFile({
      configPath,
      text: second,
      previousText: first,
      now: new Date('2026-10-04T09:30:15.250Z'),
    });
    const secondRun = writeConfigFile({
      configPath,
      text: first,
      previousText: second,
      now: new Date('2026-10-04T09:30:15.750Z'),
    });

    expect(firstRun.backupPath).not.toBe(secondRun.backupPath);
    expect(readFileSync(firstRun.backupPath as string, 'utf8')).toBe(first);
    expect(readFileSync(secondRun.backupPath as string, 'utf8')).toBe(second);
  });

  it('writes through the filesystem it was given, and through nothing else', () => {
    const calls: { path: string; text: string }[] = [];
    const made: string[] = [];

    const result = writeConfigFile({
      configPath,
      text: 'new\n',
      previousText: 'old\n',
      now: NOW,
      fs: {
        mkdir: (path) => made.push(path),
        write: (path, text) => calls.push({ path, text }),
      },
    });

    expect(made).toEqual([home.path]);
    expect(calls).toEqual([
      { path: result.backupPath as string, text: 'old\n' },
      { path: configPath, text: 'new\n' },
    ]);
    // Nothing reached the real filesystem.
    expect(existsSync(configPath)).toBe(false);
  });

  it('does not write through an injected filesystem when nothing changes', () => {
    let writes = 0;

    const result = writeConfigFile({
      configPath,
      text: 'same\n',
      previousText: 'same\n',
      now: NOW,
      fs: {
        mkdir: () => {
          writes += 1;
        },
        write: () => {
          writes += 1;
        },
      },
    });

    expect(result.wroteFile).toBe(false);
    expect(writes).toBe(0);
  });
});
