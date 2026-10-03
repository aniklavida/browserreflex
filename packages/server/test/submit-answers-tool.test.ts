import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  type ChoiceQuestion,
  type CheckQuestion,
  type DatabaseStore,
  SCHEMA_VIOLATION,
  createStore,
} from '../src/index.js';
import { executeDecide } from '../src/tools/decide.js';
import { executeSubmitAnswers } from '../src/tools/submit_answers.js';
import { connectToServer, sourceEntry } from './helpers/stdio-server.js';

describe('submit_answers tool', () => {
  let tempDir: string;
  let dbPath: string;
  let store: DatabaseStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-submit-'));
    dbPath = join(tempDir, 'test.db');
    store = createStore(dbPath);
  });

  afterEach(() => {
    if (store) {
      store.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects invalid answers with schema_violation and keeps pending decision retryable', async () => {
    const choiceQ: ChoiceQuestion = {
      id: 'q_popup',
      type: 'choice',
      text: 'What type of dialog is visible?',
      options: [
        { id: 'cookie_banner', description: 'Cookie banner' },
        { id: 'login_modal', description: 'Login modal' },
        { id: 'none', description: 'No dialog' },
      ],
    };

    // 1. Initial decide call creates a pending decision in needs_ai
    const decideResult = await executeDecide(
      {
        questions: [choiceQ],
        state: { url: 'https://example.com/app' },
      },
      { store },
    );

    expect(decideResult.needs_ai).toHaveLength(1);
    const pendingDecisionId = decideResult.needs_ai[0]!.decision_id;
    expect(pendingDecisionId).toBeDefined();

    const decisionBefore = store.decisions.getById(pendingDecisionId);
    expect(decisionBefore?.answer).toBe('pending');
    expect(decisionBefore?.confidence).toBe(0);

    // 2. Submit an invalid answer (value not in options, invalid distribution sum)
    const invalidSubmit = await executeSubmitAnswers(
      {
        answers: [
          {
            decision_id: pendingDecisionId,
            question: choiceQ,
            value: 'completely_unknown_option',
            confidence: 0.9,
            distribution: {
              cookie_banner: 0.2,
              login_modal: 0.2,
              none: 0.2, // sums to 0.6, violates distribution sum
            },
          },
        ],
      },
      { store },
    );

    expect(invalidSubmit.answers).toHaveLength(0);
    expect(invalidSubmit.needs_human).toHaveLength(0);
    expect(invalidSubmit.errors).toHaveLength(0);
    expect(invalidSubmit.schema_violations).toHaveLength(1);

    const violation = invalidSubmit.schema_violations[0]!;
    expect(violation.decision_id).toBe(pendingDecisionId);
    expect(violation.type).toBe(SCHEMA_VIOLATION);
    expect(violation.reason).toBeDefined();

    // Verify invariant: pending decision in database remains pending and untouched!
    const decisionAfterInvalid = store.decisions.getById(pendingDecisionId);
    expect(decisionAfterInvalid?.answer).toBe('pending');
    expect(decisionAfterInvalid?.confidence).toBe(0);

    // 3. Agent retries with the SAME decision_id with a valid answer
    const validRetry = await executeSubmitAnswers(
      {
        answers: [
          {
            decision_id: pendingDecisionId,
            question: choiceQ,
            value: 'cookie_banner',
            confidence: 0.95,
            distribution: {
              cookie_banner: 0.95,
              login_modal: 0.03,
              none: 0.02,
            },
          },
        ],
      },
      { store },
    );

    expect(validRetry.schema_violations).toHaveLength(0);
    expect(validRetry.answers).toHaveLength(1);

    const accepted = validRetry.answers[0]!;
    expect(accepted.decision_id).toBe(pendingDecisionId);
    expect(accepted.value).toBe('cookie_banner');
    expect(accepted.confidence).toBe(0.95);
    expect(accepted.path).toBe('ai');

    // Verify database record has been updated and completed
    const decisionCompleted = store.decisions.getById(pendingDecisionId);
    expect(decisionCompleted?.answer).toContain('cookie_banner');
    expect(decisionCompleted?.confidence).toBe(0.95);
    expect(decisionCompleted?.path).toBe('ai');
    expect(decisionCompleted?.needs_review).toBe(0);
  });

  it('routes below-threshold answers to needs_human instead of answers', async () => {
    const checkQ: CheckQuestion = {
      id: 'q_login',
      type: 'check',
      text: 'Is this a login wall?',
    };

    const decideResult = await executeDecide(
      {
        questions: [checkQ],
        state: { url: 'https://example.com/portal' },
      },
      { store },
    );

    const decisionId = decideResult.needs_ai[0]!.decision_id;

    // Submit answer with confidence 0.60 when threshold is 0.80
    const submitResult = await executeSubmitAnswers(
      {
        answers: [
          {
            decision_id: decisionId,
            question: checkQ,
            value: true,
            confidence: 0.6,
          },
        ],
        threshold: 0.8,
      },
      { store },
    );

    // Must be routed to needs_human, NOT to answers
    expect(submitResult.answers).toHaveLength(0);
    expect(submitResult.needs_human).toHaveLength(1);
    expect(submitResult.schema_violations).toHaveLength(0);
    expect(submitResult.errors).toHaveLength(0);

    const humanItem = submitResult.needs_human[0]!;
    expect(humanItem.decision_id).toBe(decisionId);
    expect(humanItem.confidence).toBe(0.6);
    expect(humanItem.value).toBe(true);
    expect(humanItem.reason).toContain('below threshold');

    // Verify stored decision has needs_review: 1 and confidence 0.60
    const stored = store.decisions.getById(decisionId);
    expect(stored?.confidence).toBe(0.6);
    expect(stored?.path).toBe('ai');
    expect(stored?.needs_review).toBe(1);
    expect(stored?.answer).toBe('true');
  });

  it('stores valid above-threshold answers with path ai and confirms them', async () => {
    const checkQ: CheckQuestion = {
      id: 'q_nav_safe',
      type: 'check',
      text: 'Is navigation target safe to proceed?',
    };

    const decideResult = await executeDecide(
      {
        questions: [checkQ],
        state: { url: 'https://example.com/safe-nav' },
      },
      { store },
    );

    const decisionId = decideResult.needs_ai[0]!.decision_id;

    const submitResult = await executeSubmitAnswers(
      {
        answers: [
          {
            decision_id: decisionId,
            question: checkQ,
            value: true,
            confidence: 0.95,
          },
        ],
        threshold: 0.8,
      },
      { store },
    );

    expect(submitResult.answers).toHaveLength(1);
    expect(submitResult.needs_human).toHaveLength(0);
    expect(submitResult.schema_violations).toHaveLength(0);

    const answer = submitResult.answers[0]!;
    expect(answer.decision_id).toBe(decisionId);
    expect(answer.confidence).toBe(0.95);
    expect(answer.path).toBe('ai');
    expect(answer.value).toBe(true);

    const stored = store.decisions.getById(decisionId);
    expect(stored?.confidence).toBe(0.95);
    expect(stored?.path).toBe('ai');
    expect(stored?.needs_review).toBe(0);
  });

  it('returns typed error for unknown decision id', async () => {
    const unknownId = '00000000-0000-0000-0000-000000000000';
    const submitResult = await executeSubmitAnswers(
      {
        answers: [
          {
            decision_id: unknownId,
            value: 'accept',
            confidence: 0.9,
          },
        ],
      },
      { store },
    );

    expect(submitResult.answers).toHaveLength(0);
    expect(submitResult.needs_human).toHaveLength(0);
    expect(submitResult.schema_violations).toHaveLength(0);
    expect(submitResult.errors).toHaveLength(1);

    const err = submitResult.errors[0]!;
    expect(err.decision_id).toBe(unknownId);
    expect(err.type).toBe('not_found');
    expect(err.message).toContain('not found');
  });

  it('returns typed error for already-completed decision id', async () => {
    const checkQ: CheckQuestion = {
      id: 'q_once',
      type: 'check',
      text: 'Check once?',
    };

    const decideResult = await executeDecide(
      {
        questions: [checkQ],
        state: { url: 'https://example.com/once' },
      },
      { store },
    );

    const decisionId = decideResult.needs_ai[0]!.decision_id;

    // First submit completes the decision
    const firstSubmit = await executeSubmitAnswers(
      {
        answers: [
          {
            decision_id: decisionId,
            question: checkQ,
            value: true,
            confidence: 0.92,
          },
        ],
      },
      { store },
    );
    expect(firstSubmit.answers).toHaveLength(1);

    // Second submit on the same already-completed decision returns typed error
    const secondSubmit = await executeSubmitAnswers(
      {
        answers: [
          {
            decision_id: decisionId,
            question: checkQ,
            value: false,
            confidence: 0.85,
          },
        ],
      },
      { store },
    );

    expect(secondSubmit.answers).toHaveLength(0);
    expect(secondSubmit.errors).toHaveLength(1);

    const err = secondSubmit.errors[0]!;
    expect(err.decision_id).toBe(decisionId);
    expect(err.type).toBe('already_completed');
    expect(err.message).toContain('already been completed');
  });

  it('handles batch submissions with a mix of valid, invalid, below-threshold, unknown and completed items', async () => {
    const q1: CheckQuestion = { id: 'q1', type: 'check', text: 'Valid above threshold' };
    const q2: CheckQuestion = { id: 'q2', type: 'check', text: 'Valid below threshold' };
    const q3: CheckQuestion = { id: 'q3', type: 'check', text: 'Invalid schema' };
    const q4: CheckQuestion = { id: 'q4', type: 'check', text: 'Will be completed' };

    const decideResult = await executeDecide(
      {
        questions: [q1, q2, q3, q4],
        state: { page: 'multi-batch' },
      },
      { store },
    );

    const id1 = decideResult.needs_ai[0]!.decision_id;
    const id2 = decideResult.needs_ai[1]!.decision_id;
    const id3 = decideResult.needs_ai[2]!.decision_id;
    const id4 = decideResult.needs_ai[3]!.decision_id;

    // Complete id4 ahead of batch call
    await executeSubmitAnswers(
      {
        answers: [{ decision_id: id4, question: q4, value: true, confidence: 0.9 }],
      },
      { store },
    );

    const unknownId = '11111111-2222-3333-4444-555555555555';

    // Submit batch with all 5 kinds
    const batchResult = await executeSubmitAnswers(
      {
        answers: [
          { decision_id: id1, question: q1, value: true, confidence: 0.95 },
          { decision_id: id2, question: q2, value: false, confidence: 0.5 },
          { decision_id: id3, question: q3, value: 'invalid_boolean', confidence: 0.9 },
          { decision_id: id4, question: q4, value: true, confidence: 0.9 },
          { decision_id: unknownId, value: true, confidence: 0.9 },
        ],
        threshold: 0.8,
      },
      { store },
    );

    expect(batchResult.answers).toHaveLength(1);
    expect(batchResult.answers[0]!.decision_id).toBe(id1);

    expect(batchResult.needs_human).toHaveLength(1);
    expect(batchResult.needs_human[0]!.decision_id).toBe(id2);

    expect(batchResult.schema_violations).toHaveLength(1);
    expect(batchResult.schema_violations[0]!.decision_id).toBe(id3);

    expect(batchResult.errors).toHaveLength(2);
    expect(batchResult.errors.map((e) => e.type)).toEqual(
      expect.arrayContaining(['already_completed', 'not_found']),
    );
  });

  it('proves decide -> needs_ai -> submit_answers -> a second decide hits memory only when meeting threshold over stdio MCP client', async () => {
    const stdioTempDir = mkdtempSync(join(tmpdir(), 'browserreflex-submit-stdio-'));
    const stdioDbPath = join(stdioTempDir, 'test.db');

    const prevDbEnv = process.env.BROWSERREFLEX_DB_PATH;
    process.env.BROWSERREFLEX_DB_PATH = stdioDbPath;

    let client: Client | undefined;
    try {
      const connected = await connectToServer(sourceEntry);
      client = connected.client;

      const qChoice: ChoiceQuestion = {
        id: 'q_choice_cookie',
        type: 'choice',
        text: 'Select consent policy',
        options: [
          { id: 'accept', description: 'Accept' },
          { id: 'reject', description: 'Reject' },
        ],
      };

      const qCheck: CheckQuestion = {
        id: 'q_check_modal',
        type: 'check',
        text: 'Is modal blocking viewport?',
      };

      const state = { url: 'https://example.com/stdio-lifecycle', step: 'initial' };

      // Step 1: Call decide over stdio -> returns needs_ai for both unknown questions
      const decide1 = await client.callTool({
        name: 'decide',
        arguments: {
          questions: [qChoice, qCheck],
          state,
          threshold: 0.8,
        },
      });

      expect(decide1.isError).toBeFalsy();
      const content1 = decide1.structuredContent as Record<string, unknown>;
      const needsAi1 = content1.needs_ai as {
        id: string;
        decision_id: string;
        question: unknown;
      }[];

      expect(content1.answers).toHaveLength(0);
      expect(needsAi1).toHaveLength(2);

      const choiceDecisionId = needsAi1.find((item) => item.id === 'q_choice_cookie')!.decision_id;
      const checkDecisionId = needsAi1.find((item) => item.id === 'q_check_modal')!.decision_id;

      // Step 2: Call submit_answers over stdio:
      // - Choice answer provided with high confidence 0.95 (meets threshold 0.80)
      // - Check answer provided with low confidence 0.55 (below threshold 0.80)
      const submit = await client.callTool({
        name: 'submit_answers',
        arguments: {
          answers: [
            {
              decision_id: choiceDecisionId,
              question: qChoice,
              value: 'accept',
              confidence: 0.95,
              distribution: { accept: 0.95, reject: 0.05 },
            },
            {
              decision_id: checkDecisionId,
              question: qCheck,
              value: true,
              confidence: 0.55,
            },
          ],
          threshold: 0.8,
        },
      });

      expect(submit.isError).toBeFalsy();
      const submitContent = submit.structuredContent as Record<string, unknown>;
      const acceptedAnswers = submitContent.answers as {
        decision_id: string;
        confidence: number;
      }[];
      const needsHumanItems = submitContent.needs_human as {
        decision_id: string;
        confidence: number;
      }[];

      // Choice answer accepted into answers
      expect(acceptedAnswers).toHaveLength(1);
      expect(acceptedAnswers[0]!.decision_id).toBe(choiceDecisionId);
      expect(acceptedAnswers[0]!.confidence).toBe(0.95);

      // Check answer routed to needs_human due to below-threshold confidence
      expect(needsHumanItems).toHaveLength(1);
      expect(needsHumanItems[0]!.decision_id).toBe(checkDecisionId);
      expect(needsHumanItems[0]!.confidence).toBe(0.55);

      // Step 3: Call decide a second time with the exact same questions and state
      const decide2 = await client.callTool({
        name: 'decide',
        arguments: {
          questions: [qChoice, qCheck],
          state,
          threshold: 0.8,
        },
      });

      expect(decide2.isError).toBeFalsy();
      const content2 = decide2.structuredContent as Record<string, unknown>;
      const answers2 = content2.answers as {
        id: string;
        path: string;
        value: unknown;
        confidence: number;
      }[];
      const needsAi2 = content2.needs_ai as { id: string }[];

      // qChoice hit memory because confidence 0.95 >= threshold 0.80!
      expect(answers2).toHaveLength(1);
      expect(answers2[0]!.id).toBe('q_choice_cookie');
      expect(answers2[0]!.path).toBe('memory');
      expect(answers2[0]!.value).toBe('accept');
      expect(answers2[0]!.confidence).toBe(0.95);

      // qCheck did NOT hit memory because confidence 0.55 < threshold 0.80, so it returned in needs_ai!
      expect(needsAi2).toHaveLength(1);
      expect(needsAi2[0]!.id).toBe('q_check_modal');
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
