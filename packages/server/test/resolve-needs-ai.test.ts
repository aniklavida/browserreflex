/**
 * Tests for `resolveNeedsAi`: answering `needs_ai` items through an adapter.
 *
 * The adapter here is a hand-written object rather than the Anthropic one, so this
 * file tests the recording path and not the transport, and no test in it opens a
 * socket. Every value is invented. No test reads the real home directory, the real
 * keychain or the real database location: each one creates a temporary database
 * and removes it afterwards.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AdapterError,
  type AdapterAnswerDraft,
  type AdapterDecideRequest,
  type AdapterDecideResult,
  type ModelAdapter,
  type RetryPolicy,
  resolveNeedsAi,
} from '../src/adapters/index.js';
import type { ChoiceQuestion, CheckQuestion, Question } from '../src/core/schema.js';
import type { NeedsAiItem } from '../src/core/router.js';
import { executeDecide } from '../src/tools/decide.js';
import { createStore, type DatabaseStore } from '../src/store/index.js';

const POPUP_QUESTION: ChoiceQuestion = {
  id: 'q_popup',
  type: 'choice',
  text: 'What kind of dialog is visible?',
  options: [
    { id: 'cookie_banner', description: 'Cookie banner' },
    { id: 'login_modal', description: 'Login modal' },
    { id: 'none', description: 'No dialog' },
  ],
};

const LOGIN_QUESTION: CheckQuestion = {
  id: 'q_login_wall',
  type: 'check',
  text: 'Is a login wall in the way?',
};

const RETRY: RetryPolicy = { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, backoffFactor: 1 };

/** Joins a prefix to a body so that no single literal looks like a live key. */
function token(prefix: string, body: string): string {
  return `${prefix}${body}`;
}

/** A step clock, so a reported latency is a stated number rather than a timing. */
function steppingClock(step: number): () => number {
  let reading = 0;
  return () => {
    reading += step;
    return reading;
  };
}

/** An adapter that answers exactly what a test tells it to. */
function scriptedAdapter(params: {
  answer: (request: AdapterDecideRequest) => AdapterDecideResult | Error;
  provider?: string;
  defaultModel?: string;
  timeoutMs?: number;
  retry?: RetryPolicy;
}): ModelAdapter {
  return {
    provider: params.provider ?? 'scripted',
    defaultModel: params.defaultModel ?? 'scripted-model-1',
    timeoutMs: params.timeoutMs ?? 1000,
    retry: params.retry ?? RETRY,
    decide: async (request) => {
      const outcome = params.answer(request);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

/** A result carrying the drafts a test wants, and nothing else. */
function resultWith(
  answers: AdapterAnswerDraft[],
  extra: Partial<AdapterDecideResult> = {},
): AdapterDecideResult {
  return {
    provider: 'scripted',
    model: 'scripted-model-1',
    answers,
    rejects: [],
    latencyMs: 12.5,
    attempts: 1,
    ...extra,
  };
}

describe('resolveNeedsAi', () => {
  let tempDir: string;
  let store: DatabaseStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-resolve-'));
    store = createStore(join(tempDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Runs `decide` and returns the `needs_ai` items it produced. */
  async function pending(questions: Question[]): Promise<NeedsAiItem[]> {
    const decided = await executeDecide(
      { questions, state: { url: 'https://example.test/checkout' } },
      { store },
    );
    expect(decided.schema_violations).toEqual([]);
    expect(decided.needs_ai).toHaveLength(questions.length);
    return decided.needs_ai;
  }

  it('records a valid model answer through the submit path with path ai', async () => {
    const items = await pending([POPUP_QUESTION]);
    const adapter = scriptedAdapter({
      answer: () =>
        resultWith([
          {
            questionId: 'q_popup',
            value: 'cookie_banner',
            confidence: 0.91,
            distribution: { cookie_banner: 0.91, login_modal: 0.06, none: 0.03 },
          },
        ]),
    });

    const resolved = await resolveNeedsAi(items, adapter, { store, now: steppingClock(4) });

    expect(resolved.rejects).toEqual([]);
    expect(resolved.needs_human).toEqual([]);
    expect(resolved.answers).toHaveLength(1);
    expect(resolved.answers[0]!.path).toBe('ai');
    expect(resolved.answers[0]!.value).toBe('cookie_banner');
    expect(resolved.answers[0]!.confidence).toBe(0.91);
    expect(resolved.answers[0]!.decision_id).toBe(items[0]!.decision_id);
    expect(resolved.provider).toBe('scripted');
    expect(resolved.model).toBe('scripted-model-1');
    expect(resolved.attempts).toBe(1);
    expect(resolved.latency_ms).toBeGreaterThan(0);

    // The stored record states the path that produced it and nothing else.
    const stored = store.decisions.getById(items[0]!.decision_id);
    expect(stored?.path).toBe('ai');
    expect(stored?.answer).toBe(
      JSON.stringify({
        value: 'cookie_banner',
        distribution: { cookie_banner: 0.91, login_modal: 0.06, none: 0.03 },
      }),
    );
    expect(stored?.confidence).toBe(0.91);
    expect(stored?.decision_type).toBe('choice');
    expect(stored?.needs_review).toBe(0);
  });

  it('answers several questions in one provider call and records each one', async () => {
    const items = await pending([POPUP_QUESTION, LOGIN_QUESTION]);
    const seen: AdapterDecideRequest[] = [];
    const adapter = scriptedAdapter({
      answer: (request) => {
        seen.push(request);
        return resultWith([
          {
            questionId: 'q_popup',
            value: 'none',
            confidence: 0.88,
            distribution: { cookie_banner: 0.05, login_modal: 0.07, none: 0.88 },
          },
          { questionId: 'q_login_wall', value: false, confidence: 0.83 },
        ]);
      },
    });

    const resolved = await resolveNeedsAi(items, adapter, {
      store,
      now: steppingClock(1),
      context: { url: 'https://example.test/checkout' },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.questions.map((question) => question.id)).toEqual(['q_popup', 'q_login_wall']);
    expect(seen[0]!.context).toEqual({ url: 'https://example.test/checkout' });
    expect(resolved.rejects).toEqual([]);
    expect(resolved.answers).toHaveLength(2);
    for (const item of items) {
      const stored = store.decisions.getById(item.decision_id);
      expect(stored?.answer).not.toBe('pending');
      expect(stored?.path).toBe('ai');
    }
  });

  it('rejects invalid model output and never stores it', async () => {
    const items = await pending([POPUP_QUESTION, LOGIN_QUESTION]);

    // The adapter itself reports nothing wrong, and returns a choice value the
    // question does not offer. The decision schema is the only thing that catches
    // this, so skipping validation makes it through and gets written.
    const adapter = scriptedAdapter({
      answer: () =>
        resultWith([
          {
            questionId: 'q_popup',
            value: 'newsletter_popup',
            confidence: 0.94,
            distribution: { cookie_banner: 0.03, login_modal: 0.03, none: 0.94 },
          },
          { questionId: 'q_login_wall', value: false, confidence: 0.93 },
        ]),
    });

    const resolved = await resolveNeedsAi(items, adapter, { store, now: steppingClock(1) });

    expect(resolved.answers.map((answer) => answer.decision_id)).toEqual([items[1]!.decision_id]);
    const rejects = resolved.rejects.filter(
      (reject) => reject.decision_id === items[0]!.decision_id,
    );
    expect(rejects).toHaveLength(1);
    expect(rejects[0]!.type).toBe('invalid_model_output');
    expect(rejects[0]!.reason).toContain('newsletter_popup');

    // The rejected question stays pending and retryable, with nothing written.
    const stored = store.decisions.getById(items[0]!.decision_id);
    expect(stored?.answer).toBe('pending');
    expect(stored?.confidence).toBe(0);
    expect(stored?.path).toBe('ai');
    expect(stored?.needs_review).toBe(0);
  });

  it('records a valid answer below the threshold and reports it as needs_human', async () => {
    const items = await pending([POPUP_QUESTION]);
    const adapter = scriptedAdapter({
      answer: () =>
        resultWith([
          {
            questionId: 'q_popup',
            value: 'login_modal',
            confidence: 0.5,
            distribution: { cookie_banner: 0.25, login_modal: 0.5, none: 0.25 },
          },
        ]),
    });

    const resolved = await resolveNeedsAi(items, adapter, { store, now: steppingClock(1) });

    expect(resolved.answers).toEqual([]);
    expect(resolved.rejects).toEqual([]);
    expect(resolved.needs_human).toHaveLength(1);
    expect(resolved.needs_human[0]!.decision_id).toBe(items[0]!.decision_id);
    expect(resolved.needs_human[0]!.reason).toContain('below threshold');

    const stored = store.decisions.getById(items[0]!.decision_id);
    expect(stored?.path).toBe('ai');
    expect(stored?.needs_review).toBe(1);
  });

  it('reports a question the model skipped instead of answering it', async () => {
    const items = await pending([POPUP_QUESTION, LOGIN_QUESTION]);
    const adapter = scriptedAdapter({
      answer: () =>
        resultWith([
          {
            questionId: 'q_popup',
            value: 'cookie_banner',
            confidence: 0.9,
            distribution: { cookie_banner: 0.9, login_modal: 0.07, none: 0.03 },
          },
        ]),
    });

    const resolved = await resolveNeedsAi(items, adapter, { store, now: steppingClock(1) });

    expect(resolved.answers).toHaveLength(1);
    expect(resolved.rejects).toHaveLength(1);
    expect(resolved.rejects[0]!.type).toBe('no_model_answer');
    expect(resolved.rejects[0]!.question_id).toBe('q_login_wall');
    expect(resolved.rejects[0]!.decision_id).toBe(items[1]!.decision_id);
    expect(store.decisions.getById(items[1]!.decision_id)?.answer).toBe('pending');
  });

  it('passes an adapter reject through with its reason and the decision it belongs to', async () => {
    const items = await pending([POPUP_QUESTION]);
    const adapter = scriptedAdapter({
      answer: () =>
        resultWith([], {
          rejects: [
            {
              questionId: 'q_popup',
              reason: 'Choice answer value "newsletter_popup" is not one of the valid options',
              field: 'value',
            },
          ],
        }),
    });

    const resolved = await resolveNeedsAi(items, adapter, { store, now: steppingClock(1) });

    expect(resolved.rejects).toHaveLength(1);
    expect(resolved.rejects[0]!.type).toBe('invalid_model_output');
    expect(resolved.rejects[0]!.field).toBe('value');
    expect(resolved.rejects[0]!.decision_id).toBe(items[0]!.decision_id);
    expect(resolved.rejects[0]!.reason).toContain('not one of the valid options');
    expect(store.decisions.getById(items[0]!.decision_id)?.answer).toBe('pending');
  });

  it('stores nothing and leaves every item pending when the provider call fails', async () => {
    const items = await pending([POPUP_QUESTION, LOGIN_QUESTION]);
    const adapter = scriptedAdapter({
      answer: () =>
        new AdapterError({
          code: 'rate_limited',
          message: 'The provider answered status 429 on all 3 attempts.',
          provider: 'scripted',
          model: 'scripted-model-1',
          status: 429,
          attempts: 3,
        }),
    });

    const resolved = await resolveNeedsAi(items, adapter, { store, now: steppingClock(1) });

    expect(resolved.answers).toEqual([]);
    expect(resolved.needs_human).toEqual([]);
    expect(resolved.model).toBeNull();
    expect(resolved.attempts).toBe(0);
    expect(resolved.rejects).toHaveLength(2);
    expect(resolved.rejects.every((reject) => reject.type === 'adapter_error')).toBe(true);
    expect(resolved.rejects[0]!.reason).toContain('429');
    for (const item of items) {
      expect(store.decisions.getById(item.decision_id)?.answer).toBe('pending');
    }
  });

  it('does not copy the message of an error it does not recognise', async () => {
    const items = await pending([POPUP_QUESTION]);
    // Assembled from two parts so that this file holds no literal shaped like a live
    // provider key, which the repository's own credential check rejects.
    const secretish = token('sk-' + 'ant-', 'api03NotAKeyButWouldLookLikeOne0123456789');
    const adapter = scriptedAdapter({
      answer: () => {
        throw new Error(`the adapter failed while holding ${secretish}`);
      },
    });

    const resolved = await resolveNeedsAi(items, adapter, { store, now: steppingClock(1) });

    expect(resolved.rejects).toHaveLength(1);
    expect(resolved.rejects[0]!.type).toBe('adapter_error');
    expect(resolved.rejects[0]!.reason).toContain('does not recognise');
    expect(resolved.rejects[0]!.reason).not.toContain(secretish);
    expect(JSON.stringify(resolved)).not.toContain(secretish);
  });

  it('reports an answer for a question id that was never asked', async () => {
    const items = await pending([POPUP_QUESTION]);
    const adapter = scriptedAdapter({
      answer: () => resultWith([{ questionId: 'q_invented', value: true, confidence: 0.5 }]),
    });

    const resolved = await resolveNeedsAi(items, adapter, { store, now: steppingClock(1) });

    expect(resolved.answers).toEqual([]);
    expect(resolved.rejects.map((reject) => reject.type)).toContain('invalid_model_output');
    expect(resolved.rejects.some((reject) => reject.question_id === 'q_invented')).toBe(true);
    expect(store.decisions.getById(items[0]!.decision_id)?.answer).toBe('pending');
  });

  it('reports two answers for one question rather than recording either', async () => {
    const items = await pending([POPUP_QUESTION]);
    const adapter = scriptedAdapter({
      answer: () =>
        resultWith([
          {
            questionId: 'q_popup',
            value: 'cookie_banner',
            confidence: 0.8,
            distribution: { cookie_banner: 0.8, login_modal: 0.1, none: 0.1 },
          },
          {
            questionId: 'q_popup',
            value: 'none',
            confidence: 0.6,
            distribution: { cookie_banner: 0.2, login_modal: 0.2, none: 0.6 },
          },
        ]),
    });

    const resolved = await resolveNeedsAi(items, adapter, { store, now: steppingClock(1) });

    expect(resolved.answers).toEqual([]);
    expect(resolved.rejects[0]!.reason).toContain('more than one answer');
    expect(store.decisions.getById(items[0]!.decision_id)?.answer).toBe('pending');
  });

  it('reports a decision that is already completed rather than overwriting it', async () => {
    const items = await pending([POPUP_QUESTION]);
    const adapter = scriptedAdapter({
      answer: () =>
        resultWith([
          {
            questionId: 'q_popup',
            value: 'cookie_banner',
            confidence: 0.9,
            distribution: { cookie_banner: 0.9, login_modal: 0.06, none: 0.04 },
          },
        ]),
    });

    await resolveNeedsAi(items, adapter, { store, now: steppingClock(1) });
    const stored = store.decisions.getById(items[0]!.decision_id);

    const second = await resolveNeedsAi(items, adapter, { store, now: steppingClock(1) });

    expect(second.answers).toEqual([]);
    expect(second.rejects).toHaveLength(1);
    expect(second.rejects[0]!.type).toBe('submit_rejected');
    expect(second.rejects[0]!.reason).toContain('already been completed');
    expect(store.decisions.getById(items[0]!.decision_id)?.answer).toBe(stored?.answer);
  });

  it('honours a threshold the caller passes and records the answer below it', async () => {
    const items = await pending([POPUP_QUESTION]);
    const adapter = scriptedAdapter({
      answer: () =>
        resultWith([
          {
            questionId: 'q_popup',
            value: 'cookie_banner',
            confidence: 0.7,
            distribution: { cookie_banner: 0.7, login_modal: 0.2, none: 0.1 },
          },
        ]),
    });

    const resolved = await resolveNeedsAi(items, adapter, {
      store,
      now: steppingClock(1),
      threshold: 0.6,
    });

    expect(resolved.answers).toHaveLength(1);
    expect(resolved.needs_human).toEqual([]);
    expect(store.decisions.getById(items[0]!.decision_id)?.needs_review).toBe(0);
  });

  it('calls no provider at all for an empty list and reports no model', async () => {
    let calls = 0;
    const adapter = scriptedAdapter({
      answer: () => {
        calls += 1;
        return resultWith([]);
      },
    });

    const resolved = await resolveNeedsAi([], adapter, { store, now: steppingClock(1) });

    expect(calls).toBe(0);
    expect(resolved.answers).toEqual([]);
    expect(resolved.rejects).toEqual([]);
    expect(resolved.model).toBeNull();
    expect(resolved.attempts).toBe(0);
    expect(resolved.latency_ms).toBe(0);
    expect(resolved.provider).toBe('scripted');
  });
});
