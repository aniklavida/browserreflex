import type { ToolContext, ToolDefinition } from './tool.js';
import { getStatsInputSchema, getStatsOutputSchema, executeGetStats } from '../../tools/stats.js';

export const tool: ToolDefinition = {
  name: 'get_stats',
  title: 'Report decision counts, fast-path share and latency for a range',
  description:
    'Counts what the decision log holds for a range (today, 7d or 30d) and a filter ' +
    '(all, or browser: decisions that recorded a page URL or domain): total decisions, ' +
    'the fast-path share of them, the mix of paths, the median and 95th percentile of ' +
    'recorded latency, and a time-saved estimate. The fast-path share counts memory, ' +
    'pattern and check answers only; a model answer is never counted as fast. The ' +
    'time-saved figure is an estimate from an assumed model-call time, not a ' +
    'measurement, and the output says so on every call. Use it to report numbers, not ' +
    'to decide anything.',
  inputSchema: getStatsInputSchema,
  outputSchema: getStatsOutputSchema,

  async handle(args: Record<string, unknown>, context: ToolContext) {
    const result = executeGetStats(args, { store: context.store });

    const share =
      result.fast_path_share === null
        ? 'no decisions in range, so no fast-path share'
        : `fast-path share ${(result.fast_path_share * 100).toFixed(1)}%`;

    const latency =
      result.median_latency_ms === null
        ? 'no recorded latency'
        : `median latency ${result.median_latency_ms} ms, 95th percentile ${(
            result.p95_latency_ms as number
          ).toString()} ms`;

    const estimate = result.time_saved_estimate;

    const text =
      `Range ${result.range} (${result.range_start} to ${result.range_end}), filter ` +
      `${result.filter}: ${result.total_decisions} decision(s), ${share} ` +
      `(${result.fast_path_counts.memory} memory, ${result.fast_path_counts.pattern} pattern, ` +
      `${result.fast_path_counts.check} check, ${result.counts_by_path.ai} ai, ` +
      `${result.counts_by_path.human} human), ${latency}. Estimated time saved ` +
      `${estimate.seconds} s: ${estimate.fast_answers_counted} fast answer(s) at an assumed ` +
      `${estimate.assumed_model_call_seconds} s per model call. That is an estimate, not a ` +
      `measurement; this server did not run a model to compare against.`;

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
