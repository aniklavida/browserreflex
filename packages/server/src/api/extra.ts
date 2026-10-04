/**
 * The rest of the local REST API: the live stream, sessions, pack and pattern switches,
 * provider keys, backup and retention, the integrations list and the analytics endpoints.
 *
 * Status: **implemented and tested** in `packages/server/test/api-extra.test.ts`.
 *
 * Invariants, each with a named test:
 * - **A key is never returned.** `GET /api/keys` says whether a key is stored and shows the
 *   masked form (first seven characters, dots, last four); no route returns the key itself,
 *   and a key is never written to the settings table, a log line or an error message.
 * - **A safety rule cannot be switched off here.** A pattern flagged safety cannot be
 *   disabled, and switching a pack off turns off its non-safety rules only.
 * - **Nothing is repaired silently.** A bad body is a 4xx that says why and stores nothing.
 * - **The safety check stays advisory.** These routes read and record; none of them stops an
 *   agent from acting.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createAnthropicAdapter } from '../adapters/anthropic.js';
import { AdapterError } from '../adapters/types.js';
import { resolveKeyStore, type KeyStore } from '../security/keys.js';
import type { DatabaseStore } from '../store/index.js';
import type { Pattern } from '../store/types.js';
import {
  boolParam,
  errorResponse,
  errorStatus,
  intParam,
  jsonResponse,
  parseQuery,
  readJsonBody,
  UNREADABLE_BODY,
} from './http.js';
import type { ApiRouter, RouteParams } from './router.js';

/** The providers a key can be stored for. */
export const KEY_PROVIDERS = ['anthropic'] as const;
export type KeyProvider = (typeof KEY_PROVIDERS)[number];

/** Longest key the API accepts. Provider keys are far shorter. */
export const MAX_KEY_LENGTH = 512;

export interface KeyTestResult {
  readonly ok: boolean;
  readonly provider: string;
  readonly model?: string | undefined;
  readonly latency_ms?: number | undefined;
  /** What went wrong, from the adapter's own error code. Never a response body or a key. */
  readonly error?: string | undefined;
}

export type KeyTester = (provider: KeyProvider, keyStore: KeyStore) => Promise<KeyTestResult>;

export interface ApiDeps {
  /** Where provider keys live. Defaults to the operating system keychain, else an encrypted file. */
  readonly keyStore?: KeyStore | undefined;
  /** Runs one small call to the provider. Defaults to a single Anthropic request. */
  readonly keyTester?: KeyTester | undefined;
  /** The home directory the agent configurations are read from. */
  readonly home?: string | undefined;
  /** How often the live stream looks for new decisions, in milliseconds. */
  readonly streamPollMs?: number | undefined;
}

export const DEFAULT_STREAM_POLL_MS = 1000;
const STREAM_BATCH = 100;
const HEARTBEAT_MS = 15_000;

async function readObjectBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | undefined> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    errorResponse(res, errorStatus(err), err instanceof Error ? err.message : UNREADABLE_BODY);
    return undefined;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    errorResponse(res, 400, 'Request body must be a JSON object');
    return undefined;
  }
  return body as Record<string, unknown>;
}

const FAST = "('memory', 'pattern', 'check')";

export function registerExtraRoutes(
  router: ApiRouter,
  store: DatabaseStore,
  deps: ApiDeps = {},
): void {
  let resolvedKeyStore: KeyStore | undefined = deps.keyStore;
  const keyStore = async (): Promise<KeyStore> => {
    if (resolvedKeyStore === undefined) {
      resolvedKeyStore = (await resolveKeyStore()).store;
    }
    return resolvedKeyStore;
  };

  // ---- live stream ------------------------------------------------------

  router.get('/api/stream', async (req, res) => {
    const pollMs = deps.streamPollMs ?? DEFAULT_STREAM_POLL_MS;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');

    const latest = store.db
      .prepare('SELECT COALESCE(MAX(rowid), 0) AS rid FROM decisions')
      .get() as {
      rid: number;
    };
    let cursor = latest.rid;

    const poll = (): void => {
      try {
        const rows = store.db
          .prepare('SELECT rowid AS rid, * FROM decisions WHERE rowid > ? ORDER BY rowid LIMIT ?')
          .all(cursor, STREAM_BATCH) as Array<{ rid: number } & Record<string, unknown>>;
        for (const row of rows) {
          cursor = row.rid;
          const { rid: _rid, ...decision } = row;
          void _rid;
          res.write(`event: decision\ndata: ${JSON.stringify(decision)}\n\n`);
        }
      } catch {
        // A poll that fails is tried again on the next tick; the stream stays open.
      }
    };

    const timer = setInterval(poll, pollMs);
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), HEARTBEAT_MS);
    const stop = (): void => {
      clearInterval(timer);
      clearInterval(heartbeat);
    };
    req.on('close', stop);
    res.on('close', stop);
  });

  // ---- sessions ---------------------------------------------------------

  router.get('/api/sessions', async (req, res) => {
    const q = parseQuery(req.url ?? '/');
    const limit = intParam(q.limit, 50, 1, 200);
    const items = store.db
      .prepare(
        `SELECT d.session_id AS id, s.agent_name AS agent_name, COUNT(*) AS decisions,
                SUM(CASE WHEN d.path IN ${FAST} THEN 1 ELSE 0 END) AS fast,
                SUM(CASE WHEN d.path = 'ai' THEN 1 ELSE 0 END) AS ai,
                SUM(CASE WHEN d.path = 'human' THEN 1 ELSE 0 END) AS human,
                MIN(d.created_at) AS first_at, MAX(d.created_at) AS last_at
           FROM decisions d LEFT JOIN sessions s ON s.id = d.session_id
          WHERE d.session_id IS NOT NULL
          GROUP BY d.session_id
          ORDER BY last_at DESC
          LIMIT ?`,
      )
      .all(limit);
    jsonResponse(res, 200, { items, limit });
  });

  // ---- pack and pattern switches ---------------------------------------

  router.put('/api/packs/:id', async (req, res, params: RouteParams) => {
    const body = await readObjectBody(req, res);
    if (body === undefined) return;
    if (typeof body.active !== 'boolean') {
      errorResponse(res, 400, 'active is required and must be true or false');
      return;
    }
    const id = params.id ?? '';
    if (store.packs.getById(id) === null) {
      errorResponse(res, 404, `No pack with id "${id}"`);
      return;
    }
    const pack = store.packs.update(id, { is_active: body.active ? 1 : 0 });
    jsonResponse(res, 200, {
      pack,
      note: body.active
        ? 'The pack is on.'
        : 'The pack is off: its non-safety rules stop answering and those questions go to the slow path. Its safety rules keep working.',
    });
  });

  router.put('/api/patterns/:id', async (req, res, params: RouteParams) => {
    const body = await readObjectBody(req, res);
    if (body === undefined) return;
    if (body.status !== 'active' && body.status !== 'disabled') {
      errorResponse(res, 400, 'status is required and must be "active" or "disabled"');
      return;
    }
    const id = params.id ?? '';
    const pattern = store.patterns.getById(id);
    if (pattern === null) {
      errorResponse(res, 404, `No pattern with id "${id}"`);
      return;
    }
    if (pattern.is_safety || isSafetyPackRule(store, pattern)) {
      errorResponse(res, 403, 'A safety rule cannot be switched from here');
      return;
    }
    if (body.status === 'active' && store.promotionEvents.listByPatternId(id).length === 0) {
      errorResponse(
        res,
        400,
        'Only a pattern that promotion made active can be switched on. A shadow candidate earns its promotion from samples.',
      );
      return;
    }
    const updated = store.patterns.update(id, { status: body.status });
    jsonResponse(res, 200, { pattern: updated });
  });

  router.get('/api/pattern-stats', async (_req, res) => {
    const rows = store.db
      .prepare(
        `SELECT p.id AS pattern_id, COALESCE(s.sample_count, 0) AS sample_count,
                COALESCE(s.agreed_count, 0) AS agreed_count,
                COALESCE(s.disagreed_count, 0) AS disagreed_count
           FROM patterns p LEFT JOIN pattern_stats s ON s.pattern_id = p.id`,
      )
      .all();
    jsonResponse(res, 200, { items: rows });
  });

  // ---- keys ---------------------------------------------------------------

  router.get('/api/keys', async (_req, res) => {
    const keys = await keyStore();
    const items = [];
    for (const provider of KEY_PROVIDERS) {
      const has = await keys.hasKey(provider);
      items.push({
        provider,
        has_key: has,
        masked: has ? await keys.maskKey(provider) : '',
        backend: keys.backend,
      });
    }
    jsonResponse(res, 200, { items });
  });

  router.put('/api/keys', async (req, res) => {
    const body = await readObjectBody(req, res);
    if (body === undefined) return;
    const provider = body.provider;
    if (typeof provider !== 'string' || !(KEY_PROVIDERS as readonly string[]).includes(provider)) {
      errorResponse(res, 400, `provider must be one of: ${KEY_PROVIDERS.join(', ')}`);
      return;
    }
    const key = body.key;
    if (typeof key !== 'string' || key.trim() === '') {
      errorResponse(res, 400, 'key is required');
      return;
    }
    if (key.length > MAX_KEY_LENGTH || /\s/.test(key)) {
      errorResponse(res, 400, 'key is not a plausible provider key');
      return;
    }
    const keys = await keyStore();
    try {
      await keys.setKey(provider, key);
    } catch {
      // The reason can carry nothing about the key, but it is not worth echoing either.
      errorResponse(res, 500, 'The key could not be stored');
      return;
    }
    jsonResponse(res, 200, {
      provider,
      has_key: true,
      masked: await keys.maskKey(provider),
      backend: keys.backend,
    });
  });

  router.on('DELETE', '/api/keys/:provider', async (_req, res, params: RouteParams) => {
    const provider = params.provider ?? '';
    if (!(KEY_PROVIDERS as readonly string[]).includes(provider)) {
      errorResponse(res, 404, `No provider "${provider}"`);
      return;
    }
    const removed = await (await keyStore()).deleteKey(provider);
    jsonResponse(res, 200, { provider, removed });
  });

  router.post('/api/keys/test', async (req, res) => {
    const body = await readObjectBody(req, res);
    if (body === undefined) return;
    const provider = body.provider;
    if (typeof provider !== 'string' || !(KEY_PROVIDERS as readonly string[]).includes(provider)) {
      errorResponse(res, 400, `provider must be one of: ${KEY_PROVIDERS.join(', ')}`);
      return;
    }
    const keys = await keyStore();
    if (!(await keys.hasKey(provider))) {
      jsonResponse(res, 200, { ok: false, provider, error: 'no_key' });
      return;
    }
    const tester = deps.keyTester ?? defaultKeyTester(store);
    try {
      jsonResponse(res, 200, await tester(provider as KeyProvider, keys));
    } catch {
      jsonResponse(res, 200, { ok: false, provider, error: 'transport' });
    }
  });

  // ---- data: info, backup, retention -------------------------------------

  router.get('/api/data', async (_req, res) => {
    const file = store.db.name;
    const total = store.decisions.count();
    const oldest = store.db.prepare('SELECT MIN(created_at) AS oldest FROM decisions').get() as {
      oldest: string | null;
    };
    const retention = store.settings.getValue('retention_days');
    jsonResponse(res, 200, {
      database_file: file === ':memory:' ? null : basename(file),
      size_bytes: file !== ':memory:' && existsSync(file) ? statSync(file).size : null,
      decisions: total,
      oldest_decision: oldest.oldest,
      retention_days: retention === null ? null : Number(retention),
      backups: listBackups(file),
    });
  });

  router.post('/api/backup', async (_req, res) => {
    const file = store.db.name;
    if (file === ':memory:') {
      errorResponse(res, 400, 'An in-memory database cannot be backed up');
      return;
    }
    const directory = join(dirname(file), 'backups');
    mkdirSync(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = join(directory, `browserreflex-${stamp}.db`);
    // better-sqlite3's online backup keeps a consistent copy while the database is in use.
    await store.db.backup(target);
    jsonResponse(res, 200, {
      file: basename(target),
      size_bytes: statSync(target).size,
      created_at: new Date().toISOString(),
    });
  });

  router.post('/api/retention/purge', async (req, res) => {
    const body = await readObjectBody(req, res);
    if (body === undefined) return;
    const days = body.days;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1) {
      errorResponse(res, 400, 'days is required and must be a whole number of at least 1');
      return;
    }
    if (body.confirm !== true) {
      errorResponse(res, 400, 'Purging deletes decisions for good: send confirm: true');
      return;
    }
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const result = store.db.prepare('DELETE FROM decisions WHERE created_at < ?').run(cutoff);
    jsonResponse(res, 200, { deleted: result.changes, cutoff });
  });

  // ---- integrations -------------------------------------------------------

  router.get('/api/integrations', async (_req, res) => {
    const home = deps.home ?? process.env.BROWSERREFLEX_HOME ?? homedir();
    jsonResponse(res, 200, { clients: detectClients(home) });
  });

  // ---- analytics ----------------------------------------------------------

  router.get('/api/analytics/quality', async (req, res) => {
    const q = parseQuery(req.url ?? '/');
    const from = q.from ?? '0000';
    // Decisions a person or an agent later corrected: stated confidence against what turned
    // out right. A bin with no corrected decisions is reported with a null actual.
    const rows = store.db
      .prepare(
        `SELECT d.confidence AS confidence, d.answer AS answer, d.pattern_id AS pattern_id,
                f.correct_value AS correct
           FROM decisions d JOIN feedback f ON f.decision_id = d.id
          WHERE d.created_at >= ? AND d.path != 'human' AND d.answer != 'pending'`,
      )
      .all(from) as Array<{
      confidence: number;
      answer: string;
      pattern_id: string | null;
      correct: string;
    }>;
    const bins = Array.from({ length: 10 }, (_unused, index) => ({
      lower: index / 10,
      upper: (index + 1) / 10,
      count: 0,
      stated_sum: 0,
      right: 0,
    }));
    const wrongBy = new Map<string, { wrong: number; total: number }>();
    for (const row of rows) {
      const bin = bins[Math.min(9, Math.floor(row.confidence * 10))]!;
      const right = row.answer.trim().toLowerCase() === row.correct.trim().toLowerCase();
      bin.count += 1;
      bin.stated_sum += row.confidence;
      if (right) bin.right += 1;
      if (row.pattern_id !== null) {
        const entry = wrongBy.get(row.pattern_id) ?? { wrong: 0, total: 0 };
        entry.total += 1;
        if (!right) entry.wrong += 1;
        wrongBy.set(row.pattern_id, entry);
      }
    }
    jsonResponse(res, 200, {
      corrected_decisions: rows.length,
      bins: bins.map((bin) => ({
        lower: bin.lower,
        upper: bin.upper,
        count: bin.count,
        stated: bin.count === 0 ? null : bin.stated_sum / bin.count,
        actual: bin.count === 0 ? null : bin.right / bin.count,
      })),
      wrong_most: [...wrongBy.entries()]
        .filter(([, value]) => value.wrong > 0)
        .map(([pattern_id, value]) => ({ pattern_id, ...value }))
        .sort((a, b) => b.wrong - a.wrong)
        .slice(0, 10),
    });
  });

  router.get('/api/analytics/safety', async (req, res) => {
    const q = parseQuery(req.url ?? '/');
    const from = q.from ?? '0000';
    const rows = store.db
      .prepare(
        `SELECT pattern_id, answer, COUNT(*) AS total
           FROM decisions WHERE is_safety = 1 AND created_at >= ?
          GROUP BY pattern_id, answer`,
      )
      .all(from) as Array<{ pattern_id: string | null; answer: string; total: number }>;
    const byFamily: Record<string, number> = {};
    const byAnswer: Record<string, number> = {};
    for (const row of rows) {
      const family = familyOfRule(row.pattern_id);
      byFamily[family] = (byFamily[family] ?? 0) + row.total;
      byAnswer[row.answer] = (byAnswer[row.answer] ?? 0) + row.total;
    }
    const domains = store.db
      .prepare(
        `SELECT COALESCE(domain, 'unknown') AS domain, COUNT(*) AS total
           FROM decisions WHERE is_safety = 1 AND created_at >= ?
          GROUP BY domain ORDER BY total DESC LIMIT 10`,
      )
      .all(from);
    jsonResponse(res, 200, {
      note: 'The safety check is advisory: these are records of requests to the user, not blocks.',
      by_family: byFamily,
      by_answer: byAnswer,
      risky_places: domains,
    });
  });

  router.get('/api/analytics/agents', async (req, res) => {
    const q = parseQuery(req.url ?? '/');
    const from = q.from ?? '0000';
    const agents = store.db
      .prepare(
        `SELECT COALESCE(s.agent_name, 'unknown') AS agent, COUNT(*) AS decisions,
                SUM(CASE WHEN d.path IN ${FAST} THEN 1 ELSE 0 END) AS fast
           FROM decisions d LEFT JOIN sessions s ON s.id = d.session_id
          WHERE d.created_at >= ? GROUP BY agent ORDER BY decisions DESC LIMIT 20`,
      )
      .all(from);
    const projects = store.db
      .prepare(
        `SELECT COALESCE(domain, 'unknown') AS project, COUNT(*) AS decisions,
                SUM(CASE WHEN path IN ${FAST} THEN 1 ELSE 0 END) AS fast
           FROM decisions WHERE created_at >= ? GROUP BY project ORDER BY decisions DESC LIMIT 20`,
      )
      .all(from);
    jsonResponse(res, 200, { agents, projects });
  });

  router.get('/api/drift', async (_req, res) => {
    const alerts = store.driftAlerts.list({ limit: 50 });
    const accuracy = store.db
      .prepare(
        `SELECT pattern_id, COUNT(*) AS rechecks, SUM(agreed) AS agreed
           FROM rechecks WHERE status = 'completed' GROUP BY pattern_id`,
      )
      .all() as Array<{ pattern_id: string; rechecks: number; agreed: number }>;
    jsonResponse(res, 200, {
      threshold: Number(store.settings.getValue('monitor.demotion_threshold') ?? 0.9),
      alerts,
      patterns: accuracy.map((row) => ({
        pattern_id: row.pattern_id,
        rechecks: row.rechecks,
        accuracy: row.rechecks === 0 ? null : row.agreed / row.rechecks,
      })),
    });
  });

  router.on('PUT', '/api/drift/:id', async (req, res, params: RouteParams) => {
    const body = await readObjectBody(req, res);
    if (body === undefined) return;
    if (body.status !== 'acknowledged' && body.status !== 'resolved') {
      errorResponse(res, 400, 'status must be "acknowledged" or "resolved"');
      return;
    }
    const id = params.id ?? '';
    const result = store.db
      .prepare('UPDATE drift_alerts SET status = ? WHERE id = ?')
      .run(body.status, id);
    if (result.changes === 0) {
      errorResponse(res, 404, `No drift alert with id "${id}"`);
      return;
    }
    jsonResponse(res, 200, { id, status: body.status });
  });

  // ---- logs export --------------------------------------------------------

  router.get('/api/export/decisions.csv', async (req, res) => {
    const q = parseQuery(req.url ?? '/');
    const filter: Parameters<DatabaseStore['decisions']['list']>[0] = {
      limit: intParam(q.limit, 5000, 1, 20_000),
    };
    if (q.q !== undefined) filter.search = q.q.slice(0, 200);
    if (q.from !== undefined) filter.created_from = q.from;
    if (q.to !== undefined) filter.created_to = q.to;
    const isSafety = boolParam(q.is_safety);
    if (isSafety !== undefined) filter.is_safety = isSafety;
    const rows = store.decisions.list(filter);
    const header = [
      'id',
      'created_at',
      'decision_type',
      'question',
      'answer',
      'confidence',
      'path',
      'latency_ms',
      'pattern_id',
      'domain',
      'is_safety',
    ];
    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push(
        [
          row.id,
          row.created_at,
          row.decision_type,
          row.question,
          row.answer,
          row.confidence,
          row.path,
          row.latency_ms,
          row.pattern_id ?? '',
          row.domain ?? '',
          row.is_safety,
        ]
          .map(csvCell)
          .join(','),
      );
    }
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="decisions.csv"',
    });
    res.end(`${lines.join('\n')}\n`);
  });
}

/** One CSV cell. A cell that starts like a formula is prefixed so a spreadsheet will not run it. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function isSafetyPackRule(store: DatabaseStore, pattern: Pattern): boolean {
  // A stub row for a pack rule carries the rule id. A rule id naming a safety family is not
  // something this route switches either.
  void store;
  return /^browser\.risky\./.test(pattern.id) || /\.safety\./.test(pattern.id);
}

export function familyOfRule(ruleId: string | null): string {
  if (ruleId === null) return 'other';
  if (/\.payment\./.test(ruleId)) return 'payment';
  if (/\.destructive\./.test(ruleId)) return 'destructive';
  if (/\.outbound\./.test(ruleId)) return 'outbound';
  if (/\.secret\./.test(ruleId)) return 'secrets';
  if (/\.command\./.test(ruleId)) return 'command';
  return 'other';
}

function listBackups(
  databaseFile: string,
): Array<{ file: string; size_bytes: number; modified_at: string }> {
  if (databaseFile === ':memory:') return [];
  const directory = join(dirname(databaseFile), 'backups');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.db'))
    .map((name) => {
      const stats = statSync(join(directory, name));
      return { file: name, size_bytes: stats.size, modified_at: stats.mtime.toISOString() };
    })
    .sort((a, b) => b.modified_at.localeCompare(a.modified_at))
    .slice(0, 10);
}

interface ClientEntry {
  id: string;
  label: string;
  config_file: string;
  found: boolean;
  configured: boolean;
}

/** Which supported agents have a BrowserReflex entry in their configuration file. */
export function detectClients(home: string): ClientEntry[] {
  const targets = [
    { id: 'claude-code', label: 'Claude Code', file: '.claude.json' },
    { id: 'codex', label: 'Codex', file: join('.codex', 'config.toml') },
    { id: 'cursor', label: 'Cursor', file: join('.cursor', 'mcp.json') },
    { id: 'gemini-cli', label: 'Gemini CLI', file: join('.gemini', 'settings.json') },
  ];
  return targets.map((target) => {
    const path = join(home, target.file);
    const found = existsSync(path);
    let configured = false;
    if (found) {
      try {
        configured = /browserreflex/i.test(readFileSync(path, 'utf8'));
      } catch {
        configured = false;
      }
    }
    return {
      id: target.id,
      label: target.label,
      config_file: target.file,
      found,
      configured,
    };
  });
}

function defaultKeyTester(store: DatabaseStore): KeyTester {
  return async (provider, keys) => {
    const adapter = createAnthropicAdapter({
      keyStore: keys,
      store,
      timeoutMs: 10_000,
      retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, backoffFactor: 1 },
    });
    try {
      const result = await adapter.decide({
        questions: [{ id: 'connection_test', type: 'check', text: 'Answer true.' }],
      });
      return {
        ok: result.answers.length > 0,
        provider,
        model: result.model,
        latency_ms: result.latencyMs,
        ...(result.answers.length === 0 ? { error: 'no_answer' } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        provider,
        error: error instanceof AdapterError ? error.code : 'transport',
      };
    }
  };
}
