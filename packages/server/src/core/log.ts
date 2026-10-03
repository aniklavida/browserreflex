/**
 * Decision logging: writes every decision to SQLite with path, confidence,
 * latency, session and redacted input.
 *
 * Status: **implemented and tested**.
 *
 * Core invariants:
 * - A decision record that misdescribes itself is worse than no record:
 *   the record must state the path and confidence that actually produced the answer.
 * - The safety check is advisory: safety decisions are recorded for audit
 *   and do not stop an agent from acting.
 * - Redaction runs before anything is stored. Secrets and personal data are
 *   masked, and the original input's hash is kept for exact-match memory lookup.
 * - Every decision belongs to a session. Sessions are detected per MCP connection.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  type Answer,
  type DecisionPath,
  type DecisionType,
  type Question,
  DECISION_PATHS,
  SchemaViolationException,
} from './schema.js';
import { redact, redactWithHash } from '../security/redact.js';
import {
  type DatabaseStore,
  type Decision,
  type InsertDecision,
  type Session,
  type UpdateDecision,
  DecisionRepo,
  SessionRepo,
  createStore,
} from '../store/index.js';

let defaultStore: DatabaseStore | null = null;

/**
 * Returns the default database store instance, initializing it lazily.
 */
export function getDefaultStore(): DatabaseStore {
  if (!defaultStore) {
    defaultStore = createStore();
  }
  return defaultStore;
}

/**
 * Injects a store instance to be used as default, or clears it with null.
 */
export function setDefaultStore(store: DatabaseStore | null): void {
  defaultStore = store;
}

export interface LogDecisionParams {
  /** The question asked, either as a text string or a typed Question object. */
  question: string | Question;
  /** The typed answer produced. */
  answer: string | number | boolean | Answer | Record<string, unknown>;
  /** The path that actually produced the answer (memory, pattern, check, ai, human). */
  path: DecisionPath;
  /** The confidence of the answer (0.0 to 1.0). */
  confidence: number;
  /** Latency in milliseconds. */
  latencyMs?: number | undefined;
  latency_ms?: number | undefined;
  /** Active session or session ID. */
  session?: string | Session | null | undefined;
  sessionId?: string | null | undefined;
  session_id?: string | null | undefined;
  /** The input data/snapshot or context that led to the decision. */
  input?: unknown;
  context?: string | null | undefined;
  /** URL and domain where the decision took place. */
  url?: string | null | undefined;
  domain?: string | null | undefined;
  /** Pattern ID if a pattern produced the decision. */
  patternId?: string | null | undefined;
  pattern_id?: string | null | undefined;
  /** Whether this decision involves a safety rule. The safety check is advisory. */
  isSafety?: boolean | number | undefined;
  is_safety?: boolean | number | undefined;
  /** Whether human review is needed. */
  needsReview?: boolean | number | undefined;
  needs_review?: boolean | number | undefined;
  /** Decision type override if not inferred from Question or Answer. */
  decisionType?: DecisionType | undefined;
  decision_type?: DecisionType | undefined;
  /** Optional creation timestamp (defaults to current ISO time). */
  createdAt?: string | undefined;
  created_at?: string | undefined;
  /** Optional injected store or database instance. */
  store?: DatabaseStore | Database.Database | undefined;
  /** Optional precomputed input hash for memory lookup. */
  inputHash?: string | undefined;
  input_hash?: string | undefined;
}

export interface LogDecisionOptions {
  input?: unknown;
  context?: string | null | undefined;
  url?: string | null | undefined;
  domain?: string | null | undefined;
  patternId?: string | null | undefined;
  pattern_id?: string | null | undefined;
  isSafety?: boolean | number | undefined;
  is_safety?: boolean | number | undefined;
  needsReview?: boolean | number | undefined;
  needs_review?: boolean | number | undefined;
  decisionType?: DecisionType | undefined;
  decision_type?: DecisionType | undefined;
  createdAt?: string | undefined;
  created_at?: string | undefined;
  store?: DatabaseStore | Database.Database | undefined;
  inputHash?: string | undefined;
  input_hash?: string | undefined;
}

/**
 * Extracts hostname domain from a URL safely.
 */
function extractDomain(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname;
  } catch {
    return null;
  }
}

/**
 * Logs a decision to SQLite with path, confidence, latency and session.
 *
 * Runs the question input through redaction before storage and stores the redaction hash.
 * The stored record states the path and confidence that actually produced the answer.
 */
export function logDecision(params: LogDecisionParams): Decision;
export function logDecision(
  question: string | Question,
  answer: string | number | boolean | Answer | Record<string, unknown>,
  path: DecisionPath,
  confidence: number,
  latencyMs: number,
  session?: string | Session | null,
  options?: LogDecisionOptions,
): Decision;
export function logDecision(
  first: LogDecisionParams | string | Question,
  ...rest: unknown[]
): Decision {
  let params: LogDecisionParams;
  if (
    typeof first === 'object' &&
    first !== null &&
    !('type' in first && typeof (first as Question).type === 'string' && 'text' in first) &&
    'path' in first &&
    'confidence' in first
  ) {
    params = first as LogDecisionParams;
  } else {
    const question = first as string | Question;
    const answer = rest[0] as string | number | boolean | Answer | Record<string, unknown>;
    const path = rest[1] as DecisionPath;
    const confidence = rest[2] as number;
    const latencyMs = rest[3] as number;
    const session = rest[4] as string | Session | null | undefined;
    const options = (rest[5] ?? {}) as LogDecisionOptions;
    params = {
      question,
      answer,
      path,
      confidence,
      latencyMs,
      session,
      ...options,
    };
  }

  // Validate path: must state the path that actually produced the answer
  if (!DECISION_PATHS.includes(params.path)) {
    throw new SchemaViolationException(
      `Invalid decision path: ${String(params.path)}. Expected one of: ${DECISION_PATHS.join(', ')}`,
      'path',
    );
  }

  // Validate confidence: must state the confidence that actually produced the answer
  if (
    typeof params.confidence !== 'number' ||
    Number.isNaN(params.confidence) ||
    params.confidence < 0 ||
    params.confidence > 1
  ) {
    throw new SchemaViolationException(
      `Confidence must be a number between 0 and 1, got ${params.confidence}`,
      'confidence',
    );
  }

  // Determine question text and decision type
  let questionText = '';
  let decisionType: DecisionType = 'choice';

  if (typeof params.question === 'string') {
    questionText = params.question;
    const typeOverride = params.decisionType ?? params.decision_type;
    if (typeOverride) {
      decisionType = typeOverride;
    } else if (typeof params.answer === 'boolean') {
      decisionType = 'check';
    } else if (typeof params.answer === 'number') {
      decisionType = 'score';
    } else {
      decisionType = 'choice';
    }
  } else if (typeof params.question === 'object' && params.question !== null) {
    questionText = params.question.text;
    decisionType = params.question.type;
  } else {
    throw new SchemaViolationException('Question must be a string or Question object', 'question');
  }

  // Redaction: runs question and input through redaction before storage
  const questionRedaction = redactWithHash(questionText);
  const redactedQuestion = questionRedaction.redacted;

  let rawInput: string | null = null;
  if (params.input !== undefined && params.input !== null) {
    rawInput = typeof params.input === 'string' ? params.input : JSON.stringify(params.input);
  } else if (params.context !== undefined && params.context !== null) {
    rawInput = params.context;
  }

  let storedContext: string | null = null;
  let inputHash: string;

  if (params.inputHash) {
    inputHash = params.inputHash;
  } else if (params.input_hash) {
    inputHash = params.input_hash;
  } else if (rawInput !== null) {
    const inputRedaction = redactWithHash(rawInput);
    storedContext = inputRedaction.redacted;
    inputHash = inputRedaction.originalHash;
  } else {
    // When no separate input/context is given, the question itself is the input
    inputHash = questionRedaction.originalHash;
  }

  if (rawInput !== null && storedContext === null) {
    storedContext = redact(rawInput);
  }

  // Redact URL if provided
  let storedUrl: string | null = null;
  let storedDomain: string | null = params.domain ?? null;
  if (params.url) {
    storedUrl = redact(params.url);
    if (!storedDomain) {
      storedDomain = extractDomain(params.url);
    }
  }

  // Resolve session ID
  let sessionId: string | null = null;
  if (typeof params.session === 'string') {
    sessionId = params.session;
  } else if (params.session && typeof params.session === 'object' && 'id' in params.session) {
    sessionId = params.session.id;
  } else if (params.sessionId) {
    sessionId = params.sessionId;
  } else if (params.session_id) {
    sessionId = params.session_id;
  }

  // Format answer string
  let answerStr: string;
  if (typeof params.answer === 'string') {
    answerStr = params.answer;
  } else if (typeof params.answer === 'number' || typeof params.answer === 'boolean') {
    answerStr = String(params.answer);
  } else {
    answerStr = JSON.stringify(params.answer);
  }

  const latencyMs = params.latencyMs ?? params.latency_ms ?? 0;
  const isSafety = Boolean(params.isSafety ?? params.is_safety ?? false);
  const needsReview = Boolean(params.needsReview ?? params.needs_review ?? false);
  const patternId = params.patternId ?? params.pattern_id ?? null;

  const insertData: InsertDecision = {
    id: randomUUID(),
    session_id: sessionId,
    url: storedUrl,
    domain: storedDomain,
    decision_type: decisionType,
    question: redactedQuestion,
    context: storedContext,
    input_hash: inputHash,
    answer: answerStr,
    confidence: params.confidence,
    path: params.path,
    pattern_id: patternId,
    latency_ms: latencyMs,
    is_safety: isSafety ? 1 : 0,
    needs_review: needsReview ? 1 : 0,
    created_at: params.createdAt ?? params.created_at ?? new Date().toISOString(),
  };

  if (patternId) {
    if (params.store && 'patterns' in params.store) {
      const pRepo = (params.store as DatabaseStore).patterns;
      if (!pRepo.getById(patternId)) {
        pRepo.create({
          id: patternId,
          name: patternId,
          decision_type: decisionType,
          rules: JSON.stringify({}),
          status: 'active',
          confidence: params.confidence,
          is_safety: isSafety ? 1 : 0,
        });
      }
    } else if (params.store && 'prepare' in params.store) {
      const db = params.store as Database.Database;
      const row = db.prepare('SELECT id FROM patterns WHERE id = ?').get(patternId);
      if (!row) {
        const now = new Date().toISOString();
        db.prepare(
          `
          INSERT INTO patterns (id, name, decision_type, rules, status, confidence, is_safety, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ).run(
          patternId,
          patternId,
          decisionType,
          '{}',
          'active',
          params.confidence,
          isSafety ? 1 : 0,
          now,
          now,
        );
      }
    } else if (!params.store) {
      const defStore = getDefaultStore();
      if (!defStore.patterns.getById(patternId)) {
        defStore.patterns.create({
          id: patternId,
          name: patternId,
          decision_type: decisionType,
          rules: JSON.stringify({}),
          status: 'active',
          confidence: params.confidence,
          is_safety: isSafety ? 1 : 0,
        });
      }
    }
  }

  let decisionRepo: DecisionRepo;
  if (params.store) {
    if ('decisions' in params.store) {
      decisionRepo = params.store.decisions;
    } else {
      decisionRepo = new DecisionRepo(params.store);
    }
  } else {
    decisionRepo = getDefaultStore().decisions;
  }

  return decisionRepo.create(insertData);
}

/** Export log alias for convenient tool invocation. */
export const log = logDecision;

export interface UpdateDecisionLogParams {
  id: string;
  answer: string | number | boolean | Answer | Record<string, unknown>;
  confidence: number;
  path: DecisionPath;
  latencyMs?: number | undefined;
  latency_ms?: number | undefined;
  isSafety?: boolean | number | undefined;
  is_safety?: boolean | number | undefined;
  needsReview?: boolean | number | undefined;
  needs_review?: boolean | number | undefined;
  patternId?: string | null | undefined;
  pattern_id?: string | null | undefined;
  store?: DatabaseStore | Database.Database | undefined;
}

/**
 * Updates an existing decision record in SQLite with the verified answer, path,
 * confidence and latency.
 *
 * Invariant:
 * - A decision record that misdescribes itself is worse than no record:
 *   path and confidence are strictly validated before updating the record.
 */
export function updateDecisionLog(params: UpdateDecisionLogParams): Decision | null {
  if (!DECISION_PATHS.includes(params.path)) {
    throw new SchemaViolationException(
      `Invalid decision path: ${String(params.path)}. Expected one of: ${DECISION_PATHS.join(', ')}`,
      'path',
    );
  }

  if (
    typeof params.confidence !== 'number' ||
    Number.isNaN(params.confidence) ||
    params.confidence < 0 ||
    params.confidence > 1
  ) {
    throw new SchemaViolationException(
      `Confidence must be a number between 0 and 1, got ${params.confidence}`,
      'confidence',
    );
  }

  let decisionRepo: DecisionRepo;
  if (params.store) {
    if ('decisions' in params.store) {
      decisionRepo = params.store.decisions;
    } else {
      decisionRepo = new DecisionRepo(params.store);
    }
  } else {
    decisionRepo = getDefaultStore().decisions;
  }

  let answerStr: string;
  if (typeof params.answer === 'string') {
    answerStr = params.answer;
  } else if (typeof params.answer === 'number' || typeof params.answer === 'boolean') {
    answerStr = String(params.answer);
  } else {
    answerStr = JSON.stringify(params.answer);
  }

  const updateData: UpdateDecision = {
    answer: answerStr,
    confidence: params.confidence,
    path: params.path,
  };

  const latencyMs = params.latencyMs ?? params.latency_ms;
  if (latencyMs !== undefined) {
    updateData.latency_ms = latencyMs;
  }
  const isSafety = params.isSafety ?? params.is_safety;
  if (isSafety !== undefined) {
    updateData.is_safety = isSafety;
  }
  const needsReview = params.needsReview ?? params.needs_review;
  if (needsReview !== undefined) {
    updateData.needs_review = needsReview;
  }
  const patternId = params.patternId ?? params.pattern_id;
  if (patternId !== undefined) {
    updateData.pattern_id = patternId;
  }

  return decisionRepo.update(params.id, updateData);
}

export const updateDecision = updateDecisionLog;

/**
 * Tracks MCP connection sessions and manages lifecycle updates.
 */
export interface SessionTracker {
  /** Returns the active session for the current connection, if any. */
  getActiveSession(): Session | null;
  /** Returns all sessions created through this tracker. */
  getSessions(): readonly Session[];
  /** Creates and records a new session for a detected MCP connection. */
  createConnectionSession(agentName: string, metadata?: Record<string, unknown>): Session;
  /** Marks the active session as completed on connection close. */
  closeActiveSession(): Session | null;
}

/**
 * Creates a session tracker backed by a store or session repo.
 */
export function createSessionTracker(store: DatabaseStore | SessionRepo): SessionTracker {
  const repo = 'sessions' in store ? store.sessions : store;
  let activeSession: Session | null = null;
  const sessions: Session[] = [];

  return {
    getActiveSession() {
      return activeSession;
    },
    getSessions() {
      return [...sessions];
    },
    createConnectionSession(agentName: string, metadata?: Record<string, unknown>) {
      const created = repo.create({
        agent_name: agentName,
        status: 'active',
        metadata: metadata ? JSON.stringify(metadata) : null,
      });
      activeSession = created;
      sessions.push(created);
      return created;
    },
    closeActiveSession() {
      if (!activeSession) return null;
      const updated = repo.update(activeSession.id, {
        status: 'completed',
        updated_at: new Date().toISOString(),
      });
      activeSession = null;
      return updated;
    },
  };
}
