import { z } from 'zod';
import type { ToolContext, ToolDefinition } from './tool.js';

/**
 * Tools the specification names that this build does not serve.
 *
 * Named here rather than left to prose, because a tool list that quietly omits a planned
 * tool is a server that describes itself wrongly: a caller reading the list cannot tell
 * which tool to plan around. `page_check` is the only one left as of this build.
 */
const PLANNED_TOOL_NAMES = ['page_check'] as const;

const serverStatusOutputSchema = {
  server: z.string(),
  version: z.string(),
  transport: z.string(),
  tool_names: z.array(z.string()),
  /** Every specification tool this build does not serve. */
  planned_tool_names: z.array(z.string()),
  /** `planned` because the set is not finished; `planned_tool_names` names what is left. */
  decision_tools_status: z.literal('planned'),
  safety_check: z.literal('advisory'),
};

export const tool: ToolDefinition = {
  name: 'server_status',
  title: 'BrowserReflex server status',
  description:
    'Reports that this BrowserReflex MCP server is running, which tools this build serves, ' +
    'and which specification tools are still planned. This build serves the decision tools ' +
    'decide, submit_answers, action_guard, feedback, get_pending_reviews and get_stats; ' +
    'page_check is planned and will not answer. The safety check is advisory: it reports a ' +
    'request to the user and does not stop an agent from acting.',
  inputSchema: {},
  outputSchema: serverStatusOutputSchema,

  async handle(_args: Record<string, unknown>, context: ToolContext) {
    const status = {
      server: context.serverName,
      version: context.serverVersion,
      transport: context.transport,
      tool_names: [...context.toolNames],
      planned_tool_names: [...PLANNED_TOOL_NAMES],
      decision_tools_status: 'planned' as const,
      safety_check: 'advisory' as const,
    };

    return {
      content: [
        {
          type: 'text' as const,
          text:
            `${status.server} ${status.version} on ${status.transport}; tools: ` +
            `${status.tool_names.join(', ')}. Planned and not implemented: ` +
            `${status.planned_tool_names.join(', ')}. The safety check is advisory.`,
        },
      ],
      structuredContent: status,
    };
  },
};
