/**
 * Decision router: routes decisions across fast paths and slow paths.
 *
 * Routing order:
 * 1. Memory: exact-match lookup on normalized input, question and options.
 * 2. Patterns: matching rules and learned patterns with microsecond evaluation.
 * 3. Direct checks: deterministic page checks (planned for Phase 1).
 * 4. Needs AI / Slow path: returns needs_ai entry with a pending decision_id.
 *
 * Status: **implemented and tested** for exact-match memory, pattern matching, pattern-path
 * confidence calibration, and needs_ai fallback.
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
import { type PatternEngine, getDefaultPatternEngine } from '../patterns/index.js';
import { getThresholdForType } from './thresholds.js';
import { type CalibrationScope, calibrate, readCalibrationHistory } from '../learning/calibrate.js';

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
  patternEngine?: PatternEngine | undefined;
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
      path: 'memory' | 'pattern';
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
  threshold?: number | undefined;
  memory: Memory;
  store: DatabaseStore;
  session?: Session | string | null | undefined;
  url?: string | null | undefined;
  domain?: string | null | undefined;
  patternEngine?: PatternEngine | undefined;
}

/**
 * Routes a single validated question through the decision path hierarchy.
 */
export function routeQuestion(options: RouteQuestionOptions): RouteQuestionResult {
  const { question, input, memory, store, session } = options;
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

  // Thresholds for this decision type read from settings repository without restart
  const typeThresholds = getThresholdForType(store, question.type);

  // Exact-match memory threshold: caller's explicit threshold takes precedence,
  // keeping existing caller threshold behaviour intact and tested.
  const memoryThreshold =
    options.threshold !== undefined ? options.threshold : typeThresholds.auto_at_or_above;

  // 1. Fast path: exact-match memory
  const memoryHit = memory.lookup({
    input,
    question,
    inputHash: memoryKey,
    threshold: memoryThreshold,
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

  // 2. Patterns: matching rules and learned patterns
  // Match candidate rules down to threshold 0 so the router can evaluate confidence
  // against human_below and auto_at_or_above.
  const patternEngine = options.patternEngine ?? getDefaultPatternEngine();
  const patternHit = patternEngine.matchForQuestion(input, question, {
    threshold: 0,
    url,
    domain,
  });

  if (patternHit) {
    // Confidence calibration (Phase 2). A pattern's stated confidence is read against the
    // feedback-confirmed history of this rule before the router trusts it, so a rule that
    // says 90% and is right 30% of the time stops being answered automatically. Only the
    // confidence moves: the value, the path and the pattern id are the rule's own. A safety
    // scope is not calibrated, and the reason is in the header of learning/calibrate.ts.
    //
    // The decision row stores the calibrated confidence, because that is the confidence the
    // answer carried and the confidence the threshold below was read against. The stated
    // confidence belongs to the rule that matched, which the answer names in pattern_id.
    //
    // Read before the latency is taken, so latency_ms covers the whole routing work and not
    // the part of it that happened first.
    const calibrationScope: CalibrationScope = {
      pattern_id: patternHit.pattern_id,
      decision_type: question.type,
      safety: patternHit.is_safety,
    };
    const confidence = calibrate(
      patternHit.output.confidence,
      readCalibrationHistory(store, { scope: calibrationScope }),
      { scope: calibrationScope },
    );

    const latencyMs = Number((performance.now() - startTime).toFixed(3));

    // Safety rules requiring user confirmation (ask_user) are advisory safety stops.
    // Invariant: Safety-flagged answers are never auto-allowed past a human gate:
    // a safety rule's ask_user is not a confidence matter and is not affected by thresholds.
    const isAskUser =
      patternHit.output.value === 'ask_user' ||
      (patternHit.output as unknown as Record<string, unknown>).ask_user === true;

    if (patternHit.is_safety && isAskUser) {
      const logged = logDecision({
        question,
        answer: {
          value: patternHit.output.value,
          distribution: patternHit.output.distribution,
        },
        path: 'pattern',
        confidence,
        latencyMs,
        session,
        store,
        input,
        inputHash: memoryKey,
        url,
        domain,
        patternId: patternHit.pattern_id,
        isSafety: true,
        needsReview: true,
      });

      return {
        status: 'needs_human',
        needsHuman: {
          id: question.id,
          type: question.type,
          decision_id: logged.id,
          question,
          reason: `Safety rule "${patternHit.pattern_id}" requires user confirmation (ask_user)`,
        },
        decision: logged,
      };
    }

    // Threshold evaluation:
    // - At or above auto_at_or_above: answered automatically (fast path).
    // - Below human_below: routed to human review (needs_human).
    // - Between human_below and auto_at_or_above: routed to AI for confirmation (needs_ai).
    if (confidence >= typeThresholds.auto_at_or_above) {
      const logged = logDecision({
        question,
        answer: {
          value: patternHit.output.value,
          distribution: patternHit.output.distribution,
        },
        path: 'pattern',
        confidence,
        latencyMs,
        session,
        store,
        input,
        inputHash: memoryKey,
        url,
        domain,
        patternId: patternHit.pattern_id,
        isSafety: patternHit.is_safety,
      });

      const answerOutput: AnswerOutput = {
        id: question.id,
        type: question.type,
        value: patternHit.output.value,
        confidence,
        path: 'pattern',
        pattern_id: patternHit.pattern_id,
        latency_ms: latencyMs,
        decision_id: logged.id,
        ...(patternHit.output.distribution ? { distribution: patternHit.output.distribution } : {}),
      };

      return {
        status: 'answered',
        path: 'pattern',
        answer: answerOutput,
        decision: logged,
      };
    }

    if (confidence < typeThresholds.human_below) {
      const logged = logDecision({
        question,
        answer: {
          value: patternHit.output.value,
          distribution: patternHit.output.distribution,
        },
        path: 'pattern',
        confidence,
        latencyMs,
        session,
        store,
        input,
        inputHash: memoryKey,
        url,
        domain,
        patternId: patternHit.pattern_id,
        isSafety: patternHit.is_safety,
        needsReview: true,
      });

      return {
        status: 'needs_human',
        needsHuman: {
          id: question.id,
          type: question.type,
          decision_id: logged.id,
          question,
          reason: `Confidence ${confidence} is below human threshold ${typeThresholds.human_below}`,
        },
        decision: logged,
      };
    }

    // Between human_below and auto_at_or_above: goes to needs_ai for confirmation
    const logged = logDecision({
      question,
      answer: 'pending',
      path: 'ai',
      confidence,
      latencyMs,
      session,
      store,
      input,
      inputHash: memoryKey,
      url,
      domain,
      patternId: patternHit.pattern_id,
      isSafety: patternHit.is_safety,
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

  const threshold = options.threshold;

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
      patternEngine: options.patternEngine,
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
