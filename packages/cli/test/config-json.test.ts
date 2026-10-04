/**
 * Tests for merging one entry into a JSON agent configuration.
 *
 * The behaviour under test is the reason this command is allowed to touch a file
 * it does not own: everything except the one entry it is adding must survive
 * byte for byte, and a file it cannot understand must be left alone rather than
 * replaced. `init does not destroy an existing unrelated MCP server entry` and
 * `refuses a file it cannot parse` are the two named tests those claims rest on.
 */

import { describe, expect, it } from 'vitest';
import {
  MCP_SERVERS_KEY,
  detectIndent,
  mergeJsonConfig,
  serializeEntry,
  serializeJson,
  type McpServerEntry,
} from '../src/config-json.js';

const ENTRY: McpServerEntry = {
  command: 'npx',
  args: ['-y', 'browserreflex-mcp', 'serve'],
};

function merge(
  existing: string | undefined,
  entryName = 'browserreflex',
  entry: McpServerEntry = ENTRY,
) {
  return mergeJsonConfig(existing, entry, { entryName });
}

describe('creating a configuration that does not exist', () => {
  it('writes a document holding only this entry', () => {
    const result = merge(undefined);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.outcome).toBe('created');
    expect(JSON.parse(result.text)).toEqual({
      [MCP_SERVERS_KEY]: {
        browserreflex: {
          command: 'npx',
          args: ['-y', 'browserreflex-mcp', 'serve'],
        },
      },
    });
  });

  it('ends the file with a newline', () => {
    const result = merge(undefined);

    expect(result.ok && result.text.endsWith('\n')).toBe(true);
  });

  it('treats an empty file the same as a missing one', () => {
    const result = merge('   \n');

    expect(result.ok && result.outcome).toBe('created');
  });
});

describe('init does not destroy an existing unrelated MCP server entry', () => {
  it('adds its own entry beside another server and keeps every other key', () => {
    const existing = serializeJson(
      {
        numStartups: 41,
        theme: 'dark',
        projects: { '/opt/work': { allowedTools: ['Bash'] } },
        [MCP_SERVERS_KEY]: {
          'someone-elses-server': {
            command: '/usr/local/bin/other',
            args: ['--stdio'],
            env: { SOME_TOKEN: 'not-a-real-key' },
          },
          'a-server-with-no-args': { command: 'other-cmd' },
        },
      },
      '  ',
    );

    const result = merge(existing);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const parsed = JSON.parse(result.text) as Record<string, unknown>;

    // The other server is still there, unchanged, including its own arguments
    // and its own environment block.
    expect(parsed[MCP_SERVERS_KEY]).toMatchObject({
      'someone-elses-server': {
        command: '/usr/local/bin/other',
        args: ['--stdio'],
        env: { SOME_TOKEN: 'not-a-real-key' },
      },
      'a-server-with-no-args': { command: 'other-cmd' },
    });
    // This entry was added alongside them.
    expect((parsed[MCP_SERVERS_KEY] as Record<string, unknown>)['browserreflex']).toEqual({
      command: 'npx',
      args: ['-y', 'browserreflex-mcp', 'serve'],
    });
    // And nothing else in the document moved.
    expect(parsed['numStartups']).toBe(41);
    expect(parsed['theme']).toBe('dark');
    expect(parsed['projects']).toEqual({ '/opt/work': { allowedTools: ['Bash'] } });
    expect(result.outcome).toBe('updated');
  });

  it('keeps a key it has never heard of at the top level', () => {
    const existing = '{"somethingNewInAFutureRelease":{"nested":[1,2,3]}}';

    const result = merge(existing);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(JSON.parse(result.text)).toEqual({
      somethingNewInAFutureRelease: { nested: [1, 2, 3] },
      [MCP_SERVERS_KEY]: {
        browserreflex: { command: 'npx', args: ['-y', 'browserreflex-mcp', 'serve'] },
      },
    });
  });

  it('replaces only its own entry when the command changes', () => {
    const existing = JSON.stringify({
      [MCP_SERVERS_KEY]: {
        browserreflex: { command: 'old-command', args: ['serve'] },
        'other-server': { command: 'other' },
      },
    });

    const result = merge(existing);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(JSON.parse(result.text)).toEqual({
      [MCP_SERVERS_KEY]: {
        browserreflex: { command: 'npx', args: ['-y', 'browserreflex-mcp', 'serve'] },
        'other-server': { command: 'other' },
      },
    });
  });

  it('adds the key when the document does not have one yet', () => {
    const result = merge('{"history":[{"prompt":"hello"}]}');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(JSON.parse(result.text)).toMatchObject({
      history: [{ prompt: 'hello' }],
      [MCP_SERVERS_KEY]: { browserreflex: { command: 'npx' } },
    });
  });
});

describe('refuses a file it cannot parse', () => {
  it('leaves a file that is not JSON alone, and says why', () => {
    const existing = 'this is not json at all';

    const result = merge(existing);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('not valid JSON');
    expect(result.error).toContain('left alone');
    expect('text' in result).toBe(false);
  });

  it('refuses a document whose top level is an array', () => {
    const result = merge('[{"mcpServers":{}}]');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('does not hold a JSON object');
    }
  });

  it('refuses a document whose mcpServers key is not an object', () => {
    const result = merge('{"mcpServers":["a","b"]}');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('does not hold an object');
    }
  });
});

describe('idempotency', () => {
  it('reports the file as unchanged when it already holds exactly this entry', () => {
    const first = merge(undefined);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    const second = merge(first.text);

    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.outcome).toBe('unchanged');
    expect(second.text).toBe(first.text);
  });

  it('reaches the same file again after a round trip through an unrelated entry', () => {
    const withOther = JSON.stringify({
      [MCP_SERVERS_KEY]: { 'other-server': { command: 'other', args: ['--x'] } },
    });
    const first = merge(withOther);
    const second = first.ok ? merge(first.text) : undefined;

    expect(first.ok && second?.ok).toBe(true);
    expect(second?.ok && second.outcome).toBe('unchanged');
  });
});

describe('detectIndent', () => {
  it('copies the indentation an existing document uses', () => {
    expect(detectIndent('{\n    "a": 1\n}\n')).toBe('    ');
    expect(detectIndent('{\n  "a": 1\n}\n')).toBe('  ');
    expect(detectIndent('{\n      "a": 1\n}\n')).toBe('      ');
  });

  it('uses two spaces when there is nothing to copy from', () => {
    expect(detectIndent(undefined)).toBe('  ');
    expect(detectIndent('{}')).toBe('  ');
  });

  it('refuses to guess from a tab or an implausible width', () => {
    expect(detectIndent('{\n\t"a": 1\n}\n')).toBe('  ');
    expect(detectIndent(`{\n${' '.repeat(12)}"a": 1\n}\n`)).toBe('  ');
  });

  it('keeps the indentation of the file it is merging into', () => {
    const existing = '{\n    "numStartups": 1\n}';

    const result = merge(existing);

    expect(result.ok && result.text).toContain('\n    "numStartups": 1');
  });
});

describe('serializeEntry', () => {
  it('writes command and args', () => {
    expect(serializeEntry(ENTRY)).toEqual({
      command: 'npx',
      args: ['-y', 'browserreflex-mcp', 'serve'],
    });
  });

  it('omits an empty environment rather than writing an empty object', () => {
    expect(serializeEntry({ ...ENTRY, env: {} })).not.toHaveProperty('env');
    expect(serializeEntry({ ...ENTRY, env: undefined })).not.toHaveProperty('env');
  });

  it('writes an environment when one is given', () => {
    expect(serializeEntry({ ...ENTRY, env: { A: '1' } })).toMatchObject({ env: { A: '1' } });
  });

  it('copies the arrays rather than sharing them', () => {
    const args: string[] = ['serve'];
    const serialized = serializeEntry({ command: 'node', args }) as { args: string[] };
    serialized.args.push('extra');

    expect(args).toEqual(['serve']);
  });
});
