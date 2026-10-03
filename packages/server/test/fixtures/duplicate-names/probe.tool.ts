import { z } from 'zod';
import type { ToolDefinition } from '../../../src/mcp/tools/tool.js';

/** A well-formed tool file, used to prove the registry finds files it did not list. */
export const tool: ToolDefinition = {
  name: 'probe_tool',
  title: 'Probe tool',
  description: 'Fixture tool used by the registry tests. Not served by the server.',
  inputSchema: {},
  outputSchema: { ok: z.boolean() },
  async handle() {
    return {
      content: [{ type: 'text', text: 'probe' }],
      structuredContent: { ok: true },
    };
  },
};
