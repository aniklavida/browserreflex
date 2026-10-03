import { loadInstructions } from './instructions.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { defaultToolsDirectory, loadToolDefinitions } from './tools/registry.js';
import type { ToolContext } from './tools/tool.js';

/** Server name sent in the MCP handshake. */
export const SERVER_NAME = 'browserreflex';

/**
 * Version sent in the MCP handshake. Kept equal to the package version; a test reads
 * `package.json` and fails if the two drift apart.
 */
export const SERVER_VERSION = '0.1.0';

/** Transport label reported to tools. This card ships the stdio transport only. */
export const SERVER_TRANSPORT = 'stdio';

export interface CreateServerOptions {
  readonly name?: string;
  readonly version?: string;
  /** Label passed to tools in their context. */
  readonly transport?: string;
  /** Directory scanned for `*.tool.ts` / `*.tool.js` files. */
  readonly toolsDirectory?: URL;
  /** Overrides the served instruction text. Intended for tests. */
  readonly instructions?: string;
}

export interface BrowserReflexMcpServer {
  readonly server: McpServer;
  /** Names of the registered tools, in registration order. */
  readonly toolNames: readonly string[];
  /** The text served as the `instructions` field. */
  readonly instructions: string;
}

/**
 * Builds the MCP server: handshake identity, the `instructions` field and every tool
 * found in the tools directory.
 *
 * A malformed tool file fails here, so the server either serves the tools it was built
 * with or it does not start.
 */
export async function createMcpServer(
  options: CreateServerOptions = {},
): Promise<BrowserReflexMcpServer> {
  const name = options.name ?? SERVER_NAME;
  const version = options.version ?? SERVER_VERSION;
  const transport = options.transport ?? SERVER_TRANSPORT;
  const instructions = options.instructions ?? loadInstructions();
  const definitions = await loadToolDefinitions(options.toolsDirectory ?? defaultToolsDirectory());

  const toolNames = definitions.map((definition) => definition.name);
  const context: ToolContext = {
    serverName: name,
    serverVersion: version,
    transport,
    toolNames,
  };

  const server = new McpServer({ name, version }, { instructions });

  for (const definition of definitions) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema,
      },
      async (args) => definition.handle(args as Record<string, unknown>, context),
    );
  }

  return { server, toolNames, instructions };
}
