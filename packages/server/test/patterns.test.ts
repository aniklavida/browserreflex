import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  type DatabaseStore,
  type Question,
  type Rule,
  createMemory,
  createPatternEngine,
  createStore,
  routeBatch,
  routeQuestion,
  setDefaultPatternEngine,
} from '../src/index.js';
import {
  computeSpecificity,
  DEFAULT_MAX_REGEX_INPUT_LENGTH,
  globToRegex,
  matchExitCode,
  matchFilePathGlob,
  matchLogRegex,
  matchRole,
  matchTextAny,
  matchTextRegex,
  matchUrlDomain,
  matchUrlPath,
  normalizeSnapshot,
} from '../src/patterns/index.js';

describe('pattern engine core', () => {
  let tempDir: string;
  let dbPath: string;
  let store: DatabaseStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-patterns-'));
    dbPath = join(tempDir, 'test.db');
    store = createStore(dbPath);
    setDefaultPatternEngine(null);
  });

  afterEach(() => {
    setDefaultPatternEngine(null);
    if (store) {
      store.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('unit matchers', () => {
    it('matches text_any case-insensitively with single or multiple terms', () => {
      expect(matchTextAny(['accept cookies', 'agree'], 'Please Accept Cookies to continue')).toBe(
        true,
      );
      expect(matchTextAny(['agree'], 'Please Accept Cookies to continue')).toBe(false);
      expect(matchTextAny([], 'Some text')).toBe(false);
      expect(matchTextAny(['accept'], null)).toBe(false);
    });

    it('matches text_regex safely and case-insensitively', () => {
      const re = /cookie|consent/i;
      expect(matchTextRegex(re, 'Manage your cookie preferences')).toBe(true);
      expect(matchTextRegex(re, 'Payment checkout form')).toBe(false);
      expect(matchTextRegex(re, null)).toBe(false);
    });

    it('matches role case-insensitively', () => {
      expect(matchRole(['button', 'link'], 'Button')).toBe(true);
      expect(matchRole(['button'], 'dialog')).toBe(false);
      expect(matchRole(['button'], null)).toBe(false);
    });

    it('matches url_domain for exact, subdomain and wildcard patterns', () => {
      expect(matchUrlDomain(['example.com'], 'example.com', null)).toBe(true);
      expect(matchUrlDomain(['example.com'], 'sub.example.com', null)).toBe(true);
      expect(matchUrlDomain(['*.example.com'], 'checkout.example.com', null)).toBe(true);
      expect(matchUrlDomain(['other.org'], 'example.com', null)).toBe(false);
      expect(matchUrlDomain(['api.service.io'], null, 'https://api.service.io/v1/auth')).toBe(true);
    });

    it('matches url_path with exact path, prefix, wildcard glob and RegExp', () => {
      expect(matchUrlPath(['/checkout'], 'https://shop.example/checkout')).toBe(true);
      expect(matchUrlPath(['/checkout/*'], 'https://shop.example/checkout/step2')).toBe(true);
      expect(matchUrlPath(['/auth/'], 'https://auth.example/auth/login')).toBe(true);
      expect(matchUrlPath([/^\/admin/], 'https://site.example/admin/dashboard')).toBe(true);
      expect(matchUrlPath(['/checkout'], 'https://shop.example/cart')).toBe(false);
    });

    it('matches file_path_glob against snapshot file paths', () => {
      const globs = [globToRegex('*.ts'), globToRegex('src/**/*.js')];
      expect(matchFilePathGlob(globs, ['packages/server/src/index.ts'])).toBe(true);
      expect(matchFilePathGlob(globs, ['src/core/router.js'])).toBe(true);
      expect(matchFilePathGlob(globs, ['README.md', 'docs/SPEC.md'])).toBe(false);
      expect(matchFilePathGlob(globs, [])).toBe(false);
    });

    it('matches exit_code for numeric equality or inclusion', () => {
      expect(matchExitCode([0], 0)).toBe(true);
      expect(matchExitCode([1, 2, 127], 127)).toBe(true);
      expect(matchExitCode([0], 1)).toBe(false);
      expect(matchExitCode([0], null)).toBe(false);
    });

    it('matches log_regex on log excerpts', () => {
      const re = /connection refused|ETIMEDOUT/i;
      expect(matchLogRegex(re, 'Error: connect ETIMEDOUT 127.0.0.1:8080')).toBe(true);
      expect(matchLogRegex(re, 'Server listening on port 3000')).toBe(false);
      expect(matchLogRegex(re, null)).toBe(false);
    });
  });

  describe('conjunction and snapshot normalization', () => {
    it('requires all listed matchers to succeed for a rule to match', () => {
      const rule: Rule = {
        id: 'compound-checkout-btn',
        safety: true,
        matchers: {
          url_domain: 'shop.example',
          url_path: '/checkout/*',
          role: 'button',
          text_any: ['Place order', 'Pay now'],
        },
        output: {
          decision_type: 'check',
          value: true,
          confidence: 0.99,
        },
      };

      const engine = createPatternEngine([rule]);

      // All match
      expect(
        engine.match({
          url: 'https://shop.example/checkout/payment',
          elements: [{ role: 'button', text: 'Pay now with card' }],
        }),
      ).not.toBeNull();

      // Wrong domain
      expect(
        engine.match({
          url: 'https://other.example/checkout/payment',
          elements: [{ role: 'button', text: 'Pay now with card' }],
        }),
      ).toBeNull();

      // Wrong path
      expect(
        engine.match({
          url: 'https://shop.example/cart',
          elements: [{ role: 'button', text: 'Pay now with card' }],
        }),
      ).toBeNull();

      // Wrong role (e.g. heading instead of button)
      expect(
        engine.match({
          url: 'https://shop.example/checkout/payment',
          elements: [{ role: 'heading', text: 'Pay now with card' }],
        }),
      ).toBeNull();

      // Wrong text
      expect(
        engine.match({
          url: 'https://shop.example/checkout/payment',
          elements: [{ role: 'button', text: 'Cancel' }],
        }),
      ).toBeNull();
    });

    it('normalizes snapshot from raw objects, state wrappers or direct properties', () => {
      const fromWrapped = normalizeSnapshot({
        state: {
          url: 'https://example.com/test',
          elements: [{ role: 'dialog', text: 'Modal' }],
          exitCode: 0,
          logExcerpt: 'all tests passed',
          filePaths: ['test.ts'],
        },
      });

      expect(fromWrapped.url).toBe('https://example.com/test');
      expect(fromWrapped.domain).toBe('example.com');
      expect(fromWrapped.elements).toHaveLength(1);
      expect(fromWrapped.exit_code).toBe(0);
      expect(fromWrapped.log).toBe('all tests passed');
      expect(fromWrapped.file_paths).toEqual(['test.ts']);
    });
  });

  describe('catastrophic backtracking safety', () => {
    it('safely executes pathological regex on long input without catastrophic backtracking', () => {
      // Pathological backtracking pattern: a*a*b on a long input of 50,000 characters
      // Without input bounding, this pattern causes exponential/polynomial backtracking that stalls for minutes.
      const pathologicalRule: Rule = {
        id: 'backtrack-guard-test',
        matchers: {
          log_regex: 'a*a*b',
        },
        output: {
          decision_type: 'check',
          value: false,
          confidence: 0.9,
        },
      };

      const engine = createPatternEngine({
        rules: [pathologicalRule],
        maxRegexInputLength: DEFAULT_MAX_REGEX_INPUT_LENGTH,
      });

      const longInput = 'a'.repeat(50_000) + 'c';

      const t0 = performance.now();
      const result = engine.match({
        log: longInput,
      });
      const elapsed = performance.now() - t0;

      expect(result).toBeNull();
      // Must finish quickly (under 150ms) due to bounded input length (instead of minutes)
      expect(elapsed).toBeLessThan(150);
    });
  });

  describe('specificity scoring and precedence', () => {
    it('computes higher specificity for compound rules with multiple constraints', () => {
      const single = computeSpecificity({ text_any: 'Buy' });
      const compound = computeSpecificity({
        url_domain: 'example.com',
        url_path: '/checkout',
        role: 'button',
        text_any: 'Buy',
      });

      expect(compound).toBeGreaterThan(single);
    });

    it('safety rules always win over non-safety rules', () => {
      // Rule A: non-safety with high specificity (multiple matchers)
      const nonSafetyRule: Rule = {
        id: 'rule-nonsafety-specific',
        safety: false,
        matchers: {
          url_domain: 'example.com',
          url_path: '/checkout',
          role: 'button',
          text_any: ['Buy now', 'Order'],
        },
        output: {
          decision_type: 'check',
          value: false,
          confidence: 0.85,
        },
      };

      // Rule B: safety rule with lower specificity (single matcher)
      const safetyRule: Rule = {
        id: 'rule-safety-broad',
        safety: true,
        matchers: {
          role: 'button',
        },
        output: {
          decision_type: 'check',
          value: true,
          confidence: 1.0,
        },
      };

      const engine = createPatternEngine([nonSafetyRule, safetyRule]);

      const match = engine.match({
        url: 'https://example.com/checkout',
        elements: [{ role: 'button', text: 'Buy now' }],
      });

      expect(match).not.toBeNull();
      // Safety rule MUST win despite having fewer matchers and lower specificity
      expect(match!.pattern_id).toBe('rule-safety-broad');
      expect(match!.is_safety).toBe(true);
      expect(match!.output.value).toBe(true);
    });

    it('prefers more specific rule when safety status is equal', () => {
      const broadRule: Rule = {
        id: 'rule-broad',
        safety: false,
        matchers: {
          role: 'button',
        },
        output: {
          decision_type: 'choice',
          value: 'broad',
          confidence: 0.8,
        },
      };

      const specificRule: Rule = {
        id: 'rule-specific',
        safety: false,
        matchers: {
          url_domain: 'example.com',
          role: 'button',
          text_any: 'Click me',
        },
        output: {
          decision_type: 'choice',
          value: 'specific',
          confidence: 0.95,
        },
      };

      const engine = createPatternEngine([broadRule, specificRule]);

      const match = engine.match({
        url: 'https://example.com/page',
        elements: [{ role: 'button', text: 'Click me please' }],
      });

      expect(match).not.toBeNull();
      expect(match!.pattern_id).toBe('rule-specific');
      expect(match!.output.value).toBe('specific');
    });

    it('breaks ties deterministically by rule id when safety and specificity are identical', () => {
      const ruleB: Rule = {
        id: 'rule-zebra',
        matchers: { role: 'button' },
        output: { decision_type: 'check', value: false, confidence: 0.8 },
      };

      const ruleA: Rule = {
        id: 'rule-alpha',
        matchers: { role: 'button' },
        output: { decision_type: 'check', value: true, confidence: 0.8 },
      };

      const engine = createPatternEngine([ruleB, ruleA]);

      const match = engine.match({
        elements: [{ role: 'button', text: 'Test' }],
      });

      expect(match).not.toBeNull();
      expect(match!.pattern_id).toBe('rule-alpha');
    });
  });

  describe('router integration', () => {
    it('a pattern hit is logged with path pattern', () => {
      const cookieRule: Rule = {
        id: 'pattern-cookie-consent',
        safety: false,
        matchers: {
          role: 'button',
          text_any: ['Accept all cookies', 'Agree'],
        },
        output: {
          decision_type: 'check',
          value: true,
          confidence: 0.95,
        },
      };

      const engine = createPatternEngine([cookieRule]);
      const memory = createMemory(store);

      const question: Question = {
        id: 'q-cookie-check',
        type: 'check',
        text: 'Is there a cookie banner on this page?',
      };

      const inputSnapshot = {
        url: 'https://example.com/welcome',
        elements: [
          { role: 'heading', text: 'Welcome to our site' },
          { role: 'button', text: 'Accept all cookies' },
        ],
      };

      const result = routeQuestion({
        question,
        input: inputSnapshot,
        threshold: 0.8,
        memory,
        store,
        patternEngine: engine,
      });

      expect(result.status).toBe('answered');
      if (result.status === 'answered') {
        expect(result.path).toBe('pattern');
        expect(result.answer.path).toBe('pattern');
        expect(result.answer.pattern_id).toBe('pattern-cookie-consent');
        expect(result.answer.value).toBe(true);
        expect(result.answer.confidence).toBe(0.95);
        expect(result.decision.path).toBe('pattern');
        expect(result.decision.pattern_id).toBe('pattern-cookie-consent');

        // Confirm database record was persisted with path pattern
        const inDb = store.decisions.getById(result.decision.id);
        expect(inDb).not.toBeNull();
        expect(inDb!.path).toBe('pattern');
        expect(inDb!.pattern_id).toBe('pattern-cookie-consent');
        expect(inDb!.confidence).toBe(0.95);
      }
    });

    it('gives memory fast-path precedence over patterns for previously confirmed decisions', () => {
      const rule: Rule = {
        id: 'pattern-rule-01',
        matchers: { role: 'button' },
        output: { decision_type: 'check', value: true, confidence: 0.85 },
      };

      const engine = createPatternEngine([rule]);
      const memory = createMemory(store);

      const question: Question = {
        id: 'q1',
        type: 'check',
        text: 'Is this button safe?',
      };

      const input = { role: 'button', text: 'Click' };

      // Save a previous memory answer with high confidence
      memory.save({
        question,
        input,
        answer: { value: false },
        confidence: 0.99,
        path: 'memory',
      });

      const result = routeQuestion({
        question,
        input,
        threshold: 0.8,
        memory,
        store,
        patternEngine: engine,
      });

      expect(result.status).toBe('answered');
      if (result.status === 'answered') {
        // Memory hit occurs first
        expect(result.path).toBe('memory');
        expect(result.answer.value).toBe(false);
      }
    });

    it('falls through to needs_ai when no memory and no pattern matches', () => {
      const engine = createPatternEngine([]);
      const memory = createMemory(store);

      const question: Question = {
        id: 'q-unknown',
        type: 'check',
        text: 'Is there a login wall?',
      };

      const result = routeQuestion({
        question,
        input: { url: 'https://example.com' },
        threshold: 0.8,
        memory,
        store,
        patternEngine: engine,
      });

      expect(result.status).toBe('needs_ai');
      if (result.status === 'needs_ai') {
        expect(result.decision.path).toBe('ai');
      }
    });

    it('routes batches correctly with routeBatch and patternEngine', () => {
      const rule: Rule = {
        id: 'pattern-popup-check',
        matchers: { role: 'dialog' },
        output: { decision_type: 'check', value: true, confidence: 0.9 },
      };

      const engine = createPatternEngine([rule]);
      const memory = createMemory(store);

      const batchResult = routeBatch({
        questions: [
          { id: 'q1', type: 'check', text: 'Is a popup visible?' },
          { id: 'q2', type: 'choice', text: 'Which item is selected?', options: ['a', 'b'] },
        ],
        input: {
          elements: [{ role: 'dialog', text: 'Terms update' }],
        },
        threshold: 0.8,
        memory,
        store,
        patternEngine: engine,
      });

      // q1 matches pattern rule
      expect(batchResult.answers).toHaveLength(1);
      expect(batchResult.answers[0].id).toBe('q1');
      expect(batchResult.answers[0].path).toBe('pattern');
      expect(batchResult.answers[0].pattern_id).toBe('pattern-popup-check');

      // q2 falls through to needs_ai
      expect(batchResult.needs_ai).toHaveLength(1);
      expect(batchResult.needs_ai[0].id).toBe('q2');
    });
  });

  describe('performance bound: 1,000 rules in under 5ms', () => {
    it('matches typical input across 1,000 rules in under 5ms', () => {
      // Build 1,000 distinct typed rules
      const rules: Rule[] = [];
      for (let i = 0; i < 1000; i++) {
        rules.push({
          id: `rule-${i.toString().padStart(4, '0')}`,
          safety: i === 999, // 1 safety rule placed at the end
          matchers: {
            url_domain: i % 5 === 0 ? 'example.com' : `tenant-${i}.org`,
            role: i % 2 === 0 ? 'button' : 'link',
            text_any: [`action-${i}`, `label-${i}`, 'Accept cookies'],
          },
          output: {
            decision_type: 'check',
            value: true,
            confidence: 0.8 + (i % 20) * 0.01,
          },
        });
      }

      const engine = createPatternEngine(rules);
      expect(engine.size).toBe(1000);

      const typicalSnapshot = {
        url: 'https://example.com/checkout/step2',
        elements: [
          { role: 'heading', text: 'Billing address' },
          { role: 'input', text: '' },
          { role: 'button', text: 'Accept cookies and continue' },
          { role: 'link', text: 'Privacy policy' },
        ],
      };

      // Warmup JIT
      for (let w = 0; w < 10; w++) {
        engine.match(typicalSnapshot);
      }

      // Measure mean cost per call over 40 calls per TIMING TESTS rule
      const iterations = 40;
      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        const match = engine.match(typicalSnapshot);
        expect(match).not.toBeNull();
      }
      const totalElapsed = performance.now() - start;
      const meanCostMs = totalElapsed / iterations;

      console.log(
        `1,000 rules match performance: mean of ${iterations} calls: ${meanCostMs.toFixed(4)} ms per call`,
      );

      // Done when: 1,000 rules match a typical input in under 5ms
      expect(meanCostMs).toBeLessThan(5);
      // Expect comfortable margin on modern hardware (typically under 1ms)
      expect(meanCostMs).toBeLessThan(2);
    }, 30_000); // Explicit generous test timeout per TIMING TESTS rule
  });
});
