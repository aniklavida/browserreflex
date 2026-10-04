import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SERVER_NAME, SERVER_VERSION } from '../src/mcp/server.js';
import { loadInstructions } from '../src/mcp/instructions.js';
import {
  connectToServer,
  ensureBuiltEntry,
  measureStartupMs,
  readJsonFile,
  serverPackageRoot,
  sourceEntry,
} from './helpers/stdio-server.js';

/** Budget from the card: the server must be answering within one second. */
const STARTUP_BUDGET_MS = 1000;

const toolsDirectory = new URL('../src/mcp/tools/', import.meta.url);

/**
 * Tool names derived from the file names on disk, following the documented convention
 * of one `<tool_name>.tool.ts` file per tool, in kebab case.
 *
 * This is written out here rather than taken from the registry: a test that compares
 * the served tools with whatever the registry produced passes even when the registry
 * has quietly stopped finding files.
 */
async function toolNamesOnDisk(): Promise<string[]> {
  const entries = await readdir(toolsDirectory);
  return entries
    .filter((entry) => entry.endsWith('.tool.ts') || entry.endsWith('.tool.js'))
    .map((entry) => entry.replace(/\.tool\.(ts|js)$/, '').replaceAll('-', '_'))
    .sort();
}

describe('MCP server over stdio', () => {
  let client: Client;
  let serverStderr: () => string;

  beforeAll(async () => {
    const connected = await connectToServer(sourceEntry);
    client = connected.client;
    serverStderr = connected.serverStderr;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('lists every tool found in the tools directory', async () => {
    const expected = await toolNamesOnDisk();
    const listed = await client.listTools();

    expect(listed.tools.map((entry) => entry.name).sort()).toEqual(expected);
    expect(expected).toContain('server_status');
    expect(expected).toContain('page_check');
  }, 30_000);

  it('serves the instructions text to the client', () => {
    expect(client.getInstructions()).toBe(loadInstructions());
  });

  it('reports its name and version in the handshake, matching the package manifest', () => {
    const manifest = readJsonFile(resolve(serverPackageRoot, 'package.json'));

    expect(client.getServerVersion()).toEqual({ name: SERVER_NAME, version: SERVER_VERSION });
    expect(SERVER_VERSION).toBe(manifest['version']);
  });

  it('answers server_status with the tools this build serves', async () => {
    const listed = await client.listTools();
    const result = await client.callTool({ name: 'server_status', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      server: SERVER_NAME,
      version: SERVER_VERSION,
      transport: 'stdio',
      tool_names: listed.tools.map((entry) => entry.name),
      decision_tools_status: 'complete',
      planned_tools: [],
      safety_check: 'advisory',
    });
    expect((result.content as { text: string }[])[0]?.text).toContain('advisory');
  }, 30_000);

  it('writes its startup diagnostics to stderr, leaving stdout to the protocol', () => {
    expect(serverStderr()).toContain('browserreflex mcp server ready on stdio');
  });

  it('completes the MCP handshake in under one second', async () => {
    const entry = ensureBuiltEntry();
    const startupMs = await measureStartupMs(entry);

    expect(startupMs).toBeLessThan(STARTUP_BUDGET_MS);
  }, 120_000);
});
