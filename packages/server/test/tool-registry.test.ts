import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  discoverToolFiles,
  loadToolDefinitions,
  readToolDefinition,
} from '../src/mcp/tools/registry.js';

const fixturesBase = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** A fixture directory, addressed the way the registry addresses the real one. */
const fixturesDir = (name: string): URL => new URL(`file://${fixturesBase}${name}/`);

describe('tool registry', () => {
  it('finds tool files by directory listing, without a list to keep up to date', async () => {
    const files = await discoverToolFiles(fixturesDir('tools'));

    expect(files).toEqual(['probe.tool.ts']);
  });

  it('registers a tool file it discovered, using the definition the file exports', async () => {
    const definitions = await loadToolDefinitions(fixturesDir('tools'));

    expect(definitions).toHaveLength(1);
    expect(definitions[0]?.name).toBe('probe_tool');
    expect(definitions[0]?.title).toBe('Probe tool');
  });

  it('refuses to start when a tool file does not export a definition', async () => {
    await expect(loadToolDefinitions(fixturesDir('tools/missing-export'))).rejects.toThrow(
      /missing\.tool\.ts does not export a `tool` definition/,
    );
  });

  it('refuses to start when a tool definition has no handler', async () => {
    await expect(loadToolDefinitions(fixturesDir('tools/no-handler'))).rejects.toThrow(
      /needs a handle function/,
    );
  });

  it('refuses to start when two tool files declare the same name', async () => {
    await expect(loadToolDefinitions(fixturesDir('duplicate-names'))).rejects.toThrow(
      /is declared twice/,
    );
  });

  it('refuses to start when the tools directory holds no tool file', async () => {
    await expect(loadToolDefinitions(fixturesDir('empty-tools'))).rejects.toThrow(/No tool files/);
  });

  it('rejects a tool name that is not lower snake case', () => {
    expect(() => readToolDefinition('bad.tool.ts', { tool: { name: 'ServerStatus' } })).toThrow(
      /must match/,
    );
  });

  it('ships a tools directory whose files all parse as definitions', async () => {
    const definitions = await loadToolDefinitions();

    expect(definitions.map((definition) => definition.name)).toContain('server_status');
  });
});
