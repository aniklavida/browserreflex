/**
 * Tests for the browser launcher.
 *
 * Nothing is launched here: the spawn function is injected, so the test asserts
 * which command each platform gets and what happens when the launcher is missing.
 * Whether a browser window actually appears was not verified, and the module
 * header says so.
 */

import { describe, expect, it } from 'vitest';
import { openUrl, openUrlCommand, type SpawnedProcess, type SpawnFn } from '../src/open-url.js';

interface SpawnCall {
  readonly executable: string;
  readonly args: readonly string[];
  readonly options: { readonly detached: boolean; readonly stdio: 'ignore' };
}

/** Records what it was asked to launch, and hands back a child that can be inspected. */
function recordingSpawn(returned: SpawnedProcess = { unref: () => undefined }) {
  const calls: SpawnCall[] = [];
  const spawnFn: SpawnFn = (executable, args, options) => {
    calls.push({ executable, args, options });
    return returned;
  };
  return { calls, spawnFn };
}

describe('openUrlCommand', () => {
  it('uses open on macOS', () => {
    expect(openUrlCommand('http://127.0.0.1:4040/setup', 'darwin')).toEqual({
      executable: 'open',
      args: ['http://127.0.0.1:4040/setup'],
    });
  });

  it('uses xdg-open on Linux', () => {
    expect(openUrlCommand('http://127.0.0.1:4040/setup', 'linux')).toEqual({
      executable: 'xdg-open',
      args: ['http://127.0.0.1:4040/setup'],
    });
  });

  it('goes through cmd /c start on Windows, with a window title for a path with spaces', () => {
    expect(openUrlCommand('http://127.0.0.1:4040/setup', 'win32')).toEqual({
      executable: 'cmd',
      args: ['/c', 'start', '', 'http://127.0.0.1:4040/setup'],
    });
  });
});

describe('openUrl', () => {
  const base = { platform: 'darwin' } as const;

  it('launches the platform command detached, and reports that it did', () => {
    const { calls, spawnFn } = recordingSpawn();

    const result = openUrl('http://127.0.0.1:4040/setup', { ...base, spawnFn });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      executable: 'open',
      args: ['http://127.0.0.1:4040/setup'],
      options: { detached: true, stdio: 'ignore' },
    });
    expect(result.attempted).toBe(true);
    expect(result.command.executable).toBe('open');
  });

  it('lets the child go, so init is not held open by the launcher', () => {
    let unrefCalls = 0;
    const child: SpawnedProcess = {
      unref: () => {
        unrefCalls += 1;
      },
    };
    const { spawnFn } = recordingSpawn(child);

    openUrl('http://127.0.0.1:4040/setup', { ...base, spawnFn });

    expect(unrefCalls).toBe(1);
  });

  it('reports a launcher that refuses to start, and does not throw', () => {
    const failures: Error[] = [];
    const spawnFn: SpawnFn = () => {
      throw new Error('spawn xdg-open ENOENT');
    };

    const result = openUrl('http://127.0.0.1:4040/setup', {
      platform: 'linux',
      spawnFn,
      onFailure: (error) => failures.push(error),
    });

    expect(result.attempted).toBe(false);
    expect(result.error).toContain('ENOENT');
    expect(failures).toHaveLength(1);
  });

  it('reports a launcher that turns out to be missing after it started', () => {
    // `spawn` reports a missing executable through an event, not a throw, so the
    // only way to hear about it is the listener.
    const failures: Error[] = [];
    let listener: ((error: Error) => void) | undefined;
    const child: SpawnedProcess = {
      unref: () => undefined,
      on: (_event, given) => {
        listener = given;
      },
    };
    const { spawnFn } = recordingSpawn(child);

    const result = openUrl('http://127.0.0.1:4040/setup', {
      ...base,
      spawnFn,
      onFailure: (error) => failures.push(error),
    });

    expect(result.attempted).toBe(true);
    expect(listener).toBeDefined();
    listener?.(new Error('spawn open ENOENT'));
    expect(failures.map((error) => error.message)).toEqual(['spawn open ENOENT']);
  });

  it('works without an onFailure callback, because the caller may not want one', () => {
    const { spawnFn } = recordingSpawn();

    expect(() => openUrl('http://127.0.0.1:4040/setup', { ...base, spawnFn })).not.toThrow();
  });

  it('never passes a network request of its own: the only argument is the local address', () => {
    const { calls, spawnFn } = recordingSpawn();

    openUrl('http://127.0.0.1:4040/setup', { ...base, spawnFn });

    expect(calls[0]?.args).toEqual(['http://127.0.0.1:4040/setup']);
  });
});
