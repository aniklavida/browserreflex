import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, type DatabaseStore } from '../src/store/index.js';

describe('store typed repositories', () => {
  let tempDir: string;
  let dbPath: string;
  let store: DatabaseStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browserreflex-test-repos-'));
    dbPath = join(tempDir, 'test.db');
    store = createStore(dbPath);
  });

  afterEach(() => {
    if (store) {
      store.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('inserts and retrieves records for all 7 tables with typed repos', () => {
    // 1. sessions
    const session = store.sessions.create({
      agent_name: 'test-agent',
      status: 'active',
      metadata: JSON.stringify({ goal: 'scrape' }),
    });
    expect(session.id).toBeDefined();
    const fetchedSession = store.sessions.getById(session.id);
    expect(fetchedSession).not.toBeNull();
    expect(fetchedSession?.agent_name).toBe('test-agent');
    expect(fetchedSession?.status).toBe('active');

    // 2. packs
    const pack = store.packs.create({
      id: 'browser-pack-v1',
      name: 'Browser Core Pack',
      version: '1.0.0',
      description: 'Standard rules for web popups and banners',
      is_active: true,
    });
    expect(pack.id).toBe('browser-pack-v1');
    const fetchedPack = store.packs.getById(pack.id);
    expect(fetchedPack).not.toBeNull();
    expect(fetchedPack?.name).toBe('Browser Core Pack');
    expect(fetchedPack?.is_active).toBe(1);

    // 3. patterns
    const pattern = store.patterns.create({
      pack_id: pack.id,
      name: 'cookie-banner-accept',
      domain: 'example.com',
      url_pattern: '/.*',
      selector: '#accept-cookies',
      decision_type: 'check',
      rules: JSON.stringify({ textMatch: 'Accept Cookies' }),
      status: 'active',
      confidence: 0.98,
      is_safety: false,
    });
    expect(pattern.id).toBeDefined();
    const fetchedPattern = store.patterns.getById(pattern.id);
    expect(fetchedPattern).not.toBeNull();
    expect(fetchedPattern?.name).toBe('cookie-banner-accept');
    expect(fetchedPattern?.confidence).toBe(0.98);

    // 4. pattern_stats
    const stats = store.patternStats.upsert({
      pattern_id: pattern.id,
      sample_count: 10,
      agreed_count: 9,
      disagreed_count: 1,
      last_evaluated_at: new Date().toISOString(),
    });
    expect(stats.pattern_id).toBe(pattern.id);
    const fetchedStats = store.patternStats.getById(pattern.id);
    expect(fetchedStats).not.toBeNull();
    expect(fetchedStats?.sample_count).toBe(10);
    expect(fetchedStats?.agreed_count).toBe(9);
    expect(fetchedStats?.disagreed_count).toBe(1);

    // 5. decisions
    const decision = store.decisions.create({
      session_id: session.id,
      url: 'https://example.com/login',
      domain: 'example.com',
      decision_type: 'check',
      question: 'Is this button safe to click?',
      context: JSON.stringify({ tag: 'button', text: 'Accept Cookies' }),
      input_hash: 'hash-abc-123',
      answer: JSON.stringify({ allow: true }),
      confidence: 0.99,
      path: 'pattern',
      pattern_id: pattern.id,
      latency_ms: 4.5,
      is_safety: false,
      needs_review: false,
    });
    expect(decision.id).toBeDefined();
    const fetchedDecision = store.decisions.getById(decision.id);
    expect(fetchedDecision).not.toBeNull();
    expect(fetchedDecision?.path).toBe('pattern');
    expect(fetchedDecision?.confidence).toBe(0.99);

    const lookupByHash = store.decisions.findByInputHash('hash-abc-123');
    expect(lookupByHash?.id).toBe(decision.id);

    // 6. feedback
    const feedback = store.feedback.create({
      decision_id: decision.id,
      correct_value: JSON.stringify({ allow: true }),
      note: 'Verified correct by reviewer',
      source: 'human',
    });
    expect(feedback.id).toBeDefined();
    const fetchedFeedback = store.feedback.getById(feedback.id);
    expect(fetchedFeedback).not.toBeNull();
    expect(fetchedFeedback?.decision_id).toBe(decision.id);
    expect(fetchedFeedback?.note).toBe('Verified correct by reviewer');

    const feedbackList = store.feedback.getByDecisionId(decision.id);
    expect(feedbackList.length).toBe(1);
    expect(feedbackList[0]?.id).toBe(feedback.id);

    // 7. settings
    const setting = store.settings.set('retention_days', '30');
    expect(setting.key).toBe('retention_days');
    expect(setting.value).toBe('30');
    const fetchedSetting = store.settings.get('retention_days');
    expect(fetchedSetting?.value).toBe('30');
    expect(store.settings.getValue('retention_days')).toBe('30');

    store.settings.setJson('thresholds', { fastPath: 0.95, safety: 0.99 });
    const jsonVal = store.settings.getJson<{ fastPath: number; safety: number }>('thresholds');
    expect(jsonVal).toEqual({ fastPath: 0.95, safety: 0.99 });
  });

  it('enforces foreign key constraints on dependent tables', () => {
    // Feedback referencing non-existent decision must throw SQLITE_CONSTRAINT_FOREIGNKEY
    expect(() => {
      store.feedback.create({
        decision_id: 'non-existent-decision-id',
        correct_value: 'val',
      });
    }).toThrow(/FOREIGN KEY/i);

    // Decisions with invalid session_id must fail foreign key check
    expect(() => {
      store.decisions.create({
        session_id: 'non-existent-session-id',
        decision_type: 'check',
        question: 'question?',
        answer: 'yes',
        confidence: 1.0,
        path: 'check',
      });
    }).toThrow(/FOREIGN KEY/i);
  });

  it('cascades deletion from pattern to pattern_stats', () => {
    const pattern = store.patterns.create({
      name: 'temp-pattern',
      decision_type: 'check',
      rules: '{}',
    });

    store.patternStats.upsert({
      pattern_id: pattern.id,
      sample_count: 5,
    });

    expect(store.patternStats.getById(pattern.id)).not.toBeNull();

    // Delete pattern
    const deleted = store.patterns.delete(pattern.id);
    expect(deleted).toBe(true);

    // Stats should have cascaded deletion
    expect(store.patternStats.getById(pattern.id)).toBeNull();
  });

  it('records incremental samples in pattern_stats correctly', () => {
    const pattern = store.patterns.create({
      name: 'learning-pattern',
      decision_type: 'check',
      rules: '{}',
    });

    const s1 = store.patternStats.recordSample(pattern.id, true);
    expect(s1.sample_count).toBe(1);
    expect(s1.agreed_count).toBe(1);
    expect(s1.disagreed_count).toBe(0);

    const s2 = store.patternStats.recordSample(pattern.id, false);
    expect(s2.sample_count).toBe(2);
    expect(s2.agreed_count).toBe(1);
    expect(s2.disagreed_count).toBe(1);

    const s3 = store.patternStats.recordSample(pattern.id, true);
    expect(s3.sample_count).toBe(3);
    expect(s3.agreed_count).toBe(2);
    expect(s3.disagreed_count).toBe(1);
  });
});
