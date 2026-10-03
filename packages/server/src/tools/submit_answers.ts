/**
 * The `submit_answers` tool: receives the agent's typed answers for decisions that
 * previously returned `needs_ai`.
 *
 * Status: **implemented and tested**.
 *
 * Invariants:
 * - A decision record that misdescribes itself is worse than no record:
 *   every stored decision states the actual path ('ai') and confidence used.
 * - The safety check is advisory; it never prevents an agent from acting.
 * - Invalid answers return `schema_violation` for that item without updating
 *   the database, keeping the pending decision retryable with the same `decision_id`.
 * - Valid answers whose confidence is below the threshold route to `needs_human`.
 * - Unknown or already-completed decision IDs return clear typed errors.
 */

import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { ZodRawShape } from 'zod';
import {
  type Answer,
  type CheckQuestion,
  type DecisionPath,
  type DecisionType,
  type Option,
  type Scale,
  type ValidationFailure,
  type ValidationResult,
  DECISION_PATHS,
  DISTRIBUTION_SUM_TOLERANCE,
  DecisionTypeSchema,
  SCHEMA_VIOLATION,
  createSchemaViolation,
  validateAnswer,
} from '../core/schema.js';
import { updateDecisionLog } from '../core/log.js';
import { getDefaultStore, type DatabaseStore, type Session } from '../index.js';

export interface ValidatedAnswerItem {
  decision_id: string;
  id?: string | undefined;
  type?: DecisionType | undefined;
  value: string | number | boolean;
  distribution?: Record<string, number> | undefined;
  confidence: number;
  path: 'ai';
  latency_ms?: number | undefined;
}

export interface NeedsHumanAnswerItem {
  decision_id: string;
  id?: string | undefined;
  type?: DecisionType | undefined;
  value?: string | number | boolean | undefined;
  distribution?: Record<string, number> | undefined;
  confidence: number;
  reason: string;
}

export interface AnswerSchemaViolation {
  decision_id?: string | undefined;
  id?: string | undefined;
  type: typeof SCHEMA_VIOLATION;
  reason: string;
  field?: string | undefined;
  details?: unknown;
}

export interface SubmitAnswerError {
  decision_id: string;
  type: 'not_found' | 'already_completed' | 'invalid_id';
  message: string;
}

export interface SubmitAnswersOutput {
  [key: string]: unknown;
  answers: ValidatedAnswerItem[];
  needs_human: NeedsHumanAnswerItem[];
  schema_violations: AnswerSchemaViolation[];
  errors: SubmitAnswerError[];
}

export interface SubmitAnswersContext {
  store?: DatabaseStore | undefined;
  session?: Session | undefined;
  sessionId?: string | undefined;
}

export const submitAnswersInputSchema: ZodRawShape = {
  answers: z
    .union([z.array(z.any()), z.record(z.string(), z.any())])
    .describe(
      'Batch of decision answers from the agent, provided as an array or map containing ' +
        'decision_id, value, confidence, and optional distribution/question',
    ),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      'Confidence threshold for accepting answers without human review (default 0.8). ' +
        'Answers with confidence below this threshold are routed to needs_human.',
    ),
};

export const submitAnswersOutputSchema: ZodRawShape = {
  answers: z.array(
    z.object({
      decision_id: z.string(),
      id: z.string().optional(),
      type: DecisionTypeSchema.optional(),
      value: z.union([z.string(), z.number(), z.boolean()]),
      distribution: z.record(z.string(), z.number()).optional(),
      confidence: z.number().min(0).max(1),
      path: z.literal('ai'),
      latency_ms: z.number().optional(),
    }),
  ),
  needs_human: z.array(
    z.object({
      decision_id: z.string(),
      id: z.string().optional(),
      type: DecisionTypeSchema.optional(),
      value: z.union([z.string(), z.number(), z.boolean()]).optional(),
      distribution: z.record(z.string(), z.number()).optional(),
      confidence: z.number(),
      reason: z.string(),
    }),
  ),
  schema_violations: z.array(
    z.object({
      decision_id: z.string().optional(),
      id: z.string().optional(),
      type: z.literal(SCHEMA_VIOLATION),
      reason: z.string(),
      field: z.string().optional(),
      details: z.any().optional(),
    }),
  ),
  errors: z.array(
    z.object({
      decision_id: z.string(),
      type: z.string(),
      message: z.string(),
    }),
  ),
};

function serializeAnswer(value: unknown, distribution?: Record<string, number>): string {
  if (distribution !== undefined) {
    return JSON.stringify({ value, distribution });
  }
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Executes the `submit_answers` tool logic.
 *
 * Validates each submitted answer against the decision schema:
 * - If invalid: returns schema_violation for that item and leaves the database decision
 *   as pending, allowing the agent to retry with the same decision_id.
 * - If unknown decision_id or already-completed: returns typed error.
 * - If valid and meets threshold: stores decision with path 'ai' and returns in answers.
 * - If valid and below threshold: stores decision with needs_review: 1 and routes to needs_human.
 */
export async function executeSubmitAnswers(
  args: Record<string, unknown>,
  context: SubmitAnswersContext = {},
): Promise<SubmitAnswersOutput> {
  const store = context.store ?? getDefaultStore();
  const threshold =
    typeof args.threshold === 'number' && !Number.isNaN(args.threshold)
      ? Math.max(0, Math.min(1, args.threshold))
      : 0.8;

  let rawList: unknown[] = [];
  const rawAnswers = args.answers ?? args.decisions ?? args.items;
  if (Array.isArray(rawAnswers)) {
    rawList = rawAnswers;
  } else if (typeof rawAnswers === 'object' && rawAnswers !== null) {
    rawList = Object.entries(rawAnswers).map(([key, val]) => {
      if (typeof val === 'object' && val !== null) {
        return { decision_id: key, ...val };
      }
      return { decision_id: key, value: val };
    });
  } else if (Array.isArray(args)) {
    rawList = args;
  }

  const answers: ValidatedAnswerItem[] = [];
  const needs_human: NeedsHumanAnswerItem[] = [];
  const schema_violations: AnswerSchemaViolation[] = [];
  const errors: SubmitAnswerError[] = [];

  for (const itemRaw of rawList) {
    const itemStartTime = performance.now();

    if (typeof itemRaw !== 'object' || itemRaw === null) {
      schema_violations.push({
        type: SCHEMA_VIOLATION,
        reason: 'Answer item must be an object',
      });
      continue;
    }

    const obj = itemRaw as Record<string, unknown>;
    const rawId = obj.decision_id ?? obj.decisionId ?? obj.id;

    if (typeof rawId !== 'string' || rawId.trim().length === 0) {
      errors.push({
        decision_id: '',
        type: 'invalid_id',
        message: 'Missing or empty decision_id',
      });
      continue;
    }

    const decisionId = rawId.trim();
    const decision = store.decisions.getById(decisionId);

    if (!decision) {
      errors.push({
        decision_id: decisionId,
        type: 'not_found',
        message: `Decision with ID "${decisionId}" was not found.`,
      });
      continue;
    }

    if (decision.answer !== 'pending') {
      errors.push({
        decision_id: decisionId,
        type: 'already_completed',
        message: `Decision with ID "${decisionId}" has already been completed.`,
      });
      continue;
    }

    // Validate value presence
    if (obj.value === undefined) {
      schema_violations.push({
        decision_id: decisionId,
        id: typeof obj.id === 'string' ? obj.id : undefined,
        type: SCHEMA_VIOLATION,
        reason: 'Answer value is required',
        field: 'value',
      });
      continue;
    }

    // Validate confidence presence and bounds
    if (
      typeof obj.confidence !== 'number' ||
      Number.isNaN(obj.confidence) ||
      obj.confidence < 0 ||
      obj.confidence > 1
    ) {
      schema_violations.push({
        decision_id: decisionId,
        id: typeof obj.id === 'string' ? obj.id : undefined,
        type: SCHEMA_VIOLATION,
        reason: `Confidence must be a number between 0 and 1 (received ${String(obj.confidence)})`,
        field: 'confidence',
      });
      continue;
    }

    // Validate path if explicitly provided
    if (
      obj.path !== undefined &&
      (typeof obj.path !== 'string' || !DECISION_PATHS.includes(obj.path as DecisionPath))
    ) {
      schema_violations.push({
        decision_id: decisionId,
        id: typeof obj.id === 'string' ? obj.id : undefined,
        type: SCHEMA_VIOLATION,
        reason: `Invalid decision path "${String(obj.path)}". Must be one of: ${DECISION_PATHS.join(', ')}`,
        field: 'path',
      });
      continue;
    }

    const answerObj: Answer = {
      decisionId,
      decision_id: decisionId,
      value: obj.value as string | number | boolean,
      confidence: obj.confidence,
      path: (obj.path as DecisionPath | undefined) ?? 'ai',
      ...(obj.distribution && typeof obj.distribution === 'object'
        ? { distribution: obj.distribution as Record<string, number> }
        : {}),
    };

    let validationResult: ValidationResult<Answer> = validateAnswer(answerObj);

    if (obj.question && typeof obj.question === 'object') {
      validationResult = validateAnswer(obj.question, answerObj);
    } else if (decision.decision_type === 'check') {
      const checkQ: CheckQuestion = {
        id: decision.id,
        type: 'check',
        text: decision.question,
      };
      validationResult = validateAnswer(checkQ, answerObj);
    } else if (decision.decision_type === 'score') {
      if (obj.scale) {
        const scoreQ = {
          id: decision.id,
          type: 'score' as const,
          text: decision.question,
          scale: obj.scale as Scale,
        };
        validationResult = validateAnswer(scoreQ, answerObj);
      } else {
        if (typeof obj.value !== 'number' || Number.isNaN(obj.value)) {
          validationResult = createSchemaViolation(
            `Score answer value must be a number (received ${typeof obj.value})`,
            'value',
          );
        } else {
          validationResult = validateAnswer(answerObj);
        }
      }
    } else if (decision.decision_type === 'choice') {
      if (Array.isArray(obj.options) && obj.options.length > 0) {
        const choiceQ = {
          id: decision.id,
          type: 'choice' as const,
          text: decision.question,
          options: obj.options as Option[],
        };
        validationResult = validateAnswer(choiceQ, answerObj);
      } else {
        if (typeof obj.value !== 'string') {
          validationResult = createSchemaViolation(
            `Choice answer value must be a string matching an option id (received ${typeof obj.value})`,
            'value',
          );
        } else if (obj.distribution !== undefined) {
          if (
            typeof obj.distribution !== 'object' ||
            obj.distribution === null ||
            Array.isArray(obj.distribution)
          ) {
            validationResult = createSchemaViolation(
              'Distribution must be a key-value record',
              'distribution',
            );
          } else {
            const dist = obj.distribution as Record<string, unknown>;
            let sum = 0;
            let distValid = true;
            for (const [k, prob] of Object.entries(dist)) {
              if (typeof prob !== 'number' || Number.isNaN(prob) || prob < 0 || prob > 1) {
                validationResult = createSchemaViolation(
                  `Distribution probability for "${k}" must be between 0 and 1 (received ${String(prob)})`,
                  `distribution.${k}`,
                );
                distValid = false;
                break;
              }
              sum += prob;
            }
            if (distValid) {
              if (Math.abs(sum - 1.0) > DISTRIBUTION_SUM_TOLERANCE + 1e-9) {
                validationResult = createSchemaViolation(
                  `Distribution probabilities must sum to 1 ± 0.01 (received sum of ${sum.toFixed(4)})`,
                  'distribution',
                );
              } else {
                validationResult = validateAnswer(answerObj);
              }
            }
          }
        } else {
          validationResult = validateAnswer(answerObj);
        }
      }
    } else {
      validationResult = validateAnswer(answerObj);
    }

    if (!validationResult.success) {
      const failure = validationResult as ValidationFailure;
      schema_violations.push({
        decision_id: decisionId,
        id: typeof obj.id === 'string' ? obj.id : undefined,
        type: SCHEMA_VIOLATION,
        reason: failure.reason,
        field: failure.field,
        details: failure.details,
      });
      // Invariant: rejected invalid answer leaves pending decision intact so agent can retry.
      continue;
    }

    const latencyMs = Number((performance.now() - itemStartTime).toFixed(3));
    const serialized = serializeAnswer(
      obj.value,
      obj.distribution as Record<string, number> | undefined,
    );

    if (obj.confidence >= threshold) {
      updateDecisionLog({
        id: decision.id,
        answer: serialized,
        confidence: obj.confidence,
        path: 'ai',
        latencyMs,
        needsReview: 0,
        store,
      });

      answers.push({
        decision_id: decision.id,
        id: typeof obj.id === 'string' ? obj.id : decision.id,
        type: decision.decision_type,
        value: obj.value as string | number | boolean,
        ...(obj.distribution && typeof obj.distribution === 'object'
          ? { distribution: obj.distribution as Record<string, number> }
          : {}),
        confidence: obj.confidence,
        path: 'ai',
        latency_ms: latencyMs,
      });
    } else {
      updateDecisionLog({
        id: decision.id,
        answer: serialized,
        confidence: obj.confidence,
        path: 'ai',
        latencyMs,
        needsReview: 1,
        store,
      });

      needs_human.push({
        decision_id: decision.id,
        id: typeof obj.id === 'string' ? obj.id : decision.id,
        type: decision.decision_type,
        value: obj.value as string | number | boolean,
        ...(obj.distribution && typeof obj.distribution === 'object'
          ? { distribution: obj.distribution as Record<string, number> }
          : {}),
        confidence: obj.confidence,
        reason: `Confidence ${obj.confidence} is below threshold ${threshold}`,
      });
    }
  }

  return {
    answers,
    needs_human,
    schema_violations,
    errors,
  };
}
