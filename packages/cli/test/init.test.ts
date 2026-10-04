/**
 * Tests for `init`.
 *
 * What the card is about, and what these tests back:
 *
 * - the entry lands in a detected agent's real configuration file, beside the
 *   entries that were already there, and the previous content is in a backup;
 * - a second run writes nothing, so there is one entry and no second backup;
 * - a file that cannot be understood is left exactly as it was;
 * - `--dry-run` prints the file it would write and changes nothing on disk;
 * - `--agent` chooses the agents, detection chooses them by default;
 * - the local API is started on loopback, the setup wizard address is reported,
 *   and opening a browser is skipped on request and survives a failure.
 *
 * Every home directory is a temporary directory created by `makeTempHome`. The
 * filesystem, the clock, the API and the browser launcher are injected, so no
 * test opens a real agent configuration, a real database, a real port or a real
 * browser window.
 *
 * The Windows and Linux layouts are checked as strings through the injectable
 * platform. Nothing here writes through a Windows path, because a path with
 * backslashes is not a path on the machine running these tests.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DATABASE_FILE_NAME,
  DATA_DIRECTORY_NAME,
  DEFAULT_INIT_PORT,
  SETUP_WIZARD_ROUTE,
  buildServerEntry,
  exitCodeFor,
  renderReport,
  resolveDatabasePath,
  runInit,
  selectAgents,
  type ApiHandleLike,
  type InitOptions,
  type OpenUrlFn,
  type StartApiFn,
} from '../src/init.js';
import { AGENT_IDS } from '../src/agents.js';
import { makeTempHome, type TempHome } from './helpers/temp-home.js';

const NOW = new Date('2026-10-04T09:30:15.250Z');

const DEFAULT_COMMAND = ['npx', '-y', 'browserreflex-mcp'];

/** A stand-in for the local API: reports a loopback address and records the request. */
function fakeApi(address = 'http://127.0.0.1:4040') {
  const requests: { port: number; databasePath: string; staticDir: string | undefined }[] = [];
  const startApi: StartApiFn = async (request) => {
    requests.push({
      port: request.port,
      databasePath: request.databasePath,
      staticDir: request.staticDir,
    });
    return {
      address,
      port: Number(address.split(':')[2] ?? '0'),
      stop: async (): Promise<void> => undefined,
    };
  };
  return { requests, startApi };
}

/** A stand-in for the browser launcher that records the address it was given. */
function fakeBrowser(attempted = true) {
  const opened: string[] = [];
  const openUrl: OpenUrlFn = (url) => {
    opened.push(url);
    return attempted ? { attempted: true } : { attempted: false, error: 'no launcher here' };
  };
  return { opened, openUrl };
}

/** An injected API that always refuses, standing in for a port already in use. */
const failingApi: StartApiFn = async () => {
  throw new Error('listen EADDRINUSE: address already in use');
};

describe('runInit against a temporary home', () => {
  let home: TempHome;

  beforeEach(() => {
    home = makeTempHome();
  });

  afterEach(() => {
    home.remove();
  });

  function options(overrides: Partial<InitOptions> = {}): InitOptions {
    return {
      home: home.path,
      platform: 'darwin',
      env: {},
      serverCommand: DEFAULT_COMMAND,
      now: NOW,
      startApi: fakeApi().startApi,
      ...overrides,
    };
  }

  function resultFor(report: Awaited<ReturnType<typeof runInit>>, agent: string) {
    const found = report.agents.find((entry) => entry.agent === agent);
    if (found === undefined) {
      throw new Error(`no result for ${agent}`);
    }
    return found;
  }

  it('writes the entry into a detected agent configuration', async () => {
    mkdirSync(join(home.path, '.cursor'));

    const report = await runInit(options());
    const cursor = resultFor(report, 'cursor');

    expect(cursor.detected).toBe(true);
    expect(cursor.status).toBe('created');
    expect(JSON.parse(readFileSync(cursor.configPath, 'utf8'))).toEqual({
      mcpServers: {
        browserreflex: { command: 'npx', args: ['-y', 'browserreflex-mcp', 'serve'] },
      },
    });
    expect(report.wroteAnyConfig).toBe(true);
    expect(exitCodeFor(report)).toBe(0);
  });

  it('init does not destroy an existing unrelated MCP server entry', async () => {
    // The named test for the claim that matters most about a file this command
    // does not own: another server's entry, and every other key in the document,
    // survive a run. It fails if the merge ever replaces the whole file.
    const configPath = join(home.path, '.claude.json');
    const previous = JSON.stringify(
      {
        numStartups: 12,
        mcpServers: {
          'someone-elses-server': { command: 'other', args: ['--stdio'] },
        },
      },
      null,
      2,
    );
    writeFileSync(configPath, previous, 'utf8');

    const report = await runInit(options());
    const claudeCode = resultFor(report, 'claude-code');

    expect(claudeCode.status).toBe('updated');
    const written = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(written['numStartups']).toBe(12);
    expect(written['mcpServers']).toEqual({
      'someone-elses-server': { command: 'other', args: ['--stdio'] },
      browserreflex: { command: 'npx', args: ['-y', 'browserreflex-mcp', 'serve'] },
    });
    // And the previous content is in the backup the report names.
    expect(claudeCode.backupPath).toBeDefined();
    expect(readFileSync(claudeCode.backupPath as string, 'utf8')).toBe(previous);
  });

  it('keeps an unrelated entry in a TOML configuration too', async () => {
    mkdirSync(join(home.path, '.codex'));
    writeFileSync(
      join(home.path, '.codex', 'config.toml'),
      ['model = "some-model"', '', '[mcp_servers.other-server]', 'command = "other"', ''].join(
        '\n',
      ),
      'utf8',
    );

    const report = await runInit(options());
    const codex = resultFor(report, 'codex');
    const written = readFileSync(codex.configPath, 'utf8');

    expect(codex.status).toBe('updated');
    expect(written).toContain('model = "some-model"');
    expect(written).toContain('[mcp_servers.other-server]');
    expect(written).toContain('[mcp_servers.browserreflex]');
  });

  it('writes nothing on a second run', async () => {
    mkdirSync(join(home.path, '.cursor'));

    await runInit(options());
    // The file did not exist, so the first run created it and backed up nothing.
    expect(readdirSync(join(home.path, '.cursor'))).toEqual(['mcp.json']);

    const second = await runInit(options({ now: new Date('2026-10-04T09:31:00.000Z') }));

    expect(resultFor(second, 'cursor').status).toBe('unchanged');
    expect(second.wroteAnyConfig).toBe(false);
    // Still one file: a second backup, or a rewrite of the same bytes, would show
    // up here.
    expect(readdirSync(join(home.path, '.cursor'))).toEqual(['mcp.json']);
    expect(exitCodeFor(second)).toBe(0);
  });

  it('leaves a file it cannot parse exactly as it found it', async () => {
    const configPath = join(home.path, '.claude.json');
    const broken = '{ this is not json';
    writeFileSync(configPath, broken, 'utf8');

    const report = await runInit(options());
    const claudeCode = resultFor(report, 'claude-code');

    expect(claudeCode.status).toBe('refused');
    expect(claudeCode.reason).toContain('not valid JSON');
    expect(readFileSync(configPath, 'utf8')).toBe(broken);
    expect(readdirSync(home.path)).toEqual(['.claude.json']);
    expect(report.refusedAnyConfig).toBe(true);
    expect(exitCodeFor(report)).toBe(1);
  });

  it('leaves a file it cannot read exactly as it found it', async () => {
    const configPath = join(home.path, '.gemini', 'settings.json');
    mkdirSync(join(home.path, '.gemini'), { recursive: true });
    writeFileSync(configPath, '{"mcpServers":{}}', 'utf8');

    const report = await runInit(
      options({
        // A file that exists but cannot be read must not be treated as missing:
        // that would overwrite it with a default document. The writes below throw
        // if anything tries, so this test cannot pass by being harmless.
        fs: {
          exists: () => true,
          read: () => undefined,
          mkdir: () => {
            throw new Error('nothing may be created');
          },
          write: () => {
            throw new Error('nothing may be written');
          },
        },
        agents: ['gemini-cli'],
      }),
    );
    const gemini = resultFor(report, 'gemini-cli');

    expect(gemini.status).toBe('refused');
    expect(gemini.reason).toContain('could not be read');
    expect(readFileSync(configPath, 'utf8')).toBe('{"mcpServers":{}}');
  });

  it('--dry-run changes nothing on disk', async () => {
    // The named test for the second claim in the card: a dry run writes nothing.
    // It fails if the command writes a configuration, a backup, a database or
    // starts anything.
    const configPath = join(home.path, '.claude.json');
    const previous = JSON.stringify({ mcpServers: { other: { command: 'other' } } }, null, 2);
    writeFileSync(configPath, previous, 'utf8');
    const api = fakeApi();
    const browser = fakeBrowser();

    const report = await runInit(
      options({
        dryRun: true,
        agents: ['claude-code'],
        startApi: api.startApi,
        openUrl: browser.openUrl,
      }),
    );

    // Nothing on disk.
    expect(readdirSync(home.path)).toEqual(['.claude.json']);
    expect(readFileSync(configPath, 'utf8')).toBe(previous);
    expect(existsSync(join(home.path, DATA_DIRECTORY_NAME))).toBe(false);
    // Nothing started.
    expect(api.requests).toEqual([]);
    expect(browser.opened).toEqual([]);
    expect(report.apiStatus).toBe('dry-run');
    expect(report.openStatus).toBe('dry-run');
    // And what it would have written is printed, which is the point of the flag.
    const claudeCode = resultFor(report, 'claude-code');
    expect(claudeCode.status).toBe('would-write');
    expect(claudeCode.wouldWrite).toContain('"browserreflex"');
    const printed = renderReport(report, true).join('\n');
    expect(printed).toContain('browserreflex');
    expect(printed).toContain('Dry run');
    expect(exitCodeFor(report)).toBe(0);
  });

  it('says a dry run would write nothing when the file already holds the entry', async () => {
    mkdirSync(join(home.path, '.cursor'));

    await runInit(options({ agents: ['cursor'] }));
    const report = await runInit(options({ agents: ['cursor'], dryRun: true }));
    const cursor = resultFor(report, 'cursor');

    expect(cursor.status).toBe('unchanged');
    expect(renderReport(report, true).join('\n')).not.toContain('would write');
  });

  it('writes only the agents that were detected, or that were named', async () => {
    mkdirSync(join(home.path, '.gemini'));

    const detected = await runInit(options());

    expect(resultFor(detected, 'gemini-cli').status).toBe('created');
    expect(resultFor(detected, 'cursor').status).toBe('not-selected');
    expect(existsSync(join(home.path, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('writes an agent that was named but not detected, and says so', async () => {
    const report = await runInit(options({ agents: ['cursor'] }));
    const cursor = resultFor(report, 'cursor');

    expect(cursor.detected).toBe(false);
    expect(cursor.status).toBe('created');
    expect(report.lines.join('\n')).toContain('not detected for this user');
  });

  it('writes nothing and says so when nothing is detected and nothing is named', async () => {
    const report = await runInit(options());

    expect(readdirSync(home.path)).toEqual([]);
    expect(report.agents.every((entry) => entry.status === 'not-selected')).toBe(true);
    expect(report.lines.join('\n')).toContain('No supported agent configuration was found');
  });

  it('reports each agent with the claim this package makes about its layout', async () => {
    const report = await runInit(options());

    // No layout was confirmed by running the agent, so all four say experimental.
    expect(report.agents.map((entry) => entry.configStatus)).toEqual([
      'experimental',
      'experimental',
      'experimental',
      'experimental',
    ]);
  });

  it('writes the command it was given, with serve appended', async () => {
    mkdirSync(join(home.path, '.cursor'));

    await runInit(options({ agents: ['cursor'], serverCommand: ['node', '/tmp/dev/bin.js'] }));
    const written = JSON.parse(readFileSync(join(home.path, '.cursor', 'mcp.json'), 'utf8'));

    expect(written.mcpServers.browserreflex).toEqual({
      command: 'node',
      args: ['/tmp/dev/bin.js', 'serve'],
    });
  });

  it('follows an agent configuration path override from the environment', async () => {
    const override = join(home.path, 'somewhere-else.json');

    const report = await runInit(
      options({
        agents: ['cursor'],
        env: { BROWSERREFLEX_CONFIG_PATH_CURSOR: override },
      }),
    );

    expect(resultFor(report, 'cursor').configPath).toBe(override);
    expect(existsSync(override)).toBe(true);
  });

  it('starts the local API on the default port and reports the wizard address', async () => {
    const api = fakeApi('http://127.0.0.1:4040');
    const browser = fakeBrowser();

    const report = await runInit(options({ startApi: api.startApi, openUrl: browser.openUrl }));

    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.port).toBe(DEFAULT_INIT_PORT);
    expect(report.apiStatus).toBe('started');
    expect(report.apiAddress).toBe('http://127.0.0.1:4040');
    expect(report.wizardUrl).toBe(`http://127.0.0.1:4040${SETUP_WIZARD_ROUTE}`);
    expect(browser.opened).toEqual([`http://127.0.0.1:4040${SETUP_WIZARD_ROUTE}`]);
    expect(report.openStatus).toBe('launched');
    expect(report.lines.join('\n')).toContain('loopback only');
    await report.handle?.stop();
  });

  it('uses the port it was given', async () => {
    const api = fakeApi('http://127.0.0.1:4141');

    const report = await runInit(options({ port: 4141, startApi: api.startApi, open: false }));

    expect(api.requests[0]?.port).toBe(4141);
    expect(report.wizardUrl).toBe(`http://127.0.0.1:4141${SETUP_WIZARD_ROUTE}`);
    await report.handle?.stop();
  });

  it('does not open a browser when it is told not to, and still prints the address', async () => {
    const api = fakeApi();
    const browser = fakeBrowser();

    const report = await runInit(
      options({ startApi: api.startApi, openUrl: browser.openUrl, open: false }),
    );

    expect(browser.opened).toEqual([]);
    expect(report.openStatus).toBe('skipped');
    expect(report.wizardUrl).toBe(`http://127.0.0.1:4040${SETUP_WIZARD_ROUTE}`);
    await report.handle?.stop();
  });

  it('reports a browser that would not open, and carries on', async () => {
    const api = fakeApi();
    const browser = fakeBrowser(false);

    const report = await runInit(options({ startApi: api.startApi, openUrl: browser.openUrl }));

    expect(report.openStatus).toBe('failed');
    expect(report.openError).toBe('no launcher here');
    expect(report.lines.join('\n')).toContain('Open http://127.0.0.1:4040/setup by hand');
    expect(exitCodeFor(report)).toBe(0);
    await report.handle?.stop();
  });

  it('keeps the configuration it wrote when the API cannot start, and fails the command', async () => {
    const browser = fakeBrowser();

    const report = await runInit(
      options({ agents: ['cursor'], startApi: failingApi, openUrl: browser.openUrl }),
    );

    expect(report.apiStatus).toBe('failed');
    expect(report.apiError).toContain('EADDRINUSE');
    expect(resultFor(report, 'cursor').status).toBe('created');
    expect(existsSync(join(home.path, '.cursor', 'mcp.json'))).toBe(true);
    expect(browser.opened).toEqual([]);
    expect(report.lines.join('\n')).toContain('The agent configurations above were still written');
    expect(exitCodeFor(report)).toBe(1);
  });

  it('says the UI has no build to serve rather than claiming a page is there', async () => {
    const report = await runInit(options({ startApi: fakeApi().startApi, open: false }));

    expect(report.lines.join('\n')).toContain('planned');
    await report.handle?.stop();
  });

  it('passes a built UI directory to the API when there is one', async () => {
    const api = fakeApi();

    const report = await runInit(
      options({ startApi: api.startApi, open: false, staticDir: join(home.path, 'ui') }),
    );

    expect(api.requests[0]?.staticDir).toBe(join(home.path, 'ui'));
    await report.handle?.stop();
  });

  it('puts the database under the home directory unless told otherwise', () => {
    expect(resolveDatabasePath('/opt/fakehome', 'darwin', {})).toBe(
      `/opt/fakehome/${DATA_DIRECTORY_NAME}/${DATABASE_FILE_NAME}`,
    );
    expect(resolveDatabasePath('C:\\fakehome', 'win32', {})).toBe(
      'C:\\fakehome\\.browserreflex\\browserreflex.db',
    );
    expect(
      resolveDatabasePath('/opt/fakehome', 'linux', { BROWSERREFLEX_DB_PATH: '/tmp/d.db' }),
    ).toBe('/tmp/d.db');
    // An explicit path wins over the environment variable.
    expect(
      resolveDatabasePath(
        '/opt/fakehome',
        'linux',
        { BROWSERREFLEX_DB_PATH: '/tmp/d.db' },
        '/tmp/o.db',
      ),
    ).toBe('/tmp/o.db');
  });

  it('reports the database path it would use, in the output', async () => {
    const report = await runInit(options({ startApi: fakeApi().startApi, open: false }));

    expect(report.databasePath).toBe(join(home.path, DATA_DIRECTORY_NAME, DATABASE_FILE_NAME));
    expect(renderReport(report, false).join('\n')).toContain(report.databasePath);
    await report.handle?.stop();
  });
});

describe('buildServerEntry', () => {
  it('puts the command first and serve last', () => {
    expect(buildServerEntry(DEFAULT_COMMAND)).toEqual({
      command: 'npx',
      args: ['-y', 'browserreflex-mcp', 'serve'],
    });
  });

  it('falls back to the bare command name when given an empty list', () => {
    expect(buildServerEntry([])).toEqual({ command: 'browserreflex-mcp', args: ['serve'] });
  });
});

describe('selectAgents', () => {
  it('takes exactly what was named, detected or not', () => {
    expect(selectAgents(['codex'], ['claude-code', 'cursor'])).toEqual(['codex']);
  });

  it('takes every detected agent when nothing was named', () => {
    expect(selectAgents([], ['claude-code', 'cursor'])).toEqual(['claude-code', 'cursor']);
  });

  it('takes nothing when nothing is named and nothing is detected', () => {
    expect(selectAgents([], [])).toEqual([]);
  });

  it('ignores a name it does not know', () => {
    expect(selectAgents(['emacs' as never], ['cursor'])).toEqual([]);
  });
});

describe('exitCodeFor', () => {
  const base = {
    home: '/opt/fakehome',
    platform: 'darwin' as const,
    agents: [],
    databasePath: '/tmp/db',
    openStatus: 'skipped' as const,
    wroteAnyConfig: false,
    refusedAnyConfig: false,
    lines: [],
  };

  it('is zero for a clean run', () => {
    expect(exitCodeFor({ ...base, apiStatus: 'started' })).toBe(0);
    expect(exitCodeFor({ ...base, apiStatus: 'dry-run' })).toBe(0);
  });

  it('is one when a configuration could not be written or the API could not start', () => {
    expect(exitCodeFor({ ...base, apiStatus: 'started', refusedAnyConfig: true })).toBe(1);
    expect(exitCodeFor({ ...base, apiStatus: 'failed' })).toBe(1);
  });
});

describe('the platforms this card covers', () => {
  it('reports the Windows and Linux layouts without writing through them', async () => {
    const home = makeTempHome('browserreflex-cli-platform-');
    // A Windows path is not a path on the machine running this test: a write
    // through one would create a file whose name holds backslashes, in whatever
    // directory the runner happens to be in. The filesystem here refuses every
    // write, so a dry run cannot reach the disk on either platform.
    const refusingFileSystem = {
      exists: () => false,
      read: () => undefined,
      mkdir: (path: string) => {
        throw new Error(`nothing may be created, asked for ${path}`);
      },
      write: (path: string) => {
        throw new Error(`nothing may be written, asked for ${path}`);
      },
    };

    try {
      for (const platform of ['win32', 'linux'] as const) {
        const report = await runInit({
          home: home.path,
          platform,
          env: {},
          serverCommand: DEFAULT_COMMAND,
          // Every agent is named, because a Windows detect path is not a path on
          // the machine running this test and nothing would be detected.
          agents: [...AGENT_IDS],
          dryRun: true,
          now: NOW,
          fs: refusingFileSystem,
          startApi: fakeApi().startApi,
        });

        expect(report.agents.map((entry) => entry.agent)).toEqual([...AGENT_IDS]);
        for (const entry of report.agents) {
          expect(entry.status).toBe('would-write');
          expect(entry.wouldWrite).toContain('browserreflex');
          if (platform === 'win32') {
            expect(entry.configPath).toContain('\\');
            expect(entry.configPath).not.toContain('/');
          } else {
            expect(entry.configPath).toContain('/');
          }
        }
      }
      // A dry run wrote nothing on either platform.
      expect(readdirSync(home.path)).toEqual([]);
    } finally {
      home.remove();
    }
  });
});

describe('the handle init hands back', () => {
  it('stops the server it started', async () => {
    const home = makeTempHome('browserreflex-cli-handle-');
    let stops = 0;
    const startApi: StartApiFn = async () => ({
      address: 'http://127.0.0.1:4040',
      port: 4040,
      stop: async (): Promise<void> => {
        stops += 1;
      },
    });

    try {
      const report = await runInit({
        home: home.path,
        env: {},
        serverCommand: DEFAULT_COMMAND,
        startApi,
        open: false,
      });
      const handle: ApiHandleLike | undefined = report.handle;

      expect(handle).toBeDefined();
      await handle?.stop();
      expect(stops).toBe(1);
    } finally {
      home.remove();
    }
  });
});
