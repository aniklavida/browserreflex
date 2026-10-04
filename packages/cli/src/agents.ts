/**
 * The agents this card detects and configures, and where each one keeps its MCP
 * configuration.
 *
 * Each definition states the format and the path it believes in, and the claim
 * this card can make about that belief. **No definition here has been confirmed
 * by running the agent**, so every one of them is marked `experimental`, the
 * package README repeats that, and `init` prints it for each agent it writes.
 * Every definition is additive: this package only ever adds or replaces its own
 * entry inside someone else's file, and a wrong guess costs a restore from the
 * backup rather than a lost configuration.
 *
 * Detection is by the presence of the agent's configuration directory, not by
 * looking for a running process or an installed binary: that directory is the
 * thing this command has to write into, so if it is not there the agent is not
 * installed for this user.
 *
 * Status of the table and the path arithmetic: **implemented and tested** in
 * `packages/cli/test/agents.test.ts` and `packages/cli/test/paths.test.ts`.
 */

import { joinFor, type Platform } from './paths.js';

export type AgentId = 'claude-code' | 'codex' | 'cursor' | 'gemini-cli';

/** The agents, in the order they are reported. */
export const AGENT_IDS: readonly AgentId[] = ['claude-code', 'codex', 'cursor', 'gemini-cli'];

/** The name the entry is filed under inside each agent's configuration. */
export const SERVER_ENTRY_NAME = 'browserreflex';

export type ConfigFormat = 'json' | 'toml';

export type ConfigStatus = 'implemented and tested' | 'experimental';

/**
 * A document's claims about itself, in the four permitted states.
 *
 * `experimental` means the file layout and the key names are written from the
 * agent's published conventions and have not been confirmed by running the agent.
 * That is the state every definition below is in: this card did not run any of
 * these agents against a configuration it wrote, so it cannot claim the layout is
 * tested. `implemented and tested` is kept in the type for a later card that has
 * the output of a real run to point at.
 *
 * The command is careful either way: it backs the file up and merges additively,
 * so a wrong guess costs a restore rather than a lost configuration.
 */
export interface AgentDefinition {
  readonly id: AgentId;
  /** Name shown to the person reading the output. */
  readonly label: string;
  readonly format: ConfigFormat;
  /** What this card knows about the agent's configuration layout. */
  readonly status: ConfigStatus;
  /** Path segments from the home directory to the agent's configuration directory. */
  readonly configDirRelative: readonly string[];
  /** Path segments from that directory to the configuration file. */
  readonly configFileRelative: readonly string[];
  /**
   * Paths under the home directory whose presence means the agent is installed
   * for this user. The configuration directory is normally the first entry.
   */
  readonly detectRelativePaths: readonly string[];
  /**
   * Environment variable that relocates the agent's whole configuration
   * directory, for the agents that document one.
   */
  readonly configDirectoryVariable?: string;
  /** Printed in the output and repeated in the README. */
  readonly note: string;
}

export const AGENT_DEFINITIONS: readonly AgentDefinition[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    format: 'json',
    status: 'experimental',
    configDirRelative: ['.'],
    configFileRelative: ['.claude.json'],
    detectRelativePaths: ['.claude', '.claude.json'],
    note: 'MCP servers live under the top-level "mcpServers" object of .claude.json, which is the user-level file the agent reads at start-up.',
  },
  {
    id: 'codex',
    label: 'Codex',
    format: 'toml',
    status: 'experimental',
    configDirRelative: ['.codex'],
    configFileRelative: ['config.toml'],
    detectRelativePaths: ['.codex'],
    configDirectoryVariable: 'CODEX_HOME',
    note: 'The entry is written as a [mcp_servers.browserreflex] table.',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    format: 'json',
    status: 'experimental',
    configDirRelative: ['.cursor'],
    configFileRelative: ['mcp.json'],
    detectRelativePaths: ['.cursor'],
    note: 'Servers live under the top-level "mcpServers" object of .cursor/mcp.json.',
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    format: 'json',
    status: 'experimental',
    configDirRelative: ['.gemini'],
    configFileRelative: ['settings.json'],
    detectRelativePaths: ['.gemini'],
    note: 'Servers live under the top-level "mcpServers" object of .gemini/settings.json.',
  },
];

const BY_ID = new Map<AgentId, AgentDefinition>(AGENT_DEFINITIONS.map((d) => [d.id, d]));

export function findAgent(id: string): AgentDefinition | undefined {
  return BY_ID.get(id as AgentId);
}

/** True when the string names one of the supported agents. */
export function isAgentId(value: string): value is AgentId {
  return BY_ID.has(value as AgentId);
}

export interface AgentPathContext {
  readonly platform: Platform;
  readonly home: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** An absolute path that replaces the computed one. */
  readonly configPathOverride?: string | undefined;
}

export interface ResolvedAgentPath {
  /** The configuration file this agent's entry goes into. */
  readonly configPath: string;
  /** The paths whose presence means the agent is installed for this user. */
  readonly detectPaths: readonly string[];
  /** How the path was arrived at, for the output. */
  readonly pathSource: 'override' | 'environment' | 'home';
}

/**
 * The absolute path of an agent's configuration file for a platform and home.
 *
 * Precedence: an explicit override, then the agent's own configuration directory
 * environment variable where it documents one, then the path under the home
 * directory. `'.'` in a segment list is dropped by the path join, which is how a
 * file sitting directly in the home directory is expressed.
 */
export function resolveAgentConfigPath(
  definition: AgentDefinition,
  context: AgentPathContext,
): ResolvedAgentPath {
  const env = context.env ?? {};
  const detectPaths = definition.detectRelativePaths.map((segment) =>
    joinFor(context.platform, context.home, segment),
  );

  if (context.configPathOverride !== undefined && context.configPathOverride !== '') {
    return { configPath: context.configPathOverride, detectPaths, pathSource: 'override' };
  }

  const variable = definition.configDirectoryVariable;
  if (variable !== undefined) {
    const directory = env[variable];
    if (directory !== undefined && directory !== '') {
      return {
        configPath: joinFor(context.platform, directory, ...definition.configFileRelative),
        detectPaths: [directory, ...detectPaths],
        pathSource: 'environment',
      };
    }
  }

  return {
    configPath: joinFor(
      context.platform,
      context.home,
      ...definition.configDirRelative,
      ...definition.configFileRelative,
    ),
    detectPaths,
    pathSource: 'home',
  };
}

/**
 * The environment variable that overrides one agent's configuration path.
 *
 * `BROWSERREFLEX_CONFIG_PATH_CLAUDE_CODE` overrides Claude Code's path, and so
 * on for each agent id in upper case with underscores.
 */
export function configPathOverrideVariable(id: AgentId): string {
  return `BROWSERREFLEX_CONFIG_PATH_${id.toUpperCase().replaceAll('-', '_')}`;
}
