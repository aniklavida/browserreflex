/**
 * Decision router: routes decisions across fast paths and slow paths.
 *
 * Routing order:
 * 1. Memory: exact-match lookup on normalized input, question and options.
 * 2. Patterns: matching rules and learned patterns (planned for Phase 1).
 * 3. Direct checks: deterministic page checks (planned for Phase 1).
 * 4. Needs AI / Slow path: returns needs_ai entry with a pending decision_id.
 *
 * Status: **implemented and tested** for exact-match memory and needs_ai fallback.
 *
 * Invariants:
 * - A decision record that misdescribes itself is worse than no record:
 *   every decision logged carries the actual path and confidence.
 * - Every question in a batch produces exactly one decisions row.
 * - The safety check is advisory; it never prevents an agent from acting.
 */

import { performance } from 'node:perf_hooks';
import type { DatabaseStore, Decision, Session } from '../store/index.js';
import { Memory, computeMemoryKey } from './memory.js';
import { logDecision } from './log.js';
import {
  type DecisionPath,
  type DecisionType,
  type Question,
  SCHEMA_VIOLATION,
  validateQuestion,
} from './schema.js';

export interface AnswerOutput {
  id: string;
  type: DecisionType;
  value: string | number | boolean;
  distribution?: Record<string, number> | undefined;
  confidence: number;
  path: DecisionPath;
  pattern_id?: string | undefined;
  latency_ms: number;
  decision_id: string;
}

export interface NeedsAiItem {
  decision_id: string;
  id: string;
  type: DecisionType;
  text?: string | undefined;
  question: Question;
}

export interface NeedsHumanItem {
  id: string;
  type?: DecisionType | undefined;
  decision_id?: string | undefined;
  question?: Question | undefined;
  reason?: string | undefined;
}

export interface QuestionSchemaViolation {
  id?: string | undefined;
  type: typeof SCHEMA_VIOLATION;
  reason: string;
  field?: string | undefined;
  details?: unknown;
  question?: unknown;
}

export interface RouteBatchOptions {
  questions: unknown[];
  state?: unknown;
  context?: unknown;
  input?: unknown;
  threshold?: number | undefined;
  memory: Memory;
  store: DatabaseStore;
  session?: Session | string | null | undefined;
  url?: string | null | undefined;
  domain?: string | null | undefined;
}

export interface RouteBatchResult {
  [key: string]: unknown;
  answers: AnswerOutput[];
  needs_ai: NeedsAiItem[];
  needs_human: NeedsHumanItem[];
  schema_violations: QuestionSchemaViolation[];
}

export type RouteQuestionResult =
  | {
      status: 'answered';
      path: 'memory';
      answer: AnswerOutput;
      decision: Decision;
    }
  | {
      status: 'needs_ai';
      needsAi: NeedsAiItem;
      decision: Decision;
    }
  | {
      status: 'needs_human';
      needsHuman: NeedsHumanItem;
      decision: Decision;
    };

export interface RouteQuestionOptions {
  question: Question;
  input: unknown;
  threshold: number;
  memory: Memory;
  store: DatabaseStore;
  session?: Session | string | null | undefined;
  url?: string | null | undefined;
  domain?: string | null | undefined;
}

/**
 * Routes a single validated question through the decision path hierarchy.
 */
export function routeQuestion(options: RouteQuestionOptions): RouteQuestionResult {
  const { question, input, threshold, memory, store, session } = options;
  const startTime = performance.now();
  const optionsList = question.type === 'choice' ? question.options : undefined;
  const memoryKey = computeMemoryKey(input, question, optionsList);

  let url = options.url ?? null;
  let domain = options.domain ?? null;
  if (!url && typeof input === 'object' && input !== null && 'url' in input) {
    const rawUrl = (input as Record<string, unknown>).url;
    if (typeof rawUrl === 'string') {
      url = rawUrl;
    }
  }
  if (!domain && typeof input === 'object' && input !== null && 'domain' in input) {
    const rawDomain = (input as Record<string, unknown>).domain;
    if (typeof rawDomain === 'string') {
      domain = rawDomain;
    }
  }

  // 1. Fast path: exact-match memory
  const memoryHit = memory.lookup({
    input,
    question,
    inputHash: memoryKey,
    threshold,
    ...(optionsList !== undefined ? { options: optionsList } : {}),
  });

  if (memoryHit) {
    const latencyMs = Number((performance.now() - startTime).toFixed(3));
    const logged = logDecision({
      question,
      answer: memoryHit.answer,
      path: 'memory',
      confidence: memoryHit.confidence,
      latencyMs,
      session,
      store,
      input,
      inputHash: memoryKey,
      url,
      domain,
      patternId: memoryHit.decision.pattern_id ?? undefined,
    });

    const answerOutput: AnswerOutput = {
      id: question.id,
      type: question.type,
      value: memoryHit.answer.value,
      confidence: memoryHit.confidence,
      path: 'memory',
      latency_ms: latencyMs,
      decision_id: logged.id,
      ...(memoryHit.answer.distribution ? { distribution: memoryHit.answer.distribution } : {}),
      ...(memoryHit.decision.pattern_id
        ? {
            pattern_id: memoryHit.decision.pattern_id,
          }
        : {}),
    };

    return {
      status: 'answered',
      path: 'memory',
      answer: answerOutput,
      decision: logged,
    };
  }

  // 2. Patterns: planned for Phase 1. Rules and learned patterns slot here.
  // 3. Direct checks: planned for Phase 1. Snapshot evaluations slot here.

  // 4. Slow path / Chat mode: unknown items return in needs_ai with pending decision_id
  const latencyMs = Number((performance.now() - startTime).toFixed(3));
  const logged = logDecision({
    question,
    answer: 'pending',
    path: 'ai',
    confidence: 0.0,
    latencyMs,
    session,
    store,
    input,
    inputHash: memoryKey,
    url,
    domain,
  });

  const needsAiItem: NeedsAiItem = {
    id: question.id,
    type: question.type,
    text: question.text,
    decision_id: logged.id,
    question,
  };

  return {
    status: 'needs_ai',
    needsAi: needsAiItem,
    decision: logged,
  };
}

/**
 * Routes a batch of questions, validating each question schema and returning
 * answered items from memory, unknown items in needs_ai, and any invalid questions
 * in schema_violations without failing the entire batch.
 */
export function routeBatch(options: RouteBatchOptions): RouteBatchResult {
  const answers: AnswerOutput[] = [];
  const needs_ai: NeedsAiItem[] = [];
  const needs_human: NeedsHumanItem[] = [];
  const schema_violations: QuestionSchemaViolation[] = [];

  let input: unknown;
  if (options.input !== undefined) {
    input = options.input;
  } else if (options.state !== undefined && options.context !== undefined) {
    input = { state: options.state, context: options.context };
  } else if (options.state !== undefined) {
    input = options.state;
  } else if (options.context !== undefined) {
    input = options.context;
  } else {
    input = null;
  }

  let url = options.url ?? null;
  let domain = options.domain ?? null;
  if (!url && typeof input === 'object' && input !== null && 'url' in input) {
    const rawUrl = (input as Record<string, unknown>).url;
    if (typeof rawUrl === 'string') {
      url = rawUrl;
    }
  }
  if (!domain && typeof input === 'object' && input !== null && 'domain' in input) {
    const rawDomain = (input as Record<string, unknown>).domain;
    if (typeof rawDomain === 'string') {
      domain = rawDomain;
    }
  }
  if (!domain && url) {
    try {
      domain = new URL(url).hostname;
    } catch {
      // Ignore URL parsing errors
    }
  }

  const threshold = options.threshold !== undefined ? options.threshold : 0.8;

  for (const rawQ of options.questions) {
    const validation = validateQuestion(rawQ);
    if (!validation.success) {
      const rawObj =
        typeof rawQ === 'object' && rawQ !== null ? (rawQ as Record<string, unknown>) : {};
      schema_violations.push({
        id: typeof rawObj.id === 'string' ? rawObj.id : undefined,
        type: SCHEMA_VIOLATION,
        reason: validation.reason,
        field: validation.field,
        details: validation.details,
        question: rawQ,
      });
      continue;
    }

    const question = validation.data;
    const routed = routeQuestion({
      question,
      input,
      threshold,
      memory: options.memory,
      store: options.store,
      session: options.session,
      url,
      domain,
    });

    if (routed.status === 'answered') {
      answers.push(routed.answer);
    } else if (routed.status === 'needs_ai') {
      needs_ai.push(routed.needsAi);
    } else if (routed.status === 'needs_human') {
      needs_human.push(routed.needsHuman);
    }
  }

  return {
    answers,
    needs_ai,
    needs_human,
    schema_violations,
  };
}
