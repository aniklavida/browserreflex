import { z } from 'zod';
import type { ToolContext, ToolDefinition } from './tool.js';

/**
 * Tools the specification names that this build does not serve. Every decision tool in the
 * specification is served as of this build, so the list is empty; it stays a named list so a
 * tool added to the specification and not served shows up here rather than being omitted.
 */
const PLANNED_TOOL_NAMES: readonly string[] = [];

const serverStatusOutputSchema = {
  server: z.string(),
  version: z.string(),
  transport: z.string(),
  tool_names: z.array(z.string()),
  decision_tools_status: z.enum(['complete', 'partial']),
  planned_tools: z.array(z.string()),
  safety_check: z.literal('advisory'),
};

export const tool: ToolDefinition = {
  name: 'server_status',
  title: 'BrowserReflex server status',
  description:
    'Reports that this BrowserReflex MCP server is running, which tools this build serves, ' +
    'and which specification tools are still planned. This build serves the decision tools ' +
    'decide, page_check, submit_answers, action_guard, feedback, get_pending_reviews and ' +
    'get_stats. The safety check is advisory: it reports a request to the user and does not ' +
    'stop an agent from acting.',
  inputSchema: {},
  outputSchema: serverStatusOutputSchema,

  async handle(_args: Record<string, unknown>, context: ToolContext) {
    const plannedTools = [...PLANNED_TOOL_NAMES];
    const status = {
      server: context.serverName,
      version: context.serverVersion,
      transport: context.transport,
      tool_names: [...context.toolNames],
      decision_tools_status:
        plannedTools.length === 0 ? ('complete' as const) : ('partial' as const),
      planned_tools: plannedTools,
      safety_check: 'advisory' as const,
    };

    const plannedText =
      plannedTools.length === 0
        ? 'No specification tool is planned and unserved.'
        : `${plannedTools.join(' and ')} ${plannedTools.length === 1 ? 'is' : 'are'} planned, not implemented.`;

    return {
      content: [
        {
          type: 'text' as const,
          text:
            `${status.server} ${status.version} on ${status.transport}; tools: ` +
            `${status.tool_names.join(', ')}. ${plannedText} The safety check is advisory.`,
        },
      ],
      structuredContent: status,
    };
  },
};
