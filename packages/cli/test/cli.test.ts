/**
 * Tests for the command dispatcher.
 *
 * `runCli` is called directly with injected arguments, streams and side effects,
 * so these tests never start a real server, never open a browser and never read
 * the real home directory. What is checked is the contract between the command
 * line and the process: which exit code comes back, what is printed, and what is
 * or is not started.
 *
 * The executable itself is exercised as a child process in `bin.test.ts`.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FAILURE_EXIT_CODE,
  USAGE_ERROR_EXIT_CODE,
  USAGE_EXIT_CODE,
  agentSummaryLines,
  packageVersion,
  runCli,
  type CliEnvironment,
} from '../src/cli.js';
import type { OpenUrlFn, StartApiFn } from '../src/init.js';
import { makeTempHome, type TempHome } from './helpers/temp-home.js';

const NOW = new Date('2026-10-04T09:30:15.250Z');

function fakeApi(address = 'http://127.0.0.1:4040'): StartApiFn {
  return async () => ({
    address,
    port: Number(address.split(':')[2] ?? '0'),
    stop: async (): Promise<void> => undefined,
  });
}

function fakeBrowser(): { opened: string[]; openUrl: OpenUrlFn } {
  const opened: string[] = [];
  return {
    opened,
    openUrl: (url) => {
      opened.push(url);
      return { attempted: true };
    },
  };
}

describe('runCli', () => {
  let home: TempHome;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    home = makeTempHome('browserreflex-cli-run-');
    stdout = [];
    stderr = [];
  });

  afterEach(() => {
    home.remove();
  });

  function environment(overrides: Partial<CliEnvironment> = {}): CliEnvironment {
    return {
      argv: [],
      streams: {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      env: {},
      platform: 'darwin',
      version: '0.1.0',
      now: NOW,
      startApi: fakeApi(),
      openUrl: fakeBrowser().openUrl,
      waitUntilStopped: Promise.resolve(),
      ...overrides,
    };
  }

  describe('help and version', () => {
    it('prints usage when nothing is asked for', async () => {
      const code = await runCli(environment());

      expect(code).toBe(USAGE_EXIT_CODE);
      expect(stdout.join('\n')).toContain('browserreflex-mcp init');
      expect(stderr).toEqual([]);
    });

    it('prints the usage text for --help as well', async () => {
      const code = await runCli(environment({ argv: ['init', '--help'] }));

      expect(code).toBe(USAGE_EXIT_CODE);
      expect(stdout.join('\n')).toContain('browserreflex-mcp serve');
    });

    it('prints the version from the manifest', async () => {
      const code = await runCli(environment({ argv: ['--version'] }));

      expect(code).toBe(USAGE_EXIT_CODE);
      expect(stdout).toEqual([packageVersion()]);
      expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('lists the agents it can configure, each with its own claim', () => {
      const summary = agentSummaryLines();

      expect(summary).toHaveLength(4);
      // Every layout is experimental: no agent was run against a file this
      // command wrote.
      expect(summary.every((line) => line.endsWith('(experimental)'))).toBe(true);
      expect(summary.join('\n')).toContain('.cursor/mcp.json');
    });
  });

  describe('usage errors', () => {
    it('exits 2 and explains an option it does not know', async () => {
      const code = await runCli(environment({ argv: ['init', '--nope'] }));

      expect(code).toBe(USAGE_ERROR_EXIT_CODE);
      expect(stderr.join('\n')).toContain('unknown option "--nope"');
      expect(stdout).toEqual([]);
    });

    it('exits 2 for an agent it does not know, without writing anything', async () => {
      const code = await runCli(environment({ argv: ['init', '--agent', 'emacs'] }));

      expect(code).toBe(USAGE_ERROR_EXIT_CODE);
      expect(stderr.join('\n')).toContain('unknown agent "emacs"');
      expect(readdirSync(home.path)).toEqual([]);
    });

    it('exits 2 and prints usage for a bad port', async () => {
      const code = await runCli(environment({ argv: ['init', '--port', '99999'] }));

      expect(code).toBe(USAGE_ERROR_EXIT_CODE);
      expect(stderr.join('\n')).toContain('--port must be a number');
    });
  });

  describe('serve', () => {
    it('runs the MCP stdio server and exits cleanly when it stops', async () => {
      let started = 0;

      const code = await runCli(
        environment({
          argv: ['serve'],
          startMcp: async () => {
            started += 1;
            return undefined;
          },
        }),
      );

      expect(started).toBe(1);
      expect(code).toBe(USAGE_EXIT_CODE);
      // stdout is the JSON-RPC channel: nothing else may go there.
      expect(stdout).toEqual([]);
    });

    it('applies --db to the process before the server starts, and puts it back after', async () => {
      // The server package resolves its database from this variable, so a flag
      // that was accepted and dropped would quietly open a different file.
      let seen: string | undefined;
      const before = process.env['BROWSERREFLEX_DB_PATH'];

      const code = await runCli(
        environment({
          argv: ['serve', '--db', join(home.path, 'explicit.db')],
          startMcp: async () => {
            seen = process.env['BROWSERREFLEX_DB_PATH'];
            return undefined;
          },
        }),
      );

      expect(code).toBe(USAGE_EXIT_CODE);
      expect(seen).toBe(join(home.path, 'explicit.db'));
      expect(process.env['BROWSERREFLEX_DB_PATH']).toBe(before);
    });

    it('resolves the database under --home when --db is not given', async () => {
      let seen: string | undefined;

      await runCli(
        environment({
          argv: ['serve', '--home', home.path],
          startMcp: async () => {
            seen = process.env['BROWSERREFLEX_DB_PATH'];
            return undefined;
          },
        }),
      );

      expect(seen).toBe(join(home.path, '.browserreflex', 'browserreflex.db'));
    });

    it('exits 1 and says so when the server cannot start', async () => {
      const code = await runCli(
        environment({
          argv: ['serve'],
          startMcp: async () => {
            throw new Error('no transport');
          },
        }),
      );

      expect(code).toBe(FAILURE_EXIT_CODE);
      expect(stderr.join('\n')).toContain('no transport');
    });
  });

  describe('init', () => {
    it('writes the configuration, starts the API and opens the wizard', async () => {
      const browser = fakeBrowser();
      const requested: string[] = [];
      const startApi: StartApiFn = async (request) => {
        requested.push(request.databasePath);
        return {
          address: 'http://127.0.0.1:4040',
          port: 4040,
          stop: async (): Promise<void> => undefined,
        };
      };

      const code = await runCli(
        environment({
          argv: ['init', '--home', home.path, '--agent', 'cursor'],
          startApi,
          openUrl: browser.openUrl,
        }),
      );

      expect(code).toBe(USAGE_EXIT_CODE);
      expect(readdirSync(join(home.path, '.cursor'))).toEqual(['mcp.json']);
      expect(JSON.parse(readFileSync(join(home.path, '.cursor', 'mcp.json'), 'utf8'))).toEqual({
        mcpServers: {
          browserreflex: { command: 'npx', args: ['-y', 'browserreflex-mcp', 'serve'] },
        },
      });
      expect(browser.opened).toEqual(['http://127.0.0.1:4040/setup']);
      expect(stdout.join('\n')).toContain('loopback only');
      expect(stdout.join('\n')).toContain('http://127.0.0.1:4040/setup');
    });

    it('changes nothing and starts nothing with --dry-run', async () => {
      let apiCalls = 0;
      const browser = fakeBrowser();

      const code = await runCli(
        environment({
          argv: ['init', '--home', home.path, '--agent', 'cursor', '--dry-run'],
          startApi: async () => {
            apiCalls += 1;
            throw new Error('must not be called');
          },
          openUrl: browser.openUrl,
        }),
      );

      expect(code).toBe(USAGE_EXIT_CODE);
      expect(apiCalls).toBe(0);
      expect(browser.opened).toEqual([]);
      expect(readdirSync(home.path)).toEqual([]);
      expect(stdout.join('\n')).toContain('Dry run');
      expect(stdout.join('\n')).toContain('"browserreflex"');
    });

    it('does not open a browser with --no-open, and still prints the address', async () => {
      const browser = fakeBrowser();

      await runCli(
        environment({
          argv: ['init', '--home', home.path, '--agent', 'cursor', '--no-open'],
          openUrl: browser.openUrl,
        }),
      );

      expect(browser.opened).toEqual([]);
      expect(stdout.join('\n')).toContain('Not opening a browser');
      expect(stdout.join('\n')).toContain('http://127.0.0.1:4040/setup');
    });

    it('writes the command given with --command', async () => {
      mkdirSync(join(home.path, '.codex'));

      await runCli(
        environment({
          argv: [
            'init',
            '--home',
            home.path,
            '--agent',
            'codex',
            '--dry-run',
            '--command',
            'node /tmp/dev/bin.js',
          ],
        }),
      );

      expect(stdout.join('\n')).toContain('command = "node"');
      expect(stdout.join('\n')).toContain('args = ["/tmp/dev/bin.js", "serve"]');
    });

    it('exits 1 when a configuration could not be written', async () => {
      writeFileSync(join(home.path, '.claude.json'), '{ not json', 'utf8');

      const code = await runCli(
        environment({ argv: ['init', '--home', home.path, '--agent', 'claude-code'] }),
      );

      expect(code).toBe(FAILURE_EXIT_CODE);
      expect(stdout.join('\n')).toContain('left');
      expect(readFileSync(join(home.path, '.claude.json'), 'utf8')).toBe('{ not json');
    });

    it('exits 1 when the API cannot start, having written the configuration first', async () => {
      const code = await runCli(
        environment({
          argv: ['init', '--home', home.path, '--agent', 'cursor'],
          startApi: async () => {
            throw new Error('listen EADDRINUSE: address already in use');
          },
        }),
      );

      expect(code).toBe(FAILURE_EXIT_CODE);
      expect(stdout.join('\n')).toContain('The local API did not start');
      expect(stdout.join('\n')).toContain('EADDRINUSE');
      expect(existsFile(join(home.path, '.cursor', 'mcp.json'))).toBe(true);
    });

    it('resolves the home directory from the environment when no flag is given', async () => {
      const code = await runCli(
        environment({
          argv: ['init', '--dry-run', '--agent', 'cursor'],
          env: { BROWSERREFLEX_HOME: home.path },
        }),
      );

      expect(code).toBe(USAGE_EXIT_CODE);
      expect(stdout.join('\n')).toContain(join(home.path, '.cursor', 'mcp.json'));
    });

    it('says which agent layout is experimental rather than presenting it as settled', async () => {
      await runCli(
        environment({
          argv: ['init', '--home', home.path, '--dry-run', '--agent', 'cursor,codex'],
        }),
      );

      const printed = stdout.join('\n');
      // Both of the named agents carry an unverified layout, and the output says so
      // rather than letting the person assume the file shape is confirmed.
      expect(printed).toContain('Cursor: Servers live under');
      expect(printed).toContain(
        'Codex: The entry is written as a [mcp_servers.browserreflex] table',
      );
      expect(printed.match(/This layout is experimental/g)).toHaveLength(2);
    });

    it('attaches the experimental claim to every agent, because none was run here', async () => {
      await runCli(
        environment({ argv: ['init', '--home', home.path, '--dry-run', '--agent', 'claude-code'] }),
      );

      const printed = stdout.join('\n');
      expect(printed).toContain('.claude.json');
      expect(printed).toContain('This layout is experimental');
    });

    it('dispatches the report command and exits with USAGE_EXIT_CODE', async () => {
      const code = await runCli(environment({ argv: ['report', '--home', home.path] }));

      expect(code).toBe(USAGE_EXIT_CODE);
      expect(stdout.join('\n')).toContain(
        'BrowserReflex measurement report: a measurement, not a promise.',
      );
    });
  });
});

function existsFile(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
