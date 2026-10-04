/**
 * Where things live on disk, for three platforms from one run.
 *
 * The platform is a parameter, never `process.platform` read inside a helper, so
 * a test can ask for the Windows layout from a machine that is not Windows. A
 * Windows path is assembled with `node:path`'s `win32` implementation, so the
 * separators are backslashes even when the test runs on a machine whose own
 * separator is a slash.
 *
 * Nothing here reads the real home directory. The home directory comes from the
 * caller: a `--home` flag, an environment variable, or `os.homedir()` in that
 * order. A test always passes the first of those, so it can only ever touch a
 * directory it created.
 *
 * Status: **implemented and tested** in `packages/cli/test/paths.test.ts`.
 */

import * as nodePath from 'node:path';
import { homedir } from 'node:os';

/** The three platforms this card covers. */
export type Platform = 'darwin' | 'linux' | 'win32';

export const SUPPORTED_PLATFORMS: readonly Platform[] = ['darwin', 'linux', 'win32'];

export type HomeSource = 'flag' | 'environment' | 'system';

export interface HomeContext {
  /**
   * Home directory from `--home` or `BROWSERREFLEX_HOME`. Absent means "use the
   * environment, then the system".
   */
  readonly home?: string | undefined;
  /** Environment variables to read. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** The platform whose layout is being built. Defaults to the running platform. */
  readonly platform?: Platform | undefined;
  /** Injection point for the system home directory, so a test cannot reach it. */
  readonly systemHome?: string | undefined;
}

export interface HomeResolution {
  readonly home: string;
  readonly source: HomeSource;
  readonly platform: Platform;
}

/** Maps `process.platform` onto the platforms this card supports. */
export function currentPlatform(platform: NodeJS.Platform = process.platform): Platform {
  if (platform === 'win32') {
    return 'win32';
  }
  if (platform === 'linux') {
    return 'linux';
  }
  // Every other Unix-like platform shares the macOS layout for a dot-directory
  // under the home directory, so the difference between them is a
  // browser-launcher choice, not a path choice.
  return 'darwin';
}

/**
 * Resolves the home directory and the platform to build paths for.
 *
 * Order: the caller's `home`, then `BROWSERREFLEX_HOME`, then `HOME` (POSIX) or
 * `USERPROFILE` (Windows), then the system home directory.
 *
 * `APPDATA` is deliberately not consulted. No supported agent documents a
 * configuration file under it, and guessing a location there would write to the
 * wrong file; `USERPROFILE` is the Windows equivalent of a home directory.
 */
export function resolveHome(context: HomeContext = {}): HomeResolution {
  const env = context.env ?? process.env;
  const platform = context.platform ?? currentPlatform();

  if (context.home !== undefined && context.home !== '') {
    return { home: context.home, source: 'flag', platform };
  }

  const fromEnvironment = env['BROWSERREFLEX_HOME'];
  if (fromEnvironment !== undefined && fromEnvironment !== '') {
    return { home: fromEnvironment, source: 'environment', platform };
  }

  const fromPlatformVariable = env[platform === 'win32' ? 'USERPROFILE' : 'HOME'];
  if (fromPlatformVariable !== undefined && fromPlatformVariable !== '') {
    return { home: fromPlatformVariable, source: 'environment', platform };
  }

  return { home: context.systemHome ?? homedir(), source: 'system', platform };
}

/** The `node:path` implementation that matches the platform. */
export function pathFor(platform: Platform): typeof nodePath.posix | typeof nodePath.win32 {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

/** Joins path segments with the separator of the given platform. */
export function joinFor(platform: Platform, ...segments: readonly string[]): string {
  return pathFor(platform).join(...segments);
}

/** The file extension separator is not a thing, but the separator itself is. */
export function separatorFor(platform: Platform): string {
  return pathFor(platform).sep;
}
