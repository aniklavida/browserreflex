/**
 * Tests for the executable itself, run as a child process.
 *
 * Everything above tests functions. This file runs the file a package manager
 * links onto `PATH` as `browserreflex-mcp`, on Node 22, and checks the three
 * claims a user of the command can check for themselves: `--version` and
 * `--help` answer and exit 0, `init --dry-run` writes nothing, and `init` starts
 * the local API on loopback, prints the setup wizard address and stops when it is
 * interrupted.
 *
 * The home directory is a temporary directory and `--no-open` is passed wherever
 * `init` runs for real, so no browser window appears and no real agent
 * configuration is read or written.
 *
 * This is the evidence for the platform claim in the package README: it was run
 * on macOS. The Windows and Linux layouts are not run here at all.
 */

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeTempHome, type TempHome } from './helpers/temp-home.js';

const here = dirname(fileURLToPath(import.meta.url));
/** The `packages/cli` directory. */
const cliPackageRoot = resolve(here, '..');
/** The `packages/server` directory, which the bridge loads. */
const serverPackageRoot = resolve(cliPackageRoot, '../server');
const builtEntry = join(cliPackageRoot, 'dist', 'bin.js');

/**
 * The compiled entry, rebuilt whenever a source file is newer than it.
 *
 * These tests are the only evidence about the file a package manager links onto
 * `PATH`, so they must run the current sources and not a stale `dist`: an earlier
 * version of this file that trusted whatever was in `dist` kept passing while the
 * source underneath it was broken. Comparing modification times catches an edited
 * source without paying for a `tsc` run on every test, which matters because this
 * file shares the machine with the server package's one-second startup budget.
 *
 * A build failure here fails the test with that output rather than quietly running
 * an old binary.
 */
function ensureBuiltEntry(): string {
  const require = createRequire(import.meta.url);
  const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
  const packages = [
    { root: serverPackageRoot, entry: join(serverPackageRoot, 'dist/api/index.js') },
    { root: cliPackageRoot, entry: builtEntry },
  ];

  for (const { root, entry } of packages) {
    if (existsSync(entry) && !isStale(root, entry)) {
      continue;
    }
    execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')], {
      cwd: root,
      stdio: 'inherit',
    });
  }

  for (const { entry } of packages) {
    if (!existsSync(entry)) {
      throw new Error(`The compiled entry ${entry} is missing after a build.`);
    }
  }
  return builtEntry;
}

/** True when any source of a package is newer than its compiled entry. */
function isStale(packageRoot: string, entry: string): boolean {
  const builtAt = statSync(entry).mtimeMs;
  const sources = [
    // `recursive` returns paths relative to the directory it was given, so the
    // `src` prefix is put back on before the path is resolved.
    ...readdirSync(join(packageRoot, 'src'), { recursive: true, encoding: 'utf8' }).map((name) =>
      join('src', name),
    ),
    join('package.json'),
    join('tsconfig.json'),
  ];
  const paths = sources.map((source) => join(packageRoot, source));
  if (paths.some((path) => !existsSync(path))) {
    throw new Error(
      `the source list for ${packageRoot} is wrong: a path in it does not exist, so nothing can be compared`,
    );
  }
  return paths.some((path) => statSync(path).mtimeMs > builtAt);
}

interface Completed {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the executable to completion and collects what it printed. */
function run(entry: string, args: readonly string[], timeoutMs = 60_000): Promise<Completed> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: cliPackageRoot,
      env: { ...process.env, HOME: '/nonexistent-home-for-this-test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`the command did not finish within ${timeoutMs}ms. stdout: ${stdout}`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

describe('the browserreflex-mcp executable', () => {
  let entry: string;
  let home: TempHome;

  beforeAll(() => {
    entry = ensureBuiltEntry();
  });

  afterEach(() => {
    home?.remove();
  });

  it('prints its version and exits 0', async () => {
    home = makeTempHome('browserreflex-cli-bin-');

    const result = await run(entry, ['--version']);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  }, 120_000);

  it('prints usage for --help and names both commands, and exits 0', async () => {
    home = makeTempHome('browserreflex-cli-bin-');

    const result = await run(entry, ['--help']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('browserreflex-mcp init');
    expect(result.stdout).toContain('browserreflex-mcp serve');
    expect(result.stdout).toContain('--dry-run');
  }, 120_000);

  it('exits 2 with usage on an option it does not know', async () => {
    home = makeTempHome('browserreflex-cli-bin-');

    const result = await run(entry, ['init', '--nope']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown option "--nope"');
  }, 120_000);

  it('changes nothing on disk with --dry-run', async () => {
    home = makeTempHome('browserreflex-cli-bin-');

    const result = await run(entry, [
      'init',
      '--dry-run',
      '--home',
      home.path,
      '--agent',
      'cursor',
      '--no-open',
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Dry run');
    expect(result.stdout).toContain('"browserreflex"');
    expect(readdirSync(home.path)).toEqual([]);
  }, 120_000);

  it('writes the entry, starts the API on loopback and stops when interrupted', async () => {
    home = makeTempHome('browserreflex-cli-bin-');

    const started = await new Promise<{
      stdout: string;
      stderr: string;
      child: ReturnType<typeof spawn>;
    }>((done, fail) => {
      const child = spawn(
        process.execPath,
        [entry, 'init', '--home', home.path, '--agent', 'cursor', '--no-open', '--port', '0'],
        {
          cwd: cliPackageRoot,
          // HOME points somewhere that does not exist, so the only configuration
          // this process can find is the one --home named.
          env: { ...process.env, HOME: '/nonexistent-home-for-this-test' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        fail(new Error(`init did not finish its report. stdout: ${stdout}\nstderr: ${stderr}`));
      }, 60_000);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        // The last line `init` prints when it is told not to open a browser. It
        // comes after the address, so waiting for it means the whole report has
        // been flushed rather than the first half of it.
        if (stdout.includes('Not opening a browser')) {
          clearTimeout(timer);
          done({ stdout, stderr, child });
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        fail(error);
      });
    });

    // The address is loopback and the wizard route is on the same port.
    const address = /Local API listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(started.stdout)?.[1];
    expect(address).toBeDefined();
    expect(started.stdout).toContain(`${address as string}/setup`);
    expect(started.stdout).toContain('Not opening a browser');

    // The agent configuration was written into the temporary home.
    const written = JSON.parse(readFileSync(join(home.path, '.cursor', 'mcp.json'), 'utf8'));
    expect(written.mcpServers.browserreflex).toEqual({
      command: 'npx',
      args: ['-y', 'browserreflex-mcp', 'serve'],
    });

    // And the database the API was serving was created there too.
    expect(existsSync(join(home.path, '.browserreflex', 'browserreflex.db'))).toBe(true);

    const exit = await new Promise<number | null>((done) => {
      started.child.once('close', (code) => done(code));
      started.child.kill('SIGTERM');
    });

    expect(exit).toBe(0);
  }, 180_000);
});
