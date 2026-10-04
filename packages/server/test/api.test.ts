/**
 * Tests for the local REST API.
 *
 * What the card is about, and what these tests back:
 * - a non-local request is refused, by remote address and by Host header;
 * - a cross-origin browser request is refused;
 * - a settings response never carries a credential, and a credential is never
 *   written to the settings table;
 * - every endpoint answers with JSON over a real socket;
 * - the same process serves a built UI directory when one is configured.
 *
 * The store is an in-memory SQLite database and the UI fixture directory is a
 * temporary directory, so no test touches the real home directory or the
 * repository. The server binds to 127.0.0.1 on an operating-system assigned
 * port.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { connect } from 'node:net';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createStore, type DatabaseStore } from '../src/store/index.js';
import {
  startApiServer,
  createRequestListener,
  defaultAllowedOrigins,
  isLocalAddress,
  isLocalRequest,
  isCorsAllowed,
  maskSetting,
  maskSettingValue,
  refuseSettingWrite,
  resolveWithinRoot,
  MASKED_PLACEHOLDER,
  type ApiServerHandle,
} from '../src/api/index.js';
import { ApiRouter } from '../src/api/router.js';
import { MAX_BODY_BYTES, readJsonBody } from '../src/api/http.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A local HTTP request to the test server, over a real socket. */
function request(
  url: string,
  options: http.RequestOptions & { body?: string } = {},
): Promise<{
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
  json: () => unknown;
}> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: (options.path as string | undefined) ?? parsed.pathname + parsed.search,
        method: options.method ?? 'GET',
        agent: false,
        headers: { 'Content-Type': 'application/json', ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            body: text,
            headers: res.headers,
            json: () => JSON.parse(text) as unknown,
          });
        });
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** A request object shaped like the ones Node hands a listener. */
function fakeRequest(init: {
  url: string;
  method?: string;
  remoteAddress?: string;
  host?: string;
  origin?: string;
  body?: string;
}): IncomingMessage {
  const stream = Readable.from([Buffer.from(init.body ?? '', 'utf8')]);
  const headers: Record<string, string> = {};
  if (init.host !== undefined) headers.host = init.host;
  if (init.origin !== undefined) headers.origin = init.origin;
  return Object.assign(stream, {
    url: init.url,
    method: init.method ?? 'GET',
    headers,
    socket: { remoteAddress: init.remoteAddress ?? '127.0.0.1' },
  }) as unknown as IncomingMessage;
}

/** A response object that records what a listener wrote to it. */
class RecordedResponse {
  status = 0;
  headers: Record<string, string> = {};
  body = '';
  ended = false;

  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.status = status;
    this.headers = headers;
    return this;
  }

  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) this.body += String(chunk);
    this.ended = true;
    return this;
  }

  get nodeResponse(): ServerResponse {
    return this as unknown as ServerResponse;
  }
}

const openHandles: ApiServerHandle[] = [];
const openStores: DatabaseStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const handle of openHandles.splice(0)) {
    void handle.stop();
  }
  for (const store of openStores.splice(0)) {
    store.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A started server plus the store behind it. */
interface TestApi extends ApiServerHandle {
  readonly store: DatabaseStore;
  /** The address to send requests to. */
  readonly url: string;
}

/** Starts a server on an OS assigned port, tracked for cleanup after the test. */
async function startTestServer(
  options: Parameters<typeof startApiServer>[1] = {},
): Promise<TestApi> {
  const store = createStore(':memory:');
  openStores.push(store);
  const handle = await startApiServer(store, { port: 0, ...options });
  openHandles.push(handle);
  return { ...handle, store, url: handle.address };
}

/** A store that is closed after the test that made it. */
function newStore(): DatabaseStore {
  const store = createStore(':memory:');
  openStores.push(store);
  return store;
}

/** A built UI fixture: a shell, an asset and an asset directory. */
function makeUiFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'browserreflex-ui-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>local ui</title>');
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log("ui");\n');
  writeFileSync(join(root, 'assets', 'app.css'), 'body{margin:0}\n');
  return root;
}

/**
 * A value shaped like a generated credential, assembled at run time so that no
 * credential-shaped literal sits in a tracked file. The redaction rules mask it
 * as high entropy: over 32 characters, with a digit and a letter, and no dot.
 */
function credentialShapedValue(): string {
  return 'Zz1' + '0123456789abcdef' + 'GH43klmnopqrstuv';
}

// ---------------------------------------------------------------------------
// Guard: remote address
// ---------------------------------------------------------------------------

describe('localhost guard, remote address', () => {
  it('accepts the IPv4 loopback address', () => {
    expect(isLocalAddress('127.0.0.1')).toBe(true);
  });

  it('accepts the whole 127.0.0.0/8 range', () => {
    expect(isLocalAddress('127.1.2.3')).toBe(true);
  });

  it('accepts an IPv4-mapped loopback address', () => {
    expect(isLocalAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('accepts the IPv6 loopback address', () => {
    expect(isLocalAddress('::1')).toBe(true);
  });

  it('refuses an address outside the loopback range', () => {
    expect(isLocalAddress('203.0.113.5')).toBe(false);
    expect(isLocalAddress('10.0.0.1')).toBe(false);
    expect(isLocalAddress('128.0.0.1')).toBe(false);
    expect(isLocalAddress('::ffff:203.0.113.5')).toBe(false);
    expect(isLocalAddress(undefined)).toBe(false);
    expect(isLocalAddress('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guard: Host header
// ---------------------------------------------------------------------------

describe('isLocalRequest', () => {
  it('accepts a loopback address with a localhost Host header', () => {
    expect(isLocalRequest(fakeRequest({ url: '/api/stats', host: 'localhost:4040' }))).toBe(true);
  });

  it('accepts a loopback address with a loopback Host header', () => {
    expect(isLocalRequest(fakeRequest({ url: '/api/stats', host: '127.0.0.1:4040' }))).toBe(true);
    expect(isLocalRequest(fakeRequest({ url: '/api/stats', host: '[::1]:4040' }))).toBe(true);
    expect(isLocalRequest(fakeRequest({ url: '/api/stats', host: 'localhost' }))).toBe(true);
  });

  it('refuses a request with no Host header', () => {
    expect(isLocalRequest(fakeRequest({ url: '/api/stats' }))).toBe(false);
  });

  it('refuses a non-local remote address', () => {
    expect(
      isLocalRequest(
        fakeRequest({ url: '/api/stats', remoteAddress: '203.0.113.5', host: 'localhost:4040' }),
      ),
    ).toBe(false);
  });

  it('refuses a Host header naming a host outside localhost', () => {
    // A name the attacker controls, pointed at 127.0.0.1 by DNS: the guard reads
    // the header rather than resolving it, so the name is refused.
    expect(isLocalRequest(fakeRequest({ url: '/api/stats', host: 'attacker.example.com' }))).toBe(
      false,
    );
    expect(
      isLocalRequest(fakeRequest({ url: '/api/stats', host: 'localhost.attacker.example' })),
    ).toBe(false);
    expect(
      isLocalRequest(fakeRequest({ url: '/api/stats', host: '127.0.0.1.attacker.example' })),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guard: Origin
// ---------------------------------------------------------------------------

describe('isCorsAllowed', () => {
  it('allows a request with no Origin header', () => {
    expect(isCorsAllowed(fakeRequest({ url: '/api/stats' }), ['http://localhost:4040'])).toBe(true);
  });

  it('allows a browser request from an allowed origin', () => {
    const req = fakeRequest({ url: '/api/stats', origin: 'http://localhost:4040' });
    expect(isCorsAllowed(req, ['http://localhost:4040'])).toBe(true);
  });

  it('refuses a browser request from another origin', () => {
    const req = fakeRequest({ url: '/api/stats', origin: 'http://evil.example' });
    expect(isCorsAllowed(req, ['http://localhost:4040'])).toBe(false);
  });

  it('refuses every browser request when no origin is allowed', () => {
    const req = fakeRequest({ url: '/api/stats', origin: 'http://localhost:4040' });
    expect(isCorsAllowed(req, [])).toBe(false);
  });

  it('lists this server own origin as the default set', () => {
    expect(defaultAllowedOrigins(4040)).toContain('http://127.0.0.1:4040');
    expect(defaultAllowedOrigins(4040)).toContain('http://localhost:4040');
  });
});

// ---------------------------------------------------------------------------
// The listener refuses before any handler runs
// ---------------------------------------------------------------------------

describe('createRequestListener refusals', () => {
  /** Runs the listener over a fake socket and returns what it answered. */
  async function dispatch(init: Parameters<typeof fakeRequest>[0], store: DatabaseStore) {
    const listener = createRequestListener({
      store,
      allowedOrigins: defaultAllowedOrigins(4040),
    });
    const res = new RecordedResponse();
    await listener(fakeRequest(init), res.nodeResponse);
    return res;
  }

  it('refuses a non-local remote address and writes nothing', async () => {
    const localStore = newStore();
    const res = await dispatch(
      {
        url: '/api/settings',
        method: 'PUT',
        remoteAddress: '203.0.113.5',
        host: 'localhost:4040',
        body: JSON.stringify({ key: 'theme', value: 'dark' }),
      },
      localStore,
    );

    expect(res.status).toBe(403);
    expect(res.body).toContain('Forbidden');
    // The setting would exist if any handler had run.
    expect(localStore.settings.list()).toEqual([]);
  });

  it('refuses a Host header outside localhost and writes nothing', async () => {
    const localStore = newStore();
    const res = await dispatch(
      {
        url: '/api/settings',
        method: 'PUT',
        host: 'attacker.example.com',
        body: JSON.stringify({ key: 'theme', value: 'dark' }),
      },
      localStore,
    );

    expect(res.status).toBe(403);
    expect(res.body).toContain('Forbidden');
    expect(localStore.settings.list()).toEqual([]);
  });

  it('refuses a cross-origin browser request and writes nothing', async () => {
    const localStore = newStore();
    const res = await dispatch(
      {
        url: '/api/settings',
        method: 'PUT',
        host: 'localhost:4040',
        origin: 'http://evil.example',
        body: JSON.stringify({ key: 'theme', value: 'dark' }),
      },
      localStore,
    );

    expect(res.status).toBe(403);
    expect(res.body).toContain('Forbidden');
    expect(localStore.settings.list()).toEqual([]);
  });

  it('serves the same request when the address, the Host header and the Origin are local', async () => {
    const localStore = newStore();
    const res = await dispatch(
      {
        url: '/api/settings',
        method: 'PUT',
        host: 'localhost:4040',
        origin: 'http://localhost:4040',
        body: JSON.stringify({ key: 'theme', value: 'dark' }),
      },
      localStore,
    );

    // The three refusals above are the guard working, not the endpoint failing:
    // this request is identical apart from those three values, and it is stored.
    expect(res.status).toBe(200);
    expect(localStore.settings.list().map((s) => s.key)).toEqual(['theme']);
  });
});

// ---------------------------------------------------------------------------
// Settings masking and refusal
// ---------------------------------------------------------------------------

describe('settings masking', () => {
  it('masks a setting whose name signals a credential', () => {
    expect(maskSettingValue('anthropic_api_key', 'any-value')).toBe(MASKED_PLACEHOLDER);
    expect(maskSettingValue('auth_token', 'any-value')).toBe(MASKED_PLACEHOLDER);
    expect(maskSettingValue('client_secret', 'any-value')).toBe(MASKED_PLACEHOLDER);
    expect(maskSettingValue('db_password', 'any-value')).toBe(MASKED_PLACEHOLDER);
  });

  it('masks a value the redaction rules would mask, whatever its name', () => {
    expect(maskSettingValue('config', credentialShapedValue())).toBe(MASKED_PLACEHOLDER);
    expect(maskSettingValue('contact', 'person@example.com')).toBe(MASKED_PLACEHOLDER);
  });

  it('leaves an ordinary value as written', () => {
    expect(maskSettingValue('theme', 'dark')).toBe('dark');
    expect(maskSettingValue('retention_days', '30')).toBe('30');
    expect(maskSettingValue('model', 'claude-sonnet-4-5-20250929')).toBe(
      'claude-sonnet-4-5-20250929',
    );
  });

  it('says whether the response is showing a placeholder', () => {
    expect(maskSetting({ key: 'api_key', value: 'x', updated_at: '' })).toEqual({
      key: 'api_key',
      value: MASKED_PLACEHOLDER,
      masked: true,
      updated_at: '',
    });
    expect(maskSetting({ key: 'theme', value: 'dark', updated_at: '' })).toEqual({
      key: 'theme',
      value: 'dark',
      masked: false,
      updated_at: '',
    });
  });

  it('refuses a credential-named setting write', () => {
    expect(refuseSettingWrite('openai_api_key', 'whatever')).toMatch(/keychain/);
    expect(refuseSettingWrite('session_token', 'whatever')).toMatch(/keychain/);
  });

  it('refuses a value carrying a secret under an ordinary name', () => {
    expect(refuseSettingWrite('config', credentialShapedValue())).toMatch(/secret/);
    expect(refuseSettingWrite('contact', 'person@example.com')).toMatch(/secret/);
  });

  it('allows an ordinary setting write', () => {
    expect(refuseSettingWrite('theme', 'dark')).toBeUndefined();
    expect(refuseSettingWrite('retention_days', '30')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

describe('ApiRouter', () => {
  it('matches a static route', async () => {
    const router = new ApiRouter();
    let called = false;
    router.get('/api/stats', async () => {
      called = true;
    });
    expect(
      await router.handle(fakeRequest({ url: '/api/stats' }), new RecordedResponse().nodeResponse),
    ).toBe(true);
    expect(called).toBe(true);
  });

  it('extracts path params', async () => {
    const router = new ApiRouter();
    let captured: string | undefined;
    router.get('/api/decisions/:id', async (_req, _res, params) => {
      captured = params.id;
    });
    await router.handle(
      fakeRequest({ url: '/api/decisions/abc-123' }),
      new RecordedResponse().nodeResponse,
    );
    expect(captured).toBe('abc-123');
  });

  it('ignores the query string when matching', async () => {
    const router = new ApiRouter();
    let called = false;
    router.get('/api/decisions', async () => {
      called = true;
    });
    await router.handle(
      fakeRequest({ url: '/api/decisions?limit=5' }),
      new RecordedResponse().nodeResponse,
    );
    expect(called).toBe(true);
  });

  it('returns false for an unmatched route', async () => {
    const router = new ApiRouter();
    expect(
      await router.handle(fakeRequest({ url: '/unknown' }), new RecordedResponse().nodeResponse),
    ).toBe(false);
  });

  it('does not match a route with a different method', async () => {
    const router = new ApiRouter();
    router.get('/api/stats', async () => {});
    expect(
      await router.handle(
        fakeRequest({ url: '/api/stats', method: 'POST' }),
        new RecordedResponse().nodeResponse,
      ),
    ).toBe(false);
  });

  it('matches a literal segment registered before a parameter segment', async () => {
    const router = new ApiRouter();
    const seen: string[] = [];
    router.post(
      '/api/reviews/:id/answer',
      async (_req, _res, params) => void seen.push(`answer:${params.id}`),
    );
    router.post('/api/reviews/bulk', async () => void seen.push('bulk'));
    const res = new RecordedResponse();
    await router.handle(
      fakeRequest({ url: '/api/reviews/bulk', method: 'POST' }),
      res.nodeResponse,
    );
    expect(seen).toEqual(['bulk']);
  });
});

// ---------------------------------------------------------------------------
// Body reading
// ---------------------------------------------------------------------------

describe('readJsonBody', () => {
  it('parses a JSON object', async () => {
    const req = fakeRequest({ url: '/api/settings', method: 'PUT', body: '{"key":"theme"}' });
    expect(await readJsonBody(req)).toEqual({ key: 'theme' });
  });

  it('resolves an empty body to undefined', async () => {
    const req = fakeRequest({ url: '/api/settings', method: 'PUT', body: '' });
    expect(await readJsonBody(req)).toBeUndefined();
  });

  it('rejects a body that is not JSON with a 400', async () => {
    const req = fakeRequest({ url: '/api/settings', method: 'PUT', body: 'not json' });
    await expect(readJsonBody(req)).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a body over the limit with a 413', async () => {
    const req = fakeRequest({
      url: '/api/settings',
      method: 'PUT',
      body: 'a'.repeat(MAX_BODY_BYTES + 1),
    });
    await expect(readJsonBody(req)).rejects.toMatchObject({ status: 413 });
  });

  it('answers 413 over a real socket for a body over the limit', async () => {
    const api = await startTestServer();

    const res = await request(`${api.url}/api/settings`, {
      method: 'PUT',
      body: JSON.stringify({ key: 'theme', value: 'a'.repeat(MAX_BODY_BYTES + 1024) }),
    });

    expect(res.status).toBe(413);
    expect(api.store.settings.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Endpoints over a real socket
// ---------------------------------------------------------------------------

describe('GET /api/stats', () => {
  it('reports zero counts on an empty store', async () => {
    const api = await startTestServer();

    const res = await request(`${api.url}/api/stats`);
    expect(res.status).toBe(200);
    const body = res.json() as Record<string, unknown>;
    const decisions = body.decisions as Record<string, unknown>;
    expect(decisions.total).toBe(0);
    expect(decisions.fast_path_share).toBe(0);
  });

  it('counts the fast path share from the recorded paths', async () => {
    const api = await startTestServer();

    api.store.decisions.create({
      decision_type: 'check',
      question: 'Cookie banner?',
      answer: 'true',
      confidence: 1,
      path: 'memory',
    });
    api.store.decisions.create({
      decision_type: 'check',
      question: 'Captcha?',
      answer: 'true',
      confidence: 0.9,
      path: 'pattern',
    });
    api.store.decisions.create({
      decision_type: 'check',
      question: 'Login wall?',
      answer: 'false',
      confidence: 0.4,
      path: 'ai',
      needs_review: true,
    });

    const body = (await request(`${api.url}/api/stats`)).json() as Record<string, unknown>;
    const decisions = body.decisions as Record<string, unknown>;
    expect(decisions.total).toBe(3);
    expect(decisions.fast).toBe(2);
    expect(decisions.ai).toBe(1);
    expect(decisions.pending_review).toBe(1);
    expect(decisions.fast_path_share).toBeCloseTo(2 / 3, 4);
  });

  it('counts the active drift alerts, and not the ones that were resolved', async () => {
    const api = await startTestServer();
    expect(
      ((await request(`${api.url}/api/stats`)).json() as Record<string, unknown>).drift_alerts,
    ).toEqual({
      active: 0,
    });

    api.store.patterns.create({
      id: 'learned-drift',
      name: 'learned-drift',
      decision_type: 'check',
      rules: '{}',
      status: 'disabled',
      confidence: 0.9,
      is_safety: false,
    });
    const base = {
      pattern_id: 'learned-drift',
      sample_count: 20,
      agreed_count: 10,
      disagreed_count: 10,
      accuracy: 0.5,
      threshold: 0.9,
      message: 'disabled',
    };
    api.store.driftAlerts.create({ ...base, status: 'active' });
    api.store.driftAlerts.create({ ...base, status: 'resolved' });

    const body = (await request(`${api.url}/api/stats`)).json() as Record<string, unknown>;
    expect(body.drift_alerts).toEqual({ active: 1 });
  });

  it('reports no latency or token figure, because none is measured', async () => {
    const api = await startTestServer();

    const body = (await request(`${api.url}/api/stats`)).json() as Record<string, unknown>;
    const keys = JSON.stringify(body).toLowerCase();
    expect(keys).not.toContain('latency');
    expect(keys).not.toContain('token');
  });
});

describe('GET /api/decisions', () => {
  it('returns an empty list when no decisions exist', async () => {
    const api = await startTestServer();

    const res = await request(`${api.url}/api/decisions`);
    expect(res.status).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.total).toBe(0);
    expect(body.items).toEqual([]);
  });

  it('returns a stored decision and honours the filters', async () => {
    const api = await startTestServer();

    api.store.decisions.create({
      decision_type: 'check',
      question: 'Cookie banner?',
      answer: 'true',
      confidence: 1,
      path: 'memory',
      domain: 'example.test',
    });
    api.store.decisions.create({
      decision_type: 'check',
      question: 'Captcha?',
      answer: 'true',
      confidence: 0.8,
      path: 'pattern',
      domain: 'other.test',
    });

    const all = (await request(`${api.url}/api/decisions`)).json() as Record<string, unknown>;
    expect(all.total).toBe(2);

    const filtered = (
      await request(`${api.url}/api/decisions?domain=example.test`)
    ).json() as Record<string, unknown>;
    expect(filtered.total).toBe(1);

    const byPath = (await request(`${api.url}/api/decisions?path=pattern`)).json() as Record<
      string,
      unknown
    >;
    expect(byPath.total).toBe(1);
  });

  it('caps the page size', async () => {
    const api = await startTestServer();
    api.store.decisions.create({
      decision_type: 'check',
      question: 'Q',
      answer: 'true',
      confidence: 1,
      path: 'memory',
    });
    const body = (await request(`${api.url}/api/decisions?limit=9999`)).json() as Record<
      string,
      unknown
    >;
    expect(body.limit).toBe(500);
  });
});

describe('GET /api/decisions/:id', () => {
  it('returns the decision for a known id', async () => {
    const api = await startTestServer();

    const created = api.store.decisions.create({
      decision_type: 'check',
      question: 'Login wall?',
      answer: 'false',
      confidence: 1,
      path: 'pattern',
    });
    const res = await request(`${api.url}/api/decisions/${created.id}`);
    expect(res.status).toBe(200);
    expect((res.json() as Record<string, unknown>).id).toBe(created.id);
  });

  it('returns 404 for an unknown id', async () => {
    const api = await startTestServer();
    expect((await request(`${api.url}/api/decisions/nonexistent`)).status).toBe(404);
  });
});

describe('GET /api/reviews', () => {
  it('returns only the decisions waiting for a person', async () => {
    const api = await startTestServer();

    api.store.decisions.create({
      decision_type: 'check',
      question: 'Captcha present?',
      answer: 'true',
      confidence: 0.5,
      path: 'human',
      needs_review: true,
    });
    api.store.decisions.create({
      decision_type: 'check',
      question: 'Cookie banner?',
      answer: 'false',
      confidence: 1,
      path: 'memory',
      needs_review: false,
    });

    const body = (await request(`${api.url}/api/reviews`)).json() as Record<string, unknown>;
    expect(body.total).toBe(1);
    expect((body.items as unknown[]).length).toBe(1);
  });
});

describe('POST /api/reviews/:id/answer', () => {
  it('stores the answer and clears the review flag', async () => {
    const api = await startTestServer();

    const created = api.store.decisions.create({
      decision_type: 'check',
      question: 'Payment action?',
      answer: 'false',
      confidence: 0.6,
      path: 'human',
      needs_review: true,
    });

    const res = await request(`${api.url}/api/reviews/${created.id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ correct_value: 'true', note: 'Confirmed a payment button' }),
    });
    expect(res.status).toBe(201);

    const body = res.json() as Record<string, Record<string, unknown>>;
    expect(body.feedback.decision_id).toBe(created.id);
    expect(body.feedback.correct_value).toBe('true');
    expect(body.feedback.source).toBe('user');
    expect(body.review_cleared).toBe(true);
    // What the answer changed, reported by the feedback function itself: this
    // decision came from no pattern, so the pattern report is null, not invented.
    expect(body.recorded.status).toBe('recorded');
    expect(body.recorded.memory_confirmed).toBe(true);
    expect(body.recorded.pattern).toBeNull();

    const updated = api.store.decisions.getById(created.id);
    expect(updated?.needs_review).toBe(0);
    // The decision keeps the path and confidence it was recorded with: answering
    // it does not rewrite how the answer was produced.
    expect(updated?.path).toBe('human');
    expect(updated?.confidence).toBe(0.6);
  });

  it('reports a pattern sample when the answer came from a pattern', async () => {
    const api = await startTestServer();

    const pattern = api.store.patterns.create({
      name: 'cookie-banner',
      decision_type: 'check',
      rules: JSON.stringify({ text_match: 'Accept Cookies' }),
    });
    const created = api.store.decisions.create({
      decision_type: 'check',
      question: 'Cookie banner?',
      answer: 'true',
      confidence: 0.7,
      path: 'pattern',
      pattern_id: pattern.id,
      needs_review: true,
    });

    const res = await request(`${api.url}/api/reviews/${created.id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ correct_value: false }),
    });
    expect(res.status).toBe(201);

    const body = res.json() as Record<string, Record<string, unknown>>;
    const report = body.recorded.pattern as Record<string, unknown>;
    expect(report.pattern_id).toBe(pattern.id);
    expect(report.sample_recorded).toBe(true);
    expect(report.agreed).toBe(false);
    expect(report.disagreed_count).toBe(1);
  });

  it('rejects a correct_value the decision type cannot hold', async () => {
    const api = await startTestServer();

    const created = api.store.decisions.create({
      decision_type: 'check',
      question: 'Cookie banner?',
      answer: 'false',
      confidence: 0.5,
      path: 'ai',
      needs_review: true,
    });

    const res = await request(`${api.url}/api/reviews/${created.id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ correct_value: 'maybe later' }),
    });
    expect(res.status).toBe(400);
    expect(api.store.feedback.getByDecisionId(created.id)).toEqual([]);
    // The item stays in the queue: a refused answer must not look answered.
    expect(api.store.decisions.getById(created.id)?.needs_review).toBe(1);
  });

  it('redacts the note before storing it', async () => {
    const api = await startTestServer();

    const created = api.store.decisions.create({
      decision_type: 'check',
      question: 'Login wall?',
      answer: 'false',
      confidence: 0.4,
      path: 'ai',
      needs_review: true,
    });

    const res = await request(`${api.url}/api/reviews/${created.id}/answer`, {
      method: 'POST',
      body: JSON.stringify({
        correct_value: 'true',
        note: 'write to person@example.test to confirm',
      }),
    });
    expect(res.status).toBe(201);

    const stored = api.store.feedback.getByDecisionId(created.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.note).not.toContain('person@example.test');
    expect(stored[0]?.note).toContain('[REDACTED:EMAIL]');
  });

  it('returns 404 for an unknown decision', async () => {
    const api = await startTestServer();
    const res = await request(`${api.url}/api/reviews/nope/answer`, {
      method: 'POST',
      body: JSON.stringify({ correct_value: 'true' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 when correct_value is missing', async () => {
    const api = await startTestServer();
    const created = api.store.decisions.create({
      decision_type: 'check',
      question: 'Destructive action?',
      answer: 'false',
      confidence: 0.9,
      path: 'pattern',
      needs_review: true,
    });
    const res = await request(`${api.url}/api/reviews/${created.id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ note: 'no value here' }),
    });
    expect(res.status).toBe(400);
    expect(api.store.feedback.getByDecisionId(created.id)).toEqual([]);
  });

  it('returns 400 for a body that is not an object', async () => {
    const api = await startTestServer();
    const res = await request(`${api.url}/api/reviews/anything/answer`, {
      method: 'POST',
      body: JSON.stringify(['not', 'an', 'object']),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/reviews/bulk', () => {
  it('stores each answer and reports per-item errors without aborting', async () => {
    const api = await startTestServer();

    const first = api.store.decisions.create({
      decision_type: 'check',
      question: 'Q1',
      answer: 'true',
      confidence: 0.7,
      path: 'human',
      needs_review: true,
    });
    const second = api.store.decisions.create({
      decision_type: 'check',
      question: 'Q2',
      answer: 'false',
      confidence: 0.6,
      path: 'human',
      needs_review: true,
    });

    const res = await request(`${api.url}/api/reviews/bulk`, {
      method: 'POST',
      body: JSON.stringify({
        answers: [
          { decision_id: first.id, correct_value: 'true' },
          { decision_id: 'nonexistent', correct_value: 'false' },
          { decision_id: second.id, correct_value: 'false', note: 'looked right' },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.processed).toBe(2);
    expect(body.errors).toEqual([{ index: 1, error: 'Decision nonexistent not found' }]);
    expect(api.store.decisions.getById(second.id)?.needs_review).toBe(0);
  });

  it('returns 400 when answers is not an array', async () => {
    const api = await startTestServer();
    const res = await request(`${api.url}/api/reviews/bulk`, {
      method: 'POST',
      body: JSON.stringify({ answers: 'nope' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/settings', () => {
  it('returns an empty list on a fresh store', async () => {
    const api = await startTestServer();
    const body = (await request(`${api.url}/api/settings`)).json() as Record<string, unknown>;
    expect(body.settings).toEqual([]);
  });

  it('never returns a credential value or a masked value', async () => {
    const api = await startTestServer();

    api.store.settings.set('theme', 'dark');
    // A credential-shaped value written under a name that signals nothing.
    api.store.settings.set('config', credentialShapedValue());

    const res = await request(`${api.url}/api/settings`);
    expect(res.status).toBe(200);
    expect(res.body).not.toContain(credentialShapedValue());

    const body = res.json() as { settings: { key: string; value: string; masked: boolean }[] };
    const config = body.settings.find((s) => s.key === 'config');
    const theme = body.settings.find((s) => s.key === 'theme');
    expect(config?.value).toBe(MASKED_PLACEHOLDER);
    expect(config?.masked).toBe(true);
    expect(theme?.value).toBe('dark');
    expect(theme?.masked).toBe(false);
  });
});

describe('PUT /api/settings', () => {
  it('stores a setting and returns it unmasked', async () => {
    const api = await startTestServer();

    const res = await request(`${api.url}/api/settings`, {
      method: 'PUT',
      body: JSON.stringify({ key: 'retention_days', value: '30' }),
    });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({
      setting: {
        key: 'retention_days',
        value: '30',
        masked: false,
        updated_at: expect.any(String),
      },
    });
    expect(api.store.settings.getValue('retention_days')).toBe('30');
  });

  it('refuses a credential-named key and stores nothing', async () => {
    const api = await startTestServer();

    const res = await request(`${api.url}/api/settings`, {
      method: 'PUT',
      body: JSON.stringify({ key: 'anthropic_api_key', value: 'anything' }),
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain('keychain');
    expect(api.store.settings.list()).toEqual([]);
  });

  it('refuses a value carrying a secret under an ordinary name', async () => {
    const api = await startTestServer();

    const res = await request(`${api.url}/api/settings`, {
      method: 'PUT',
      body: JSON.stringify({ key: 'config', value: credentialShapedValue() }),
    });
    expect(res.status).toBe(400);
    expect(api.store.settings.get('config')).toBeNull();
  });

  it('returns 400 when the key or the value is missing', async () => {
    const api = await startTestServer();

    expect(
      (
        await request(`${api.url}/api/settings`, {
          method: 'PUT',
          body: JSON.stringify({ value: 'dark' }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`${api.url}/api/settings`, {
          method: 'PUT',
          body: JSON.stringify({ key: 'theme' }),
        })
      ).status,
    ).toBe(400);
  });
});

describe('GET /api/packs', () => {
  it('returns the stored packs and honours the active filter', async () => {
    const api = await startTestServer();

    api.store.packs.create({
      id: 'browser-v1',
      name: 'Browser Pack',
      version: '1.0.0',
      is_active: true,
    });
    api.store.packs.create({ id: 'old-v1', name: 'Old Pack', version: '0.9.0', is_active: false });

    const all = (await request(`${api.url}/api/packs`)).json() as Record<string, unknown>;
    expect((all.items as unknown[]).length).toBe(2);

    const active = (await request(`${api.url}/api/packs?active=true`)).json() as Record<
      string,
      unknown
    >;
    expect((active.items as unknown[]).length).toBe(1);
  });
});

describe('GET /api/patterns', () => {
  it('returns the stored patterns and honours the status filter', async () => {
    const api = await startTestServer();

    api.store.patterns.create({
      name: 'cookie-banner',
      decision_type: 'check',
      rules: JSON.stringify({ text_match: 'Accept Cookies' }),
      status: 'active',
    });
    api.store.patterns.create({
      name: 'login-wall',
      decision_type: 'check',
      rules: JSON.stringify({ text_match: 'Sign in to continue' }),
      status: 'candidate',
    });

    const all = (await request(`${api.url}/api/patterns`)).json() as Record<string, unknown>;
    expect((all.items as unknown[]).length).toBe(2);

    const active = (await request(`${api.url}/api/patterns?status=active`)).json() as Record<
      string,
      unknown
    >;
    expect((active.items as unknown[]).length).toBe(1);
  });
});

describe('unknown routes', () => {
  it('returns 404 as JSON for an unregistered API path', async () => {
    const api = await startTestServer();
    const res = await request(`${api.url}/api/unknown`);
    expect(res.status).toBe(404);
    expect(res.json()).toEqual({ error: 'Not found' });
  });
});

describe('refusals over a real socket', () => {
  it('refuses a request whose Host header is not local', async () => {
    const api = await startTestServer();

    const res = await request(`${api.url}/api/stats`, {
      headers: { Host: 'attacker.example.com' },
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain('Forbidden');
  });

  it('refuses a cross-origin browser request', async () => {
    const api = await startTestServer();

    const res = await request(`${api.url}/api/stats`, {
      headers: { Origin: 'http://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('allows a browser request from the UI origin on its own port', async () => {
    const api = await startTestServer();

    const res = await request(`${api.url}/api/stats`, {
      headers: { Origin: `http://127.0.0.1:${api.port}` },
    });
    expect(res.status).toBe(200);
  });

  it('refuses a request with no Host header', async () => {
    const api = await startTestServer();

    // The HTTP client always sends a Host header, so the request is written by
    // hand over HTTP/1.0, where a Host header is optional. HTTP/1.1 would be
    // refused by Node's own parser before the guard ever saw it.
    const status = await rawStatus(api.url, 'GET /api/stats HTTP/1.0\r\n\r\n');
    expect(status).toBe(403);
  });
});

/**
 * Sends a request line verbatim over a socket and returns the status code. Used
 * for the request shapes the HTTP client cannot express, such as no Host header.
 */
function rawStatus(baseUrl: string, requestText: string): Promise<number> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: Number(url.port) }, () => {
      socket.end(requestText);
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      const head = Buffer.concat(chunks).toString('utf8').split('\r\n')[0] ?? '';
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(head);
      resolve(match === null ? 0 : Number(match[1]));
    });
  });
}

// ---------------------------------------------------------------------------
// The same process serves the built UI
// ---------------------------------------------------------------------------

describe('static UI serving', () => {
  it('binds to 127.0.0.1 and to nothing else', async () => {
    const api = await startTestServer();

    const address = api.server.address();
    expect(typeof address === 'object' && address !== null ? address.address : null).toBe(
      '127.0.0.1',
    );
    expect(api.address.startsWith('http://127.0.0.1:')).toBe(true);
  });

  it('serves the app shell at the root of the configured directory', async () => {
    const api = await startTestServer({ staticDir: makeUiFixture() });

    const res = await request(`${api.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('local ui');
  });

  it('serves a built asset with its own content type', async () => {
    const api = await startTestServer({ staticDir: makeUiFixture() });

    const js = await request(`${api.url}/assets/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.body).toContain('ui');

    const css = await request(`${api.url}/assets/app.css`);
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
  });

  it('answers a client-side route with the app shell', async () => {
    const api = await startTestServer({ staticDir: makeUiFixture() });

    const res = await request(`${api.url}/reviews`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('local ui');
  });

  it('returns 404 for a missing asset rather than the shell', async () => {
    const api = await startTestServer({ staticDir: makeUiFixture() });

    const res = await request(`${api.url}/assets/missing.js`);
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('local ui');
  });

  it('refuses a path that leaves the UI directory', async () => {
    const api = await startTestServer({ staticDir: makeUiFixture() });

    // The path is passed verbatim because a URL parser would collapse the dot
    // segments before the request is sent, which is exactly what must be tested.
    const encoded = await request(api.url, { path: '/%2e%2e/%2e%2e/etc/passwd' });
    expect(encoded.status).toBe(403);

    const plain = await request(api.url, { path: '/../../etc/passwd' });
    expect(plain.status).toBe(403);

    expect(resolveWithinRoot('/srv/ui', '/../secret')).toBeNull();
    expect(resolveWithinRoot('/srv/ui', '/%2e%2e/secret')).toBeNull();
    expect(resolveWithinRoot('/srv/ui', '/assets/app.js')).not.toBeNull();
  });

  it('refuses a write to a UI path', async () => {
    const api = await startTestServer({ staticDir: makeUiFixture() });

    const res = await request(`${api.url}/`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(405);
  });

  it('says no UI is served when no directory is configured', async () => {
    const api = await startTestServer();

    const res = await request(`${api.url}/`);
    expect(res.status).toBe(404);
    expect((res.json() as Record<string, string>).error).toContain('Not found');
  });

  it('says no build is present when the directory holds no index.html', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'browserreflex-ui-empty-'));
    tempDirs.push(empty);
    const api = await startTestServer({ staticDir: empty });

    const res = await request(`${api.url}/`);
    expect(res.status).toBe(404);
    expect((res.json() as Record<string, string>).error).toContain('No local UI build');
  });

  it('keeps the API reachable while the UI is served', async () => {
    const api = await startTestServer({ staticDir: makeUiFixture() });

    expect((await request(`${api.url}/api/stats`)).status).toBe(200);
    expect((await request(`${api.url}/`)).status).toBe(200);
  });

  it('refuses a cross-origin page load from another site', async () => {
    const api = await startTestServer({ staticDir: makeUiFixture() });

    const res = await request(`${api.url}/`, { headers: { Origin: 'http://evil.example' } });
    expect(res.status).toBe(403);
  });
});
