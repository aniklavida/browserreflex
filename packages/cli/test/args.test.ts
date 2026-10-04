/**
 * Tests for the command line parser.
 *
 * The parser is total: it never throws and never touches the filesystem, so
 * every branch here is reachable from a test. The cases that matter for the card
 * are the ones that decide what `init` is allowed to touch: which agents were
 * named, whether anything is written, whether a browser is opened, and which
 * command line goes into an agent's configuration.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SERVER_COMMAND,
  SERVE_ARGUMENT,
  parseArgs,
  splitCommandLine,
  usageText,
} from '../src/args.js';

describe('commands', () => {
  it('prints help when no command is given', () => {
    expect(parseArgs([]).command).toBe('help');
  });

  it('recognises init and serve', () => {
    expect(parseArgs(['init']).command).toBe('init');
    expect(parseArgs(['serve']).command).toBe('serve');
  });

  it('lets --help win over a command, and --version over nothing', () => {
    expect(parseArgs(['init', '--help']).command).toBe('help');
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--version']).command).toBe('version');
    expect(parseArgs(['serve', '--version']).command).toBe('serve');
  });

  it('reports an unknown command rather than guessing', () => {
    const parsed = parseArgs(['instal']);

    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain('unknown command "instal"');
  });

  it('reports an unknown option', () => {
    const parsed = parseArgs(['init', '--wat']);

    expect(parsed.errors).toEqual(['unknown option "--wat"']);
  });

  it('reports a trailing argument it has no use for', () => {
    const parsed = parseArgs(['init', 'extra']);

    expect(parsed.errors).toEqual(['unexpected argument "extra"']);
  });

  it('reports every problem it found, not only the first', () => {
    const parsed = parseArgs(['init', '--wat', '--port', 'x']);

    expect(parsed.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('--agent', () => {
  it('takes a comma-separated list and keeps the order it was given in', () => {
    const parsed = parseArgs(['init', '--agent', 'cursor,claude-code']);

    expect(parsed.agents).toEqual(['cursor', 'claude-code']);
    expect(parsed.errors).toEqual([]);
  });

  it('drops a repeat rather than writing the same agent twice', () => {
    expect(parseArgs(['init', '--agent', 'cursor,cursor']).agents).toEqual(['cursor']);
  });

  it('rejects an agent it does not know, and names the ones it does', () => {
    const parsed = parseArgs(['init', '--agent', 'cursor,emacs']);

    expect(parsed.agents).toEqual(['cursor']);
    expect(parsed.unknownAgents).toEqual(['emacs']);
    expect(parsed.errors[0]).toContain('unknown agent "emacs"');
    expect(parsed.errors[0]).toContain('claude-code');
  });

  it('accepts --agent=name as well as --agent name', () => {
    expect(parseArgs(['init', '--agent=cursor']).agents).toEqual(['cursor']);
  });

  it('says so when a value is missing', () => {
    expect(parseArgs(['init', '--agent']).errors).toEqual(['--agent needs a value']);
  });

  it('selects nothing when it is not given at all', () => {
    expect(parseArgs(['init']).agents).toEqual([]);
  });
});

describe('--command', () => {
  it('defaults to the npx invocation the published package documents', () => {
    expect(parseArgs(['init']).serverCommand).toEqual([...DEFAULT_SERVER_COMMAND]);
  });

  it('takes a whole command line and splits it into words', () => {
    expect(parseArgs(['init', '--command', 'node ./dist/bin.js']).serverCommand).toEqual([
      'node',
      './dist/bin.js',
    ]);
  });

  it('keeps a quoted path with a space as one word', () => {
    expect(parseArgs(['init', '--command', 'node "C:\\my apps\\bin.js"']).serverCommand).toEqual([
      'node',
      'C:\\my apps\\bin.js',
    ]);
  });

  it('refuses an empty command rather than writing an entry with no command', () => {
    expect(parseArgs(['init', '--command', '   ']).errors).toEqual([
      '--command needs the command to launch the server',
    ]);
  });

  it('appends serve to the command it writes into an agent configuration', () => {
    // The entry is command + args + serve; this is the shape every agent gets.
    const parsed = parseArgs(['init', '--command', 'node ./dist/bin.js']);

    expect([parsed.serverCommand[0], ...parsed.serverCommand.slice(1), SERVE_ARGUMENT]).toEqual([
      'node',
      './dist/bin.js',
      'serve',
    ]);
  });
});

describe('splitCommandLine', () => {
  it('collapses runs of whitespace and ignores leading and trailing space', () => {
    expect(splitCommandLine('  node   --flag  ')).toEqual(['node', '--flag']);
  });

  it('honours single quotes', () => {
    expect(splitCommandLine("node '/a path/bin.js'")).toEqual(['node', '/a path/bin.js']);
  });

  it('escapes a backslash outside quotes only for itself and for quotes', () => {
    expect(splitCommandLine('a\\\\b')).toEqual(['a\\b']);
    expect(splitCommandLine('C:\\dir\\file')).toEqual(['C:\\dir\\file']);
  });

  it('leaves an unterminated quote in the word rather than swallowing the rest', () => {
    expect(splitCommandLine('node "/a path')).toEqual(['node', '/a path"']);
  });

  it('returns nothing for an empty string', () => {
    expect(splitCommandLine('')).toEqual([]);
  });
});

describe('flags that decide what init touches', () => {
  it('opens a browser unless told not to', () => {
    expect(parseArgs(['init']).open).toBe(true);
    expect(parseArgs(['init', '--no-open']).open).toBe(false);
  });

  it('writes nothing unless --dry-run is given', () => {
    expect(parseArgs(['init']).dryRun).toBe(false);
    expect(parseArgs(['init', '--dry-run']).dryRun).toBe(true);
  });

  it('accepts a port inside the range and refuses one outside it', () => {
    expect(parseArgs(['init', '--port', '4141']).port).toBe(4141);
    expect(parseArgs(['init', '--port', '0']).port).toBe(0);
    expect(parseArgs(['init', '--port', '70000']).errors).toHaveLength(1);
    expect(parseArgs(['init', '--port', 'abc']).errors[0]).toContain('--port must be a number');
  });

  it('accepts a home directory and a database path, including with an equals sign', () => {
    expect(parseArgs(['init', '--home', '/tmp/h']).home).toBe('/tmp/h');
    expect(parseArgs(['init', '--home=/tmp/h2']).home).toBe('/tmp/h2');
    expect(parseArgs(['init', '--db', '/tmp/db.sqlite']).databasePath).toBe('/tmp/db.sqlite');
  });

  it('reports a flag whose value is missing instead of taking the next flag', () => {
    expect(parseArgs(['init', '--home']).errors).toEqual(['--home needs a value']);
  });
});

describe('usageText', () => {
  it('names every command the dispatcher answers to', () => {
    const text = usageText('0.1.0');

    expect(text).toContain('browserreflex-mcp 0.1.0');
    expect(text).toContain('browserreflex-mcp init');
    expect(text).toContain('browserreflex-mcp serve');
    expect(text).toContain('--dry-run');
    expect(text).toContain('--no-open');
    expect(text).toContain('--agent');
    expect(text).toContain('--home');
  });

  it('says the API listens on loopback only', () => {
    expect(usageText('0.1.0')).toContain('127.0.0.1');
  });

  it('says a backup is taken before an existing file is written', () => {
    expect(usageText('0.1.0')).toContain('backed up');
  });
});
