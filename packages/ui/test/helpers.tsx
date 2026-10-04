import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

export type Handler = (method: string, path: string, body: unknown) => unknown;

/** Replaces `fetch` with a handler that answers from memory. No request leaves the process. */
export function mockApi(handler: Handler) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, path: String(input), body });
      const result = handler(method, String(input), body);
      if (result instanceof Error) {
        return new Response(JSON.stringify({ error: result.message }), { status: 500 });
      }
      return new Response(JSON.stringify(result ?? {}), { status: 200 });
    }),
  );
  return calls;
}

export function useCleanup() {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    window.localStorage.clear();
    document.documentElement.setAttribute('data-theme', 'dark');
  });
}

export const STATS = {
  generated_at: '2026-10-04T12:00:00.000Z',
  decisions: {
    total: 40,
    fast: 32,
    ai: 6,
    human: 2,
    pending_review: 3,
    safety_stops: 4,
    fast_path_share: 0.8,
  },
  patterns: { total: 5, active: 2 },
  packs: { total: 1, active: 1 },
  feedback: { total: 1 },
};

export function decision(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    session_id: null,
    decision_type: 'check',
    question: 'Is this a cookie banner?',
    answer: 'true',
    confidence: 0.91,
    path: 'memory',
    latency_ms: 4,
    is_safety: 0,
    needs_review: 0,
    pattern_id: null,
    url: null,
    domain: 'shop.example',
    context: null,
    created_at: '2026-10-04T10:00:00.000Z',
    ...overrides,
  };
}
