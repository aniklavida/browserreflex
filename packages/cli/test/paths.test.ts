/**
 * Tests for path resolution across the three platforms this card covers.
 *
 * The platform is a parameter, so the Windows and Linux layouts are checked from
 * this machine. What is not checked here is anything only Windows or Linux can
 * answer: no file is written through a Windows path and no process is launched.
 * Those claims are limited to what the path strings show.
 *
 * Every home directory is an injected string. The one test that exercises the
 * system fallback passes `systemHome`, so `os.homedir()` is never called.
 */

import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_PLATFORMS,
  currentPlatform,
  joinFor,
  pathFor,
  resolveHome,
  separatorFor,
  type Platform,
} from '../src/paths.js';
import { AGENT_DEFINITIONS, resolveAgentConfigPath } from '../src/agents.js';
import { makeTempHome } from './helpers/temp-home.js';

/** A home directory written the way each platform writes one. */
const FAKE_HOMES: Record<Platform, string> = {
  darwin: '/opt/fakehome',
  linux: '/opt/fakehome',
  win32: 'C:\\fakehome',
};

describe('supported platforms', () => {
  it('covers macOS, Linux and Windows', () => {
    expect([...SUPPORTED_PLATFORMS]).toEqual(['darwin', 'linux', 'win32']);
  });

  it('maps every Unix-like platform onto the macOS layout', () => {
    expect(currentPlatform('darwin')).toBe('darwin');
    expect(currentPlatform('linux')).toBe('linux');
    expect(currentPlatform('win32')).toBe('win32');
    // A dot-directory under the home directory is the same on every Unix, so the
    // only thing that differs there is the browser launcher.
    expect(currentPlatform('freebsd')).toBe('darwin');
    expect(currentPlatform('aix')).toBe('darwin');
  });
});

describe('joinFor', () => {
  it('joins with a slash on macOS and Linux', () => {
    expect(joinFor('darwin', FAKE_HOMES.darwin, '.codex', 'config.toml')).toBe(
      '/opt/fakehome/.codex/config.toml',
    );
    expect(joinFor('linux', FAKE_HOMES.linux, '.gemini', 'settings.json')).toBe(
      '/opt/fakehome/.gemini/settings.json',
    );
  });

  it('joins with a backslash on Windows, from a machine that is not Windows', () => {
    const joined = joinFor('win32', FAKE_HOMES.win32, '.codex', 'config.toml');

    expect(joined).toBe('C:\\fakehome\\.codex\\config.toml');
    expect(joined).not.toContain('/');
  });

  it('reports the separator of each platform', () => {
    expect(separatorFor('darwin')).toBe('/');
    expect(separatorFor('linux')).toBe('/');
    expect(separatorFor('win32')).toBe('\\');
  });

  it('picks the path implementation that matches the platform', () => {
    expect(pathFor('win32').sep).toBe('\\');
    expect(pathFor('linux').sep).toBe('/');
  });
});

describe('resolveHome', () => {
  it('prefers the flag over every environment variable', () => {
    const resolution = resolveHome({
      home: '/tmp/from-flag',
      env: { BROWSERREFLEX_HOME: '/tmp/from-browserreflex', HOME: '/tmp/from-home' },
      platform: 'linux',
    });

    expect(resolution).toEqual({ home: '/tmp/from-flag', source: 'flag', platform: 'linux' });
  });

  it('uses BROWSERREFLEX_HOME before the platform home variable', () => {
    const resolution = resolveHome({
      env: { BROWSERREFLEX_HOME: '/tmp/from-browserreflex', HOME: '/tmp/from-home' },
      platform: 'linux',
    });

    expect(resolution.source).toBe('environment');
    expect(resolution.home).toBe('/tmp/from-browserreflex');
  });

  it('reads USERPROFILE on Windows and HOME elsewhere', () => {
    const env = { HOME: '/tmp/posix-home', USERPROFILE: FAKE_HOMES.win32 };

    expect(resolveHome({ env, platform: 'win32' }).home).toBe(FAKE_HOMES.win32);
    expect(resolveHome({ env, platform: 'darwin' }).home).toBe('/tmp/posix-home');
  });

  it('ignores an empty value rather than resolving to the empty path', () => {
    const resolution = resolveHome({
      env: { BROWSERREFLEX_HOME: '', HOME: '/tmp/posix-home' },
      platform: 'linux',
    });

    expect(resolution.home).toBe('/tmp/posix-home');
  });

  it('falls back to the injected system home, and says that is what it did', () => {
    const resolution = resolveHome({
      env: {},
      platform: 'linux',
      systemHome: '/tmp/injected-system-home',
    });

    expect(resolution).toEqual({
      home: '/tmp/injected-system-home',
      source: 'system',
      platform: 'linux',
    });
  });

  it('does not read APPDATA, because no supported agent keeps its configuration there', () => {
    const resolution = resolveHome({
      env: { APPDATA: 'C:\\fake\\AppData\\Roaming' },
      platform: 'win32',
      systemHome: FAKE_HOMES.win32,
    });

    expect(resolution.home).toBe(FAKE_HOMES.win32);
  });
});

describe('agent configuration paths', () => {
  it('keeps every agent configuration file inside the home directory it was given', () => {
    for (const platform of SUPPORTED_PLATFORMS) {
      const home = FAKE_HOMES[platform];

      for (const definition of AGENT_DEFINITIONS) {
        const resolved = resolveAgentConfigPath(definition, { platform, home, env: {} });

        expect(
          resolved.configPath.startsWith(`${home}\\`) || resolved.configPath.startsWith(`${home}/`),
        ).toBe(true);
        expect(resolved.detectPaths.length).toBeGreaterThan(0);
        for (const detectPath of resolved.detectPaths) {
          expect(detectPath.startsWith(home)).toBe(true);
        }
        if (platform === 'win32') {
          expect(resolved.configPath).not.toContain('/');
        }
      }
    }
  });

  it('lands inside a temporary home directory when one is used', () => {
    const home = makeTempHome();

    try {
      for (const definition of AGENT_DEFINITIONS) {
        const resolved = resolveAgentConfigPath(definition, {
          platform: 'darwin',
          home: home.path,
          env: {},
        });

        expect(resolved.configPath.startsWith(home.path)).toBe(true);
      }
    } finally {
      home.remove();
    }
  });
});
