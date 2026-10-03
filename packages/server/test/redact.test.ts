import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  hashForMemoryLookup,
  redact,
  redactWithHash,
  redactionRules,
} from '../src/security/redact.js';
import {
  ALL_CASES,
  CLEAN_CASES,
  DIGIT_HEAVY_INPUT,
  HARD_CASES,
  LARGE_SNAPSHOT,
  SECRET_CASES,
  TYPICAL_SNAPSHOT,
} from './fixtures/redaction-cases.js';

/**
 * Strips everything that is not a letter or a digit, so a leak that only
 * changed the spacing, the punctuation or the case of the original is still a
 * leak and still fails.
 */
function normalised(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

interface Snapshot {
  url: string;
  elements: { role: string; text: string }[];
  form: Record<string, string>;
}

describe('redaction fixture set', () => {
  it('holds fifty secret bearing strings, and more awkward shapes besides', () => {
    expect(SECRET_CASES).toHaveLength(50);
    expect(HARD_CASES.length).toBeGreaterThan(0);
    expect(ALL_CASES.length).toBe(SECRET_CASES.length + HARD_CASES.length);
  });

  it('leaks no secret, in any spelling, and reports the rule that fired', () => {
    for (const testCase of ALL_CASES) {
      const result = redactWithHash(testCase.input);

      // A finding is a claim about this call. It must name the rule that
      // replaced something and count only what it replaced.
      expect(result.findings, `${testCase.label}: findings`).toEqual([
        { rule: testCase.rule, count: testCase.count },
      ]);

      // Something was masked, and the mask is one this module writes.
      expect(result.redacted, `${testCase.label}: a mask is present`).toMatch(
        /\[REDACTED:[A-Z_]+\]/,
      );

      for (const secret of testCase.secrets) {
        expect(result.redacted, `${testCase.label}: ${secret} is gone`).not.toContain(secret);
        if (secret.length >= 6) {
          expect(
            normalised(result.redacted),
            `${testCase.label}: ${secret} is gone in any spelling`,
          ).not.toContain(normalised(secret));
        }
      }

      if (testCase.digits === true) {
        expect(result.redacted, `${testCase.label}: no digit run survives`).not.toMatch(/\d{7,}/);
      }
      if (testCase.emailLike === true) {
        expect(result.redacted, `${testCase.label}: no address survives`).not.toMatch(
          /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/,
        );
      }
    }
  });

  it('changes nothing when run on its own output', () => {
    for (const testCase of ALL_CASES) {
      const once = redactWithHash(testCase.input);
      const twice = redactWithHash(once.redacted);
      expect(twice.redacted, `${testCase.label}: second pass is a no-op`).toBe(once.redacted);
      expect(twice.findings, `${testCase.label}: second pass finds nothing`).toEqual([]);
    }
  });
});

describe('redaction of ordinary text', () => {
  it('leaves page text alone when nothing looks like a secret', () => {
    for (const testCase of CLEAN_CASES) {
      const result = redactWithHash(testCase.input);
      expect(result.redacted, `${testCase.label}: unchanged`).toBe(testCase.input);
      expect(result.findings, `${testCase.label}: nothing fired`).toEqual([]);
    }
  });

  it('keeps the shape of a snapshot and masks only the values', () => {
    const result = redactWithHash(TYPICAL_SNAPSHOT);

    expect(result.redacted).toContain('"url": "https://shop.example.com/checkout/payment"');
    expect(result.redacted).toContain('"role": "button"');
    expect(result.redacted).toContain('"text": "Pay now"');
    expect(result.redacted).toContain('"name": "Password"');
    expect(result.redacted).toContain('"email": "[REDACTED:EMAIL]"');
    expect(result.redacted).toContain('"phone": "[REDACTED:PHONE]"');
    expect(result.redacted).toContain('"card_number": "[REDACTED:CARD]"');
    expect(result.redacted).toContain('"current-password": "[REDACTED:PASSWORD]"');
    expect(result.redacted).toContain('[REDACTED:SECRET]');
    expect(result.redacted).not.toContain('buyer@example.com');
    expect(result.redacted).not.toContain('+8801712345678');
    expect(result.redacted).not.toContain('4111 1111 1111 1111');
    expect(result.redacted).not.toContain('correct horse battery');
    expect(result.findings.map((finding) => finding.rule).sort()).toEqual([
      'card',
      'email',
      'high_entropy',
      'password',
      'phone',
    ]);
    // The same address appears twice in the snapshot and both are counted.
    expect(result.findings.find((finding) => finding.rule === 'email')?.count).toBe(2);

    // The masked snapshot is still the document it was: same keys, same roles,
    // same values everywhere except the ones that were masked.
    const parsed = JSON.parse(result.redacted) as Snapshot;
    const original = JSON.parse(TYPICAL_SNAPSHOT) as Snapshot;
    expect(Object.keys(parsed)).toEqual(Object.keys(original));
    expect(parsed.elements).toHaveLength(original.elements.length);
    expect(parsed.elements[4]).toEqual(original.elements[4]);
    expect(parsed.url).toBe(original.url);
    expect(parsed.form['current-password']).toBe('[REDACTED:PASSWORD]');
  });

  it('handles an empty string', () => {
    expect(redact('')).toBe('');
    expect(redactWithHash('').findings).toEqual([]);
  });
});

describe('the hash kept for memory lookup', () => {
  it('is taken from the original, not from the redacted text', () => {
    const original = 'Email buyer@example.com about order 4111111111111111';
    const redacted = redact(original);

    expect(redacted).not.toBe(original);
    expect(hashForMemoryLookup(original)).toBe(redactWithHash(original).originalHash);
    expect(hashForMemoryLookup(original)).not.toBe(hashForMemoryLookup(redacted));
  });

  it('is stable across calls and identical inputs', () => {
    expect(hashForMemoryLookup('same input')).toBe(hashForMemoryLookup('same input'));
    expect(hashForMemoryLookup('one input')).not.toBe(hashForMemoryLookup('other input'));
  });

  it('carries none of the secret it stands in for', () => {
    const secret = 'buyer@example.com';
    const hash = hashForMemoryLookup(`Email ${secret} now`);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(normalised(hash)).not.toContain(normalised(secret));
  });
});

describe('the rules the module claims', () => {
  it('are the eleven it applies, each once', () => {
    const rules = redactionRules();
    expect(rules).toHaveLength(11);
    expect(new Set(rules).size).toBe(rules.length);
    for (const rule of rules) {
      expect(redact(`nothing here matches ${rule}`)).toBe(`nothing here matches ${rule}`);
    }
  });
});

describe('redaction cost', () => {
  const CALLS = 400;

  function measure(input: string, calls: number): { mean: number; p95: number; slowest: number } {
    for (let i = 0; i < 100; i += 1) redact(input);
    const samples: number[] = [];
    const started = performance.now();
    for (let i = 0; i < calls; i += 1) {
      const callStart = performance.now();
      redact(input);
      samples.push(performance.now() - callStart);
    }
    const elapsed = performance.now() - started;
    samples.sort((a, b) => a - b);
    return {
      mean: elapsed / calls,
      p95: samples[Math.floor(calls * 0.95)] ?? 0,
      slowest: samples[calls - 1] ?? 0,
    };
  }

  it('adds under one millisecond per typical input', () => {
    const typical = measure(TYPICAL_SNAPSHOT, CALLS);
    const large = measure(LARGE_SNAPSHOT, CALLS);
    const digits = measure(DIGIT_HEAVY_INPUT, CALLS);
    const stress = measure(TYPICAL_SNAPSHOT.repeat(20), CALLS);

    console.log(
      `redaction cost per call, mean of ${CALLS} calls after 100 warm up calls: ` +
        `${TYPICAL_SNAPSHOT.length} char snapshot ${typical.mean.toFixed(4)} ms ` +
        `(p95 ${typical.p95.toFixed(4)}, slowest ${typical.slowest.toFixed(4)}); ` +
        `${LARGE_SNAPSHOT.length} char snapshot ${large.mean.toFixed(4)} ms ` +
        `(p95 ${large.p95.toFixed(4)}); ` +
        `${DIGIT_HEAVY_INPUT.length} char digit heavy input ${digits.mean.toFixed(4)} ms ` +
        `(p95 ${digits.p95.toFixed(4)}); ` +
        `${TYPICAL_SNAPSHOT.length * 20} char stress input ${stress.mean.toFixed(4)} ms ` +
        `(p95 ${stress.p95.toFixed(4)})`,
    );

    expect(typical.mean).toBeLessThan(1);
    expect(typical.p95).toBeLessThan(2);
    expect(large.mean).toBeLessThan(1);
    // The digit heavy input is not a page snapshot, so it is held to a looser
    // bound. It is here because it is the shape that catches a card or phone
    // pattern that backtracks: the same input costs about 0.4 ms with the
    // patterns in this module and over 30 ms with a pattern that backtracks.
    expect(digits.mean).toBeLessThan(5);
    expect(stress.mean).toBeLessThan(5);
    // Generous timeout: the bounds above are on the mean per call, not on how long a slow shared runner takes to repeat the calls.
  }, 30_000);
});
