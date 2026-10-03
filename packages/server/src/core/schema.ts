import { z } from 'zod';

export const MAX_CHOICE_OPTIONS = 20;
export const DISTRIBUTION_SUM_TOLERANCE = 0.01;
export const SCHEMA_VIOLATION = 'schema_violation' as const;

export const DECISION_TYPES = ['choice', 'score', 'check'] as const;
export const DecisionTypeSchema = z.enum(DECISION_TYPES);
export type DecisionType = z.infer<typeof DecisionTypeSchema>;

export const DECISION_PATHS = ['memory', 'pattern', 'check', 'ai', 'human'] as const;
export const DecisionPathSchema = z.enum(DECISION_PATHS);
export type DecisionPath = z.infer<typeof DecisionPathSchema>;

export const OptionItemSchema = z.object({
  id: z.string().min(1, 'Option id cannot be empty'),
  description: z.string().optional(),
  label: z.string().optional(),
});

export const OptionSchema = z.preprocess((val) => {
  if (typeof val === 'string') {
    return { id: val };
  }
  if (val && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if (!('id' in obj) && typeof obj.value === 'string') {
      return { id: obj.value, ...obj };
    }
  }
  return val;
}, OptionItemSchema);

export type Option = z.infer<typeof OptionItemSchema>;

export const ScaleObjectSchema = z
  .object({
    min: z.number({
      required_error: 'Scale min is required',
      invalid_type_error: 'Scale min must be a number',
    }),
    max: z.number({
      required_error: 'Scale max is required',
      invalid_type_error: 'Scale max must be a number',
    }),
    step: z
      .number({ invalid_type_error: 'Scale step must be a number' })
      .positive('Scale step must be positive')
      .optional(),
  })
  .refine((s) => s.min < s.max, {
    message: 'Scale min must be strictly less than max',
  });

export const ScaleTupleSchema = z
  .tuple([z.number(), z.number()])
  .refine(([min, max]) => min < max, {
    message: 'Scale min must be strictly less than max',
  })
  .transform(([min, max]) => ({ min, max }));

export const ScaleSchema = z.union([ScaleObjectSchema, ScaleTupleSchema]);
export type Scale = { min: number; max: number; step?: number };

export const ChoiceQuestionSchema = z.object({
  id: z.string().min(1, 'Question id cannot be empty'),
  type: z.literal('choice'),
  text: z.string().min(1, 'Question text cannot be empty'),
  options: z
    .array(OptionSchema)
    .min(1, 'Choice question must have at least one option')
    .max(MAX_CHOICE_OPTIONS, `Choice question cannot have more than ${MAX_CHOICE_OPTIONS} options`)
    .refine(
      (opts) => {
        const ids = opts.map((o) => o.id);
        return new Set(ids).size === ids.length;
      },
      {
        message: 'Choice question option IDs must be unique',
      },
    ),
  scale: z.undefined().optional(),
});

export const ScoreQuestionSchema = z.object({
  id: z.string().min(1, 'Question id cannot be empty'),
  type: z.literal('score'),
  text: z.string().min(1, 'Question text cannot be empty'),
  scale: ScaleSchema,
  options: z.undefined().optional(),
});

export const CheckQuestionSchema = z.object({
  id: z.string().min(1, 'Question id cannot be empty'),
  type: z.literal('check'),
  text: z.string().min(1, 'Question text cannot be empty'),
  options: z.undefined().optional(),
  scale: z.undefined().optional(),
});

export const QuestionSchema = z.discriminatedUnion('type', [
  ChoiceQuestionSchema,
  ScoreQuestionSchema,
  CheckQuestionSchema,
]);

export type ChoiceQuestion = z.infer<typeof ChoiceQuestionSchema>;
export type ScoreQuestion = z.infer<typeof ScoreQuestionSchema>;
export type CheckQuestion = z.infer<typeof CheckQuestionSchema>;
export type Question = z.infer<typeof QuestionSchema>;

export const AnswerSchema = z.object({
  decisionId: z.string().optional(),
  decision_id: z.string().optional(),
  questionId: z.string().optional(),
  question_id: z.string().optional(),
  value: z.union([z.string(), z.number(), z.boolean()]),
  distribution: z.record(z.string(), z.number()).optional(),
  confidence: z
    .number({
      required_error: 'Confidence is required',
      invalid_type_error: 'Confidence must be a number',
    })
    .min(0, 'Confidence cannot be less than 0')
    .max(1, 'Confidence cannot be greater than 1'),
  path: DecisionPathSchema,
  patternId: z.string().optional(),
  pattern_id: z.string().optional(),
  latencyMs: z.number().optional(),
  latency_ms: z.number().optional(),
});

export type Answer = z.infer<typeof AnswerSchema>;

export interface SchemaViolationError {
  type: typeof SCHEMA_VIOLATION;
  reason: string;
  field?: string | undefined;
  details?: unknown;
}

export class SchemaViolationException extends Error {
  readonly type = SCHEMA_VIOLATION;
  readonly field?: string | undefined;
  readonly details?: unknown;

  constructor(
    public readonly reason: string,
    field?: string | undefined,
    details?: unknown,
  ) {
    super(reason);
    this.name = 'SchemaViolationException';
    this.field = field;
    this.details = details;
  }
}

export interface ValidationSuccess<T> {
  success: true;
  valid: true;
  data: T;
}

export interface ValidationFailure {
  success: false;
  valid: false;
  type: typeof SCHEMA_VIOLATION;
  reason: string;
  error: SchemaViolationError;
  field?: string | undefined;
  details?: unknown;
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export function createSchemaViolation(
  reason: string,
  field?: string,
  details?: unknown,
): ValidationFailure {
  return {
    success: false,
    valid: false,
    type: SCHEMA_VIOLATION,
    reason,
    field,
    details,
    error: {
      type: SCHEMA_VIOLATION,
      reason,
      field,
      details,
    },
  };
}

export function isSchemaViolation(obj: unknown): obj is ValidationFailure {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'type' in obj &&
    (obj as { type: unknown }).type === SCHEMA_VIOLATION
  );
}

export function validateQuestion(raw: unknown): ValidationResult<Question> {
  try {
    if (typeof raw !== 'object' || raw === null) {
      return createSchemaViolation('Question must be an object');
    }
    const res = QuestionSchema.safeParse(raw);
    if (!res.success) {
      const issue = res.error.issues[0];
      const field = issue.path.join('.');
      return createSchemaViolation(issue.message, field || undefined, res.error.issues);
    }
    return {
      success: true,
      valid: true,
      data: res.data,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return createSchemaViolation(`Unexpected error during question validation: ${message}`);
  }
}

export interface ValidateAnswerOptions {
  requireDistribution?: boolean;
}

export function validateAnswer(
  arg1: unknown,
  arg2?: unknown,
  options: ValidateAnswerOptions = {},
): ValidationResult<Answer> {
  try {
    let questionRaw: unknown = undefined;
    let answerRaw: unknown = undefined;

    if (arg2 === undefined) {
      answerRaw = arg1;
    } else {
      const isArg1Question =
        typeof arg1 === 'object' &&
        arg1 !== null &&
        'type' in arg1 &&
        DECISION_TYPES.includes((arg1 as { type: (typeof DECISION_TYPES)[number] }).type);

      const isArg2Question =
        typeof arg2 === 'object' &&
        arg2 !== null &&
        'type' in arg2 &&
        DECISION_TYPES.includes((arg2 as { type: (typeof DECISION_TYPES)[number] }).type);

      if (isArg1Question && !isArg2Question) {
        questionRaw = arg1;
        answerRaw = arg2;
      } else if (!isArg1Question && isArg2Question) {
        questionRaw = arg2;
        answerRaw = arg1;
      } else {
        questionRaw = arg1;
        answerRaw = arg2;
      }
    }

    if (typeof answerRaw !== 'object' || answerRaw === null) {
      return createSchemaViolation('Answer must be an object');
    }

    const answerObj = answerRaw as Record<string, unknown>;

    if (answerObj.confidence === undefined) {
      return createSchemaViolation('Confidence is required', 'confidence');
    }
    if (
      typeof answerObj.confidence !== 'number' ||
      Number.isNaN(answerObj.confidence) ||
      answerObj.confidence < 0 ||
      answerObj.confidence > 1
    ) {
      return createSchemaViolation(
        `Confidence must be a number between 0 and 1 (received ${String(answerObj.confidence)})`,
        'confidence',
      );
    }

    if (
      typeof answerObj.path !== 'string' ||
      !DECISION_PATHS.includes(answerObj.path as DecisionPath)
    ) {
      return createSchemaViolation(
        `Invalid decision path "${String(answerObj.path)}". Must be one of: ${DECISION_PATHS.join(', ')}`,
        'path',
      );
    }

    if (answerObj.value === undefined) {
      return createSchemaViolation('Answer value is required', 'value');
    }

    let parsedQuestion: Question | undefined = undefined;
    if (questionRaw !== undefined) {
      const qResult = validateQuestion(questionRaw);
      if (!qResult.success) {
        return qResult;
      }
      parsedQuestion = qResult.data;
    }

    if (parsedQuestion) {
      switch (parsedQuestion.type) {
        case 'choice': {
          const optionIds = parsedQuestion.options.map((o) => o.id);
          if (typeof answerObj.value !== 'string') {
            return createSchemaViolation(
              `Choice answer value must be a string matching an option id (received ${typeof answerObj.value})`,
              'value',
            );
          }
          if (!optionIds.includes(answerObj.value)) {
            return createSchemaViolation(
              `Choice answer value "${answerObj.value}" is not one of the valid options: [${optionIds.join(', ')}]`,
              'value',
            );
          }

          const mustHaveDistribution =
            options.requireDistribution !== undefined ? options.requireDistribution : true;

          if (mustHaveDistribution && answerObj.distribution === undefined) {
            return createSchemaViolation(
              'Choice answer must include a distribution over all options',
              'distribution',
            );
          }

          if (answerObj.distribution !== undefined) {
            if (
              typeof answerObj.distribution !== 'object' ||
              answerObj.distribution === null ||
              Array.isArray(answerObj.distribution)
            ) {
              return createSchemaViolation(
                'Distribution must be a key-value record mapping option IDs to probabilities',
                'distribution',
              );
            }

            const dist = answerObj.distribution as Record<string, unknown>;
            const distKeys = Object.keys(dist);

            const missingKeys = optionIds.filter((id) => !(id in dist));
            if (missingKeys.length > 0) {
              return createSchemaViolation(
                `Distribution is missing keys for options: [${missingKeys.join(', ')}]`,
                'distribution',
              );
            }

            const extraKeys = distKeys.filter((k) => !optionIds.includes(k));
            if (extraKeys.length > 0) {
              return createSchemaViolation(
                `Distribution contains unknown keys not in options: [${extraKeys.join(', ')}]`,
                'distribution',
              );
            }

            let sum = 0;
            for (const key of optionIds) {
              const prob = dist[key];
              if (typeof prob !== 'number' || Number.isNaN(prob) || prob < 0 || prob > 1) {
                return createSchemaViolation(
                  `Distribution probability for "${key}" must be a number between 0 and 1 (received ${String(prob)})`,
                  `distribution.${key}`,
                );
              }
              sum += prob;
            }

            const diff = Math.abs(sum - 1.0);
            if (diff > DISTRIBUTION_SUM_TOLERANCE + 1e-9) {
              return createSchemaViolation(
                `Distribution probabilities must sum to 1 ± 0.01 (received sum of ${sum.toFixed(4)})`,
                'distribution',
              );
            }
          }
          break;
        }

        case 'score': {
          if (typeof answerObj.value !== 'number' || Number.isNaN(answerObj.value)) {
            return createSchemaViolation(
              `Score answer value must be a number (received ${typeof answerObj.value})`,
              'value',
            );
          }

          const scale = parsedQuestion.scale;
          if (answerObj.value < scale.min || answerObj.value > scale.max) {
            return createSchemaViolation(
              `Score value ${answerObj.value} is outside scale range [${scale.min}, ${scale.max}]`,
              'value',
            );
          }

          if ('step' in scale && scale.step !== undefined) {
            const stepCount = (answerObj.value - scale.min) / scale.step;
            const diffFromInt = Math.abs(stepCount - Math.round(stepCount));
            if (diffFromInt > 1e-7) {
              return createSchemaViolation(
                `Score value ${answerObj.value} does not align with step ${scale.step} from min ${scale.min}`,
                'value',
              );
            }
          }
          break;
        }

        case 'check': {
          const val = answerObj.value;
          const isBool = typeof val === 'boolean';
          const isYesNo = val === 'yes' || val === 'no';
          const isProbNumber =
            typeof val === 'number' && !Number.isNaN(val) && val >= 0 && val <= 1;

          if (!isBool && !isYesNo && !isProbNumber) {
            return createSchemaViolation(
              `Check answer value must be a boolean (or probability 0–1 / "yes" / "no")`,
              'value',
            );
          }

          if ('probability' in answerObj) {
            const prob = answerObj.probability;
            if (typeof prob !== 'number' || Number.isNaN(prob) || prob < 0 || prob > 1) {
              return createSchemaViolation(
                `Check probability must be a number between 0 and 1 (received ${String(prob)})`,
                'probability',
              );
            }
          }

          if (answerObj.distribution !== undefined) {
            if (
              typeof answerObj.distribution !== 'object' ||
              answerObj.distribution === null ||
              Array.isArray(answerObj.distribution)
            ) {
              return createSchemaViolation(
                'Distribution must be a key-value record',
                'distribution',
              );
            }
            const dist = answerObj.distribution as Record<string, unknown>;
            let sum = 0;
            for (const [key, prob] of Object.entries(dist)) {
              if (typeof prob !== 'number' || Number.isNaN(prob) || prob < 0 || prob > 1) {
                return createSchemaViolation(
                  `Check distribution probability for "${key}" must be between 0 and 1 (received ${String(prob)})`,
                  `distribution.${key}`,
                );
              }
              sum += prob;
            }
            const diff = Math.abs(sum - 1.0);
            if (diff > DISTRIBUTION_SUM_TOLERANCE + 1e-9) {
              return createSchemaViolation(
                `Check distribution probabilities must sum to 1 ± 0.01 (received sum of ${sum.toFixed(4)})`,
                'distribution',
              );
            }
          }
          break;
        }
      }
    } else {
      const baseResult = AnswerSchema.safeParse(answerObj);
      if (!baseResult.success) {
        const issue = baseResult.error.issues[0];
        const field = issue.path.join('.');
        return createSchemaViolation(issue.message, field || undefined, baseResult.error.issues);
      }
    }

    return {
      success: true,
      valid: true,
      data: answerObj as unknown as Answer,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return createSchemaViolation(`Unexpected error during answer validation: ${message}`);
  }
}
