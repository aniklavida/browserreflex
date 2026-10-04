/**
 * The command dispatcher.
 *
 * `runCli` takes its arguments, its output streams and every side effect as
 * parameters, so the whole command can be exercised in a test without a terminal,
 * a port or a home directory that is not a temporary one. `bin.ts` is the thin
 * wrapper that passes the real ones.
 *
 * Status: **implemented and tested** in `packages/cli/test/cli.test.ts`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SERVER_COMMAND, parseArgs, usageText, type ParsedArgs } from './args.js';
import { AGENT_DEFINITIONS } from './agents.js';
import { startMcpStdio } from './api-bridge.js';
import {
  DEFAULT_INIT_PORT,
  exitCodeFor,
  renderReport,
  resolveDatabasePath,
  runInit,
  type InitOptions,
  type InitReport,
  type StartApiFn,
  type OpenUrlFn,
} from './init.js';
import { currentPlatform, resolveHome } from './paths.js';
import { runReport } from './report.js';

/** Where the command writes its human-readable output. */
export interface CliStreams {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

/** Everything `runCli` needs from the outside world. */
export interface CliEnvironment {
  readonly argv: readonly string[];
  readonly streams: CliStreams;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly platform?: ReturnType<typeof currentPlatform> | undefined;
  readonly version?: string | undefined;
  readonly startApi?: StartApiFn | undefined;
  readonly openUrl?: OpenUrlFn | undefined;
  readonly startMcp?: (() => Promise<unknown>) | undefined;
  /** Injected clock, so a backup name in the output is predictable. */
  readonly now?: Date | undefined;
  /** Resolves the built UI directory. Omit to run without serving a UI. */
  readonly staticDir?: string | undefined;
  /**
   * Resolves when the foreground command should return. Omitted, `init` waits for
   * an interrupt; a test passes an already-resolved promise.
   */
  readonly waitUntilStopped?: Promise<void> | undefined;
}

export const USAGE_EXIT_CODE = 0;
export const FAILURE_EXIT_CODE = 1;
export const USAGE_ERROR_EXIT_CODE = 2;

/** The version, from this package's own manifest. */
export function packageVersion(): string {
  const manifestUrl = new URL('../package.json', import.meta.url);
  try {
    const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * The built UI directory, if one exists.
 *
 * The UI package is a placeholder with no build, so this normally returns
 * undefined and `init` says so rather than claiming a page is there. The URL is
 * turned into a path with `fileURLToPath`, so a Windows path comes out with
 * backslashes and a percent-escape in a directory name is decoded.
 */
export function findStaticUiDir(): string | undefined {
  const candidates = [
    new URL('../ui/dist/', import.meta.url),
    new URL('../../ui/dist/', import.meta.url),
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    if (existsSync(join(path, 'index.html'))) {
      return path;
    }
  }
  return undefined;
}

/** Runs one command and returns the process exit code. */
export async function runCli(environment: CliEnvironment): Promise<number> {
  const version = environment.version ?? packageVersion();
  const parsed = parseArgs(environment.argv);

  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) {
      environment.streams.stderr(error);
    }
    environment.streams.stderr('');
    environment.streams.stderr(usageText(version));
    return USAGE_ERROR_EXIT_CODE;
  }

  switch (parsed.command) {
    case 'help':
      environment.streams.stdout(usageText(version));
      environment.streams.stdout('');
      environment.streams.stdout('Agents this command can configure:');
      for (const line of agentSummaryLines()) {
        environment.streams.stdout(line);
      }
      return USAGE_EXIT_CODE;
    case 'version':
      environment.streams.stdout(version);
      return USAGE_EXIT_CODE;
    case 'serve':
      return runServe(parsed, environment);
    case 'init':
      return runInitCommand(parsed, environment);
    case 'report':
      return runReportCommand(parsed, environment);
  }
}

/**
 * Runs the MCP server on stdio.
 *
 * `--home` and `--db` are applied to this process before the server package opens
 * its database: it resolves the file from `BROWSERREFLEX_DB_PATH`, so the flag is
 * turned into that variable rather than accepted and ignored. The value is put
 * back afterwards, because the database is already open by then and the variable
 * is this process's own.
 */
async function runServe(parsed: ParsedArgs, environment: CliEnvironment): Promise<number> {
  const start = environment.startMcp ?? startMcpStdio;
  const env = environment.env ?? process.env;
  const home = resolveHome({
    home: parsed.home,
    env,
    platform: environment.platform,
  });
  const databasePath = resolveDatabasePath(home.home, home.platform, env, parsed.databasePath);
  const previous = process.env['BROWSERREFLEX_DB_PATH'];
  if (previous !== databasePath) {
    process.env['BROWSERREFLEX_DB_PATH'] = databasePath;
  }

  try {
    await start();
    return USAGE_EXIT_CODE;
  } catch (error) {
    environment.streams.stderr(
      `browserreflex mcp server failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
    return FAILURE_EXIT_CODE;
  } finally {
    if (previous === undefined) {
      delete process.env['BROWSERREFLEX_DB_PATH'];
    } else {
      process.env['BROWSERREFLEX_DB_PATH'] = previous;
    }
  }
}

async function runInitCommand(parsed: ParsedArgs, environment: CliEnvironment): Promise<number> {
  const home = resolveHome({
    home: parsed.home,
    env: environment.env ?? process.env,
    platform: environment.platform,
  });

  const options: InitOptions = {
    home: home.home,
    platform: home.platform,
    env: environment.env ?? process.env,
    serverCommand: parsed.serverCommand.length > 0 ? parsed.serverCommand : DEFAULT_SERVER_COMMAND,
    agents: parsed.agents,
    dryRun: parsed.dryRun,
    open: parsed.open,
    port: parsed.port ?? DEFAULT_INIT_PORT,
    databasePath: parsed.databasePath,
    staticDir: environment.staticDir,
    now: environment.now,
    startApi: environment.startApi,
    openUrl: environment.openUrl,
  };

  let report: InitReport;
  try {
    report = await runInit(options);
  } catch (error) {
    environment.streams.stderr(
      `browserreflex init failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return FAILURE_EXIT_CODE;
  }

  for (const line of renderReport(report, parsed.dryRun)) {
    environment.streams.stdout(line);
  }

  if (report.handle !== undefined) {
    // The command stays in the foreground while the wizard is reachable, and the
    // handle closes the listener and the database on the way out. A test injects
    // its own wait so it does not have to interrupt anything.
    await (environment.waitUntilStopped ?? waitForInterrupt(report.handle));
  }

  return exitCodeFor(report);
}

async function runReportCommand(parsed: ParsedArgs, environment: CliEnvironment): Promise<number> {
  const home = resolveHome({
    home: parsed.home,
    env: environment.env ?? process.env,
    platform: environment.platform,
  });
  const databasePath = resolveDatabasePath(
    home.home,
    home.platform,
    environment.env ?? process.env,
    parsed.databasePath,
  );

  return runReport({
    databasePath,
    since: parsed.since,
    json: parsed.json,
    now: environment.now,
    streams: environment.streams,
  });
}

function waitForInterrupt(handle: NonNullable<InitReport['handle']>): Promise<void> {
  return new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) {
        return;
      }
      stopping = true;
      void handle.stop().finally(() => resolve());
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/** A short summary of what the agents are and what this package knows about them. */
export function agentSummaryLines(): string[] {
  return AGENT_DEFINITIONS.map(
    (definition) =>
      `  ${definition.id.padEnd(12)} ${definition.format}  ${definition.note} (${definition.status})`,
  );
}
