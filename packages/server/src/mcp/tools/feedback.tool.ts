import type { ToolContext, ToolDefinition } from './tool.js';
import {
  type FeedbackOutput,
  executeFeedback,
  feedbackInputSchema,
  feedbackOutputSchema,
} from '../../tools/feedback.js';

export const tool: ToolDefinition = {
  name: 'feedback',
  title: 'Correct a recorded decision',
  description:
    'Records a correction to a decision this server made, from the user or from the agent. ' +
    'Takes the decision id from an earlier call, the value that is actually correct and an ' +
    'optional note. The correction confirms the decision in memory, so the next decide for ' +
    'the same input and question returns the corrected value. Memory serves the most recent ' +
    'reusable decision for an input, so correct the decision the last decide returned. ' +
    'When the decision came from a pattern, one agree or disagree sample is recorded against ' +
    'that pattern and the resulting accuracy is reported. An unknown decision id, or a value ' +
    'that does not match the decision type, is reported as an error and nothing is written. ' +
    'This tool records a correction only: it changes no pattern and no rule, and the safety ' +
    'check stays advisory, so it never prevents an agent from acting.',
  inputSchema: feedbackInputSchema,
  outputSchema: feedbackOutputSchema,

  async handle(args: Record<string, unknown>, context: ToolContext) {
    const result = await executeFeedback(args, {
      store: context.store,
      session: context.session,
      sessionId: context.sessionId,
      patternEngine: context.patternEngine,
    });

    const text =
      result.status === 'recorded'
        ? summariseRecorded(result)
        : `Feedback was not recorded (${result.error ?? 'unknown error'}): ${result.message ?? ''}`;

    return {
      content: [
        {
          type: 'text' as const,
          text,
        },
      ],
      structuredContent: result,
    };
  },
};

/** Describes what was recorded and what changed, in the words the tool used. */
function summariseRecorded(result: FeedbackOutput): string {
  const previous =
    result.previous_value === undefined
      ? 'a previous answer that could not be read'
      : String(result.previous_value);

  const parts = [
    `Recorded feedback ${result.feedback_id ?? ''} for decision ${result.decision_id}` +
      (result.decision_path ? ` (answered on the ${result.decision_path} path)` : '') +
      `: ${previous} corrected to ${String(result.correct_value)}.`,
  ];

  parts.push(
    result.memory_confirmed === true
      ? 'The memory reuse rule now reuses this decision and serves the corrected value.'
      : 'This decision is not marked confirmed.',
  );

  if (result.pattern === null || result.pattern === undefined) {
    parts.push('The decision came from no pattern, so no pattern statistics changed.');
  } else if (result.pattern.sample_recorded) {
    parts.push(
      `Pattern statistics: ${result.pattern.sample_count} sample(s), accuracy ${
        result.pattern.accuracy
      }.`,
    );
  } else {
    parts.push(
      'The decision names a pattern but no sample was recorded, because the stored answer ' +
        'could not be compared with the correction.',
    );
  }

  return parts.join(' ');
}
