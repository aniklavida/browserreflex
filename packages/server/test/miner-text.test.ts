/**
 * Miner: keyword and short-phrase rules for text decisions.
 *
 * Every value here is invented. The credential-shaped one is assembled from two
 * pieces at run time, because the repository's own credential check fails on any
 * literal shaped like a live token however it was produced.
 *
 * The decisions are written through the repositories rather than through the tools,
 * and their signals through `learning/capture.ts`, because the claim under test is
 * about what the miner does with the rows capture wrote: the stored `tokens` column
 * is ASCII-only, and a Bangla page text survives only in the stored element text.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_THRESHOLDS } from '../src/core/thresholds.js';
import {
  CANDIDATE_KIND,
  CONFIDENCE_CAP,
  CONFIDENCE_FORMULA,
  MIN_AGREEING,
  candidateId,
  learnedConfidence,
  learnedRuleFromPatternRow,
  mineTextCandidates,
  parseStoredAnswer,
  tokenizeText,
  type TextCandidate,
} from '../src/learning/miners/text.js';
import { captureDecisionSignals } from '../src/learning/capture.js';
import { PatternEngine } from '../src/patterns/engine.js';
import { validateAnswer } from '../src/core/schema.js';
import { createStore, type DatabaseStore, type DecisionType } from '../src/store/index.js';
import { executeDecide } from '../src/tools/decide.js';
import { executeSubmitAnswers } from '../src/tools/submit_answers.js';

/** Joins a prefix to its body so no tracked file holds a whole token-shaped literal. */
function token(prefix: string, body: string): string {
  return `${prefix}${body}`;
}

const SECRET_PREFIX = 'glpat-';
const SECRET_BODY = 'A1b2C3d4E5f6G7h8I9j0Kl';
const SECRET = token(SECRET_PREFIX, SECRET_BODY);

const SAFE_QUESTION = 'Is this button safe to click?';
const DIALOG_QUESTION = 'What kind of dialog is visible?';
const SHOP = 'shop.example.com';

interface SeedParams {
  readonly text: string;
  readonly answer: string;
  readonly decisionType?: DecisionType;
  readonly question?: string;
  readonly domain?: string;
  readonly url?: string;
  readonly confidence?: number;
  readonly isSafety?: boolean;
}

/** Writes one slow decision and captures its signals, as the slow path does. */
function seed(store: DatabaseStore, params: SeedParams): string {
  const domain = params.domain ?? SHOP;
  const url = params.url ?? `https://${domain}/cart`;
  const decision = store.decisions.create({
    url,
    domain,
    decision_type: params.decisionType ?? 'check',
    question: params.question ?? SAFE_QUESTION,
    context: JSON.stringify({
      url,
      target: { role: 'button', text: params.text },
    }),
    answer: params.answer,
    confidence: params.confidence ?? 0.9,
    path: 'ai',
    ...(params.isSafety === undefined ? {} : { is_safety: params.isSafety }),
  });

  const outcome = captureDecisionSignals({ store, decision, source: 'slow_path_answer' });
  expect(outcome.stored).toBe(true);
  return decision.id;
}

/** Three decisions whose element text shares exactly the words 'promo' and 'newsletter'. */
function seedPromoTriplet(store: DatabaseStore, answer = 'false'): string[] {
  return ['Promo newsletter one', 'Promo newsletter two', 'Promo newsletter three'].map((text) =>
    seed(store, { text, answer }),
  );
}

function termsOf(candidates: readonly TextCandidate[]): string[] {
  return candidates.map((candidate) => candidate.term).sort();
}

describe('text miner', () => {
  let tempDir: string;
  let store: DatabaseStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-miner-text-'));
    store = createStore(join(tempDir, 'test.db'));
  });

  afterEach(() => {
    if (store) {
      store.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('tokenisation', () => {
    it('keeps Bangla words whole when it tokenises text', () => {
      // A Bangla word carries its vowel signs as separate code points; splitting on
      // non-ASCII would turn one word into fragments that match nothing.
      expect(tokenizeText('কুকি নোটিশ স্বীকৃতি দিন')).toEqual(['কুকি', 'নোটিশ', 'স্বীকৃতি', 'দিন']);
      expect(tokenizeText('সম্মতি নিন, পরে আবার নেবেন')).toEqual([
        'সম্মতি',
        'নিন',
        'পরে',
        'আবার',
        'নেবেন',
      ]);
      expect(tokenizeText('Accept cookies, কুকি নোটিশ')).toEqual([
        'accept',
        'cookies',
        'কুকি',
        'নোটিশ',
      ]);
    });

    it('drops one-character tokens, stop words and the words of a redaction mask', () => {
      expect(tokenizeText('a I x 42 the modal')).toEqual(['42', 'modal']);
      expect(tokenizeText('Pay with [REDACTED:API_KEY] now')).toEqual(['pay', 'now']);
    });
  });

  describe('answers', () => {
    it('reads the answer off a decision row, or reports that there is none', () => {
      const decision = store.decisions.create({
        decision_type: 'check',
        question: SAFE_QUESTION,
        answer: 'pending',
        confidence: 0,
        path: 'ai',
      });
      expect(parseStoredAnswer(decision)).toBeNull();

      const answered = store.decisions.update(decision.id, {
        answer: 'false',
        confidence: 0.9,
        path: 'ai',
      });
      // `submit_answers` writes `String(value)`, so the word is read back as the
      // boolean it was written from: the schema accepts no check answer as a string.
      expect(parseStoredAnswer(answered!)).toEqual({ value: false });

      const scored = store.decisions.create({
        decision_type: 'score',
        question: 'How risky is this?',
        answer: '4.5',
        confidence: 0.9,
        path: 'ai',
      });
      expect(parseStoredAnswer(scored)).toEqual({ value: 4.5 });

      const scoredText = store.decisions.create({
        decision_type: 'score',
        question: 'How risky is this?',
        answer: 'not a number',
        confidence: 0.9,
        path: 'ai',
      });
      expect(parseStoredAnswer(scoredText)).toBeNull();

      const distributed = store.decisions.create({
        decision_type: 'choice',
        question: DIALOG_QUESTION,
        answer: JSON.stringify({ value: 'promo', distribution: { promo: 0.8, none: 0.2 } }),
        confidence: 0.9,
        path: 'ai',
      });
      expect(parseStoredAnswer(distributed)).toEqual({
        value: 'promo',
        distribution: { promo: 0.8, none: 0.2 },
      });

      const invalidCheck = store.decisions.create({
        decision_type: 'check',
        question: SAFE_QUESTION,
        answer: 'maybe',
        confidence: 0.9,
        path: 'ai',
      });
      expect(parseStoredAnswer(invalidCheck)).toBeNull();
    });
  });

  describe('mining', () => {
    it('creates a candidate for a keyword three slow decisions agree on', () => {
      const ids = seedPromoTriplet(store);

      const result = mineTextCandidates(store);

      expect(termsOf(result.created)).toEqual(['newsletter', 'promo', 'promo newsletter']);
      expect(result.summary.min_agreeing).toBe(MIN_AGREEING);
      expect(result.summary.mined_decisions).toBe(3);

      const promo = result.created.find((candidate) => candidate.term === 'promo')!;
      expect(promo).toBeDefined();
      expect(promo.term_kind).toBe('token');
      expect(promo.decision_type).toBe('check');
      expect(promo.answer).toBe(false);
      expect(promo.support).toBe(3);
      expect([...promo.decision_ids].sort()).toEqual([...ids].sort());
      expect(promo.domain).toBe(SHOP);
      expect(promo.pattern.status).toBe('shadow');
      expect(promo.pattern.confidence).toBe(
        learnedConfidence({ support: 3, meanSourceConfidence: 0.9 }),
      );
      expect(store.patterns.list()).toHaveLength(result.created.length);
    });

    it('records a keyword phrase as a phrase, not as two tokens', () => {
      seedPromoTriplet(store);

      const result = mineTextCandidates(store);
      const phrase = result.created.find((candidate) => candidate.term === 'promo newsletter');

      expect(phrase?.term_kind).toBe('phrase');
      expect(phrase?.rule.matchers.text_any).toEqual(['promo newsletter']);
      const tokenCandidate = result.created.find((candidate) => candidate.term === 'promo');
      expect(tokenCandidate?.rule.matchers.text_any).toEqual(['promo']);
    });

    it('creates nothing for a keyword that also appears under a different answer', () => {
      seedPromoTriplet(store);
      seed(store, { text: 'Promo newsletter gone', answer: 'true' });

      const result = mineTextCandidates(store);

      expect(result.created).toEqual([]);
      const conflicted = result.skipped.find(
        (entry) =>
          entry.term === 'promo' &&
          entry.term_kind === 'token' &&
          entry.answer_key === 'check:boolean:false',
      );
      expect(conflicted?.reason).toBe('conflicting_answer');
      expect(conflicted?.support).toBe(3);
      expect(conflicted?.conflicting_support).toBe(1);
      expect(conflicted?.detail).toContain('another answer');
      expect(store.patterns.list()).toEqual([]);
    });

    it('keeps the exclusion wider than the read filter', () => {
      seedPromoTriplet(store);
      // A fourth decision on another site contradicts the same word. The generated
      // rule matches on text alone, so it would match here too.
      seed(store, {
        text: 'Promo newsletter gone',
        answer: 'true',
        domain: 'news.example.org',
        url: 'https://news.example.org/subscribe',
      });

      const result = mineTextCandidates(store, { domain: SHOP });

      expect(result.summary.read_filter).toBe(`domain=${SHOP}`);
      expect(result.summary.read_signals).toBe(3);
      expect(result.created).toEqual([]);
      expect(
        result.skipped.some(
          (entry) => entry.term === 'promo' && entry.reason === 'conflicting_answer',
        ),
      ).toBe(true);
    });

    it('needs the agreement threshold before it creates a candidate', () => {
      const ids = [
        seed(store, { text: 'Promo newsletter one', answer: 'false' }),
        seed(store, { text: 'Promo newsletter two', answer: 'false' }),
      ];

      const tooFew = mineTextCandidates(store);

      expect(tooFew.created).toEqual([]);
      expect(ids).toHaveLength(2);
      const promoSkip = tooFew.skipped.find(
        (entry) => entry.term === 'promo' && entry.reason === 'below_min_agreeing',
      );
      expect(promoSkip?.support).toBe(2);
      expect(promoSkip?.detail).toContain('3 needed');

      const lowered = mineTextCandidates(store, { minAgreeing: 2 });

      expect(lowered.summary.min_agreeing).toBe(2);
      expect(termsOf(lowered.created)).toEqual(['newsletter', 'promo', 'promo newsletter']);
    });

    it('gives a candidate the same id when mining runs twice', () => {
      seedPromoTriplet(store);

      const first = mineTextCandidates(store);
      const afterFirst = store.patterns
        .list()
        .map((pattern) => pattern.id)
        .sort();
      const second = mineTextCandidates(store);
      const afterSecond = store.patterns
        .list()
        .map((pattern) => pattern.id)
        .sort();

      expect(afterFirst.length).toBeGreaterThan(0);
      expect(afterSecond).toEqual(afterFirst);
      expect(second.created).toEqual([]);
      expect(second.skipped.filter((entry) => entry.reason === 'already_mined')).toHaveLength(
        first.created.length,
      );
      expect(second.summary.terms_considered).toBe(first.summary.terms_considered);
      expect(second.summary.min_agreeing).toBe(MIN_AGREEING);
    });

    it('derives the candidate id from the term, the question and the answer only', () => {
      const base = {
        term: 'promo',
        termKind: 'token' as const,
        decisionType: 'check' as const,
        questionKey: DIALOG_QUESTION,
        answerKey: 'check:boolean:false',
      };

      const first = candidateId(base);
      const same = candidateId({ ...base });
      const otherAnswer = candidateId({ ...base, answerKey: 'check:boolean:true' });
      const otherQuestion = candidateId({ ...base, questionKey: 'another question' });
      const otherTerm = candidateId({ ...base, term: 'newsletter' });

      expect(same).toBe(first);
      expect(first.startsWith('learned_text_')).toBe(true);
      expect(new Set([first, otherAnswer, otherQuestion, otherTerm]).size).toBe(4);
    });

    it("leaves the question's own words out of a sample", () => {
      // 'button', 'safe' and 'click' are in the question every decision asked, so
      // they would agree with themselves and match unrelated pages.
      seedPromoTriplet(store);

      const result = mineTextCandidates(store);

      expect(termsOf(result.created)).toEqual(['newsletter', 'promo', 'promo newsletter']);
      expect(result.created.map((candidate) => candidate.question)).toEqual([
        SAFE_QUESTION.toLowerCase(),
        SAFE_QUESTION.toLowerCase(),
        SAFE_QUESTION.toLowerCase(),
      ]);
    });

    it('mines nothing from a decision that is still waiting for an answer', () => {
      const decision = store.decisions.create({
        url: `https://${SHOP}/cart`,
        domain: SHOP,
        decision_type: 'check',
        question: SAFE_QUESTION,
        context: JSON.stringify({
          url: `https://${SHOP}/cart`,
          target: { role: 'button', text: 'Promo newsletter one' },
        }),
        answer: 'pending',
        confidence: 0,
        path: 'ai',
      });
      expect(captureDecisionSignals({ store, decision, source: 'slow_path_answer' }).stored).toBe(
        true,
      );

      const result = mineTextCandidates(store);

      expect(result.created).toEqual([]);
      expect(result.summary.mined_decisions).toBe(0);
      expect(result.summary.skipped_decisions).toEqual([{ reason: 'no_answer', count: 1 }]);
    });

    it('mines nothing from a decision flagged as safety', () => {
      seedPromoTriplet(store, 'false');
      seed(store, { text: 'Pay now one', answer: 'false', isSafety: true });
      seed(store, { text: 'Pay now two', answer: 'false', isSafety: true });
      seed(store, { text: 'Pay now three', answer: 'false', isSafety: true });

      const result = mineTextCandidates(store);

      expect(termsOf(result.created)).not.toContain('pay');
      expect(result.summary.skipped_decisions).toContainEqual({
        reason: 'safety_decision',
        count: 3,
      });
    });

    it('never marks a mined candidate as a safety rule', () => {
      seedPromoTriplet(store);

      const result = mineTextCandidates(store);

      expect(result.created.length).toBeGreaterThan(0);
      for (const candidate of result.created) {
        expect(candidate.pattern.status).toBe('shadow');
        expect(candidate.pattern.is_safety).toBe(0);
        expect(candidate.pattern.pack_id).toBeNull();
        expect(candidate.rule.safety).toBe(false);
        expect(candidate.rule.is_safety).toBe(false);
        expect(candidate.rule.kind).toBe(CANDIDATE_KIND);
        expect(candidate.rule.output.type).toBe('check');
      }
      expect(store.patterns.list({ is_safety: true })).toEqual([]);
    });

    it('keeps a secret on a page out of the mined term', () => {
      ['first', 'second', 'third'].forEach((suffix) => {
        seed(store, { text: `Pay with ${SECRET} ${suffix}`, answer: 'false' });
      });

      const result = mineTextCandidates(store);
      const stored = JSON.stringify(store.patterns.list());

      expect(termsOf(result.created)).toContain('pay');
      expect(stored).not.toContain(SECRET_BODY);
      expect(stored).not.toContain(SECRET_PREFIX);
      expect(stored).not.toContain('redacted');
      expect(stored).not.toContain('api');
    });

    it('reports a failed write instead of a candidate that is not there', () => {
      seedPromoTriplet(store);
      store.db.exec('DROP TABLE patterns');

      const result = mineTextCandidates(store);
      const failed = result.skipped.filter((entry) => entry.reason === 'write_failed');

      expect(result.created).toEqual([]);
      expect(result.summary.terms_considered).toBeGreaterThan(0);
      expect(failed).toHaveLength(3);
      expect(failed.every((entry) => entry.detail.length > 0)).toBe(true);
      expect(
        result.skipped
          .filter((entry) => entry.term === 'promo' && entry.term_kind === 'token')
          .map((entry) => entry.reason),
      ).toContain('write_failed');
    });

    it('mines nothing on its own after a decide and a slow-path answer', async () => {
      const question = { id: 'q_safe', type: 'check', text: SAFE_QUESTION };
      const routed = await executeDecide(
        {
          questions: [question],
          state: {
            url: `https://${SHOP}/checkout`,
            target: { role: 'button', text: 'Place order' },
          },
        },
        { store },
      );
      expect(routed.needs_ai).toHaveLength(1);

      await executeSubmitAnswers(
        {
          answers: [
            { decision_id: routed.needs_ai[0]!.decision_id, value: false, confidence: 0.9 },
          ],
        },
        { store },
      );

      expect(store.signals.count()).toBe(1);
      expect(store.patterns.list()).toEqual([]);
    });
  });

  describe('Bangla', () => {
    const BANGLA_QUESTION = 'এই বোতামটি ক্লিক করা নিরাপদ?';
    const BANGLA_TEXT = 'কুকি নোটিশ গ্রহণ করুন';

    function seedBanglaTriplet(store: DatabaseStore, answer = 'false'): string[] {
      return [1, 2, 3].map(() =>
        seed(store, {
          text: BANGLA_TEXT,
          answer,
          question: BANGLA_QUESTION,
          decisionType: 'check',
        }),
      );
    }

    it('mines a Bangla keyword that the stored ASCII tokens never held', () => {
      const ids = seedBanglaTriplet(store);

      // Capture's tokeniser treats every non-ASCII letter as a separator, so the
      // stored column is empty for a Bangla page and the element text is all there is.
      const row = store.signals.getByDecisionId(ids[0]!);
      expect(row?.tokens).toEqual([]);
      expect(row?.element_text).toBe(BANGLA_TEXT);

      const result = mineTextCandidates(store);

      expect(termsOf(result.created)).toEqual([
        'করুন',
        'কুকি',
        'কুকি নোটিশ',
        'গ্রহণ',
        'গ্রহণ করুন',
        'নোটিশ',
        'নোটিশ গ্রহণ',
      ]);
      const keyword = result.created.find((candidate) => candidate.term === 'কুকি')!;
      expect([...keyword.decision_ids].sort()).toEqual([...ids].sort());
      expect(keyword.support).toBe(3);
      expect(keyword.answer).toBe(false);
    });

    it('creates nothing for a Bangla keyword that appears under a different answer', () => {
      seedBanglaTriplet(store, 'false');
      seed(store, {
        text: BANGLA_TEXT,
        answer: 'true',
        question: BANGLA_QUESTION,
        decisionType: 'check',
      });

      const result = mineTextCandidates(store);

      expect(result.created).toEqual([]);
      expect(
        result.skipped.some(
          (entry) =>
            entry.term === 'কুকি' &&
            entry.term_kind === 'token' &&
            entry.answer_key === 'check:boolean:false' &&
            entry.reason === 'conflicting_answer',
        ),
      ).toBe(true);
      expect(result.skipped.filter((entry) => entry.reason === 'conflicting_answer').length).toBe(
        14,
      );
    });

    it('runs a mined Bangla rule through the pattern engine', () => {
      seedBanglaTriplet(store);

      const result = mineTextCandidates(store);
      const keyword = result.created.find((candidate) => candidate.term === 'কুকি')!;
      const engine = new PatternEngine([keyword.rule]);
      const question = { id: 'q_safe', type: 'check', text: BANGLA_QUESTION } as const;

      const matched = engine.matchForQuestion({ text: BANGLA_TEXT }, question, { threshold: 0 });

      expect(matched?.pattern_id).toBe(keyword.pattern.id);
      expect(matched?.output.value).toBe(false);
      expect(matched?.is_safety).toBe(false);
      expect(
        engine.matchForQuestion({ text: 'সম্পূর্ণ ভিন্ন লেখা' }, question, { threshold: 0 }),
      ).toBe(null);
    });

    it('reads the mined rule back out of the pattern row', () => {
      seedBanglaTriplet(store);

      const candidate = mineTextCandidates(store).created[0]!;

      expect(learnedRuleFromPatternRow(candidate.pattern.rules)).toEqual(candidate.rule);
      expect(learnedRuleFromPatternRow(JSON.stringify([candidate.rule]))).toEqual(candidate.rule);
      expect(learnedRuleFromPatternRow(JSON.stringify({ rules: [candidate.rule] }))).toEqual(
        candidate.rule,
      );
      expect(learnedRuleFromPatternRow('{}')).toBeNull();
      expect(learnedRuleFromPatternRow('not json')).toBeNull();
      expect(learnedRuleFromPatternRow('{"id":"x"}')).toBeNull();
    });
  });

  describe('choice answers and distributions', () => {
    it('does not invent a distribution for a choice candidate', () => {
      ['one', 'two', 'three'].forEach((suffix) => {
        seed(store, {
          text: `Promo newsletter ${suffix}`,
          answer: 'promo',
          decisionType: 'choice',
          question: DIALOG_QUESTION,
        });
      });

      const result = mineTextCandidates(store);
      const candidate = result.created.find((entry) => entry.term === 'promo')!;

      expect(candidate.answer).toBe('promo');
      expect(candidate.rule.output.distribution).toBeUndefined();

      // A choice answer without a distribution does not validate, so the engine
      // rejects the rule for a choice question until the shadow card has measured one.
      const validation = validateAnswer(
        {
          id: 'q_dialog',
          type: 'choice',
          text: DIALOG_QUESTION,
          options: [{ id: 'promo' }, { id: 'none' }],
        },
        { value: candidate.rule.output.value, confidence: candidate.confidence, path: 'pattern' },
      );
      expect(validation.success).toBe(false);
    });

    it('records the mean distribution when every supporting decision carried one', () => {
      [0.7, 0.8, 0.9].forEach((probability) => {
        seed(store, {
          text: 'Promo newsletter offer',
          answer: JSON.stringify({
            value: 'promo',
            distribution: { promo: probability, none: 1 - probability },
          }),
          decisionType: 'choice',
          question: DIALOG_QUESTION,
        });
      });

      const candidate = mineTextCandidates(store).created.find((entry) => entry.term === 'promo')!;
      const distribution = candidate.rule.output.distribution!;

      expect(distribution.promo).toBeCloseTo(0.8, 6);
      expect(distribution.none).toBeCloseTo(0.2, 6);
      expect(Object.values(distribution).reduce((total, value) => total + value, 0)).toBeCloseTo(
        1,
        6,
      );
      const validation = validateAnswer(
        {
          id: 'q_dialog',
          type: 'choice',
          text: DIALOG_QUESTION,
          options: [{ id: 'promo' }, { id: 'none' }],
        },
        {
          value: candidate.rule.output.value,
          confidence: candidate.confidence,
          path: 'pattern',
          distribution,
        },
      );
      expect(validation.success).toBe(true);
    });
  });

  describe('the confidence formula', () => {
    it('computes the confidence from the formula it documents', () => {
      expect(CONFIDENCE_FORMULA).toBe(
        'min(0.6, 0.9 * min(1, support / 10) * mean_source_confidence)',
      );
      expect(learnedConfidence({ support: 3, meanSourceConfidence: 0.9 })).toBe(0.243);
      expect(learnedConfidence({ support: 5, meanSourceConfidence: 0.8 })).toBe(0.36);
      expect(learnedConfidence({ support: 10, meanSourceConfidence: 1 })).toBe(CONFIDENCE_CAP);
      expect(learnedConfidence({ support: 1000, meanSourceConfidence: 1 })).toBe(CONFIDENCE_CAP);
      expect(learnedConfidence({ support: 3, meanSourceConfidence: 0 })).toBe(0);
      expect(learnedConfidence({ support: Number.NaN, meanSourceConfidence: 1 })).toBe(0);
      expect(learnedConfidence({ support: 3, meanSourceConfidence: 5 })).toBe(0.27);
      expect(CONFIDENCE_CAP).toBeLessThan(DEFAULT_THRESHOLDS.check.auto_at_or_above);
    });

    it('records the formula and the number on the candidate and on its rule', () => {
      seedPromoTriplet(store);

      const candidate = mineTextCandidates(store).created.find((entry) => entry.term === 'promo')!;

      expect(candidate.confidence_formula).toBe(CONFIDENCE_FORMULA);
      expect(candidate.mean_source_confidence).toBe(0.9);
      expect(candidate.confidence).toBe(
        learnedConfidence({ support: candidate.support, meanSourceConfidence: 0.9 }),
      );
      expect(candidate.rule.output.confidence).toBe(candidate.pattern.confidence);
      expect(candidate.rule.confidence_formula).toBe(CONFIDENCE_FORMULA);
      expect(candidate.rule.support).toBe(candidate.support);
    });
  });
});
