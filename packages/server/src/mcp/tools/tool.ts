import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape } from 'zod';

/**
 * What the server knows about itself at registration time, passed to every tool so a
 * tool can describe the build it is part of without repeating or guessing it.
 */
export interface ToolContext {
  readonly serverName: string;
  readonly serverVersion: string;
  readonly transport: string;
  /** Names of every tool this build serves, in registration order. */
  readonly toolNames: readonly string[];
}

/**
 * One MCP tool, declared in its own file under `mcp/tools/`.
 *
 * Every file matching `*.tool.ts` (source) or `*.tool.js` (compiled) must export a
 * constant called `tool` of this shape. `mcp/tools/registry.ts` discovers those files
 * and refuses to start when one of them is malformed, so a broken tool file cannot be
 * silently skipped.
 *
 * Both schemas are required, even for a tool that takes no input: a declared schema is
 * what lets the server reject an answer that does not match it.
 *
 * The file name carries the tool name in kebab case, so `server_status` lives in
 * `server-status.tool.ts`. The stdio test checks the served tool list against the file
 * names on disk, which only holds if the two agree.
 */
export interface ToolDefinition {
  /** Wire name, lower snake case: `decide`, `page_check`, and so on. */
  readonly name: string;
  /** Short human label shown by a client. */
  readonly title: string;
  /** What the tool does, and what it does not do. Written for the agent reading it. */
  readonly description: string;
  /** Zod shape of the accepted arguments. Use `{}` for a tool that takes none. */
  readonly inputSchema: ZodRawShape;
  /** Zod shape of the structured content the tool returns. */
  readonly outputSchema: ZodRawShape;
  /** Runs the tool. Throwing is turned into a tool error result by the SDK. */
  handle(args: Record<string, unknown>, context: ToolContext): Promise<CallToolResult>;
}

/** Tool names as they appear on the wire: lower snake case, 1 to 64 characters. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** The export name every tool file must provide. */
export const TOOL_EXPORT_NAME = 'tool';
