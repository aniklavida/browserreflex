import { describe, expect, it } from 'vitest';
import {
  isSchemaViolation,
  MAX_CHOICE_OPTIONS,
  Question,
  QuestionSchema,
  SCHEMA_VIOLATION,
  validateAnswer,
  validateQuestion,
} from '../src/index.js';

describe('decision schema and validator', () => {
  describe('question schema', () => {
    it('accepts a valid choice question with options and descriptions', () => {
      const q = {
        id: 'q1',
        type: 'choice' as const,
        text: 'What type of popup is present?',
        options: [
          { id: 'cookie_banner', description: 'Consent banner' },
          { id: 'promo_modal', description: 'Promotional modal' },
          { id: 'none', description: 'No popup' },
        ],
      };
      const res = validateQuestion(q);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.id).toBe('q1');
        expect(res.data.type).toBe('choice');
        expect(res.data.options).toHaveLength(3);
      }
    });

    it('accepts a choice question with up to 20 options', () => {
      const options = Array.from({ length: MAX_CHOICE_OPTIONS }, (_, i) => ({
        id: `opt_${i + 1}`,
        description: `Option ${i + 1}`,
      }));
      const q = {
        id: 'q_max',
        type: 'choice' as const,
        text: 'Select one option',
        options,
      };
      const res = validateQuestion(q);
      expect(res.success).toBe(true);
    });

    it('rejects a choice question with more than 20 options', () => {
      const options = Array.from({ length: 21 }, (_, i) => ({
        id: `opt_${i + 1}`,
        description: `Option ${i + 1}`,
      }));
      const q = {
        id: 'q_over_max',
        type: 'choice' as const,
        text: 'Select one option',
        options,
      };
      const res = validateQuestion(q);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.type).toBe(SCHEMA_VIOLATION);
        expect(res.reason).toContain('20');
      }
    });

    it('rejects a choice question with 0 options', () => {
      const q = {
        id: 'q_empty_opts',
        type: 'choice' as const,
        text: 'Select one option',
        options: [],
      };
      const res = validateQuestion(q);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.type).toBe(SCHEMA_VIOLATION);
      }
    });

    it('rejects a choice question with duplicate option IDs', () => {
      const q = {
        id: 'q_dup_opts',
        type: 'choice' as const,
        text: 'Select one option',
        options: [
          { id: 'opt_1', description: 'First' },
          { id: 'opt_1', description: 'Duplicate' },
        ],
      };
      const res = validateQuestion(q);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.type).toBe(SCHEMA_VIOLATION);
        expect(res.reason).toContain('unique');
      }
    });

    it('accepts a valid score question with scale object', () => {
      const q = {
        id: 'q_score',
        type: 'score' as const,
        text: 'Rate the visual risk level',
        scale: { min: 1, max: 5, step: 1 },
      };
      const res = validateQuestion(q);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.type).toBe('score');
      }
    });

    it('accepts a valid score question with tuple scale', () => {
      const q = {
        id: 'q_score_tuple',
        type: 'score' as const,
        text: 'Risk percentile',
        scale: [0, 100],
      };
      const res = validateQuestion(q);
      expect(res.success).toBe(true);
      if (res.success && res.data.type === 'score') {
        expect(res.data.scale.min).toBe(0);
        expect(res.data.scale.max).toBe(100);
      }
    });

    it('rejects a score question where scale min >= max', () => {
      const q1 = {
        id: 'q_score_inv1',
        type: 'score' as const,
        text: 'Rate the visual risk level',
        scale: { min: 5, max: 1 },
      };
      const res1 = validateQuestion(q1);
      expect(res1.success).toBe(false);
      if (!res1.success) {
        expect(res1.type).toBe(SCHEMA_VIOLATION);
      }

      const q2 = {
        id: 'q_score_inv2',
        type: 'score' as const,
        text: 'Rate the visual risk level',
        scale: { min: 3, max: 3 },
      };
      const res2 = validateQuestion(q2);
      expect(res2.success).toBe(false);
    });

    it('accepts a valid check question', () => {
      const q = {
        id: 'q_check',
        type: 'check' as const,
        text: 'Is a login wall present?',
      };
      const res = validateQuestion(q);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.type).toBe('check');
      }
    });

    it('rejects questions with empty id or empty text', () => {
      const res1 = validateQuestion({ id: '', type: 'check', text: 'Text' });
      expect(res1.success).toBe(false);
      const res2 = validateQuestion({ id: 'id', type: 'check', text: '' });
      expect(res2.success).toBe(false);
    });

    it('rejects questions with invalid type', () => {
      const res = validateQuestion({
        id: 'id',
        type: 'unsupported_type',
        text: 'Text',
      });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.type).toBe(SCHEMA_VIOLATION);
      }
    });
  });

  describe('choice answer validation', () => {
    const choiceQuestion: Question = {
      id: 'popup_type',
      type: 'choice',
      text: 'What popup is visible?',
      options: [
        { id: 'cookie_banner', description: 'Consent' },
        { id: 'newsletter', description: 'Email form' },
        { id: 'none', description: 'Nothing' },
      ],
    };

    it('accepts valid choice answer with distribution summing to exactly 1.0', () => {
      const ans = {
        value: 'cookie_banner',
        distribution: {
          cookie_banner: 0.85,
          newsletter: 0.1,
          none: 0.05,
        },
        confidence: 0.85,
        path: 'pattern' as const,
      };
      const res = validateAnswer(choiceQuestion, ans);
      expect(res.success).toBe(true);
      expect(res.valid).toBe(true);
    });

    it('accepts choice answer when distribution sums to 0.99 (lower tolerance limit)', () => {
      const ans = {
        value: 'cookie_banner',
        distribution: {
          cookie_banner: 0.84,
          newsletter: 0.1,
          none: 0.05,
        },
        confidence: 0.84,
        path: 'ai' as const,
      };
      const res = validateAnswer(choiceQuestion, ans);
      expect(res.success).toBe(true);
    });

    it('accepts choice answer when distribution sums to 1.01 (upper tolerance limit)', () => {
      const ans = {
        value: 'cookie_banner',
        distribution: {
          cookie_banner: 0.86,
          newsletter: 0.1,
          none: 0.05,
        },
        confidence: 0.86,
        path: 'ai' as const,
      };
      const res = validateAnswer(choiceQuestion, ans);
      expect(res.success).toBe(true);
    });

    it('accepts choice answers across all 5 decision paths', () => {
      const paths = ['memory', 'pattern', 'check', 'ai', 'human'] as const;
      for (const path of paths) {
        const ans = {
          value: 'none',
          distribution: { cookie_banner: 0.0, newsletter: 0.0, none: 1.0 },
          confidence: 1.0,
          path,
        };
        const res = validateAnswer(choiceQuestion, ans);
        expect(res.success).toBe(true);
      }
    });

    it('rejects choice answer if value is not among options', () => {
      const ans = {
        value: 'unknown_popup',
        distribution: { cookie_banner: 0.9, newsletter: 0.05, none: 0.05 },
        confidence: 0.9,
        path: 'ai' as const,
      };
      const res = validateAnswer(choiceQuestion, ans);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.type).toBe(SCHEMA_VIOLATION);
        expect(res.reason).toContain('unknown_popup');
      }
    });

    it('rejects choice answer if distribution is missing an option key', () => {
      const ans = {
        value: 'cookie_banner',
        distribution: {
          cookie_banner: 0.9,
          newsletter: 0.1,
        },
        confidence: 0.9,
        path: 'ai' as const,
      };
      const res = validateAnswer(choiceQuestion, ans);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.type).toBe(SCHEMA_VIOLATION);
        expect(res.reason).toContain('missing keys');
        expect(res.reason).toContain('none');
      }
    });

    it('rejects choice answer if distribution contains extra unknown keys', () => {
      const ans = {
        value: 'cookie_banner',
        distribution: {
          cookie_banner: 0.8,
          newsletter: 0.1,
          none: 0.1,
          extra_key: 0.0,
        },
        confidence: 0.8,
        path: 'ai' as const,
      };
      const res = validateAnswer(choiceQuestion, ans);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.type).toBe(SCHEMA_VIOLATION);
        expect(res.reason).toContain('unknown keys');
        expect(res.reason).toContain('extra_key');
      }
    });

    it('rejects choice answer if distribution sum is less than 0.99', () => {
      const ans = {
        value: 'cookie_banner',
        distribution: {
          cookie_banner: 0.7,
          newsletter: 0.1,
          none: 0.1,
        },
        confidence: 0.7,
        path: 'ai' as const,
      };
      const res = validateAnswer(choiceQuestion, ans);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.type).toBe(SCHEMA_VIOLATION);
        expect(res.reason).toContain('sum to 1 ± 0.01');
      }
    });

    it('rejects choice answer if distribution sum is greater than 1.01', () => {
      const ans = {
        value: 'cookie_banner',
        distribution: {
          cookie_banner: 0.9,
          newsletter: 0.1,
          none: 0.05,
        },
        confidence: 0.9,
        path: 'ai' as const,
      };
      const res = validateAnswer(choiceQuestion, ans);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.type).toBe(SCHEMA_VIOLATION);
        expect(res.reason).toContain('sum to 1 ± 0.01');
      }
    });

    it('rejects choice answer if distribution has negative probability', () => {
      const ans = {
        value: 'cookie_banner',
        distribution: {
          cookie_banner: 1.1,
          newsletter: -0.1,
          none: 0.0,
        },
        confidence: 1.0,
        path: 'ai' as const,
      };
      const res = validateAnswer(choiceQuestion, ans);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.type).toBe(SCHEMA_VIOLATION);
        expect(res.reason).toContain('between 0 and 1');
      }
    });

    it('rejects choice answer if distribution probability exceeds 1', () => {
      const ans = {
        value: 'cookie_banner',
        distribution: {
          cookie_banner: 1.5,
          newsletter: 0.0,
          none: 0.0,
        },
        confidence: 1.0,
        path: 'ai' as const,
      };
      const res = validateAnswer(choiceQuestion, ans);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.type).toBe(SCHEMA_VIOLATION);
      }
    });

    it('rejects choice answer when distribution is missing by default', () => {
      const ans = {
        value: 'cookie_banner',
        confidence: 0.9,
        path: 'ai' as const,
      };
      const res = validateAnswer(choiceQuestion, ans);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.type).toBe(SCHEMA_VIOLATION);
        expect(res.reason).toContain('distribution');
      }
    });
  });

  describe('score answer validation', () => {
    const scoreQuestion: Question = {
      id: 'risk_score',
      type: 'score',
      text: 'Visual risk rating 1-5',
      scale: { min: 1, max: 5, step: 1 },
    };

    it('accepts score answer within scale range at min bound', () => {
      const ans = {
        value: 1,
        confidence: 0.95,
        path: 'pattern' as const,
      };
      const res = validateAnswer(scoreQuestion, ans);
      expect(res.success).toBe(true);
    });

    it('accepts score answer within scale range at max bound', () => {
      const ans = {
        value: 5,
        confidence: 0.95,
        path: 'human' as const,
      };
      const res = validateAnswer(scoreQuestion, ans);
      expect(res.success).toBe(true);
    });

    it('accepts score answer inside scale range', () => {
      const ans = {
        value: 3,
        confidence: 0.8,
        path: 'ai' as const,
      };
      const res = validateAnswer(scoreQuestion, ans);
      expect(res.success).toBe(true);
    });

    it('accepts continuous score answer on scale without step', () => {
      const continuousQuestion: Question = {
        id: 'cont_score',
        type: 'score',
        text: 'Risk 0 to 10',
        scale: { min: 0, max: 10 },
      };
      const ans = {
        value: 4.75,
        confidence: 0.9,
        path: 'ai' as const,
      };
      const res = validateAnswer(continuousQuestion, ans);
      expect(res.success).toBe(true);
    });

    it('rejects score answer below scale min', () => {
      const ans = {
        value: 0.5,
        confidence: 0.9,
        path: 'ai' as const,
      };
      const res = validateAnswer(scoreQuestion, ans);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.type).toBe(SCHEMA_VIOLATION);
        expect(res.reason).toContain('outside scale range');
      }
    });

    it('rejects score answer above scale max', () => {
      const ans = {
        value: 6,
        confidence: 0.9,
        path: 'ai' as const,
      };
      const res = validateAnswer(scoreQuestion, ans);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.type).toBe(SCHEMA_VIOLATION);
        expect(res.reason).toContain('outside scale range');
      }
    });

    it('rejects score answer with non-numeric value', () => {
      const ans = {
        value: 'high',
        confidence: 0.9,
        path: 'ai' as const,
      };
      const res = validateAnswer(scoreQuestion, ans);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.type).toBe(SCHEMA_VIOLATION);
        expect(res.reason).toContain('number');
      }
    });

    it('rejects score answer with NaN value', () => {
      const ans = {
        value: Number.NaN,
        confidence: 0.9,
        path: 'ai' as const,
      };
      const res = validateAnswer(scoreQuestion, ans);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.type).toBe(SCHEMA_VIOLATION);
      }
    });

    it('rejects score answer that violates declared step', () => {
      const ans = {
        value: 2.5,
        confidence: 0.9,
        path: 'ai' as const,
      };
      const res = validateAnswer(scoreQuestion, ans);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.type).toBe(SCHEMA_VIOLATION);
        expect(res.reason).toContain('step');
      }
    });
  });

  describe('check answer validation', () => {
    const checkQuestion: Question = {
      id: 'login_wall',
      type: 'check',
      text: 'Is there a login wall?',
    };

    it('accepts valid check answer with boolean true', () => {
      const ans = {
        value: true,
        confidence: 0.98,
        path: 'check' as const,
      };
      const res = validateAnswer(checkQuestion, ans);
      expect(res.success).toBe(true);
    });

    it('accepts valid check answer with boolean false', () => {
      const ans = {
        value: false,
        confidence: 0.9,
        path: 'memory' as const,
      };
      const res = validateAnswer(checkQuestion, ans);
      expect(res.success).toBe(true);
    });

    it('accepts valid check answer with probability 0 boundary', () => {
      const ans = {
        value: false,
        confidence: 0.0,
        path: 'check' as const,
      };
      const res = validateAnswer(checkQuestion, ans);
      expect(res.success).toBe(true);
    });

    it('accepts valid check answer with probability 1 boundary', () => {
      const ans = {
        value: true,
        confidence: 1.0,
        path: 'pattern' as const,
      };
      const res = validateAnswer(checkQuestion, ans);
      expect(res.success).toBe(true);
    });

    it('accepts check answer with valid distribution summing to 1.0', () => {
      const ans = {
        value: true,
        distribution: { yes: 0.95, no: 0.05 },
        confidence: 0.95,
        path: 'ai' as const,
      };
      const res = validateAnswer(checkQuestion, ans);
      expect(res.success).toBe(true);
    });

    it('rejects check answer with negative confidence', () => {
      const ans = {
        value: true,
        confidence: -0.1,
        path: 'ai' as const,
      };
      const res = validateAnswer(checkQuestion, ans);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.type).toBe(SCHEMA_VIOLATION);
        expect(res.reason).toContain('between 0 and 1');
      }
    });

    it('rejects check answer with confidence greater than 1', () => {
      const ans = {
        value: true,
        confidence: 1.05,
        path: 'ai' as const,
      };
      const res = validateAnswer(checkQuestion, ans);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.type).toBe(SCHEMA_VIOLATION);
        expect(res.reason).toContain('between 0 and 1');
      }
    });

    it('rejects check answer with invalid value type', () => {
      const ans = {
        value: { foo: 'bar' },
        confidence: 0.8,
        path: 'ai' as const,
      };
      const res = validateAnswer(checkQuestion, ans);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.type).toBe(SCHEMA_VIOLATION);
        expect(res.reason).toContain('boolean');
      }
    });

    it('rejects check answer with probability field outside 0-1', () => {
      const ans = {
        value: true,
        probability: 1.5,
        confidence: 0.9,
        path: 'ai' as const,
      };
      const res = validateAnswer(checkQuestion, ans);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.type).toBe(SCHEMA_VIOLATION);
        expect(res.reason).toContain('between 0 and 1');
      }
    });
  });

  describe('schema violation contract and never throws raw invariant', () => {
    const q: Question = {
      id: 'q_test',
      type: 'check',
      text: 'Test check',
    };

    it('returns schema_violation for null answer without throwing raw error', () => {
      expect(() => {
        const res = validateAnswer(q, null);
        expect(res.success).toBe(false);
        if (!res.success) {
          expect(res.type).toBe(SCHEMA_VIOLATION);
          expect(isSchemaViolation(res)).toBe(true);
          expect(typeof res.reason).toBe('string');
          expect(res.reason.length).toBeGreaterThan(0);
        }
      }).not.toThrow();
    });

    it('returns schema_violation for undefined answer without throwing raw error', () => {
      expect(() => {
        const res = validateAnswer(q, undefined);
        expect(res.success).toBe(false);
        if (!res.success) {
          expect(res.type).toBe(SCHEMA_VIOLATION);
        }
      }).not.toThrow();
    });

    it('returns schema_violation for string primitive answer without throwing raw error', () => {
      expect(() => {
        const res = validateAnswer(q, 'not an answer object');
        expect(res.success).toBe(false);
        if (!res.success) {
          expect(res.type).toBe(SCHEMA_VIOLATION);
        }
      }).not.toThrow();
    });

    it('returns schema_violation for empty answer object without throwing raw error', () => {
      expect(() => {
        const res = validateAnswer(q, {});
        expect(res.success).toBe(false);
        if (!res.success) {
          expect(res.type).toBe(SCHEMA_VIOLATION);
        }
      }).not.toThrow();
    });

    it('returns schema_violation for invalid question without throwing raw error', () => {
      const validAns = {
        value: true,
        confidence: 0.9,
        path: 'check' as const,
      };
      expect(() => {
        const res = validateAnswer(null, validAns);
        expect(res.success).toBe(false);
        if (!res.success) {
          expect(res.type).toBe(SCHEMA_VIOLATION);
        }
      }).not.toThrow();
    });

    it('returns schema_violation for invalid decision path', () => {
      const ans = {
        value: true,
        confidence: 0.9,
        path: 'non_existent_path',
      };
      const res = validateAnswer(q, ans);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.type).toBe(SCHEMA_VIOLATION);
        expect(res.reason).toContain('Invalid decision path');
      }
    });

    it('supports calling validateAnswer with reversed arguments (answer, question)', () => {
      const ans = {
        value: true,
        confidence: 0.9,
        path: 'check' as const,
      };
      const res = validateAnswer(ans, q);
      expect(res.success).toBe(true);
    });

    it('handles object with throwing getter gracefully and returns schema_violation', () => {
      const toxicAnswer = {
        get confidence(): number {
          throw new Error('Exploding getter');
        },
        value: true,
        path: 'check',
      };
      expect(() => {
        const res = validateAnswer(q, toxicAnswer);
        expect(res.success).toBe(false);
        if (!res.success) {
          expect(res.type).toBe(SCHEMA_VIOLATION);
          expect(res.reason).toContain('Exploding getter');
        }
      }).not.toThrow();
    });

    it('verifies QuestionSchema parses valid question directly', () => {
      const parsed = QuestionSchema.parse({
        id: 'q_direct',
        type: 'check',
        text: 'Direct check',
      });
      expect(parsed.id).toBe('q_direct');
    });
  });
});
