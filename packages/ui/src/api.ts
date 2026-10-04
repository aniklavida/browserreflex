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
  created_at: string;
  updated_at: string;
}

export interface Pack {
  id: string;
  name: string;
  version: string | null;
  description: string | null;
  source: string | null;
  active: number;
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
  patterns: (query: Record<string, string | number> = {}) =>
    request<Page<Pattern>>('GET', `/api/patterns${toQuery({ limit: 500, ...query })}`),
};

function toQuery(query: Record<string, string | number>): string {
  const parts = Object.entries(query).map(
    ([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
  );
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}
