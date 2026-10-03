import type { ToolContext, ToolDefinition } from './tool.js';
import { decideInputSchema, decideOutputSchema, executeDecide } from '../../tools/decide.js';

export const tool: ToolDefinition = {
  name: 'decide',
  title: 'Make typed browser automation decisions',
  description:
    'Answers repeated typed decisions (choice, score, check) for browser automation agents. ' +
    'Checks fast-path memory first and returns needs_ai entries for unknown decisions. ' +
    'The safety check is advisory: it reports a request to the user and never prevents an ' +
    'agent from acting.',
  inputSchema: decideInputSchema,
  outputSchema: decideOutputSchema,

  async handle(args: Record<string, unknown>, context: ToolContext) {
    const result = await executeDecide(args, {
      store: context.store,
      session: context.session,
      sessionId: context.sessionId,
      patternEngine: context.patternEngine,
    });

    const total =
      result.answers.length +
      result.needs_ai.length +
      result.needs_human.length +
      result.schema_violations.length;

    const summary =
      `Processed ${total} decision(s): ${result.answers.length} answered from memory, ` +
      `${result.needs_ai.length} need AI, ${result.needs_human.length} need human review` +
      `${result.schema_violations.length > 0 ? `, ${result.schema_violations.length} schema violation(s)` : ''}. ` +
      `The safety check is advisory.`;

    return {
      content: [
        {
          type: 'text' as const,
          text: summary,
        },
      ],
      structuredContent: result,
    };
  },
};
