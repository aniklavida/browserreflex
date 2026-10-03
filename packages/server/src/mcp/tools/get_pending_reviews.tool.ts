import type { ToolContext, ToolDefinition } from './tool.js';
import {
  getPendingReviewsInputSchema,
  getPendingReviewsOutputSchema,
  executeGetPendingReviews,
} from '../../tools/reviews.js';

export const tool: ToolDefinition = {
  name: 'get_pending_reviews',
  title: 'List the decisions still waiting on a person',
  description:
    'Lists decisions that still need a person: ones the slow path could not answer ' +
    '(needs_ai), ones routed to a human, and ones flagged for review. Filter by ' +
    'decision type, by how long an item has been waiting, or by how many to return; ' +
    'items come back oldest first and every text field comes back redacted. An item ' +
    'here is a request for a person to look at it. The safety check is advisory: this ' +
    'tool reports it and never prevents an agent from acting.',
  inputSchema: getPendingReviewsInputSchema,
  outputSchema: getPendingReviewsOutputSchema,

  async handle(args: Record<string, unknown>, context: ToolContext) {
    const result = executeGetPendingReviews(args, { store: context.store });

    const filters: string[] = [];
    if (result.type !== null) {
      filters.push(`type ${result.type}`);
    }
    if (result.older_than_minutes !== null) {
      filters.push(`waiting at least ${result.older_than_minutes} minutes`);
    }
    const filterText = filters.length > 0 ? ` (${filters.join(', ')})` : '';

    const oldest = result.items[0];
    const reasons = Array.from(new Set(result.items.flatMap((item) => item.reasons)));

    const text =
      `${result.returned_count} of ${result.matching_count} item(s) waiting on a person` +
      `${filterText}, oldest first` +
      `${oldest !== undefined ? `; oldest from ${oldest.created_at}` : ''}. ` +
      `${reasons.length > 0 ? `Reasons present: ${reasons.join(', ')}. ` : ''}` +
      `Question, context, URL and answer are redacted. The safety check is advisory: ` +
      `nothing here stops an agent from acting.`;

    return {
      content: [
        {
          type: 'text' as const,
          text,
        },
      ],
      structuredContent: { ...result },
    };
  },
};
