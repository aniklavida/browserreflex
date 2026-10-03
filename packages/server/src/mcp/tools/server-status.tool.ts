import { z } from 'zod';
import type { ToolContext, ToolDefinition } from './tool.js';

const serverStatusOutputSchema = {
  server: z.string(),
  version: z.string(),
  transport: z.string(),
  tool_names: z.array(z.string()),
  decision_tools_status: z.literal('planned'),
  safety_check: z.literal('advisory'),
};

export const tool: ToolDefinition = {
  name: 'server_status',
  title: 'BrowserReflex server status',
  description:
    'Reports that this BrowserReflex MCP server is running, which tools this build serves, ' +
    'and which specification tools are still planned. This build serves no decision tools: ' +
    'decide, submit_answers, page_check, action_guard, feedback, get_pending_reviews and ' +
    'get_stats are planned and will not answer. The safety check is advisory: it reports a ' +
    'request to the user and does not stop an agent from acting.',
  inputSchema: {},
  outputSchema: serverStatusOutputSchema,

  async handle(_args: Record<string, unknown>, context: ToolContext) {
    const status = {
      server: context.serverName,
      version: context.serverVersion,
      transport: context.transport,
      tool_names: [...context.toolNames],
      decision_tools_status: 'planned' as const,
      safety_check: 'advisory' as const,
    };

    return {
      content: [
        {
          type: 'text' as const,
          text:
            `${status.server} ${status.version} on ${status.transport}; tools: ` +
            `${status.tool_names.join(', ')}. Decision tools are planned, not implemented. ` +
            `The safety check is advisory.`,
        },
      ],
      structuredContent: status,
    };
  },
};
