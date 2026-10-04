import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';
import type { BrowserReflexMcpServer } from './server.js';
import { resolveBrowserPackDirectory } from '../tools/page_check.js';

/**
 * Starts the MCP server on stdio and wires shutdown.
 *
 * The browser pack is loaded here, at start-up, through the pack loader, so the tools that
 * answer from its rules have them. A pack that fails to load is reported as a warning and
 * the server still starts: the rules that did load are served and the tool output says which
 * pack did not load.
 *
 * Nothing may be written to stdout here: stdout is the JSON-RPC channel, and one stray
 * line makes a client fail to parse the stream. Diagnostics go to stderr.
 */
export async function main(): Promise<BrowserReflexMcpServer> {
  const built = await createMcpServer({ packsDirectory: resolveBrowserPackDirectory() });
  const transport = new StdioServerTransport();
  await built.server.connect(transport);

  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    closing ??= built.server.close();
    return closing;
  };

  process.stdin.on('end', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });

  process.stderr.write(
    `browserreflex mcp server ready on stdio: ${built.toolNames.length} tool(s) [${built.toolNames.join(', ')}]\n`,
  );

  return built;
}

const entryPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
const isDirectRun =
  entryPath !== undefined && entryPath === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main().catch((error: unknown) => {
    process.stderr.write(`browserreflex mcp server failed to start: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
