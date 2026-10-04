import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createStore, type DatabaseStore } from '../src/store/index.js';
import { startApiServer, type ApiServerHandle } from '../src/api/index.js';
import { csvCell, detectClients, familyOfRule } from '../src/api/extra.js';
import { createFileKeyStore, type KeyStore } from '../src/security/keys.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

interface Api extends ApiServerHandle {
  store: DatabaseStore;
  url: string;
  dir: string;
  keys: KeyStore;
}

async function start(
  options: Parameters<typeof startApiServer>[1] = {},
  inMemory = false,
): Promise<Api> {
  const dir = mkdtempSync(join(tmpdir(), 'browserreflex-api-extra-'));
  const store = createStore(inMemory ? ':memory:' : join(dir, 'test.db'));
  const keys = createFileKeyStore({ directory: join(dir, 'keys') });
  const handle = await startApiServer(store, {
    port: 0,
    keyStore: keys,
    home: join(dir, 'home'),
    streamPollMs: 20,
    ...options,
  });
  cleanups.push(async () => {
    await handle.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { ...handle, store, url: handle.address, dir, keys };
}

function call(
  api: Api,
  method: string,
  path: string,
  body?: unknown,
  // The test reads fields off many different response shapes, so the parsed body is loose.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; text: string; json: () => any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: api.port,
        path,
        method,
        agent: false,
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            text,
            headers: res.headers,
            json: () => JSON.parse(text),
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function decision(store: DatabaseStore, overrides: Record<string, unknown> = {}) {
  return store.decisions.create({
    decision_type: 'check',
    question: 'Is this a cookie banner?',
    answer: 'true',
    confidence: 0.9,
    path: 'memory',
    ...overrides,
  } as Parameters<DatabaseStore['decisions']['create']>[0]);
}

function runtimeKey(): string {
  return ['sk', 'ant', 'api03', 'ABCDEFGHIJ1234567890abcdef', 'WXYZ'].join('-');
}

describe('decision filters', () => {
  it('searches the question and the answer literally, so a percent sign finds only a percent sign', async () => {
    const api = await start({}, true);
    decision(api.store, { question: 'Is the discount 50% off?' });
    decision(api.store, { question: 'Is this a login wall?' });

    const found = (await call(api, 'GET', '/api/decisions?q=50%25')).json();
    expect(found.items).toHaveLength(1);
    expect(found.total).toBe(1);

    const wildcard = (await call(api, 'GET', '/api/decisions?q=%25')).json();
    expect(wildcard.items).toHaveLength(1);
  });

  it('filters by a time range, with the end exclusive, and by pattern', async () => {
    const api = await start({}, true);
    decision(api.store, { created_at: '2026-10-01T10:00:00.000Z' });
    decision(api.store, { created_at: '2026-10-02T10:00:00.000Z' });
    decision(api.store, { created_at: '2026-10-03T10:00:00.000Z' });

    const range = (
      await call(
        api,
        'GET',
        '/api/decisions?from=2026-10-02T00:00:00.000Z&to=2026-10-03T00:00:00.000Z',
      )
    ).json();
    expect(range.total).toBe(1);
  });
});

describe('malformed requests', () => {
  it('answers a malformed percent escape in a query with a normal response, not a 500', async () => {
    const api = await start({}, true);
    const result = await call(api, 'GET', '/api/decisions?q=%E0%A4%A');
    expect(result.status).toBe(200);
  });
});

describe('shutdown', () => {
  it('stops even while a live stream is open', async () => {
    const api = await start();
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        { hostname: '127.0.0.1', port: api.port, path: '/api/stream', agent: false },
        () => resolve(),
      );
      req.on('error', () => undefined);
      setTimeout(() => reject(new Error('the stream did not open')), 2000);
    });
    const started = Date.now();
    await api.stop();
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('live stream', () => {
  it('sends a decision made after the stream opened, and none from before', async () => {
    const api = await start();
    decision(api.store, { question: 'old decision' });

    const received = await new Promise<string>((resolve, reject) => {
      const req = http.get(
        { hostname: '127.0.0.1', port: api.port, path: '/api/stream', agent: false },
        (res) => {
          expect(res.headers['content-type']).toContain('text/event-stream');
          let buffer = '';
          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf8');
            if (buffer.includes('event: decision')) {
              req.destroy();
              resolve(buffer);
            }
          });
          setTimeout(() => decision(api.store, { question: 'new decision' }), 60);
        },
      );
      req.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
      });
      setTimeout(() => reject(new Error('no event arrived')), 3000);
    });

    expect(received).toContain('new decision');
    expect(received).not.toContain('old decision');
  });
});

describe('sessions', () => {
  it('summarises each session with its agent and its path mix', async () => {
    const api = await start({}, true);
    const session = api.store.sessions.create({ agent_name: 'claude-code' });
    decision(api.store, { session_id: session.id, path: 'memory' });
    decision(api.store, { session_id: session.id, path: 'ai' });
    decision(api.store, { path: 'memory' });

    const body = (await call(api, 'GET', '/api/sessions')).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: session.id,
      agent_name: 'claude-code',
      decisions: 2,
      fast: 1,
      ai: 1,
    });
  });
});

describe('pack and pattern switches', () => {
  it('turns a pack off and on, and says what it does', async () => {
    const api = await start({}, true);
    api.store.packs.create({ id: 'browser', name: 'Browser', version: '1', is_active: 1 });

    const off = await call(api, 'PUT', '/api/packs/browser', { active: false });
    expect(off.status).toBe(200);
    expect(off.json().note).toContain('safety rules keep working');
    expect(api.store.packs.getById('browser')?.is_active).toBe(0);

    await call(api, 'PUT', '/api/packs/browser', { active: true });
    expect(api.store.packs.getById('browser')?.is_active).toBe(1);

    expect((await call(api, 'PUT', '/api/packs/nope', { active: true })).status).toBe(404);
    expect((await call(api, 'PUT', '/api/packs/browser', { active: 'yes' })).status).toBe(400);
  });

  it('refuses to switch a safety pattern or a safety-family rule', async () => {
    const api = await start({}, true);
    for (const [id, is_safety] of [
      ['flagged', true],
      ['browser.risky.payment.pay_control', false],
    ] as const) {
      api.store.patterns.create({
        id,
        name: id,
        decision_type: 'check',
        rules: '{}',
        status: 'active',
        confidence: 0.9,
        is_safety,
      });
      const result = await call(api, 'PUT', `/api/patterns/${id}`, { status: 'disabled' });
      expect(result.status).toBe(403);
      expect(api.store.patterns.getById(id)?.status).toBe('active');
    }
  });

  it('switches a promoted pattern off and on, and refuses to switch on a candidate that was never promoted', async () => {
    const api = await start({}, true);
    for (const id of ['promoted', 'candidate']) {
      api.store.patterns.create({
        id,
        name: id,
        decision_type: 'check',
        rules: '{}',
        status: id === 'promoted' ? 'active' : 'disabled',
        confidence: 0.9,
        is_safety: false,
      });
    }
    api.store.promotionEvents.create({
      pattern_id: 'promoted',
      sample_count: 25,
      agreement: 1,
      threshold_samples: 20,
      threshold_agreement: 0.95,
      thresholds: {},
    });

    expect((await call(api, 'PUT', '/api/patterns/promoted', { status: 'disabled' })).status).toBe(
      200,
    );
    expect(api.store.patterns.getById('promoted')?.status).toBe('disabled');
    expect((await call(api, 'PUT', '/api/patterns/promoted', { status: 'active' })).status).toBe(
      200,
    );
    expect((await call(api, 'PUT', '/api/patterns/candidate', { status: 'active' })).status).toBe(
      400,
    );
    expect((await call(api, 'PUT', '/api/patterns/promoted', { status: 'shadow' })).status).toBe(
      400,
    );
    expect((await call(api, 'PUT', '/api/patterns/none', { status: 'disabled' })).status).toBe(404);
  });

  it('refuses to disable a written pack rule, because only its pack can switch it off', async () => {
    const api = await start({}, true);
    api.store.patterns.create({
      id: 'browser.cookie.accept_all',
      name: 'browser.cookie.accept_all',
      decision_type: 'check',
      rules: '{}',
      status: 'active',
      confidence: 0.9,
      is_safety: false,
    });
    const result = await call(api, 'PUT', '/api/patterns/browser.cookie.accept_all', {
      status: 'disabled',
    });
    expect(result.status).toBe(409);
    expect(result.text).toContain('Packs page');
    expect(api.store.patterns.getById('browser.cookie.accept_all')?.status).toBe('active');
  });

  it('refuses to switch a pattern on while a drift alert for it is open', async () => {
    const api = await start({}, true);
    api.store.patterns.create({
      id: 'demoted',
      name: 'demoted',
      decision_type: 'check',
      rules: '{}',
      status: 'disabled',
      confidence: 0.9,
      is_safety: false,
    });
    api.store.promotionEvents.create({
      pattern_id: 'demoted',
      sample_count: 25,
      agreement: 1,
      threshold_samples: 20,
      threshold_agreement: 0.95,
      thresholds: {},
    });
    const alert = api.store.driftAlerts.create({
      pattern_id: 'demoted',
      sample_count: 20,
      agreed_count: 10,
      disagreed_count: 10,
      accuracy: 0.5,
      threshold: 0.9,
      message: 'disabled',
    });
    expect((await call(api, 'PUT', '/api/patterns/demoted', { status: 'active' })).status).toBe(
      409,
    );
    await call(api, 'PUT', `/api/drift/${alert.id}`, { status: 'acknowledged' });
    expect((await call(api, 'PUT', '/api/patterns/demoted', { status: 'active' })).status).toBe(
      200,
    );
  });

  it('reports sample counts per pattern', async () => {
    const api = await start({}, true);
    api.store.patterns.create({
      id: 'p',
      name: 'p',
      decision_type: 'check',
      rules: '{}',
      status: 'shadow',
      confidence: 0.9,
      is_safety: false,
    });
    api.store.patternStats.upsert({
      pattern_id: 'p',
      sample_count: 10,
      agreed_count: 9,
      disagreed_count: 1,
    });
    const body = (await call(api, 'GET', '/api/pattern-stats')).json();
    expect(body.items).toEqual([
      { pattern_id: 'p', sample_count: 10, agreed_count: 9, disagreed_count: 1 },
    ]);
  });
});

describe('provider keys', () => {
  it('stores a key and reports it masked, and no response, setting or log ever holds the key', async () => {
    const api = await start({}, true);
    const key = runtimeKey();

    const put = await call(api, 'PUT', '/api/keys', { provider: 'anthropic', key });
    expect(put.status).toBe(200);
    expect(put.text).not.toContain(key);
    expect(put.json()).toMatchObject({ provider: 'anthropic', has_key: true });
    expect(put.json().masked).toMatch(/^sk-ant-/);
    expect(put.json().masked.endsWith(key.slice(-4))).toBe(true);

    const list = await call(api, 'GET', '/api/keys');
    expect(list.text).not.toContain(key);
    expect(list.json().items[0]).toMatchObject({ provider: 'anthropic', has_key: true });

    expect(JSON.stringify(api.store.settings.list())).not.toContain(key);
    expect(await api.keys.getKey('anthropic')).toBe(key);

    const settings = await call(api, 'GET', '/api/settings');
    expect(settings.text).not.toContain(key);
  });

  it('removes a key', async () => {
    const api = await start({}, true);
    await call(api, 'PUT', '/api/keys', { provider: 'anthropic', key: runtimeKey() });
    const removed = await call(api, 'DELETE', '/api/keys/anthropic');
    expect(removed.json()).toEqual({ provider: 'anthropic', removed: true });
    expect((await call(api, 'GET', '/api/keys')).json().items[0].has_key).toBe(false);
    expect((await call(api, 'DELETE', '/api/keys/openai')).status).toBe(404);
  });

  it('refuses a bad provider, an empty key, a key with whitespace and an oversize key, and stores nothing', async () => {
    const api = await start({}, true);
    expect(
      (await call(api, 'PUT', '/api/keys', { provider: 'nope', key: runtimeKey() })).status,
    ).toBe(400);
    expect((await call(api, 'PUT', '/api/keys', { provider: 'anthropic', key: '  ' })).status).toBe(
      400,
    );
    expect(
      (await call(api, 'PUT', '/api/keys', { provider: 'anthropic', key: 'two words' })).status,
    ).toBe(400);
    expect(
      (await call(api, 'PUT', '/api/keys', { provider: 'anthropic', key: 'x'.repeat(600) })).status,
    ).toBe(400);
    expect(await api.keys.hasKey('anthropic')).toBe(false);
  });

  it('tests a connection through the injected tester and never reveals the key', async () => {
    const key = runtimeKey();
    const seen: string[] = [];
    const api = await start({
      keyTester: async (provider, keys) => {
        seen.push((await keys.getKey(provider)) ?? '');
        return { ok: true, provider, model: 'test-model', latency_ms: 12 };
      },
    });
    expect((await call(api, 'POST', '/api/keys/test', { provider: 'anthropic' })).json()).toEqual({
      ok: false,
      provider: 'anthropic',
      error: 'no_key',
    });
    await call(api, 'PUT', '/api/keys', { provider: 'anthropic', key });
    const tested = await call(api, 'POST', '/api/keys/test', { provider: 'anthropic' });
    expect(tested.json()).toEqual({
      ok: true,
      provider: 'anthropic',
      model: 'test-model',
      latency_ms: 12,
    });
    expect(tested.text).not.toContain(key);
    expect(seen).toEqual([key]);
  });

  it('reports a failing tester as a transport error and not as a thrown 500', async () => {
    const api = await start({
      keyTester: async () => {
        throw new Error('boom ' + runtimeKey());
      },
    });
    await call(api, 'PUT', '/api/keys', { provider: 'anthropic', key: runtimeKey() });
    const result = await call(api, 'POST', '/api/keys/test', { provider: 'anthropic' });
    expect(result.status).toBe(200);
    expect(result.json().error).toBe('transport');
    expect(result.text).not.toContain(runtimeKey());
  });
});

describe('data, backup and retention', () => {
  it('describes the database and writes a consistent backup next to it', async () => {
    const api = await start();
    decision(api.store);

    const before = (await call(api, 'GET', '/api/data')).json();
    expect(before.decisions).toBe(1);
    expect(before.database_file).toBe('test.db');
    expect(before.backups).toEqual([]);

    const backup = (await call(api, 'POST', '/api/backup')).json();
    expect(backup.file).toMatch(/^browserreflex-.*\.db$/);
    expect(existsSync(join(api.dir, 'backups', backup.file))).toBe(true);

    const copy = createStore(join(api.dir, 'backups', backup.file));
    expect(copy.decisions.count()).toBe(1);
    copy.close();

    expect(((await call(api, 'GET', '/api/data')).json().backups as unknown[]).length).toBe(1);
  });

  it('cannot back up an in-memory database', async () => {
    const api = await start({}, true);
    expect((await call(api, 'POST', '/api/backup')).status).toBe(400);
  });

  it('purges only decisions older than the cutoff, and only when confirmed', async () => {
    const api = await start({}, true);
    decision(api.store, { created_at: new Date(Date.now() - 40 * 86_400_000).toISOString() });
    decision(api.store, { created_at: new Date().toISOString() });

    expect((await call(api, 'POST', '/api/retention/purge', { days: 30 })).status).toBe(400);
    expect(
      (await call(api, 'POST', '/api/retention/purge', { days: 0, confirm: true })).status,
    ).toBe(400);
    expect(api.store.decisions.count()).toBe(2);

    const purged = (
      await call(api, 'POST', '/api/retention/purge', { days: 30, confirm: true })
    ).json();
    expect(purged.deleted).toBe(1);
    expect(api.store.decisions.count()).toBe(1);
  });
});

describe('integrations', () => {
  it('reports which supported agents have a BrowserReflex entry', () => {
    const home = mkdtempSync(join(tmpdir(), 'browserreflex-home-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(join(home, '.cursor'));
    writeFileSync(join(home, '.cursor', 'mcp.json'), '{"mcpServers":{"browserreflex":{}}}');
    mkdirSync(join(home, '.gemini'));
    writeFileSync(join(home, '.gemini', 'settings.json'), '{"mcpServers":{}}');

    const clients = detectClients(home);
    const byId = Object.fromEntries(clients.map((client) => [client.id, client]));
    expect(byId.cursor).toMatchObject({ found: true, configured: true });
    expect(byId['gemini-cli']).toMatchObject({ found: true, configured: false });
    expect(byId['claude-code']).toMatchObject({ found: false, configured: false });
    expect(clients).toHaveLength(4);
  });

  it('answers over the API from the configured home', async () => {
    const api = await start({}, true);
    const body = (await call(api, 'GET', '/api/integrations')).json();
    expect(body.clients).toHaveLength(4);
    expect(body.clients.every((client: { found: boolean }) => !client.found)).toBe(true);
  });
});

describe('analytics', () => {
  it('compares stated confidence with what turned out right, per bin, and lists the patterns wrong most often', async () => {
    const api = await start({}, true);
    api.store.patterns.create({
      id: 'p1',
      name: 'p1',
      decision_type: 'check',
      rules: '{}',
      status: 'active',
      confidence: 0.9,
      is_safety: false,
    });
    const right = decision(api.store, { confidence: 0.95, answer: 'true', pattern_id: 'p1' });
    const wrong = decision(api.store, { confidence: 0.92, answer: 'true', pattern_id: 'p1' });
    api.store.feedback.create({ decision_id: right.id, correct_value: 'true', source: 'user' });
    api.store.feedback.create({ decision_id: wrong.id, correct_value: 'false', source: 'user' });

    const body = (await call(api, 'GET', '/api/analytics/quality')).json();
    expect(body.corrected_decisions).toBe(2);
    expect(body.bins).toHaveLength(10);
    expect(body.bins[9]).toMatchObject({ count: 2, actual: 0.5 });
    expect(body.bins[0]).toMatchObject({ count: 0, stated: null, actual: null });
    expect(body.wrong_most).toEqual([{ pattern_id: 'p1', wrong: 1, total: 2 }]);
  });

  it('counts safety records by family and says the check is advisory', async () => {
    const api = await start({}, true);
    api.store.patterns.create({
      id: 'browser.risky.payment.pay_control',
      name: 'x',
      decision_type: 'check',
      rules: '{}',
      status: 'active',
      confidence: 0.9,
      is_safety: true,
    });
    decision(api.store, {
      is_safety: true,
      answer: 'ask_user',
      pattern_id: 'browser.risky.payment.pay_control',
      domain: 'shop.example',
    });
    const body = (await call(api, 'GET', '/api/analytics/safety')).json();
    expect(body.by_family).toEqual({ payment: 1 });
    expect(body.by_answer).toEqual({ ask_user: 1 });
    expect(body.risky_places[0]).toEqual({ domain: 'shop.example', total: 1 });
    expect(body.note).toContain('advisory');
    expect(familyOfRule('browserreflex.safety.secret.entered_text')).toBe('secrets');
    expect(familyOfRule(null)).toBe('other');
  });

  it('groups decisions by agent and by project', async () => {
    const api = await start({}, true);
    const session = api.store.sessions.create({ agent_name: 'codex' });
    decision(api.store, { session_id: session.id, domain: 'a.example' });
    decision(api.store, { domain: 'a.example', path: 'ai' });
    const body = (await call(api, 'GET', '/api/analytics/agents')).json();
    expect(body.agents.find((agent: { agent: string }) => agent.agent === 'codex')).toMatchObject({
      decisions: 1,
      fast: 1,
    });
    expect(body.projects[0]).toMatchObject({ project: 'a.example', decisions: 2, fast: 1 });
  });

  it('reports re-check accuracy per pattern and the alert list, and lets an alert be acknowledged', async () => {
    const api = await start({}, true);
    api.store.patterns.create({
      id: 'p',
      name: 'p',
      decision_type: 'check',
      rules: '{}',
      status: 'disabled',
      confidence: 0.9,
      is_safety: false,
    });
    for (let index = 0; index < 4; index += 1) {
      const row = decision(api.store);
      const recheck = api.store.rechecks.create({
        decision_id: row.id,
        pattern_id: 'p',
        pattern_answer: 'true',
      });
      api.store.rechecks.complete(recheck.id, index < 3, 'true', 'feedback');
    }
    const alert = api.store.driftAlerts.create({
      pattern_id: 'p',
      sample_count: 4,
      agreed_count: 3,
      disagreed_count: 1,
      accuracy: 0.75,
      threshold: 0.9,
      message: 'disabled',
    });

    const body = (await call(api, 'GET', '/api/drift')).json();
    expect(body.threshold).toBe(0.9);
    expect(body.patterns).toEqual([{ pattern_id: 'p', rechecks: 4, accuracy: 0.75 }]);
    expect(body.alerts).toHaveLength(1);

    expect(
      (await call(api, 'PUT', `/api/drift/${alert.id}`, { status: 'acknowledged' })).status,
    ).toBe(200);
    expect(api.store.driftAlerts.list({ status: 'active' })).toHaveLength(0);
    expect((await call(api, 'PUT', '/api/drift/none', { status: 'resolved' })).status).toBe(404);
    expect((await call(api, 'PUT', `/api/drift/${alert.id}`, { status: 'deleted' })).status).toBe(
      400,
    );
  });
});

describe('CSV export', () => {
  it('quotes cells, and prefixes a cell that starts like a formula so a spreadsheet will not run it', async () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell(null)).toBe('');

    const api = await start({}, true);
    decision(api.store, { question: '=cmd|calc' });
    const response = await call(api, 'GET', '/api/export/decisions.csv');
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('decisions.csv');
    expect(response.text).toContain("'=cmd|calc");
    expect(response.text.split('\n')[0]).toContain('question');
  });
});

describe('the source of the keys route', () => {
  it('never writes a provider key to a file the settings or the logs read', () => {
    const source = readFileSync(join(__dirname, '../src/api/extra.ts'), 'utf8');
    expect(source).not.toMatch(/settings\.set\([^)]*key/);
    expect(source).not.toMatch(/console\.(log|error)\([^)]*key/i);
  });
});
