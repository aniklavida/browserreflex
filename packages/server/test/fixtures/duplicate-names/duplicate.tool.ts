import { z } from 'zod';
import type { ToolDefinition } from '../../../src/mcp/tools/tool.js';

/** Declares the same name as the `probe.tool.ts` beside it, which the registry refuses. */
export const tool: ToolDefinition = {
  name: 'probe',
  title: 'Duplicate probe tool',
  description: 'Fixture tool used by the registry tests. Not served by the server.',
  inputSchema: {},
  outputSchema: { ok: z.boolean() },
  async handle() {
    return {
      content: [{ type: 'text', text: 'duplicate probe' }],
      structuredContent: { ok: true },
    };
  },
};
