/**
 * The `decide` tool: general typed decision tool for browser-automation agents.
 *
 * Status: **implemented and tested**.
 *
 * Evaluates a batch of questions, trying fast paths first (memory) and returning
 * `needs_ai` for unknown items so the agent can think and submit answers.
 *
 * Invariants:
 * - A decision record that misdescribes itself is worse than no record:
 *   every decision logged carries the actual path and confidence.
 * - The safety check is advisory; it never prevents an agent from acting.
 * - Every question in the batch produces exactly one decisions row.
 */

import { z } from 'zod';
import type { ZodRawShape } from 'zod';
import { DecisionPathSchema, DecisionTypeSchema, SCHEMA_VIOLATION } from '../core/schema.js';
import { type RouteBatchResult, routeBatch } from '../core/router.js';
import { createMemory } from '../core/memory.js';
import { getDefaultStore, type DatabaseStore, type Session } from '../index.js';
import type { PatternEngine } from '../patterns/index.js';

export interface DecideInput {
  questions: unknown[];
  state?: unknown;
  context?: unknown;
  input?: unknown;
  threshold?: number | undefined;
  url?: string | undefined;
}

export type DecideOutput = RouteBatchResult;

export interface DecideContext {
  store?: DatabaseStore | undefined;
  session?: Session | undefined;
  sessionId?: string | undefined;
  patternEngine?: PatternEngine | undefined;
}

export const decideInputSchema: ZodRawShape = {
  questions: z.array(z.any()).describe('Batch of typed questions (choice, score, check)'),
  state: z.any().optional().describe('Snapshot or state of the page/browser'),
  context: z.any().optional().describe('Supplemental context for the decisions'),
  threshold: z.number().min(0).max(1).optional().describe('Confidence threshold for memory reuse'),
  url: z.string().optional().describe('Page URL if not included in state'),
};

export const decideOutputSchema: ZodRawShape = {
  answers: z.array(
    z.object({
      id: z.string(),
      type: DecisionTypeSchema,
      value: z.union([z.string(), z.number(), z.boolean()]),
      distribution: z.record(z.string(), z.number()).optional(),
      confidence: z.number().min(0).max(1),
      path: DecisionPathSchema,
      pattern_id: z.string().optional(),
      latency_ms: z.number(),
      decision_id: z.string(),
    }),
  ),
  needs_ai: z.array(
    z.object({
      id: z.string(),
      type: DecisionTypeSchema,
      decision_id: z.string(),
      text: z.string().optional(),
      question: z.any().optional(),
    }),
  ),
  needs_human: z.array(
    z.object({
      id: z.string(),
      type: DecisionTypeSchema.optional(),
      decision_id: z.string().optional(),
      question: z.any().optional(),
      reason: z.string().optional(),
    }),
  ),
  schema_violations: z
    .array(
      z.object({
        id: z.string().optional(),
        type: z.literal(SCHEMA_VIOLATION),
        reason: z.string(),
        field: z.string().optional(),
        details: z.any().optional(),
        question: z.any().optional(),
      }),
    )
    .optional(),
};

/**
 * Executes the `decide` tool logic for a batch of questions.
 */
export async function executeDecide(
  args: Record<string, unknown>,
  context: DecideContext,
): Promise<DecideOutput> {
  const store = context.store ?? getDefaultStore();
  const memory = createMemory(store);

  const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
  const threshold = typeof args.threshold === 'number' ? args.threshold : undefined;
  const url = typeof args.url === 'string' ? args.url : undefined;

  return routeBatch({
    questions: rawQuestions,
    state: args.state,
    context: args.context,
    input: args.input,
    threshold,
    memory,
    store,
    session: context.session ?? context.sessionId ?? null,
    url,
    patternEngine: context.patternEngine,
  });
}
