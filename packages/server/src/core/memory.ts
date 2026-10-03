import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  type Answer,
  type DecisionPath,
  type DecisionType,
  type Option,
  type Question,
  validateAnswer,
} from './schema.js';
import {
  type DatabaseStore,
  type Decision,
  type Feedback,
  type InsertDecision,
  DecisionRepo,
  FeedbackRepo,
} from '../store/index.js';

export interface NormalizedOption {
  id: string;
  label?: string | undefined;
  description?: string | undefined;
}

export interface MemoryKeyParams {
  input: unknown;
  question: string | Question;
  options?: (string | Option)[] | undefined;
}

/**
 * Recursively canonicalizes data values and objects with sorted keys
 * to ensure deterministic hashing across property orders.
 */
export function canonicalizeValue(val: unknown): unknown {
  if (val === null || val === undefined) {
    return null;
  }
  if (typeof val === 'string') {
    return val.trim();
  }
  if (typeof val === 'number' || typeof val === 'boolean') {
    return val;
  }
  if (val instanceof Date) {
    return val.toISOString();
  }
  if (Array.isArray(val)) {
    return val.map(canonicalizeValue);
  }
  if (typeof val === 'object') {
    const record = val as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      const v = record[key];
      if (v !== undefined) {
        result[key] = canonicalizeValue(v);
      }
    }
    return result;
  }
  return String(val);
}

/**
 * Normalizes input data for key hashing.
 * Strings containing JSON objects or arrays are parsed and canonicalized.
 */
export function normalizeInput(input: unknown): unknown {
  if (input === null || input === undefined) {
    return null;
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        return canonicalizeValue(parsed);
      } catch {
        // Not valid JSON, retain trimmed string
      }
    }
    return trimmed;
  }
  return canonicalizeValue(input);
}

/**
 * Normalizes question text by trimming and collapsing multiple whitespace runs.
 */
export function normalizeQuestionText(question: string | Question): string {
  const rawText = typeof question === 'string' ? question : question.text;
  return rawText.trim().replace(/\s+/g, ' ');
}

/**
 * Normalizes options list. Changing any option (id, label, description)
 * or adding/removing options modifies the normalized result.
 */
export function normalizeOptions(
  options?: (string | Option)[] | undefined,
  question?: string | Question | undefined,
): NormalizedOption[] {
  let opts: (string | Option)[] | undefined = options;
  if (!opts && typeof question === 'object' && question !== null && 'options' in question) {
    opts = question.options;
  }
  if (!opts || !Array.isArray(opts) || opts.length === 0) {
    return [];
  }
  return opts.map((opt) => {
    if (typeof opt === 'string') {
      return { id: opt.trim() };
    }
    const id = String(opt.id ?? '').trim();
    const label =
      typeof opt.label === 'string' && opt.label.trim().length > 0 ? opt.label.trim() : undefined;
    const description =
      typeof opt.description === 'string' && opt.description.trim().length > 0
        ? opt.description.trim()
        : undefined;
    const res: NormalizedOption = { id };
    if (label !== undefined) {
      res.label = label;
    }
    if (description !== undefined) {
      res.description = description;
    }
    return res;
  });
}

/**
 * Computes the deterministic SHA-256 memory key:
 * Key = hash(normalized input + question text + options)
 *
 * Changing any option, the question text, or the input changes the resulting key.
 */
export function computeMemoryKey(
  inputOrParams: unknown | MemoryKeyParams,
  questionArg?: string | Question,
  optionsArg?: (string | Option)[],
): string {
  let input: unknown;
  let question: string | Question;
  let options: (string | Option)[] | undefined;

  if (
    typeof inputOrParams === 'object' &&
    inputOrParams !== null &&
    'input' in inputOrParams &&
    'question' in inputOrParams
  ) {
    const params = inputOrParams as MemoryKeyParams;
    input = params.input;
    question = params.question;
    options = params.options;
  } else {
    input = inputOrParams;
    if (!questionArg) {
      throw new Error('Question must be provided to compute memory key');
    }
    question = questionArg;
    options = optionsArg;
  }

  const normalizedInput = normalizeInput(input);
  const normalizedQuestion = normalizeQuestionText(question);
  const normalizedOpts = normalizeOptions(options, question);

  const payload = JSON.stringify({
    input: normalizedInput,
    question: normalizedQuestion,
    options: normalizedOpts,
  });

  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Memory reuse rule:
 * Only reuse answers that were confirmed (feedback) or had confidence >= threshold.
 * Unconfirmed low-confidence answers are never reused.
 */
export function isAnswerReusable(
  decision: Decision,
  feedbacks: Feedback[],
  threshold: number,
): boolean {
  const hasFeedback = feedbacks.length > 0;
  return hasFeedback || decision.confidence >= threshold;
}

export interface MemoryLookupOptions {
  input?: unknown;
  question?: string | Question;
  options?: (string | Option)[];
  inputHash?: string;
  threshold: number;
}

export interface MemoryHit {
  hit: true;
  path: 'memory';
  decisionId: string;
  question: string;
  answer: Answer;
  confidence: number;
  confirmed: boolean;
  source: 'feedback' | 'high_confidence';
  feedback?: Feedback | null;
  latencyMs: number;
  decision: Decision;
}

export interface SaveMemoryOptions {
  sessionId?: string | null;
  url?: string | null;
  domain?: string | null;
  input: unknown;
  question: string | Question;
  options?: (string | Option)[];
  decisionType?: DecisionType;
  answer: string | Record<string, unknown> | number | boolean;
  confidence: number;
  path?: DecisionPath;
  patternId?: string | null;
  latencyMs?: number;
  isSafety?: boolean;
  needsReview?: boolean;
}

export class Memory {
  private readonly decisionRepo: DecisionRepo;
  private readonly feedbackRepo: FeedbackRepo;

  constructor(dbOrStore: DatabaseStore | Database.Database) {
    if ('decisions' in dbOrStore && 'feedback' in dbOrStore) {
      this.decisionRepo = dbOrStore.decisions;
      this.feedbackRepo = dbOrStore.feedback;
    } else {
      this.decisionRepo = new DecisionRepo(dbOrStore);
      this.feedbackRepo = new FeedbackRepo(dbOrStore);
    }
  }

  lookup(options: MemoryLookupOptions): MemoryHit | null {
    const startTime = performance.now();
    const { threshold } = options;

    let inputHash = options.inputHash;
    if (!inputHash) {
      if (options.question === undefined) {
        throw new Error(
          'Either inputHash or question (with input) must be provided for memory lookup',
        );
      }
      inputHash = computeMemoryKey(options.input, options.question, options.options);
    }

    const candidateDecisions = this.decisionRepo.list({
      input_hash: inputHash,
      limit: 10,
    });

    if (candidateDecisions.length === 0) {
      return null;
    }

    let matchedDecision: Decision | null = null;
    let matchedFeedbacks: Feedback[] = [];

    for (const candidate of candidateDecisions) {
      const feedbacks = this.feedbackRepo.getByDecisionId(candidate.id);
      if (isAnswerReusable(candidate, feedbacks, threshold)) {
        matchedDecision = candidate;
        matchedFeedbacks = feedbacks;
        break;
      }
    }

    if (!matchedDecision) {
      return null;
    }

    const confirmed = matchedFeedbacks.length > 0;
    const latestFeedback = confirmed ? matchedFeedbacks[0] : null;
    const source: 'feedback' | 'high_confidence' = confirmed ? 'feedback' : 'high_confidence';

    const rawAnswerText = latestFeedback ? latestFeedback.correct_value : matchedDecision.answer;
    const confidence = confirmed ? 1.0 : matchedDecision.confidence;

    const parsedAnswer = this.parseAnswerValue(
      rawAnswerText,
      matchedDecision.decision_type,
      options.question,
    );

    const endTime = performance.now();
    const latencyMs = Number((endTime - startTime).toFixed(3));

    const answerObj: Answer = {
      decisionId: matchedDecision.id,
      decision_id: matchedDecision.id,
      value: parsedAnswer.value,
      confidence,
      path: 'memory',
      ...(parsedAnswer.distribution ? { distribution: parsedAnswer.distribution } : {}),
      ...(matchedDecision.pattern_id
        ? { patternId: matchedDecision.pattern_id, pattern_id: matchedDecision.pattern_id }
        : {}),
      latencyMs,
      latency_ms: latencyMs,
    };

    if (options.question && typeof options.question === 'object') {
      const valResult = validateAnswer(options.question, answerObj);
      if (!valResult.success) {
        return null;
      }
    }

    return {
      hit: true,
      path: 'memory',
      decisionId: matchedDecision.id,
      question: matchedDecision.question,
      answer: answerObj,
      confidence,
      confirmed,
      source,
      feedback: latestFeedback,
      latencyMs,
      decision: matchedDecision,
    };
  }

  save(options: SaveMemoryOptions): Decision {
    const inputHash = computeMemoryKey(options.input, options.question, options.options);
    const questionText =
      typeof options.question === 'string' ? options.question : options.question.text;

    let decisionType: DecisionType = 'choice';
    if (options.decisionType) {
      decisionType = options.decisionType;
    } else if (typeof options.question === 'object' && 'type' in options.question) {
      decisionType = options.question.type;
    }

    const answerStr =
      typeof options.answer === 'string' ? options.answer : JSON.stringify(options.answer);

    const insertData: InsertDecision = {
      session_id: options.sessionId ?? null,
      url: options.url ?? null,
      domain: options.domain ?? null,
      decision_type: decisionType,
      question: questionText,
      context:
        typeof options.input === 'string'
          ? options.input
          : JSON.stringify(canonicalizeValue(options.input)),
      input_hash: inputHash,
      answer: answerStr,
      confidence: options.confidence,
      path: options.path ?? 'memory',
      pattern_id: options.patternId ?? null,
      latency_ms: options.latencyMs ?? 0,
      is_safety: options.isSafety ?? false,
      needs_review: options.needsReview ?? false,
    };

    return this.decisionRepo.create(insertData);
  }

  private parseAnswerValue(
    raw: string,
    decisionType: DecisionType,
    question?: string | Question,
  ): { value: string | number | boolean; distribution?: Record<string, number> | undefined } {
    let parsedJson: unknown = undefined;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      // not JSON
    }

    let value: string | number | boolean = raw;
    let distribution: Record<string, number> | undefined = undefined;

    if (parsedJson !== undefined && parsedJson !== null) {
      if (typeof parsedJson === 'object' && !Array.isArray(parsedJson)) {
        const obj = parsedJson as Record<string, unknown>;
        if (
          'value' in obj &&
          (typeof obj.value === 'string' ||
            typeof obj.value === 'number' ||
            typeof obj.value === 'boolean')
        ) {
          value = obj.value;
        }
        if (
          'distribution' in obj &&
          typeof obj.distribution === 'object' &&
          obj.distribution !== null
        ) {
          distribution = obj.distribution as Record<string, number>;
        }
      } else if (
        typeof parsedJson === 'string' ||
        typeof parsedJson === 'number' ||
        typeof parsedJson === 'boolean'
      ) {
        value = parsedJson;
      }
    }

    if (decisionType === 'check') {
      if (typeof value === 'string') {
        const lower = value.toLowerCase().trim();
        if (lower === 'true' || lower === 'yes') {
          value = true;
        } else if (lower === 'false' || lower === 'no') {
          value = false;
        }
      }
    } else if (decisionType === 'score') {
      if (typeof value === 'string') {
        const num = Number(value);
        if (!Number.isNaN(num)) {
          value = num;
        }
      }
    } else if (decisionType === 'choice') {
      value = String(value);
      if (!distribution && question && typeof question === 'object' && question.type === 'choice') {
        const dist: Record<string, number> = {};
        for (const opt of question.options) {
          dist[opt.id] = opt.id === value ? 1.0 : 0.0;
        }
        distribution = dist;
      }
    }

    if (distribution !== undefined) {
      return { value, distribution };
    }
    return { value };
  }
}

export function createMemory(dbOrStore: DatabaseStore | Database.Database): Memory {
  return new Memory(dbOrStore);
}
