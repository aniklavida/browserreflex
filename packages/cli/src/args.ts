/**
 * Parsing the command line.
 *
 * A hand-written parser, because the whole surface is small enough to read in one
 * screen and a dependency would be one more thing to license, audit and keep
 * current. It is total: it never throws and never reads the filesystem, so every
 * branch in here is reachable from a test.
 *
 * Status: **implemented and tested** in `packages/cli/test/args.test.ts`.
 */

import { AGENT_IDS, isAgentId, type AgentId } from './agents.js';

export type Command = 'init' | 'serve' | 'help' | 'version';

export interface ParsedArgs {
  readonly command: Command;
  readonly home: string | undefined;
  readonly agents: readonly AgentId[];
  /** Every agent the command was asked to write to, in the order given. */
  readonly unknownAgents: readonly string[];
  /** The command line written into an agent configuration, before `serve`. */
  readonly serverCommand: readonly string[];
  readonly dryRun: boolean;
  readonly open: boolean;
  readonly port: number | undefined;
  readonly databasePath: string | undefined;
  readonly help: boolean;
  readonly version: boolean;
  /** Usage errors, in the order they were found. */
  readonly errors: readonly string[];
}

/** What an agent configuration gets when `--command` is not given. */
export const DEFAULT_SERVER_COMMAND: readonly string[] = ['npx', '-y', 'browserreflex-mcp'];

/** The argument appended to the server command in every agent configuration. */
export const SERVE_ARGUMENT = 'serve';

/**
 * Splits a command line into words, honouring single and double quotes.
 *
 * `--command` takes a whole command line, and a path inside it may contain a
 * space. Quotes are the usual way to write that; a backslash outside quotes
 * escapes the next character.
 */
export function splitCommandLine(value: string): string[] {
  const words: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;

    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
        continue;
      }
      current += character;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }

    if (character === '\\' && index + 1 < value.length) {
      const next = value[index + 1] as string;
      // Outside quotes a backslash only escapes itself and the two quote
      // characters. Anything else keeps the backslash, so a Windows path written
      // without quotes survives.
      if (next === '\\' || next === '"' || next === "'") {
        current += next;
        started = true;
        index += 1;
        continue;
      }
      current += character;
      started = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (started) {
        words.push(current);
        current = '';
        started = false;
      }
      continue;
    }

    current += character;
    started = true;
  }

  if (quote !== undefined) {
    // An unterminated quote is left in place rather than silently closed: the
    // caller sees the text it wrote, and can decide.
    current += quote;
  }
  if (started) {
    words.push(current);
  }
  return words;
}

const KNOWN_COMMANDS = new Set<string>(['init', 'serve', 'help', 'version']);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const errors: string[] = [];
  let command: Command = 'help';
  let home: string | undefined;
  const agents: AgentId[] = [];
  const unknownAgents: string[] = [];
  let serverCommand: string[] = [...DEFAULT_SERVER_COMMAND];
  let dryRun = false;
  let open = true;
  let port: number | undefined;
  let databasePath: string | undefined;
  let help = false;
  let version = false;
  let commandSeen = false;

  const rest: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;

    const takesValue = (): string | undefined => {
      const inline = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : undefined;
      if (inline !== undefined) {
        return inline;
      }
      const next = argv[index + 1];
      if (next === undefined) {
        errors.push(`${argument} needs a value`);
        return undefined;
      }
      index += 1;
      return next;
    };

    const name = argument.includes('=') ? argument.slice(0, argument.indexOf('=')) : argument;

    switch (name) {
      case '--home': {
        home = takesValue();
        break;
      }
      case '--agent': {
        const value = takesValue();
        if (value === undefined) {
          break;
        }
        for (const part of value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)) {
          if (isAgentId(part)) {
            if (!agents.includes(part)) {
              agents.push(part);
            }
          } else if (!unknownAgents.includes(part)) {
            unknownAgents.push(part);
            errors.push(`unknown agent "${part}"; supported agents: ${AGENT_IDS.join(', ')}`);
          }
        }
        break;
      }
      case '--command': {
        const value = takesValue();
        if (value === undefined) {
          break;
        }
        const words = splitCommandLine(value);
        if (words.length === 0) {
          errors.push('--command needs the command to launch the server');
          break;
        }
        serverCommand = words;
        break;
      }
      case '--db': {
        databasePath = takesValue();
        break;
      }
      case '--port': {
        const value = takesValue();
        if (value === undefined) {
          break;
        }
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          errors.push(`--port must be a number between 0 and 65535, got "${value}"`);
          break;
        }
        port = parsed;
        break;
      }
      case '--dry-run': {
        dryRun = true;
        break;
      }
      case '--no-open': {
        open = false;
        break;
      }
      case '--help':
      case '-h': {
        help = true;
        break;
      }
      case '--version':
      case '-v': {
        version = true;
        break;
      }
      default: {
        if (name.startsWith('-')) {
          errors.push(`unknown option "${name}"`);
          break;
        }
        if (!commandSeen && KNOWN_COMMANDS.has(argument)) {
          command = argument as Command;
          commandSeen = true;
          break;
        }
        if (!commandSeen) {
          // Reported once. It is not also pushed onto `rest`, which would report
          // the same word a second time as an unexpected argument.
          errors.push(`unknown command "${argument}"; run browserreflex-mcp --help`);
          commandSeen = true;
          break;
        }
        rest.push(argument);
      }
    }
  }

  if (rest.length > 0) {
    errors.push(`unexpected argument "${rest[0] as string}"`);
  }
  if (help) {
    command = 'help';
  }
  if (version && !commandSeen) {
    command = 'version';
  }

  return {
    command,
    home,
    agents,
    unknownAgents,
    serverCommand,
    dryRun,
    open,
    port,
    databasePath,
    help,
    version,
    errors,
  };
}

/** The whole usage text, printed by `--help` and by a usage error. */
export function usageText(version: string): string {
  return [
    `browserreflex-mcp ${version}`,
    '',
    'A decision layer for browser-automation agents, served over MCP.',
    '',
    'Usage:',
    '  browserreflex-mcp init [options]    detect installed agents, write their MCP',
    '                                       configuration, then start the local API',
    '                                       and open the setup wizard',
    '  browserreflex-mcp serve [options]   run the MCP server on stdio; this is the',
    '                                       command the agent configurations point at',
    '  browserreflex-mcp --help',
    '  browserreflex-mcp --version',
    '',
    'Options for init:',
    '  --agent <names>     comma-separated subset of: ' + AGENT_IDS.join(', '),
    '  --command <line>    command written into the agent configuration; defaults to',
    '                      "npx -y browserreflex-mcp". "serve" is appended to it.',
    '  --dry-run           print what would be written and change nothing',
    '  --no-open           do not open a browser',
    '  --port <number>     port for the local API and the setup wizard (default 4040)',
    '  --home <directory>  home directory to resolve configuration paths under',
    '  --db <file>         SQLite file to use instead of <home>/.browserreflex/browserreflex.db',
    '',
    'Options for serve:',
    '  --home <directory>  home directory to resolve the database path under',
    '  --db <file>         SQLite file to use',
    '',
    'The entry written into an agent configuration runs "serve" on its own, so an',
    'agent-launched server uses the default database unless BROWSERREFLEX_DB_PATH',
    "is set in that process's environment. Set it for both processes to share one",
    'file.',
    '',
    'An existing agent configuration is backed up to a timestamped copy next to it',
    "before anything is written, and only this package's own entry is added or",
    'replaced. Nothing is sent anywhere: the API listens on 127.0.0.1 only.',
  ].join('\n');
}
