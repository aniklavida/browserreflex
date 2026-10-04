/**
 * Opening a local address in a browser, on all three platforms.
 *
 * This is best effort by design. A machine with no launcher, a headless session
 * or a container without a display has no way to open a window, and none of those
 * is a reason for `init` to fail: the address is always printed, so the person
 * can open it by hand.
 *
 * No network request is made from this package. The launcher is started
 * detached and nothing is waited for; whether the browser appears is not this
 * package's business.
 *
 * Status: **implemented and tested** in `packages/cli/test/open-url.test.ts`. The
 * command each platform gets is asserted there. Whether a real browser window
 * appears was not verified.
 */

import { spawn } from 'node:child_process';
import type { Platform } from './paths.js';

export interface OpenUrlCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

/**
 * The launcher command for a platform.
 *
 * Windows goes through `cmd /c start`, which is what opens a URL in the default
 * browser there; the empty pair of quotes after `start` is the window title, and
 * omitting it makes a path with spaces break.
 */
export function openUrlCommand(url: string, platform: Platform): OpenUrlCommand {
  if (platform === 'darwin') {
    return { executable: 'open', args: [url] };
  }
  if (platform === 'win32') {
    return { executable: 'cmd', args: ['/c', 'start', '', url] };
  }
  return { executable: 'xdg-open', args: [url] };
}

/**
 * The part of a child process this module uses. Declared here so a test can hand
 * in a stand-in without constructing a real process.
 */
export interface SpawnedProcess {
  unref(): void;
  on?(event: 'error', listener: (error: Error) => void): void;
}

export type SpawnFn = (
  executable: string,
  args: readonly string[],
  options: { readonly detached: boolean; readonly stdio: 'ignore' },
) => SpawnedProcess;

export interface OpenUrlOptions {
  readonly platform: Platform;
  /** Injected so a test can observe the command without launching anything. */
  readonly spawnFn?: SpawnFn | undefined;
  /** Called when the launcher turns out not to exist or not to be allowed. */
  readonly onFailure?: ((error: Error) => void) | undefined;
}

export interface OpenUrlResult {
  /** True when the launcher was started. It does not mean a window appeared. */
  readonly attempted: boolean;
  readonly command: OpenUrlCommand;
  readonly error?: string;
}

const defaultSpawn: SpawnFn = (executable, args, options) => spawn(executable, [...args], options);

/**
 * Starts the platform's browser launcher for a URL.
 *
 * Returns whether the launcher was started. A failure to start is reported
 * through `onFailure` as well, because `spawn` reports a missing executable
 * asynchronously: this function cannot know about it yet.
 */
export function openUrl(url: string, options: OpenUrlOptions): OpenUrlResult {
  const command = openUrlCommand(url, options.platform);
  const spawnFn = options.spawnFn ?? defaultSpawn;

  try {
    const child = spawnFn(command.executable, command.args, {
      detached: true,
      stdio: 'ignore',
    });
    child.on?.('error', (error: Error) => {
      options.onFailure?.(error);
    });
    child.unref();
    return { attempted: true, command };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    options.onFailure?.(failure);
    return { attempted: false, command, error: failure.message };
  }
}
