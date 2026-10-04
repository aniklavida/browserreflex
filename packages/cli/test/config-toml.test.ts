/**
 * Tests for merging one entry into a TOML agent configuration.
 *
 * The TOML path is the smallest reader in this package: it recognises a section
 * header and copies everything else through as text. The tests are therefore
 * about what survives — other servers under the same parent table, unrelated
 * tables, comments, the preamble — and about a second run being a no-op.
 *
 * The known limitation is stated in `config-toml.ts` and repeated in the package
 * README: a line beginning with `[` inside a multi-line string is mistaken for a
 * header. No supported agent's configuration file uses a multi-line string, and
 * the tests below hold that assumption explicitly.
 */

import { describe, expect, it } from 'vitest';
import {
  CODEX_SERVERS_KEY,
  mergeTomlConfig,
  renderEntryTable,
  tomlString,
  tomlStringArray,
} from '../src/config-toml.js';
import type { McpServerEntry } from '../src/config-json.js';

const ENTRY: McpServerEntry = {
  command: 'npx',
  args: ['-y', 'browserreflex-mcp', 'serve'],
};

const TABLE = `${CODEX_SERVERS_KEY}.browserreflex`;

function merge(existing: string | undefined) {
  return mergeTomlConfig(existing, ENTRY, { tableName: TABLE });
}

describe('creating a configuration that does not exist', () => {
  it('writes the one table this command owns', () => {
    const result = merge(undefined);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.outcome).toBe('created');
    expect(result.text).toBe(
      [
        '[mcp_servers.browserreflex]',
        'command = "npx"',
        'args = ["-y", "browserreflex-mcp", "serve"]',
        '',
      ].join('\n'),
    );
  });

  it('treats an empty file the same as a missing one', () => {
    const result = merge('  \n');

    expect(result.ok && result.outcome).toBe('created');
  });
});

describe('init does not destroy an existing unrelated MCP server entry', () => {
  it('keeps another server under the same parent table', () => {
    const existing = [
      '[mcp_servers.other-server]',
      'command = "other-command"',
      'args = ["--stdio"]',
      '',
    ].join('\n');

    const result = merge(existing);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.text).toContain('[mcp_servers.other-server]');
    expect(result.text).toContain('command = "other-command"');
    expect(result.text).toContain('args = ["--stdio"]');
    expect(result.text).toContain('[mcp_servers.browserreflex]');
  });

  it('keeps the preamble, the comments and every unrelated table', () => {
    const existing = [
      '# Codex configuration, hand written.',
      'model = "some-model"',
      '',
      '[mcp_servers.other-server]',
      'command = "other-command"',
      '',
      '[shell_environment_policy]',
      'inherit = "all"',
      '',
    ].join('\n');

    const result = merge(existing);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.text).toContain('# Codex configuration, hand written.');
    expect(result.text).toContain('model = "some-model"');
    expect(result.text).toContain('[shell_environment_policy]');
    expect(result.text).toContain('inherit = "all"');
    expect(result.outcome).toBe('updated');
  });

  it('replaces only its own table', () => {
    const existing = [
      '[mcp_servers.browserreflex]',
      'command = "an-older-command"',
      'args = ["serve"]',
      '',
      '[mcp_servers.other-server]',
      'command = "other-command"',
      '',
    ].join('\n');

    const result = merge(existing);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.text).not.toContain('an-older-command');
    expect(result.text.match(/\[mcp_servers\.browserreflex\]/g)).toHaveLength(1);
    expect(result.text).toContain('[mcp_servers.other-server]');
    expect(result.text).toContain('command = "other-command"');
  });
});

describe('idempotency', () => {
  it('reports the file as unchanged when it already holds exactly this table', () => {
    const first = merge(undefined);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    const second = merge(first.text);

    expect(second.ok && second.outcome).toBe('unchanged');
    expect(second.ok && second.text).toBe(first.text);
  });

  it('reaches the same file again after another table is added by hand', () => {
    const withOther = merge(['[mcp_servers.other-server]', 'command = "other"', ''].join('\n'));
    expect(withOther.ok).toBe(true);
    if (!withOther.ok) {
      return;
    }

    const second = merge(withOther.text);

    expect(second.ok && second.outcome).toBe('unchanged');
  });
});

describe('value rendering', () => {
  it('escapes a value so the document still parses', () => {
    expect(tomlString('plain')).toBe('"plain"');
    expect(tomlString('a "quoted" word')).toBe('"a \\"quoted\\" word"');
    expect(tomlString('C:\\dir\\file')).toBe('"C:\\\\dir\\\\file"');
    expect(tomlString('one\ntwo')).toBe('"one\\ntwo"');
    expect(tomlString('one\ttwo')).toBe('"one\\ttwo"');
  });

  it('writes an array of strings on one line', () => {
    expect(tomlStringArray(['a', 'b c'])).toBe('["a", "b c"]');
    expect(tomlStringArray([])).toBe('[]');
  });

  it('omits an empty argument list rather than writing an empty array', () => {
    const table = renderEntryTable(TABLE, { command: 'node', args: [] });

    expect(table).toBe(`[${TABLE}]\ncommand = "node"`);
  });

  it('writes each environment variable as its own key', () => {
    const table = renderEntryTable(TABLE, {
      command: 'node',
      args: ['serve'],
      env: { FIRST: '1', SECOND: 'two' },
    });

    expect(table).toContain('FIRST = "1"');
    expect(table).toContain('SECOND = "two"');
  });
});

describe('the single documented limitation', () => {
  it('mistakes a bracketed line inside a multi-line string for a header', () => {
    // Written out here so the limitation in the module comment is a test rather
    // than a caveat. The value of this line is that a reader can see exactly what
    // the reader gets wrong.
    const existing = ['notes = """', '[not-a-section]', '"""', ''].join('\n');

    const result = merge(existing);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The line is still present, but it has become a section of its own.
    expect(result.text).toContain('[not-a-section]');
    expect(result.text.indexOf(`[${TABLE}]`)).toBeGreaterThan(
      result.text.indexOf('[not-a-section]'),
    );
  });
});
