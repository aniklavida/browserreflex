import type { ToolContext, ToolDefinition } from './tool.js';
import {
  executeSubmitAnswers,
  submitAnswersInputSchema,
  submitAnswersOutputSchema,
} from '../../tools/submit_answers.js';

export const tool: ToolDefinition = {
  name: 'submit_answers',
  title: 'Submit typed answers for decisions needing AI',
  description:
    'Submits typed answers (value, distribution, confidence) for decisions that returned needs_ai. ' +
    'Validates each answer against the decision schema: invalid answers return schema_violation and ' +
    'remain retryable with the same decision_id. Valid answers are stored with path "ai"; answers below ' +
    'the confidence threshold route to needs_human. The safety check is advisory: it reports a ' +
    'request to the user and never prevents an agent from acting.',
  inputSchema: submitAnswersInputSchema,
  outputSchema: submitAnswersOutputSchema,

  async handle(args: Record<string, unknown>, context: ToolContext) {
    const result = await executeSubmitAnswers(args, {
      store: context.store,
      session: context.session,
      sessionId: context.sessionId,
    });

    const total =
      result.answers.length +
      result.needs_human.length +
      result.schema_violations.length +
      result.errors.length;

    const summary =
      `Processed ${total} answer(s): ${result.answers.length} accepted, ` +
      `${result.needs_human.length} routed to human review, ` +
      `${result.schema_violations.length} schema violation(s), ` +
      `${result.errors.length} error(s). ` +
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
