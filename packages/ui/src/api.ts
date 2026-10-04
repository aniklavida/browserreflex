/**
 * A small typed client for the local REST API. The UI is served by the same process as the
 * API, so every call is a relative path. Nothing here talks to another host.
 */

export type DecisionPath = 'memory' | 'pattern' | 'check' | 'ai' | 'human';
export type DecisionType = 'choice' | 'score' | 'check';

export interface Decision {
  id: string;
  session_id: string | null;
  decision_type: DecisionType;
  question: string;
  answer: string;
  confidence: number;
  path: DecisionPath;
  latency_ms: number | null;
  is_safety: number;
  needs_review: number;
  pattern_id: string | null;
  url: string | null;
  domain: string | null;
  context: string | null;
  created_at: string;
}

export interface ApiStats {
  generated_at: string;
  decisions: {
    total: number;
    fast: number;
    ai: number;
    human: number;
    pending_review: number;
    safety_stops: number;
    fast_path_share: number;
  };
  patterns: { total: number; active: number };
  packs: { total: number; active: number };
  feedback: { total: number };
  drift_alerts?: { active: number };
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Pattern {
  id: string;
  name: string | null;
  pack_id: string | null;
  decision_type: DecisionType;
  status: string;
  confidence: number | null;
  is_safety: number;
  rules?: string;
  created_at: string;
  updated_at: string;
}

export interface Pack {
  id: string;
  name: string;
  version: string;
  description: string | null;
  is_active: number;
}

export interface PatternStat {
  pattern_id: string;
  sample_count: number;
  agreed_count: number;
  disagreed_count: number;
}

export interface SessionRow {
  id: string;
  agent_name: string | null;
  decisions: number;
  fast: number;
  ai: number;
  human: number;
  first_at: string;
  last_at: string;
}

export interface KeyInfo {
  provider: string;
  has_key: boolean;
  masked: string;
  backend: string;
}

export interface KeyTestResult {
  ok: boolean;
  provider: string;
  model?: string;
  latency_ms?: number;
  error?: string;
}

export interface DataInfo {
  database_file: string | null;
  size_bytes: number | null;
  decisions: number;
  oldest_decision: string | null;
  retention_days: number | null;
  backups: { file: string; size_bytes: number; modified_at: string }[];
}

export interface Client {
  id: string;
  label: string;
  config_file: string;
  found: boolean;
  configured: boolean;
}

export interface QualityBin {
  lower: number;
  upper: number;
  count: number;
  stated: number | null;
  actual: number | null;
}

export interface Quality {
  corrected_decisions: number;
  bins: QualityBin[];
  wrong_most: { pattern_id: string; wrong: number; total: number }[];
}

export interface SafetyAnalytics {
  note: string;
  by_family: Record<string, number>;
  by_answer: Record<string, number>;
  risky_places: { domain: string; total: number }[];
}

export interface AgentsAnalytics {
  agents: { agent: string; decisions: number; fast: number }[];
  projects: { project: string; decisions: number; fast: number }[];
}

export interface DriftAlert {
  id: string;
  pattern_id: string;
  accuracy: number;
  threshold: number;
  status: string;
  message: string;
  created_at: string;
}

export interface Drift {
  threshold: number;
  alerts: DriftAlert[];
  patterns: { pattern_id: string; rechecks: number; accuracy: number | null }[];
}

export interface Setting {
  key: string;
  value: string;
}

export interface ReviewAnswerResult {
  ok?: boolean;
  recorded?: { status?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { ...init.headers, 'Content-Type': 'application/json' };
  }
  const response = await fetch(path, init);
  const text = await response.text();
  let parsed: unknown = null;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    const message =
      parsed !== null && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `Request failed with status ${response.status}`;
    throw new ApiError(message, response.status);
  }
  return parsed as T;
}

export const api = {
  stats: () => request<ApiStats>('GET', '/api/stats'),
  decisions: (query: Record<string, string | number> = {}) =>
    request<Page<Decision>>('GET', `/api/decisions${toQuery(query)}`),
  reviews: (limit = 50) => request<Page<Decision>>('GET', `/api/reviews?limit=${limit}`),
  answerReview: (id: string, correctValue: string | number | boolean, note?: string) =>
    request<ReviewAnswerResult>('POST', `/api/reviews/${encodeURIComponent(id)}/answer`, {
      correct_value: correctValue,
      ...(note ? { note } : {}),
    }),
  settings: () => request<{ settings: Setting[] }>('GET', '/api/settings'),
  putSetting: (key: string, value: unknown) =>
    request<unknown>('PUT', '/api/settings', { key, value }),
  packs: () => request<Page<Pack>>('GET', '/api/packs?limit=100'),
  setPack: (id: string, active: boolean) =>
    request<{ pack: Pack; note: string }>('PUT', `/api/packs/${encodeURIComponent(id)}`, {
      active,
    }),
  setPattern: (id: string, status: 'active' | 'disabled') =>
    request<{ pattern: Pattern }>('PUT', `/api/patterns/${encodeURIComponent(id)}`, { status }),
  patternStats: () => request<{ items: PatternStat[] }>('GET', '/api/pattern-stats'),
  sessions: () => request<{ items: SessionRow[] }>('GET', '/api/sessions?limit=100'),
  keys: () => request<{ items: KeyInfo[] }>('GET', '/api/keys'),
  putKey: (provider: string, key: string) =>
    request<KeyInfo>('PUT', '/api/keys', { provider, key }),
  deleteKey: (provider: string) =>
    request<{ removed: boolean }>('DELETE', `/api/keys/${encodeURIComponent(provider)}`),
  testKey: (provider: string) => request<KeyTestResult>('POST', '/api/keys/test', { provider }),
  data: () => request<DataInfo>('GET', '/api/data'),
  backup: () =>
    request<{ file: string; size_bytes: number; created_at: string }>('POST', '/api/backup'),
  purge: (days: number) =>
    request<{ deleted: number; cutoff: string }>('POST', '/api/retention/purge', {
      days,
      confirm: true,
    }),
  integrations: () => request<{ clients: Client[] }>('GET', '/api/integrations'),
  quality: (from?: string) =>
    request<Quality>('GET', `/api/analytics/quality${toQuery(from ? { from } : {})}`),
  safety: (from?: string) =>
    request<SafetyAnalytics>('GET', `/api/analytics/safety${toQuery(from ? { from } : {})}`),
  agents: (from?: string) =>
    request<AgentsAnalytics>('GET', `/api/analytics/agents${toQuery(from ? { from } : {})}`),
  drift: () => request<Drift>('GET', '/api/drift'),
  setDrift: (id: string, status: 'acknowledged' | 'resolved') =>
    request<unknown>('PUT', `/api/drift/${encodeURIComponent(id)}`, { status }),
  patterns: (query: Record<string, string | number> = {}) =>
    request<Page<Pattern>>('GET', `/api/patterns${toQuery({ limit: 500, ...query })}`),
};

function toQuery(query: Record<string, string | number>): string {
  const parts = Object.entries(query).map(
    ([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
  );
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}
