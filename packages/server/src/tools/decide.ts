/**
 * The `decide` tool: general typed decision tool for browser-automation agents.
 *
 * Status: **implemented and tested**.
 *
 * Evaluates a batch of questions, trying fast paths first (memory, patterns) and
 * returning `needs_ai` for unknown items in chat mode. In BYOK mode, when a
 * provider key is configured and mode is not chat, `decide` resolves `needs_ai`
 * decisions itself through the provider adapter and validates answers against
 * the typed schema.
 *
 * Invariants:
 * - A decision record that misdescribes itself is worse than no record:
 *   every decision logged carries the actual path and confidence.
 * - The safety check is advisory; it never prevents an agent from acting.
 * - Every question in the batch produces exactly one decisions row.
 * - In BYOK mode, answers resolved via model carry path 'ai', with measured
 *   latency and model confidence.
 * - Invalid model output is rejected and falls back to needs_ai, never stored
 *   as an answer.
 * - Provider failure falls back to needs_ai and never throws to the MCP client.
 * - Provider keys are never logged, stored in decisions, or returned in tool output.
 */

import { z } from 'zod';
import type { ZodRawShape } from 'zod';
import {
  type DecisionPath,
  type DecisionType,
  DecisionPathSchema,
  DecisionTypeSchema,
  SCHEMA_VIOLATION,
} from '../core/schema.js';
import {
  type AnswerOutput,
  type NeedsHumanItem,
  type RouteBatchResult,
  routeBatch,
} from '../core/router.js';
import { createMemory } from '../core/memory.js';
import { getDefaultStore, type DatabaseStore, type Session } from '../index.js';
import type { PatternEngine } from '../patterns/index.js';
import {
  ANTHROPIC_PROVIDER_ID,
  type ModelAdapter,
  createAnthropicAdapter,
  resolveNeedsAi,
} from '../adapters/index.js';
import type { KeyStore } from '../security/keys.js';

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
  keyStore?: KeyStore | undefined;
  adapter?: ModelAdapter | undefined;
  now?: (() => number) | undefined;
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
 * Resolves a model adapter for BYOK mode.
 *
 * Returns null when in chat mode (mode === 'chat' or no provider key configured).
 */
async function resolveDecideAdapter(
  context: DecideContext,
  store: DatabaseStore,
): Promise<ModelAdapter | null> {
  const mode = store.settings.getValue('mode');
  if (mode === 'chat') {
    return null;
  }

  // If a custom or scripted adapter was explicitly provided (e.g. in tests)
  if (context.adapter) {
    if (context.keyStore) {
      const hasKey = await context.keyStore.hasKey(context.adapter.provider);
      if (!hasKey) {
        return null;
      }
    }
    return context.adapter;
  }

  // The key store is passed in by the server at start-up. It is never looked up here, so a
  // direct call to `decide` (a test, an embedding) can never reach a key the machine holds.
  const keyStore = context.keyStore;
  if (!keyStore) {
    return null;
  }

  const provider = store.settings.getValue('provider') ?? ANTHROPIC_PROVIDER_ID;
  if (provider === ANTHROPIC_PROVIDER_ID) {
    const hasKey = await keyStore.hasKey(ANTHROPIC_PROVIDER_ID);
    if (!hasKey) {
      return null;
    }
    return createAnthropicAdapter({
      keyStore,
      store,
      ...(context.now !== undefined ? { now: context.now } : {}),
    });
  }

  return null;
}

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

  const result = routeBatch({
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

  if (result.needs_ai.length === 0) {
    return result;
  }

  // Attempt BYOK resolution if a provider key / adapter is configured
  const adapter = await resolveDecideAdapter(context, store);
  if (!adapter) {
    return result;
  }

  try {
    let input: unknown;
    if (args.input !== undefined) {
      input = args.input;
    } else if (args.state !== undefined && args.context !== undefined) {
      input = { state: args.state, context: args.context };
    } else if (args.state !== undefined) {
      input = args.state;
    } else if (args.context !== undefined) {
      input = args.context;
    } else {
      input = null;
    }

    const resolved = await resolveNeedsAi(result.needs_ai, adapter, {
      store,
      session: context.session,
      sessionId: context.sessionId,
      threshold,
      context: input,
      now: context.now,
    });

    const aiAnswers: AnswerOutput[] = resolved.answers.map((ans) => {
      const original = result.needs_ai.find(
        (q) => q.decision_id === ans.decision_id || q.id === ans.id,
      );
      return {
        id: ans.id ?? ans.decision_id,
        type: (ans.type ?? original?.type ?? 'choice') as DecisionType,
        value: ans.value,
        confidence: ans.confidence,
        path: 'ai' as DecisionPath,
        latency_ms: ans.latency_ms ?? resolved.latency_ms,
        decision_id: ans.decision_id,
        ...(ans.distribution ? { distribution: ans.distribution } : {}),
      };
    });

    const aiNeedsHuman: NeedsHumanItem[] = resolved.needs_human.map((item) => {
      const original = result.needs_ai.find(
        (q) => q.decision_id === item.decision_id || q.id === item.id,
      );
      return {
        id: item.id ?? item.decision_id,
        type: item.type ?? original?.type,
        decision_id: item.decision_id,
        question: original?.question,
        reason: item.reason,
      };
    });

    const resolvedDecisionIds = new Set([
      ...resolved.answers.map((a) => a.decision_id),
      ...resolved.needs_human.map((h) => h.decision_id),
    ]);

    const remainingNeedsAi = result.needs_ai.filter(
      (item) => !resolvedDecisionIds.has(item.decision_id),
    );

    return {
      answers: [...result.answers, ...aiAnswers],
      needs_ai: remainingNeedsAi,
      needs_human: [...result.needs_human, ...aiNeedsHuman],
      schema_violations: result.schema_violations,
    };
  } catch {
    // Adapter or resolution failure falls back to needs_ai, never throws to client
    return result;
  }
}
