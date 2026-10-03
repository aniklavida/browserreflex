import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { loadToolDefinitions } from '../src/mcp/tools/registry.js';
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
import { resolve } from 'node:path';

/** Budget from the card: the server must be answering within one second. */
const STARTUP_BUDGET_MS = 1000;

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
    const definitions = await loadToolDefinitions();
    const listed = await client.listTools();

    expect(listed.tools.map((entry) => entry.name).sort()).toEqual(
      definitions.map((definition) => definition.name).sort(),
    );
    expect(listed.tools.length).toBeGreaterThan(0);
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
      decision_tools_status: 'planned',
      safety_check: 'advisory',
    });
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
