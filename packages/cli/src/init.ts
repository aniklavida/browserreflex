/**
 * `browserreflex-mcp init`: write this package's MCP entry into the configuration
 * of every supported agent found on this machine, then start the local API and
 * open the setup wizard.
 *
 * What the command promises:
 *
 * - It touches exactly one entry per agent, named `browserreflex`. Every other
 *   key in the file, and every other server's entry, is copied through byte for
 *   byte.
 * - An existing file is copied to a timestamped backup before it is written. A
 *   file that cannot be read, does not parse, or whose `mcpServers` key is not an
 *   object, is left alone and reported; it is never replaced.
 * - Running it twice writes nothing the second time, so there is one entry and at
 *   most one new backup rather than a pile of them.
 * - `--dry-run` prints the whole file as it would be written and changes nothing:
 *   no configuration file, no database, no listening port, no browser.
 * - Opening a browser is best effort. The address is printed either way.
 * - `env` defaults to an empty object rather than `process.env`, so a caller that
 *   forgets to inject one cannot have its output decided by the machine it runs
 *   on. `bin.ts` passes the real environment; every test passes `{}` or a
 *   temporary path.
 *
 * What the command is not: it cannot make an agent reload the configuration it
 * wrote, and it cannot make an agent call anything. The safety check in the server
 * is advisory, and this command does not change that.
 *
 * Status: **implemented and tested** on macOS in `packages/cli/test/init.test.ts`,
 * against temporary home directories. The Windows and Linux layouts and launcher
 * commands are exercised through the injectable platform; nothing was run on
 * those operating systems.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  AGENT_DEFINITIONS,
  SERVER_ENTRY_NAME,
  configPathOverrideVariable,
  resolveAgentConfigPath,
  type AgentDefinition,
  type AgentId,
  type ConfigFormat,
  type ConfigStatus,
} from './agents.js';
import { mergeJsonConfig, type McpServerEntry } from './config-json.js';
import { mergeTomlConfig, CODEX_SERVERS_KEY } from './config-toml.js';
import { backupPathFor, writeConfigFile } from './config-write.js';
import { startApiForDatabase } from './api-bridge.js';
import { openUrl } from './open-url.js';
import { SERVE_ARGUMENT } from './args.js';
import { currentPlatform, joinFor, type Platform } from './paths.js';

/** The route the setup wizard is expected to live at. */
export const SETUP_WIZARD_ROUTE = '/setup';

/** The default port of the local API, matching the server package. */
export const DEFAULT_INIT_PORT = 4040;

/** The directory the database lives in, under the home directory. */
export const DATA_DIRECTORY_NAME = '.browserreflex';

export const DATABASE_FILE_NAME = 'browserreflex.db';

export type AgentWriteStatus =
  /** The file did not exist and was created. */
  | 'created'
  /** The file existed and now holds this entry. */
  | 'updated'
  /** The file already held exactly this entry; nothing was written. */
  | 'unchanged'
  /** Nothing was written because `--dry-run` was given. */
  | 'would-write'
  /** The file was left alone; `reason` says why. */
  | 'refused'
  /** This agent was not part of the run. */
  | 'not-selected';

export interface AgentResult {
  readonly agent: AgentId;
  readonly label: string;
  readonly format: ConfigFormat;
  /** What this package knows about the agent's configuration layout. */
  readonly configStatus: ConfigStatus;
  /** True when one of the agent's detect paths was found on disk. */
  readonly detected: boolean;
  readonly configPath: string;
  readonly status: AgentWriteStatus;
  /** Where the previous content was kept, when a file was written. */
  readonly backupPath?: string | undefined;
  /** Why the file was refused, or why the agent was not part of the run. */
  readonly reason?: string | undefined;
  /** The entry as it is written. */
  readonly entry?: McpServerEntry | undefined;
  /** The whole file as it would be on disk; only set for `--dry-run`. */
  readonly wouldWrite?: string | undefined;
}

export type ApiStatus = 'started' | 'dry-run' | 'failed';
/**
 * What happened to the browser.
 *
 * `launched` means the platform's launcher command was started, not that a window
 * appeared: nothing waits for one, and this command has no way to know. The
 * output says so in the same words rather than claiming a browser opened.
 */
export type OpenStatus = 'launched' | 'skipped' | 'failed' | 'dry-run';

export interface ApiHandleLike {
  readonly address: string;
  readonly port: number;
  stop(): Promise<void>;
}

export interface StartApiRequest {
  readonly port: number;
  readonly staticDir: string | undefined;
  readonly databasePath: string;
}

export type StartApiFn = (request: StartApiRequest) => Promise<ApiHandleLike>;

export interface OpenUrlResult {
  readonly attempted: boolean;
  readonly error?: string | undefined;
}

export type OpenUrlFn = (url: string) => OpenUrlResult;

/** The filesystem operations `init` needs, injected so a test can watch them. */
export interface InitFileSystem {
  exists(path: string): boolean;
  read(path: string): string | undefined;
  mkdir(path: string): void;
  write(path: string, text: string): void;
}

export interface InitOptions {
  readonly home: string;
  readonly platform?: Platform | undefined;
  /**
   * Variables consulted for path overrides. Defaults to an empty object, never to
   * `process.env`: an injected home directory is only a safe test input if the
   * variables around it cannot redirect the command somewhere else.
   */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** The command written into the entry, before `serve` is appended. */
  readonly serverCommand: readonly string[];
  readonly agents?: readonly AgentId[] | undefined;
  readonly dryRun?: boolean | undefined;
  /** False for `--no-open`. */
  readonly open?: boolean | undefined;
  readonly port?: number | undefined;
  /** Database file to use; defaults to `<home>/.browserreflex/browserreflex.db`. */
  readonly databasePath?: string | undefined;
  /** Directory holding the built UI. Omitted when there is no build to serve. */
  readonly staticDir?: string | undefined;
  /** Injected clock, so backup names are predictable. */
  readonly now?: Date | undefined;
  readonly fs?: InitFileSystem | undefined;
  readonly startApi?: StartApiFn | undefined;
  readonly openUrl?: OpenUrlFn | undefined;
}

export interface InitReport {
  readonly home: string;
  readonly platform: Platform;
  readonly agents: readonly AgentResult[];
  readonly databasePath: string;
  readonly apiStatus: ApiStatus;
  readonly apiAddress?: string | undefined;
  readonly apiError?: string | undefined;
  readonly openStatus: OpenStatus;
  readonly wizardUrl?: string | undefined;
  readonly openError?: string | undefined;
  /** The running server, when one started. Stop it with `stop()`. */
  readonly handle?: ApiHandleLike | undefined;
  /** True when at least one agent configuration file was written. */
  readonly wroteAnyConfig: boolean;
  /** True when at least one agent configuration file could not be written. */
  readonly refusedAnyConfig: boolean;
  /** What happened, one line per event, in the order it happened. */
  readonly lines: readonly string[];
}

const realFileSystem: InitFileSystem = {
  exists: (path) => existsSync(path),
  read: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  mkdir: (path) => {
    mkdirSync(path, { recursive: true });
  },
  write: (path, text) => {
    writeFileSync(path, text, 'utf8');
  },
};

/** The entry written into an agent configuration. */
export function buildServerEntry(serverCommand: readonly string[]): McpServerEntry {
  return {
    command: serverCommand[0] ?? 'browserreflex-mcp',
    args: [...serverCommand.slice(1), SERVE_ARGUMENT],
  };
}

/**
 * Which agents this run writes to.
 *
 * With `--agent` the list is exactly what was named, detected or not: the person
 * asked for it, and the output says whether it was detected. Without it, every
 * detected agent.
 */
export function selectAgents(
  requested: readonly AgentId[],
  detected: readonly AgentId[],
): readonly AgentId[] {
  if (requested.length > 0) {
    return requested.filter((id) => AGENT_DEFINITIONS.some((definition) => definition.id === id));
  }
  return detected;
}

/**
 * Merges the entry into one agent's configuration and reports exactly what
 * happened to the file.
 *
 * The status comes from what was on disk and what was written, never from what
 * was intended. A refusal reports `refused`.
 */
export function applyAgentConfig(options: {
  readonly definition: AgentDefinition;
  readonly configPath: string;
  readonly detected: boolean;
  readonly entry: McpServerEntry;
  readonly dryRun: boolean;
  readonly now: Date;
  readonly fs: InitFileSystem;
}): AgentResult {
  const { definition, configPath, detected, entry, dryRun, now, fs } = options;
  const existedBefore = fs.exists(configPath);
  const existing = existedBefore ? fs.read(configPath) : undefined;

  const base = {
    agent: definition.id,
    label: definition.label,
    format: definition.format,
    configStatus: definition.status,
    detected,
    configPath,
    entry,
  } as const;

  if (existedBefore && existing === undefined) {
    // The file is there and could not be read: wrong permissions, a directory
    // where a file should be, or an encoding this process cannot decode. Treating
    // that as "no file" would overwrite the only copy of whatever is in it with a
    // default document, so it is refused instead.
    return {
      ...base,
      status: 'refused',
      reason: 'the file exists but could not be read, so it was left alone',
    };
  }

  const merged =
    definition.format === 'json'
      ? mergeJsonConfig(existing, entry, { entryName: SERVER_ENTRY_NAME })
      : mergeTomlConfig(existing, entry, {
          tableName: `${CODEX_SERVERS_KEY}.${SERVER_ENTRY_NAME}`,
        });

  if (!merged.ok) {
    return { ...base, status: 'refused', reason: merged.error };
  }

  if (dryRun) {
    // A file that already holds exactly the merged text is reported as unchanged
    // even in a dry run: saying it "would be written" when it already is would
    // be a claim about a change that will not happen.
    return merged.outcome === 'unchanged'
      ? { ...base, status: 'unchanged', wouldWrite: merged.text }
      : { ...base, status: 'would-write', wouldWrite: merged.text };
  }

  const written = writeConfigFile({
    configPath,
    text: merged.text,
    previousText: existing,
    now,
    fs: { mkdir: (path) => fs.mkdir(path), write: (path, text) => fs.write(path, text) },
  });

  return {
    ...base,
    status: merged.outcome,
    backupPath: written.backupPath,
  };
}

/** Where the SQLite file goes: an explicit path, the environment, else the home directory. */
export function resolveDatabasePath(
  home: string,
  platform: Platform,
  env: NodeJS.ProcessEnv = {},
  explicit?: string | undefined,
): string {
  if (explicit !== undefined && explicit !== '') {
    return explicit;
  }
  const fromEnvironment = env['BROWSERREFLEX_DB_PATH'];
  if (fromEnvironment !== undefined && fromEnvironment !== '') {
    return fromEnvironment;
  }
  return joinFor(platform, home, DATA_DIRECTORY_NAME, DATABASE_FILE_NAME);
}

function describeBackup(result: AgentResult, now: Date): string {
  return result.backupPath ?? backupPathFor(result.configPath, now);
}

/**
 * Runs the whole of `init` and returns a report of what happened.
 *
 * Everything that reaches outside this process is injected, so every test in this
 * package runs against a temporary directory and never the real home directory.
 */
export async function runInit(options: InitOptions): Promise<InitReport> {
  const fs = options.fs ?? realFileSystem;
  const platform = options.platform ?? currentPlatform();
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? new Date();
  const env = options.env ?? {};
  const lines: string[] = [];

  const detected: AgentId[] = [];
  const prepared: {
    definition: AgentDefinition;
    configPath: string;
    detected: boolean;
  }[] = [];

  for (const definition of AGENT_DEFINITIONS) {
    const resolved = resolveAgentConfigPath(definition, {
      platform,
      home: options.home,
      env,
      configPathOverride: env[configPathOverrideVariable(definition.id)],
    });
    const isDetected = resolved.detectPaths.some((path) => fs.exists(path));
    if (isDetected) {
      detected.push(definition.id);
    }
    prepared.push({ definition, configPath: resolved.configPath, detected: isDetected });
  }

  const selected = new Set(selectAgents(options.agents ?? [], detected));
  const entry = buildServerEntry(options.serverCommand);
  const databasePath = resolveDatabasePath(options.home, platform, env, options.databasePath);

  const results: AgentResult[] = [];
  let wroteAnyConfig = false;
  let refusedAnyConfig = false;

  for (const item of prepared) {
    if (!selected.has(item.definition.id)) {
      results.push({
        agent: item.definition.id,
        label: item.definition.label,
        format: item.definition.format,
        configStatus: item.definition.status,
        detected: item.detected,
        configPath: item.configPath,
        status: 'not-selected',
        reason: 'not detected, and not named with --agent',
      });
      continue;
    }

    if (!item.detected) {
      lines.push(
        `${item.definition.label}: not detected for this user; writing ${item.configPath} because it was named with --agent.`,
      );
    }

    const result = applyAgentConfig({
      definition: item.definition,
      configPath: item.configPath,
      detected: item.detected,
      entry,
      dryRun,
      now,
      fs,
    });
    results.push(result);

    if (item.definition.status === 'experimental') {
      // The output must not present an unverified file layout as a settled one.
      lines.push(
        `${result.label}: ${item.definition.note} This layout is experimental: it was written from that agent's published convention and was not confirmed by running the agent.`,
      );
    }

    switch (result.status) {
      case 'created':
        wroteAnyConfig = true;
        lines.push(
          `${result.label}: wrote ${result.configPath}. The file did not exist, so there was nothing to back up.`,
        );
        break;
      case 'updated':
        wroteAnyConfig = true;
        lines.push(
          `${result.label}: added the ${SERVER_ENTRY_NAME} entry to ${result.configPath}. The previous content is at ${describeBackup(result, now)}.`,
        );
        break;
      case 'unchanged':
        lines.push(
          `${result.label}: ${SERVER_ENTRY_NAME} is already configured in ${result.configPath}; nothing was written.`,
        );
        break;
      case 'would-write':
        lines.push(
          `${result.label}: would write ${result.configPath} (dry run; nothing on disk was changed).`,
        );
        break;
      case 'refused':
        refusedAnyConfig = true;
        lines.push(
          `${result.label}: left ${result.configPath} alone because ${result.reason ?? 'of an unknown reason'}.`,
        );
        break;
      case 'not-selected':
        break;
    }
  }

  if (selected.size === 0) {
    lines.push(
      'No supported agent configuration was found and none was named with --agent, so no configuration file was written.',
    );
  }

  const plannedPort = options.port ?? DEFAULT_INIT_PORT;

  if (dryRun) {
    const plannedUrl = `http://127.0.0.1:${plannedPort}${SETUP_WIZARD_ROUTE}`;
    lines.push(
      `Dry run: the local API would listen on http://127.0.0.1:${plannedPort} and the setup wizard would be at ${plannedUrl}. Nothing was started and no browser was opened.`,
    );
    lines.push(`Dry run: the decision database would be created at ${databasePath}.`);
    return {
      home: options.home,
      platform,
      agents: results,
      databasePath,
      apiStatus: 'dry-run',
      openStatus: 'dry-run',
      wizardUrl: plannedUrl,
      wroteAnyConfig,
      refusedAnyConfig,
      lines,
    };
  }

  const start = options.startApi ?? startLocalApiWithStore;
  let handle: ApiHandleLike;
  try {
    handle = await start({
      port: plannedPort,
      staticDir: options.staticDir,
      databasePath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lines.push(
      `The local API did not start: ${message}. The agent configurations above were still written. Run init again with a different --port, or start the server with "browserreflex-mcp serve".`,
    );
    return {
      home: options.home,
      platform,
      agents: results,
      databasePath,
      apiStatus: 'failed',
      apiError: message,
      openStatus: 'skipped',
      wroteAnyConfig,
      refusedAnyConfig,
      lines,
    };
  }

  const wizardUrl = `${handle.address}${SETUP_WIZARD_ROUTE}`;
  lines.push(`Local API listening on ${handle.address}, bound to loopback only.`);
  lines.push(`The setup wizard is at ${wizardUrl}.`);
  if (options.staticDir === undefined) {
    lines.push(
      'The UI package has no build to serve yet, so that route answers 404 until it does. Status: planned.',
    );
  }

  let openStatus: OpenStatus;
  let openError: string | undefined;

  if (options.open === false) {
    openStatus = 'skipped';
    lines.push(`Not opening a browser (--no-open). Open ${wizardUrl} by hand.`);
  } else {
    const result = (options.openUrl ?? defaultOpenUrl(platform))(wizardUrl);
    if (result.attempted) {
      openStatus = 'launched';
      lines.push(
        `Started the browser launcher for ${wizardUrl}. Whether a window appeared was not checked.`,
      );
    } else {
      openStatus = 'failed';
      openError = result.error;
      lines.push(
        `No browser was opened: ${result.error ?? 'the platform launcher is unavailable'}. Open ${wizardUrl} by hand.`,
      );
    }
  }

  return {
    home: options.home,
    platform,
    agents: results,
    databasePath,
    apiStatus: 'started',
    apiAddress: handle.address,
    openStatus,
    wizardUrl,
    openError,
    wroteAnyConfig,
    refusedAnyConfig,
    lines,
    // The caller keeps the process alive and stops the server through this
    // handle, which closes the listener and then the database.
    handle,
  };
}

const startLocalApiWithStore: StartApiFn = async (request) =>
  startApiForDatabase(request.databasePath, {
    port: request.port,
    staticDir: request.staticDir,
  });

function defaultOpenUrl(platform: Platform): OpenUrlFn {
  return (url) => openUrl(url, { platform });
}

/** The exit code the process should use for a report. */
export function exitCodeFor(report: InitReport): number {
  if (report.refusedAnyConfig || report.apiStatus === 'failed') {
    return 1;
  }
  return 0;
}

/** The lines to print for a report, including the dry-run file contents. */
export function renderReport(report: InitReport, dryRun: boolean): string[] {
  const header = [
    `BrowserReflex init on ${report.platform}. Home ${report.home}. Decision database ${report.databasePath}.`,
  ];
  if (dryRun) {
    header.push('Dry run: no file was created or changed, and nothing was started.');
  }
  const output = [...header, ...report.lines];
  for (const result of report.agents) {
    // Both statuses that carry the whole file are dry-run outcomes: the file as
    // it would be written, and the file as it already is.
    if (
      (result.status === 'would-write' || result.status === 'unchanged') &&
      result.wouldWrite !== undefined
    ) {
      output.push(
        '',
        `--- ${result.label}: ${result.configPath} (this is the whole file) ---`,
        result.wouldWrite.replace(/\n$/, ''),
        `--- end ${result.configPath} ---`,
      );
    }
  }
  return output;
}
