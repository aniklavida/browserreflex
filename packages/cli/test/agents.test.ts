/**
 * Tests for the agent table and the configuration paths it produces.
 *
 * The table is the part of this card that can be wrong about someone else's
 * software, so two things are checked here. First, that every claim in it is one
 * of the four permitted states and that the labels are the ones the output
 * prints. Second, that the paths resolve to the documented location for each of
 * the three platforms, with the overrides the parser offers taking precedence in
 * the documented order.
 *
 * No file is written or read: this is a table of paths, and a path is only a
 * claim about where a file would go.
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_DEFINITIONS,
  AGENT_IDS,
  SERVER_ENTRY_NAME,
  configPathOverrideVariable,
  findAgent,
  isAgentId,
  resolveAgentConfigPath,
} from '../src/agents.js';

describe('the agent table', () => {
  it('configures the four agents the card names', () => {
    expect([...AGENT_IDS]).toEqual(['claude-code', 'codex', 'cursor', 'gemini-cli']);
  });

  it('gives every agent a unique id, a label, a format and a note', () => {
    const ids = AGENT_DEFINITIONS.map((definition) => definition.id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const definition of AGENT_DEFINITIONS) {
      expect(definition.label.length).toBeGreaterThan(0);
      expect(['json', 'toml']).toContain(definition.format);
      expect(definition.note.length).toBeGreaterThan(0);
      expect(definition.configFileRelative.length).toBeGreaterThan(0);
    }
  });

  it('states one of the permitted claims for every agent', () => {
    for (const definition of AGENT_DEFINITIONS) {
      expect(['implemented and tested', 'experimental']).toContain(definition.status);
    }
  });

  it('marks every layout experimental, because this card ran none of these agents', () => {
    // The claim is about the file layout, not about the code that writes it: the
    // merge is tested, the layout is written from a published convention and has
    // not been confirmed against a running agent.
    for (const definition of AGENT_DEFINITIONS) {
      expect(definition.status).toBe('experimental');
    }
  });

  it('writes JSON for the three agents that use JSON and TOML for the one that does not', () => {
    expect(findAgent('claude-code')?.format).toBe('json');
    expect(findAgent('cursor')?.format).toBe('json');
    expect(findAgent('gemini-cli')?.format).toBe('json');
    expect(findAgent('codex')?.format).toBe('toml');
  });

  it('names the entry every agent is given', () => {
    expect(SERVER_ENTRY_NAME).toBe('browserreflex');
  });
});

describe('findAgent and isAgentId', () => {
  it('finds a known agent and refuses an unknown one', () => {
    expect(findAgent('cursor')?.id).toBe('cursor');
    expect(findAgent('not-an-agent')).toBeUndefined();
    expect(isAgentId('codex')).toBe(true);
    expect(isAgentId('Codex')).toBe(false);
  });
});

describe('resolveAgentConfigPath', () => {
  const claudeCode = findAgent('claude-code');
  const codex = findAgent('codex');
  const cursor = findAgent('cursor');
  const gemini = findAgent('gemini-cli');

  it('writes the documented location for each agent on macOS and Linux', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const home = '/opt/fakehome';
      const cases = [
        [claudeCode, `${home}/.claude.json`],
        [codex, `${home}/.codex/config.toml`],
        [cursor, `${home}/.cursor/mcp.json`],
        [gemini, `${home}/.gemini/settings.json`],
      ] as const;

      for (const [definition, expected] of cases) {
        expect(definition).toBeDefined();
        const resolved = resolveAgentConfigPath(definition!, { platform, home, env: {} });
        expect(resolved.configPath).toBe(expected);
        expect(resolved.pathSource).toBe('home');
      }
    }
  });

  it('writes the same layout with backslashes on Windows', () => {
    const home = 'C:\\fakehome';

    expect(
      resolveAgentConfigPath(claudeCode!, { platform: 'win32', home, env: {} }).configPath,
    ).toBe('C:\\fakehome\\.claude.json');
    expect(resolveAgentConfigPath(codex!, { platform: 'win32', home, env: {} }).configPath).toBe(
      'C:\\fakehome\\.codex\\config.toml',
    );
    expect(resolveAgentConfigPath(cursor!, { platform: 'win32', home, env: {} }).configPath).toBe(
      'C:\\fakehome\\.cursor\\mcp.json',
    );
    expect(resolveAgentConfigPath(gemini!, { platform: 'win32', home, env: {} }).configPath).toBe(
      'C:\\fakehome\\.gemini\\settings.json',
    );
  });

  it('detects an agent by the presence of its configuration directory or file', () => {
    const claude = resolveAgentConfigPath(claudeCode!, {
      platform: 'linux',
      home: '/opt/fakehome',
      env: {},
    });
    const geminiCli = resolveAgentConfigPath(gemini!, {
      platform: 'linux',
      home: '/opt/fakehome',
      env: {},
    });

    expect(claude.detectPaths).toEqual(['/opt/fakehome/.claude', '/opt/fakehome/.claude.json']);
    expect(geminiCli.detectPaths).toEqual(['/opt/fakehome/.gemini']);
  });

  it('follows CODEX_HOME when the agent documents one', () => {
    const resolved = resolveAgentConfigPath(codex!, {
      platform: 'linux',
      home: '/opt/fakehome',
      env: { CODEX_HOME: '/opt/fakehome/elsewhere' },
    });

    expect(resolved.configPath).toBe('/opt/fakehome/elsewhere/config.toml');
    expect(resolved.pathSource).toBe('environment');
    // The relocated directory counts as installed, and the default one is still
    // looked at, so an agent moved by hand is still found.
    expect(resolved.detectPaths[0]).toBe('/opt/fakehome/elsewhere');
    expect(resolved.detectPaths).toContain('/opt/fakehome/.codex');
  });

  it('lets an explicit path override every environment variable', () => {
    const overrideVariable = configPathOverrideVariable('codex');
    const resolved = resolveAgentConfigPath(codex!, {
      platform: 'linux',
      home: '/opt/fakehome',
      env: { CODEX_HOME: '/opt/fakehome/elsewhere', [overrideVariable]: '/tmp/explicit.toml' },
      configPathOverride: '/tmp/explicit.toml',
    });

    expect(resolved.configPath).toBe('/tmp/explicit.toml');
    expect(resolved.pathSource).toBe('override');
  });

  it('ignores an empty override rather than resolving to the empty path', () => {
    const resolved = resolveAgentConfigPath(cursor!, {
      platform: 'linux',
      home: '/opt/fakehome',
      env: {},
      configPathOverride: '',
    });

    expect(resolved.configPath).toBe('/opt/fakehome/.cursor/mcp.json');
  });

  it('builds one environment variable name per agent', () => {
    expect(configPathOverrideVariable('claude-code')).toBe('BROWSERREFLEX_CONFIG_PATH_CLAUDE_CODE');
    expect(configPathOverrideVariable('gemini-cli')).toBe('BROWSERREFLEX_CONFIG_PATH_GEMINI_CLI');
    for (const id of AGENT_IDS) {
      expect(configPathOverrideVariable(id)).toMatch(/^BROWSERREFLEX_CONFIG_PATH_[A-Z_]+$/);
    }
  });
});
