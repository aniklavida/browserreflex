import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  type ChoiceQuestion,
  type CheckQuestion,
  type DatabaseStore,
  type Question,
  SCHEMA_VIOLATION,
  createMemory,
  createStore,
} from '../src/index.js';
import { executeDecide } from '../src/tools/decide.js';
import { connectToServer, sourceEntry } from './helpers/stdio-server.js';

describe('decide tool', () => {
  let tempDir: string;
  let dbPath: string;
  let store: DatabaseStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-decide-'));
    dbPath = join(tempDir, 'test.db');
    store = createStore(dbPath);
  });

  afterEach(() => {
    if (store) {
      store.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function create10Questions(): Question[] {
    const questions: Question[] = [];
    for (let i = 1; i <= 10; i++) {
      if (i % 3 === 1) {
        questions.push({
          id: `q_choice_${i}`,
          type: 'choice',
          text: `Choice question ${i}: Select action?`,
          options: [
            { id: 'accept', description: 'Accept' },
            { id: 'reject', description: 'Reject' },
            { id: 'ignore', description: 'Ignore' },
          ],
        });
      } else if (i % 3 === 2) {
        questions.push({
          id: `q_check_${i}`,
          type: 'check',
          text: `Check question ${i}: Is this dialog visible?`,
        });
      } else {
        questions.push({
          id: `q_score_${i}`,
          type: 'score',
          text: `Score question ${i}: Rate urgency 1 to 5`,
          scale: { min: 1, max: 5, step: 1 },
        });
      }
    }
    return questions;
  }

  it('batch of 10 questions answered in one call', async () => {
    const questions = create10Questions();
    expect(questions).toHaveLength(10);

    const state = { url: 'https://example.com/checkout', pageTitle: 'Checkout' };
    const result = await executeDecide(
      {
        questions,
        state,
        context: 'initial-load',
      },
      { store },
    );

    // Initial run: all 10 are unknown, returning in needs_ai
    expect(result.answers).toHaveLength(0);
    expect(result.needs_ai).toHaveLength(10);
    expect(result.needs_human).toHaveLength(0);
    expect(result.schema_violations).toHaveLength(0);

    // Each needs_ai item carries its question id, type, text, and fresh decision_id
    for (let i = 0; i < 10; i++) {
      const item = result.needs_ai[i]!;
      expect(item.id).toBe(questions[i]!.id);
      expect(item.type).toBe(questions[i]!.type);
      expect(item.decision_id).toBeDefined();
      expect(item.decision_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });

  it('unknown items return in needs_ai, known ones from memory', async () => {
    const memory = createMemory(store);
    const state = { url: 'https://example.com/app', section: 'login' };
    const questions = create10Questions();

    // Pre-seed first 4 questions into memory with high confidence (>= 0.8)
    for (let i = 0; i < 4; i++) {
      const q = questions[i]!;
      let answerVal: string | number | boolean = true;
      if (q.type === 'choice') {
        answerVal = 'accept';
      } else if (q.type === 'score') {
        answerVal = 4;
      }

      memory.save({
        input: state,
        question: q,
        answer: answerVal,
        confidence: 0.95,
        path: 'memory',
      });
    }

    const result = await executeDecide(
      {
        questions,
        state,
      },
      { store },
    );

    // Exactly 4 known from memory, 6 unknown in needs_ai
    expect(result.answers).toHaveLength(4);
    expect(result.needs_ai).toHaveLength(6);
    expect(result.needs_human).toHaveLength(0);

    // Verify known items have path: 'memory', valid confidence, latency and decision_id
    for (let i = 0; i < 4; i++) {
      const ans = result.answers[i]!;
      expect(ans.id).toBe(questions[i]!.id);
      expect(ans.path).toBe('memory');
      expect(ans.confidence).toBe(0.95);
      expect(ans.latency_ms).toBeDefined();
      expect(ans.decision_id).toBeDefined();

      if (ans.type === 'choice') {
        expect(ans.value).toBe('accept');
        expect(ans.distribution).toBeDefined();
      } else if (ans.type === 'check') {
        expect(ans.value).toBe(true);
      } else if (ans.type === 'score') {
        expect(ans.value).toBe(4);
      }
    }

    // Verify unknown items are returned in needs_ai
    for (let i = 0; i < 6; i++) {
      const unknownItem = result.needs_ai[i]!;
      expect(unknownItem.id).toBe(questions[i + 4]!.id);
      expect(unknownItem.decision_id).toBeDefined();
    }
  });

  it('produces exactly one decisions row per question across batch calls', async () => {
    const questions = create10Questions();
    const state = { url: 'https://example.com/test-logging' };

    const initialCount = store.decisions.count();
    expect(initialCount).toBe(0);

    // 1. Call with batch of 10 questions
    const result = await executeDecide(
      {
        questions,
        state,
      },
      { store },
    );

    expect(result.needs_ai).toHaveLength(10);
    const countAfter10 = store.decisions.count();
    // Exactly 10 rows in decisions table: one per question
    expect(countAfter10).toBe(10);

    const loggedDecisions = store.decisions.list({ limit: 20 });
    expect(loggedDecisions).toHaveLength(10);

    // Each logged decision matches the decision_id in needs_ai, with pending answer and confidence 0
    for (let i = 0; i < 10; i++) {
      const needsAiItem = result.needs_ai[i]!;
      const matchingRow = loggedDecisions.find((d) => d.id === needsAiItem.decision_id);
      expect(matchingRow).toBeDefined();
      expect(matchingRow?.path).toBe('ai');
      expect(matchingRow?.confidence).toBe(0);
      expect(matchingRow?.answer).toBe('pending');
    }

    // 2. Call with batch of 3 questions
    const subQuestions = questions.slice(0, 3);
    await executeDecide(
      {
        questions: subQuestions,
        state: { url: 'https://example.com/other' },
      },
      { store },
    );

    // 10 + 3 = 13 decisions rows total
    expect(store.decisions.count()).toBe(13);
  });

  it('returns schema_violation for invalid question without failing the whole batch', async () => {
    const validChoice: ChoiceQuestion = {
      id: 'valid_q1',
      type: 'choice',
      text: 'Choose option',
      options: [{ id: 'opt1' }, { id: 'opt2' }],
    };
    const validCheck: CheckQuestion = {
      id: 'valid_q2',
      type: 'check',
      text: 'Is valid check?',
    };
    const invalidQuestion = {
      id: 'invalid_q',
      type: 'unknown_type_that_fails_schema',
      text: 'Malformed question',
    };
    const anotherInvalidQuestion = {
      // Missing id and text
      type: 'choice',
      options: [],
    };

    const mixedBatch = [validChoice, invalidQuestion, validCheck, anotherInvalidQuestion];

    const result = await executeDecide(
      {
        questions: mixedBatch,
        state: { page: 'mixed' },
      },
      { store },
    );

    // The two valid questions are routed to needs_ai (or memory)
    expect(result.needs_ai).toHaveLength(2);
    expect(result.needs_ai.map((item) => item.id)).toEqual(['valid_q1', 'valid_q2']);

    // The two invalid questions produce schema_violation entries without failing the batch
    expect(result.schema_violations).toHaveLength(2);
    expect(result.schema_violations[0]?.type).toBe(SCHEMA_VIOLATION);
    expect(result.schema_violations[0]?.id).toBe('invalid_q');
    expect(result.schema_violations[0]?.reason).toBeDefined();

    expect(result.schema_violations[1]?.type).toBe(SCHEMA_VIOLATION);
    expect(result.schema_violations[1]?.reason).toBeDefined();

    // Valid questions still produce decisions rows
    expect(store.decisions.count()).toBe(2);
  });

  it('proves decide over a real MCP client on stdio: batch of 10, hits memory on second call after answer confirmed or meets threshold', async () => {
    const stdioTempDir = mkdtempSync(join(tmpdir(), 'browserreflex-decide-stdio-'));
    const stdioDbPath = join(stdioTempDir, 'test.db');

    // Start server connected to stdioDbPath
    const prevDbEnv = process.env.BROWSERREFLEX_DB_PATH;
    process.env.BROWSERREFLEX_DB_PATH = stdioDbPath;

    let client: Client | undefined;
    try {
      const connected = await connectToServer(sourceEntry);
      client = connected.client;

      // Create inspection store handle on the same SQLite database
      const inspectStore = createStore(stdioDbPath);

      const questions = create10Questions();
      const state = { url: 'https://example.com/stdio-test', role: 'main' };

      // First call over stdio: all 10 questions are unknown
      const call1 = await client.callTool({
        name: 'decide',
        arguments: {
          questions,
          state,
        },
      });

      expect(call1.isError).toBeFalsy();
      const content1 = call1.structuredContent as Record<string, unknown>;
      const answers1 = content1.answers as unknown[];
      const needsAi1 = content1.needs_ai as { id: string; decision_id: string }[];

      expect(answers1).toHaveLength(0);
      expect(needsAi1).toHaveLength(10);

      // Verify that inspectStore has exactly 10 decisions rows
      expect(inspectStore.decisions.count()).toBe(10);

      // Now confirm/complete the first 5 decisions:
      // - 3 by updating decision with high confidence >= 0.8
      // - 2 by creating feedback records
      for (let i = 0; i < 3; i++) {
        const item = needsAi1[i]!;
        const q = questions[i]!;
        let answerVal: string | number | boolean = true;
        if (q.type === 'choice') {
          answerVal = 'accept';
        } else if (q.type === 'score') {
          answerVal = 3;
        }

        inspectStore.decisions.update(item.decision_id, {
          answer: String(answerVal),
          confidence: 0.96,
          path: 'ai',
        });
      }

      for (let i = 3; i < 5; i++) {
        const item = needsAi1[i]!;
        const q = questions[i]!;
        let answerVal: string | number | boolean = true;
        if (q.type === 'choice') {
          answerVal = 'reject';
        } else if (q.type === 'score') {
          answerVal = 5;
        }

        // Add feedback confirming the decision
        inspectStore.feedback.create({
          decision_id: item.decision_id,
          correct_value: String(answerVal),
          source: 'human',
          note: 'Confirmed correct in review',
        });
      }

      // Second identical call over stdio with the same 10 questions and state
      const call2 = await client.callTool({
        name: 'decide',
        arguments: {
          questions,
          state,
          threshold: 0.8,
        },
      });

      expect(call2.isError).toBeFalsy();
      const content2 = call2.structuredContent as Record<string, unknown>;
      const answers2 = content2.answers as {
        id: string;
        path: string;
        confidence: number;
        decision_id: string;
        value: unknown;
      }[];
      const needsAi2 = content2.needs_ai as { id: string; decision_id: string }[];

      // Exactly 5 hit memory, 5 return in needs_ai!
      expect(answers2).toHaveLength(5);
      expect(needsAi2).toHaveLength(5);

      // Verify memory answers carry path: 'memory', expected values, and decision_id
      for (let i = 0; i < 5; i++) {
        const ans = answers2[i]!;
        expect(ans.id).toBe(questions[i]!.id);
        expect(ans.path).toBe('memory');
        expect(ans.decision_id).toBeDefined();
        if (i < 3) {
          expect(ans.confidence).toBe(0.96);
        } else {
          // Confirmed via feedback
          expect(ans.confidence).toBe(1.0);
        }
      }

      // Verify the other 5 unconfirmed items returned in needs_ai
      for (let i = 0; i < 5; i++) {
        const unconfirmed = needsAi2[i]!;
        expect(unconfirmed.id).toBe(questions[i + 5]!.id);
        expect(unconfirmed.decision_id).toBeDefined();
      }

      inspectStore.close();
    } finally {
      await client?.close();
      if (prevDbEnv === undefined) {
        delete process.env.BROWSERREFLEX_DB_PATH;
      } else {
        process.env.BROWSERREFLEX_DB_PATH = prevDbEnv;
      }
      rmSync(stdioTempDir, { recursive: true, force: true });
    }
  }, 120_000);
});
