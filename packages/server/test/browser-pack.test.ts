/**
 * Browser pack v1: the seven browser checks measured on synthetic snapshots.
 *
 * Status: **implemented and tested** for the pack files, the fixtures and the loader
 * path exercised here. The `page_check` tool serves these rules and asks the same canonical
 * questions written out below; `action_guard`, the tool that answers one action, is not
 * part of this card.
 *
 * The safety flag is advisory: a safety rule here tells the caller to ask the user, and
 * nothing in this pack prevents an agent from acting.
 *
 * Every fixture file states that it is a synthetic example written to resemble a real
 * accessibility tree. None of them is a capture of a real site, and the test fails if
 * that statement is removed from a file.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  createPatternEngine,
  loadPacksFromDirectory,
  type PatternEngine,
  type PatternMatchResult,
  type Rule,
} from '../src/patterns/index.js';
import type { Question } from '../src/core/schema.js';

const PACKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../packs/browser');
const FIXTURES_DIR = join(PACKS_DIR, 'fixtures');
const THRESHOLD = 0.8;

const POPUP_OPTIONS = ['none', 'cookie_banner', 'promo'];
const RISKY_OPTIONS = ['allow', 'ask_user', 'block'];

interface CheckSpec {
  /** Canonical question id the rules of this check answer. */
  readonly question: Question;
  /** Prefix every rule id of this check starts with. */
  readonly rulePrefix: string;
  /** True when every rule of this check is a safety rule. */
  readonly risky: boolean;
  /** Pack file that carries the rules of this check. */
  readonly packId: string;
}

const CHECKS: Record<string, CheckSpec> = {
  cookie_banner: {
    question: {
      id: 'browser.check.popup_kind',
      type: 'choice',
      text: 'What kind of popup is on this page, if any?',
      options: POPUP_OPTIONS.map((id) => ({ id })),
    },
    rulePrefix: 'browser.popup.cookie.',
    risky: false,
    packId: 'browser-cookie-banner',
  },
  newsletter_popup: {
    question: {
      id: 'browser.check.popup_kind',
      type: 'choice',
      text: 'What kind of popup is on this page, if any?',
      options: POPUP_OPTIONS.map((id) => ({ id })),
    },
    rulePrefix: 'browser.popup.promo.',
    risky: false,
    packId: 'browser-newsletter-popup',
  },
  login_wall: {
    question: {
      id: 'browser.check.login_wall',
      type: 'check',
      text: 'Is a login wall in the way?',
    },
    rulePrefix: 'browser.login_wall.',
    risky: false,
    packId: 'browser-login-wall',
  },
  captcha: {
    question: {
      id: 'browser.check.captcha',
      type: 'check',
      text: 'Is a human verification widget on this page?',
    },
    rulePrefix: 'browser.captcha.',
    risky: false,
    packId: 'browser-captcha',
  },
  payment: {
    question: {
      id: 'browser.check.risky_action',
      type: 'choice',
      text: 'Should the agent ask the user before taking this action?',
      options: RISKY_OPTIONS.map((id) => ({ id })),
    },
    rulePrefix: 'browser.risky.payment.',
    risky: true,
    packId: 'browser-risky-payment',
  },
  destructive: {
    question: {
      id: 'browser.check.risky_action',
      type: 'choice',
      text: 'Should the agent ask the user before taking this action?',
      options: RISKY_OPTIONS.map((id) => ({ id })),
    },
    rulePrefix: 'browser.risky.destructive.',
    risky: true,
    packId: 'browser-risky-destructive',
  },
  outbound: {
    question: {
      id: 'browser.check.risky_action',
      type: 'choice',
      text: 'Should the agent ask the user before taking this action?',
      options: RISKY_OPTIONS.map((id) => ({ id })),
    },
    rulePrefix: 'browser.risky.outbound.',
    risky: true,
    packId: 'browser-risky-outbound',
  },
};

const CHECK_NAMES = Object.keys(CHECKS);

interface FixtureExpectation {
  readonly noMatch: boolean;
  readonly value: string | number | boolean | undefined;
  readonly patternId: string | undefined;
}

interface Fixture {
  readonly file: string;
  readonly check: string;
  readonly knownGap: boolean;
  readonly hasBanglaText: boolean;
  readonly snapshot: Record<string, unknown>;
  readonly expected: FixtureExpectation;
}

interface Outcome {
  readonly fixture: Fixture;
  readonly expectedLabel: string;
  readonly actualLabel: string;
  readonly correct: boolean;
  readonly reason: string;
}

const BENGALI_CODE_POINT = /[ঀ-৿]/;

function fail(file: string, message: string): never {
  throw new Error(`[${file}] ${message}`);
}

function readFixture(file: string): Fixture {
  const raw: unknown = parse(readFileSync(join(FIXTURES_DIR, file), 'utf8'));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail(file, 'fixture must be a YAML mapping');
  }
  const doc = raw as Record<string, unknown>;

  if (doc.synthetic !== true) {
    fail(
      file,
      'fixture must state `synthetic: true`: every fixture is a synthetic example written to resemble a real accessibility tree, never a capture of a real site',
    );
  }
  if (typeof doc.provenance !== 'string' || doc.provenance.trim().length === 0) {
    fail(
      file,
      'fixture must carry a non-empty `provenance` string saying it is a synthetic example written to resemble a real accessibility tree, never a capture of a real site',
    );
  }
  if (!doc.provenance.toLowerCase().includes('synthetic')) {
    fail(file, 'fixture `provenance` must say in words that the fixture is synthetic');
  }

  const check = doc.check;
  if (typeof check !== 'string' || !(check in CHECKS)) {
    fail(file, `fixture \`check\` must be one of ${CHECK_NAMES.join(', ')}`);
  }

  const rawExpected = doc.expected;
  if (typeof rawExpected !== 'object' || rawExpected === null || Array.isArray(rawExpected)) {
    fail(file, 'fixture `expected` must be a mapping');
  }
  const expectedDoc = rawExpected as Record<string, unknown>;
  const noMatch = expectedDoc.no_match === true;
  if (!noMatch && expectedDoc.value === undefined) {
    fail(file, 'fixture `expected` must set `value`, or set `no_match: true`');
  }

  const snapshot = doc.snapshot;
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    fail(file, 'fixture `snapshot` must be a mapping in the engine snapshot shape');
  }
  const snapshotDoc = snapshot as Record<string, unknown>;
  if (snapshotDoc.elements !== undefined && !Array.isArray(snapshotDoc.elements)) {
    fail(file, 'fixture `snapshot.elements` must be a list when present');
  }

  const serialized = JSON.stringify(snapshotDoc);

  return {
    file,
    check,
    knownGap: doc.known_gap === true,
    hasBanglaText: BENGALI_CODE_POINT.test(serialized),
    snapshot: snapshotDoc,
    expected: {
      noMatch,
      value: noMatch ? undefined : (expectedDoc.value as string | number | boolean),
      patternId: typeof expectedDoc.pattern_id === 'string' ? expectedDoc.pattern_id : undefined,
    },
  };
}

function loadFixtures(): Fixture[] {
  const files = readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
    .sort();
  return files.map(readFixture);
}

function label(value: string | number | boolean | undefined): string {
  return value === undefined ? 'none' : String(value);
}

function runFixture(engine: PatternEngine, fixture: Fixture): Outcome {
  const spec = CHECKS[fixture.check]!;
  const match = engine.matchForQuestion(fixture.snapshot, spec.question, { threshold: THRESHOLD });
  const expectedLabel = fixture.expected.noMatch ? 'no_match' : label(fixture.expected.value);

  if (fixture.expected.noMatch) {
    return {
      fixture,
      expectedLabel,
      actualLabel: match === null ? 'no_match' : `rule ${match.pattern_id}`,
      correct: match === null,
      reason: match === null ? '' : `a rule fired instead: ${match.pattern_id}`,
    };
  }

  if (match === null) {
    return {
      fixture,
      expectedLabel,
      actualLabel: 'no_match',
      correct: false,
      reason: 'no rule fired',
    };
  }

  const reasons: string[] = [];
  if (!match.pattern_id.startsWith(spec.rulePrefix)) {
    reasons.push(`winning rule ${match.pattern_id} is outside ${spec.rulePrefix}`);
  }
  if (match.output.value !== fixture.expected.value) {
    reasons.push(`value ${String(match.output.value)} instead of ${expectedLabel}`);
  }
  if (fixture.expected.patternId !== undefined && match.pattern_id !== fixture.expected.patternId) {
    reasons.push(`rule ${match.pattern_id} instead of ${fixture.expected.patternId}`);
  }
  if (spec.risky && match.is_safety !== true) {
    reasons.push(`rule ${match.pattern_id} is not flagged safety, so it would not take precedence`);
  }

  return {
    fixture,
    expectedLabel,
    actualLabel: label(match.output.value as string | number | boolean),
    correct: reasons.length === 0,
    reason: reasons.join('; '),
  };
}

function summarise(outcomes: readonly Outcome[]): string {
  const lines: string[] = [];
  for (const checkName of CHECK_NAMES) {
    const own = outcomes.filter((o) => o.fixture.check === checkName);
    const correct = own.filter((o) => o.correct).length;
    lines.push(`  ${checkName}: ${correct}/${own.length} correct`);
  }
  const confusion = new Map<string, number>();
  for (const outcome of outcomes) {
    const key = `${outcome.fixture.check}: expected ${outcome.expectedLabel} -> got ${outcome.actualLabel}`;
    confusion.set(key, (confusion.get(key) ?? 0) + 1);
  }
  for (const key of [...confusion.keys()].sort()) {
    lines.push(`  ${key} x${confusion.get(key)}`);
  }
  const misses = outcomes.filter((o) => !o.correct);
  lines.push(`  misses: ${misses.length} of ${outcomes.length}`);
  for (const miss of misses) {
    lines.push(`  MISS ${miss.fixture.file}: ${miss.reason}`);
  }
  const gaps = outcomes.filter((o) => o.fixture.knownGap).map((o) => o.fixture.file);
  if (gaps.length > 0) {
    lines.push(`  known gaps recorded in the fixture note: ${gaps.join(', ')}`);
  }
  return lines.join('\n');
}

function loadEngine(): { engine: PatternEngine; rules: readonly Rule[] } {
  const loaded = loadPacksFromDirectory(PACKS_DIR);
  expect(loaded.errors.map((e) => e.formatted)).toEqual([]);
  return { engine: createPatternEngine(loaded.rules), rules: loaded.rules };
}

function safetyRuleIds(rules: readonly Rule[]): string[] {
  return rules.filter((r) => r.safety === true || r.is_safety === true).map((r) => r.id);
}

function matchAllFor(engine: PatternEngine, fixture: Fixture): PatternMatchResult[] {
  return engine.matchAll(fixture.snapshot);
}

describe('browser pack v1 rules and fixtures', () => {
  it('loads all seven browser pack files through the loader with no validation error', () => {
    const loaded = loadPacksFromDirectory(PACKS_DIR);
    expect(loaded.errors).toEqual([]);
    expect(loaded.loadedPacks.map((p) => p.manifest.id).sort()).toEqual(
      CHECK_NAMES.map((name) => CHECKS[name]!.packId).sort(),
    );
    for (const pack of loaded.loadedPacks) {
      expect(pack.signatureStatus).toBe('unsigned');
      expect(pack.rules.length).toBeGreaterThan(0);
    }
  });

  it('gives every rule a unique id that starts with the id prefix of its own pack', () => {
    const { rules } = loadEngine();
    const ids = rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const checkName of CHECK_NAMES) {
      const spec = CHECKS[checkName]!;
      const own = rules.filter((r) => r.id.startsWith(spec.rulePrefix));
      expect(own.length, `${checkName} has no rule with prefix ${spec.rulePrefix}`).toBeGreaterThan(
        0,
      );
      for (const rule of own) {
        expect(rule.pack_id).toBe(spec.packId);
        expect(rule.matchers.target_question_id).toBe(spec.question.id);
      }
    }
  });

  it('declares every payment, destructive and outbound rule as an advisory safety rule answering ask_user', () => {
    const { rules } = loadEngine();
    const riskyPrefixes = ['payment', 'destructive', 'outbound'].map(
      (name) => CHECKS[name]!.rulePrefix,
    );

    const riskyRules = rules.filter((r) => riskyPrefixes.some((p) => r.id.startsWith(p)));
    expect(riskyRules.length).toBeGreaterThan(0);

    const notSafety = riskyRules
      .filter((r) => r.safety !== true || r.is_safety !== true)
      .map((r) => r.id);
    expect(
      notSafety,
      `every risky rule must be flagged safety so it takes precedence: ${notSafety.join(', ')}`,
    ).toEqual([]);

    for (const rule of riskyRules) {
      expect(rule.output.value).toBe('ask_user');
      expect(rule.output.type).toBe('choice');
      expect(rule.output.confidence).toBeGreaterThanOrEqual(0.85);
      const distribution = rule.output.distribution ?? {};
      expect(Object.keys(distribution).sort()).toEqual([...RISKY_OPTIONS].sort());
    }
  });

  it('covers all seven browser checks with at least one rule and at least one fixture', () => {
    const { rules } = loadEngine();
    const fixtures = loadFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(40);

    for (const checkName of CHECK_NAMES) {
      const spec = CHECKS[checkName]!;
      expect(
        rules.filter((r) => r.id.startsWith(spec.rulePrefix)).length,
        `${checkName} has no rule`,
      ).toBeGreaterThan(0);
      expect(
        fixtures.filter((f) => f.check === checkName).length,
        `${checkName} has no fixture`,
      ).toBeGreaterThan(0);
    }
  });

  it('resolves the seven browser checks on at least 95 percent of the fixtures overall', () => {
    const { engine } = loadEngine();
    const outcomes = loadFixtures().map((fixture) => runFixture(engine, fixture));
    console.log('browser pack fixture confusion summary:\n' + summarise(outcomes));

    const correct = outcomes.filter((o) => o.correct);
    const accuracy = correct.length / outcomes.length;
    expect(accuracy).toBeGreaterThanOrEqual(0.95);
  });

  it('resolves every payment and destructive fixture with the right risky answer through a safety rule', () => {
    const { engine } = loadEngine();
    const fixtures = loadFixtures().filter(
      (fixture) => fixture.check === 'payment' || fixture.check === 'destructive',
    );
    expect(fixtures.length).toBeGreaterThanOrEqual(10);

    const outcomes = fixtures.map((fixture) => runFixture(engine, fixture));
    const misses = outcomes.filter((o) => !o.correct);
    expect(
      misses.map((o) => `${o.fixture.file}: ${o.reason}`),
      'every payment and destructive fixture must resolve exactly',
    ).toEqual([]);
  });

  it('resolves every Bangla fixture exactly as its expected block states', () => {
    const { engine } = loadEngine();
    const banglaFixtures = loadFixtures().filter((fixture) => fixture.hasBanglaText);
    expect(banglaFixtures.length).toBeGreaterThanOrEqual(8);

    const outcomes = banglaFixtures.map((fixture) => runFixture(engine, fixture));
    const misses = outcomes.filter((o) => !o.correct);
    expect(
      misses.map((o) => `${o.fixture.file}: ${o.reason}`),
      'every Bangla fixture must resolve exactly',
    ).toEqual([]);
  });

  it('fires no safety rule on any fixture of a risky check that expects no match', () => {
    const { engine } = loadEngine();
    const benign = loadFixtures().filter(
      (fixture) => fixture.expected.noMatch && CHECKS[fixture.check]!.risky,
    );
    expect(benign.length).toBeGreaterThanOrEqual(6);

    const riskyOnBenign: string[] = [];
    for (const fixture of benign) {
      for (const match of matchAllFor(engine, fixture)) {
        if (match.is_safety) {
          riskyOnBenign.push(`${fixture.file}: ${match.pattern_id}`);
        }
      }
    }
    expect(riskyOnBenign, 'a page that is not a risky action must not fire a safety rule').toEqual(
      [],
    );
  });

  it('keeps the safety rules that fired on risky fixtures inside the risky family of the fixture', () => {
    const { engine, rules } = loadEngine();
    const safetyIds = new Set(safetyRuleIds(rules));
    expect(safetyIds.size).toBeGreaterThan(0);

    const leaked: string[] = [];
    for (const fixture of loadFixtures()) {
      const spec = CHECKS[fixture.check]!;
      if (!spec.risky) continue;
      for (const match of matchAllFor(engine, fixture)) {
        if (match.is_safety && !match.pattern_id.startsWith(spec.rulePrefix)) {
          leaked.push(`${fixture.file}: ${match.pattern_id}`);
        }
      }
    }
    expect(leaked, 'a risky page must not also look like a different risky family').toEqual([]);
  });
});
