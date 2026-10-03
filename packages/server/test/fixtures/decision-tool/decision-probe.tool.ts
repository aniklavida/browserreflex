import { z } from 'zod';
import type { ToolDefinition } from '../../../src/mcp/tools/tool.js';

/**
 * Fixture tool for testing decision logging per question across MCP calls.
 */
export const tool: ToolDefinition = {
  name: 'decision_probe',
  title: 'Decision probe fixture tool',
  description: 'Fixture tool answering questions and logging decisions. For tests only.',
  inputSchema: {
    questions: z.array(z.any()).optional(),
  },
  outputSchema: {
    answers: z.array(z.any()).optional(),
  },
  async handle(args, context) {
    const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
    const answers = rawQuestions.map((q, idx) => {
      const logged = context.logDecision?.({
        question: q,
        answer: { value: `choice_${idx + 1}` },
        path: 'check',
        confidence: 0.95,
        latencyMs: 3,
      });

      return {
        decision_id: logged?.id,
        decisionId: logged?.id,
        value: `choice_${idx + 1}`,
        confidence: 0.95,
        path: 'check',
        latencyMs: 3,
      };
    });

    return {
      content: [{ type: 'text', text: 'probe decisions logged' }],
      structuredContent: { answers },
    };
  },
};
