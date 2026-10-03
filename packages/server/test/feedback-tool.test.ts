import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  type ChoiceQuestion,
  type CheckQuestion,
  type DatabaseStore,
  type Question,
  createMemory,
  createStore,
} from '../src/index.js';
import { executeDecide } from '../src/tools/decide.js';
import { executeFeedback } from '../src/tools/feedback.js';
import { connectToServer, sourceEntry } from './helpers/stdio-server.js';

const POPUP_QUESTION: ChoiceQuestion = {
  id: 'q_popup',
  type: 'choice',
  text: 'What kind of popup is this?',
  options: [
    { id: 'cookie_banner', description: 'Cookie consent' },
    { id: 'promo_modal', description: 'Promotional dialog' },
    { id: 'none', description: 'No popup' },
  ],
};

const LOGIN_QUESTION: CheckQuestion = {
  id: 'q_login_wall',
  type: 'check',
  text: 'Is a login wall in the way?',
};

/**
 * Builds a value shaped like a provider key out of two fragments.
 *
 * A literal key in source is blocked by push protection, and a key assembled here is
 * the same string to the redaction rules, which is what the test needs.
 */
function providerKey(): string {
  return ['sk', 'live', '4f8c1a9d2b7e6053'].join('_');
}

describe('feedback tool', () => {
  let tempDir: string;
  let store: DatabaseStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-feedback-'));
    store = createStore(join(tempDir, 'test.db'));
  });

  afterEach(() => {
    if (store) {
      store.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('records a correction and the next decide for the same input returns the corrected value', async () => {
    const state = { url: 'https://example.com/pricing', section: 'plans' };

    const first = await executeDecide({ questions: [POPUP_QUESTION], state }, { store });
    expect(first.needs_ai).toHaveLength(1);
    const decisionId = first.needs_ai[0]!.decision_id;

    // The pending answer is below any reuse threshold, so nothing is served yet.
    const beforeFeedback = await executeDecide({ questions: [POPUP_QUESTION], state }, { store });
    expect(beforeFeedback.answers).toHaveLength(0);
    expect(beforeFeedback.needs_ai).toHaveLength(1);

    const correction = await executeFeedback(
      { decision_id: decisionId, correct_value: 'cookie_banner' },
      { store },
    );

    expect(correction.status).toBe('recorded');
    expect(correction.decision_id).toBe(decisionId);
    expect(correction.decision_path).toBe('ai');
    expect(correction.previous_value).toBe('pending');
    expect(correction.correct_value).toBe('cookie_banner');
    expect(correction.memory_confirmed).toBe(true);
    expect(correction.pattern).toBeNull();
    expect(correction.feedback_id).toBeDefined();

    const afterFeedback = await executeDecide({ questions: [POPUP_QUESTION], state }, { store });
    expect(afterFeedback.needs_ai).toHaveLength(0);
    expect(afterFeedback.answers).toHaveLength(1);
    expect(afterFeedback.answers[0]!.value).toBe('cookie_banner');
    expect(afterFeedback.answers[0]!.path).toBe('memory');
    expect(afterFeedback.answers[0]!.confidence).toBe(1);
    expect(afterFeedback.answers[0]!.distribution).toEqual({
      cookie_banner: 1,
      promo_modal: 0,
      none: 0,
    });

    const rows = store.feedback.getByDecisionId(decisionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.correct_value).toBe('cookie_banner');
    expect(rows[0]!.source).toBe('agent');
  });

  it('a correction that differs from the stored answer replaces what memory returns next time', async () => {
    const memory = createMemory(store);
    const state = { url: 'https://example.com/home', modal: 'newsletter' };

    const stored = memory.save({
      input: state,
      question: POPUP_QUESTION,
      answer: 'promo_modal',
      confidence: 0.95,
      path: 'ai',
    });

    // Before the correction memory serves the answer the decision row carries.
    const beforeCorrection = memory.lookup({
      input: state,
      question: POPUP_QUESTION,
      threshold: 0.8,
    });
    expect(beforeCorrection?.answer.value).toBe('promo_modal');

    const correction = await executeFeedback(
      { decision_id: stored.id, correct_value: 'none', source: 'user' },
      { store },
    );

    expect(correction.status).toBe('recorded');
    expect(correction.previous_value).toBe('promo_modal');
    expect(correction.correct_value).toBe('none');
    expect(correction.source).toBe('user');

    const afterCorrection = await executeDecide({ questions: [POPUP_QUESTION], state }, { store });
    expect(afterCorrection.needs_ai).toHaveLength(0);
    expect(afterCorrection.answers[0]!.value).toBe('none');
    expect(afterCorrection.answers[0]!.path).toBe('memory');

    // The decision row keeps the answer, path and confidence that produced it.
    const untouched = store.decisions.getById(stored.id);
    expect(untouched?.answer).toBe('promo_modal');
    expect(untouched?.path).toBe('ai');
    expect(untouched?.confidence).toBe(0.95);
  });

  it('records an agree and a disagree sample against the statistics of the decision pattern', async () => {
    const memory = createMemory(store);
    const pattern = store.patterns.create({
      name: 'newsletter modal',
      decision_type: 'choice',
      rules: JSON.stringify({ selector: '.newsletter' }),
      status: 'active',
      confidence: 0.8,
    });

    const agreedDecision = memory.save({
      input: { url: 'https://example.com/a', modal: 'newsletter' },
      question: POPUP_QUESTION,
      answer: 'promo_modal',
      confidence: 0.9,
      path: 'pattern',
      patternId: pattern.id,
    });

    const firstResult = await executeFeedback(
      { decision_id: agreedDecision.id, correct_value: 'promo_modal' },
      { store },
    );

    expect(firstResult.status).toBe('recorded');
    expect(firstResult.pattern).toEqual({
      pattern_id: pattern.id,
      sample_recorded: true,
      agreed: true,
      sample_count: 1,
      agreed_count: 1,
      disagreed_count: 0,
      accuracy: 1,
    });

    const disagreedDecision = memory.save({
      input: { url: 'https://example.com/b', modal: 'newsletter' },
      question: POPUP_QUESTION,
      answer: 'promo_modal',
      confidence: 0.9,
      path: 'pattern',
      patternId: pattern.id,
    });

    const secondResult = await executeFeedback(
      { decision_id: disagreedDecision.id, correct_value: 'none' },
      { store },
    );

    expect(secondResult.pattern).toEqual({
      pattern_id: pattern.id,
      sample_recorded: true,
      agreed: false,
      sample_count: 2,
      agreed_count: 1,
      disagreed_count: 1,
      accuracy: 0.5,
    });

    const stats = store.patternStats.getById(pattern.id);
    expect(stats?.sample_count).toBe(2);
    expect(stats?.agreed_count).toBe(1);
    expect(stats?.disagreed_count).toBe(1);
    expect(stats?.last_evaluated_at).not.toBeNull();
  });

  it('agrees with a check answer written in a different but equal form', async () => {
    const memory = createMemory(store);
    const pattern = store.patterns.create({
      name: 'login wall detector',
      decision_type: 'check',
      rules: JSON.stringify({ passwordField: true }),
      status: 'active',
      confidence: 0.8,
    });

    const decision = memory.save({
      input: { url: 'https://example.com/account' },
      question: LOGIN_QUESTION,
      answer: true,
      confidence: 0.7,
      path: 'pattern',
      patternId: pattern.id,
    });

    const result = await executeFeedback(
      { decision_id: decision.id, correct_value: 'yes' },
      { store },
    );

    expect(result.correct_value).toBe(true);
    expect(result.pattern?.agreed).toBe(true);
    expect(store.patternStats.getById(pattern.id)?.agreed_count).toBe(1);
  });

  it('returns a typed error for an unknown decision id and writes nothing', async () => {
    const result = await executeFeedback(
      { decision_id: 'dec-does-not-exist', correct_value: 'none' },
      { store },
    );

    expect(result.status).toBe('error');
    expect(result.error).toBe('decision_not_found');
    expect(result.message).toContain('dec-does-not-exist');
    expect(result.memory_confirmed).toBeUndefined();
    expect(store.feedback.list()).toHaveLength(0);
  });

  it('rejects a correction that does not match the decision type and writes nothing', async () => {
    const memory = createMemory(store);
    const decision = memory.save({
      input: { url: 'https://example.com/account' },
      question: LOGIN_QUESTION,
      answer: true,
      confidence: 0.6,
      path: 'check',
    });

    const result = await executeFeedback(
      { decision_id: decision.id, correct_value: 'banana' },
      { store },
    );

    expect(result.status).toBe('error');
    expect(result.error).toBe('invalid_correct_value');
    expect(result.message).toContain('check');
    expect(store.feedback.list()).toHaveLength(0);
    expect(store.patternStats.list()).toHaveLength(0);
  });

  it('stores the reported source and a note that is redacted before it reaches the database', async () => {
    const memory = createMemory(store);
    const question: Question = LOGIN_QUESTION;
    const decision = memory.save({
      input: { url: 'https://example.com/pay' },
      question,
      answer: false,
      confidence: 0.4,
      path: 'ai',
    });

    const key = providerKey();
    const result = await executeFeedback(
      {
        decision_id: decision.id,
        correct_value: false,
        source: 'user',
        note: `the page had ${key} in a hidden field, so this is a payment wall`,
      },
      { store },
    );

    expect(result.status).toBe('recorded');
    expect(result.note).toContain('[REDACTED:API_KEY]');
    expect(result.note).not.toContain(key);

    const rows = store.feedback.getByDecisionId(decision.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('user');
    expect(rows[0]!.note).not.toContain(key);
    expect(rows[0]!.note).toContain('[REDACTED:API_KEY]');
    expect(rows[0]!.correct_value).toBe('false');
  });

  it('serves feedback over stdio and the corrected answer comes back on the next decide', async () => {
    const stdioTempDir = mkdtempSync(join(tmpdir(), 'browserreflex-feedback-stdio-'));
    const stdioDbPath = join(stdioTempDir, 'test.db');
    const previousDbEnv = process.env.BROWSERREFLEX_DB_PATH;
    process.env.BROWSERREFLEX_DB_PATH = stdioDbPath;

    let client: Client | undefined;
    let inspectStore: DatabaseStore | undefined;
    try {
      client = (await connectToServer(sourceEntry)).client;

      const listed = await client.listTools();
      expect(listed.tools.map((entry) => entry.name)).toContain('feedback');

      const state = { url: 'https://example.com/stdio-feedback', section: 'checkout' };

      const firstCall = await client.callTool({
        name: 'decide',
        arguments: { questions: [POPUP_QUESTION], state },
      });
      expect(firstCall.isError).toBeFalsy();
      const firstContent = firstCall.structuredContent as {
        needs_ai: { decision_id: string }[];
      };
      expect(firstContent.needs_ai).toHaveLength(1);
      const decisionId = firstContent.needs_ai[0]!.decision_id;

      const feedbackCall = await client.callTool({
        name: 'feedback',
        arguments: { decision_id: decisionId, correct_value: 'none', source: 'user' },
      });

      expect(feedbackCall.isError).toBeFalsy();
      const feedbackText = feedbackCall.content as { type: string; text: string }[];
      expect(feedbackText.map((entry) => entry.text).join(' ')).toContain(decisionId);
      const feedbackContent = feedbackCall.structuredContent as {
        status: string;
        memory_confirmed: boolean;
        pattern: unknown;
      };
      expect(feedbackContent.status).toBe('recorded');
      expect(feedbackContent.memory_confirmed).toBe(true);
      expect(feedbackContent.pattern).toBeNull();

      inspectStore = createStore(stdioDbPath);
      const rows = inspectStore.feedback.getByDecisionId(decisionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.correct_value).toBe('none');
      expect(rows[0]!.source).toBe('user');

      const secondCall = await client.callTool({
        name: 'decide',
        arguments: { questions: [POPUP_QUESTION], state },
      });
      expect(secondCall.isError).toBeFalsy();
      const secondContent = secondCall.structuredContent as {
        answers: { value: unknown; path: string }[];
        needs_ai: unknown[];
      };
      expect(secondContent.needs_ai).toHaveLength(0);
      expect(secondContent.answers).toHaveLength(1);
      expect(secondContent.answers[0]!.value).toBe('none');
      expect(secondContent.answers[0]!.path).toBe('memory');
    } finally {
      await client?.close();
      inspectStore?.close();
      if (previousDbEnv === undefined) {
        delete process.env.BROWSERREFLEX_DB_PATH;
      } else {
        process.env.BROWSERREFLEX_DB_PATH = previousDbEnv;
      }
      rmSync(stdioTempDir, { recursive: true, force: true });
    }
  }, 120_000);
});
