import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { Decision, Pattern } from '../src/api';
import { dayKey } from '../src/format';
import { dailyFastPath, latencyPercentile, pathCounts } from '../src/pages/Analytics';
import { changedToday, filterPatterns } from '../src/pages/Learned';
import { coerce } from '../src/pages/Review';
import {
  AUTO_MAX,
  HUMAN_MAX,
  SAFETY_GATES,
  parseSplits,
  splitProblem,
} from '../src/pages/Thresholds';
import { STATS, decision, mockApi, useCleanup } from './helpers';

useCleanup();

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const asDecision = (overrides: Record<string, unknown> = {}) =>
  decision(overrides) as unknown as Decision;

describe('dashboard', () => {
  it('shows a day-one page, with no invented numbers, when nothing has been decided', async () => {
    mockApi((_m, url) =>
      url === '/api/stats'
        ? { ...STATS, decisions: { ...STATS.decisions, total: 0, fast: 0, fast_path_share: 0 } }
        : { items: [], total: 0, limit: 6, offset: 0 },
    );
    renderAt('/');
    await waitFor(() => expect(screen.getByText('Waiting for your first decision')).toBeTruthy());
    expect(screen.getByText(/Nothing has been measured yet/)).toBeTruthy();
    expect(document.querySelector('.hero-number')).toBeNull();
  });

  it('shows the fast-path share from the API, labelled a measurement and not a promise', async () => {
    mockApi((_m, url) =>
      url === '/api/stats' ? STATS : { items: [decision()], total: 1, limit: 6, offset: 0 },
    );
    renderAt('/');
    await waitFor(() => expect(document.querySelector('.hero-number')?.textContent).toBe('80%'));
    expect(screen.getByText(/a measurement of this log, not a promise/i)).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Is this a cookie banner?')).toBeTruthy());
  });

  it('calls safety numbers records and says the check is advisory', async () => {
    mockApi((_m, url) =>
      url === '/api/stats' ? STATS : { items: [], total: 0, limit: 6, offset: 0 },
    );
    renderAt('/');
    await waitFor(() => expect(screen.getByText('Safety records')).toBeTruthy());
    expect(screen.getByText(/The safety check is advisory/)).toBeTruthy();
  });

  it('shows a drift strip when an alert is active', async () => {
    mockApi((_m, url) =>
      url === '/api/stats'
        ? { ...STATS, drift_alerts: { active: 2 } }
        : { items: [], total: 0, limit: 6, offset: 0 },
    );
    renderAt('/');
    await waitFor(() => expect(screen.getByText('Drift alert.')).toBeTruthy());
  });

  it('shows the error when the API fails instead of an empty page', async () => {
    mockApi(() => new Error('database locked'));
    renderAt('/');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('database locked'));
  });
});

describe('review queue', () => {
  it('sends a typed answer for a yes-no question and says what happened', async () => {
    let items = [asDecision({ id: 'r1', answer: 'pending', needs_review: 1 })];
    const calls = mockApi((method, url, body) => {
      if (url === '/api/stats') return STATS;
      if (url.startsWith('/api/reviews?'))
        return { items, total: items.length, limit: 100, offset: 0 };
      if (method === 'POST') {
        items = [];
        expect(body).toEqual({ correct_value: true });
        return { recorded: { status: 'recorded' } };
      }
      return {};
    });
    renderAt('/review');
    await waitFor(() =>
      expect(screen.getByText('Is this a cookie banner?', { selector: 'h2' })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Yes/ }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Answer recorded'));
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/reviews/r1/answer')).toBe(
      true,
    );
    await waitFor(() => expect(screen.getByText('Nothing to review')).toBeTruthy());
  });

  it('shows the server refusal and keeps the item in the queue', async () => {
    mockApi((method, url) => {
      if (url === '/api/stats') return STATS;
      if (url.startsWith('/api/reviews?'))
        return {
          items: [asDecision({ id: 'r1', answer: 'pending' })],
          total: 1,
          limit: 100,
          offset: 0,
        };
      if (method === 'POST') return new Error('correct_value does not match');
      return {};
    });
    renderAt('/review');
    await waitFor(() => expect(screen.getByRole('button', { name: /Yes/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /No/ }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('correct_value does not match'),
    );
    expect(screen.getByRole('button', { name: /Yes/ })).toBeTruthy();
  });

  it('skips an item with S and an empty queue explains what will appear', async () => {
    mockApi((_m, url) => {
      if (url === '/api/stats') return STATS;
      if (url.startsWith('/api/reviews?'))
        return {
          items: [asDecision({ id: 'r1', answer: 'pending' })],
          total: 1,
          limit: 100,
          offset: 0,
        };
      return {};
    });
    renderAt('/review');
    await waitFor(() => expect(screen.getByRole('button', { name: /Yes/ })).toBeTruthy());
    fireEvent.keyDown(window, { key: 's' });
    await waitFor(() => expect(screen.getByText('Nothing to review')).toBeTruthy());
  });

  it('types the value to the decision type', () => {
    expect(coerce(asDecision({ decision_type: 'check' }), 'true')).toBe(true);
    expect(coerce(asDecision({ decision_type: 'check' }), 'false')).toBe(false);
    expect(coerce(asDecision({ decision_type: 'score' }), '0.7')).toBe(0.7);
    expect(coerce(asDecision({ decision_type: 'choice' }), 'promo')).toBe('promo');
  });
});

describe('thresholds and safety', () => {
  it('reads stored fractions as percentages and falls back to the defaults', () => {
    const splits = parseSplits(
      JSON.stringify({ check: { human_below: 0.3, auto_at_or_above: 0.9 } }),
    );
    expect(splits.check).toEqual({ human_below: 30, auto_at_or_above: 90 });
    expect(splits.choice).toEqual({ human_below: 20, auto_at_or_above: 80 });
    expect(parseSplits('not json').check).toEqual({ human_below: 20, auto_at_or_above: 80 });
    expect(parseSplits(undefined).score).toEqual({ human_below: 20, auto_at_or_above: 80 });
  });

  it('refuses a split outside the ranges or one that crosses', () => {
    expect(splitProblem({ human_below: 20, auto_at_or_above: 80 })).toBeNull();
    expect(splitProblem({ human_below: 5, auto_at_or_above: 80 })).toMatch(/Human below/);
    expect(splitProblem({ human_below: HUMAN_MAX + 1, auto_at_or_above: 90 })).toMatch(
      /Human below/,
    );
    expect(splitProblem({ human_below: 20, auto_at_or_above: 40 })).toMatch(/Auto at or above/);
    expect(splitProblem({ human_below: 20, auto_at_or_above: AUTO_MAX + 1 })).toMatch(
      /Auto at or above/,
    );
    expect(splitProblem({ human_below: 80, auto_at_or_above: 60 })).toMatch(/cross/);
  });

  it('saves the thresholds as fractions through the settings API', async () => {
    const calls = mockApi((_m, url) =>
      url === '/api/settings' ? { settings: [] } : url === '/api/stats' ? STATS : {},
    );
    renderAt('/thresholds');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save thresholds' })).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText('check human below'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save thresholds' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toMatchObject({
      key: 'thresholds',
      value: { check: { human_below: 0.3, auto_at_or_above: 0.8 } },
    });
  });

  it('lists the safety gates as always on, with no switch to turn one off, and says the check is advisory', async () => {
    mockApi((_m, url) => (url === '/api/settings' ? { settings: [] } : STATS));
    renderAt('/thresholds');
    await waitFor(() => expect(screen.getByText('Payment controls')).toBeTruthy());
    expect(SAFETY_GATES.length).toBeGreaterThanOrEqual(4);
    expect(screen.getAllByText('always on')).toHaveLength(SAFETY_GATES.length);
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.getByText(/The safety check is advisory/)).toBeTruthy();
  });
});

describe('engines and keys', () => {
  it('saves the mode and the model, never a key, and labels the key step as planned', async () => {
    const calls = mockApi((_m, url) =>
      url === '/api/settings' ? { settings: [{ key: 'mode', value: 'byok' }] } : STATS,
    );
    renderAt('/engines');
    await waitFor(() => expect(screen.getByText(/Entering a key here is planned/)).toBeTruthy());
    expect(screen.getByRole('button', { name: /Test connection/ }).hasAttribute('disabled')).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'my-model' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').length).toBe(3));
    const written = calls
      .filter((c) => c.method === 'PUT')
      .map((c) => (c.body as { key: string }).key);
    expect(written).toEqual(['mode', 'provider', 'provider.anthropic.model']);
    expect(JSON.stringify(calls)).not.toMatch(/api[_-]?key/i);
  });

  it('shows how chat mode routes and saves chat mode alone', async () => {
    const calls = mockApi((_m, url) => (url === '/api/settings' ? { settings: [] } : STATS));
    renderAt('/engines');
    await waitFor(() => expect(screen.getByText('New question')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });
});

describe('analytics', () => {
  const NOW = new Date(2026, 9, 4, 12, 0, 0);
  const at = (daysAgo: number, path = 'memory', latency: number | null = 5) =>
    asDecision({
      path,
      latency_ms: latency,
      created_at: new Date(2026, 9, 4 - daysAgo, 9, 0, 0).toISOString(),
    });

  it('computes the fast-path share per local day, with null for a day with no decisions', () => {
    const bars = dailyFastPath([at(0), at(0, 'ai'), at(0, 'pattern'), at(2, 'human')], 3, NOW);
    expect(bars.map((bar) => bar.day)).toEqual([
      dayKey(new Date(2026, 9, 2).toISOString()),
      dayKey(new Date(2026, 9, 3).toISOString()),
      dayKey(new Date(2026, 9, 4).toISOString()),
    ]);
    expect(bars[0]).toMatchObject({ total: 1, fast: 0, share: 0 });
    expect(bars[1]).toMatchObject({ total: 0, share: null });
    expect(bars[2]).toMatchObject({ total: 3, fast: 2 });
    expect(bars[2]?.share).toBeCloseTo(2 / 3);
  });

  it('ignores decisions outside the range', () => {
    expect(dailyFastPath([at(40)], 7, NOW).every((bar) => bar.total === 0)).toBe(true);
  });

  it('counts decisions by path and never counts a model answer as fast', () => {
    const counts = pathCounts([at(0), at(0, 'ai'), at(0, 'human')]);
    expect(counts).toEqual({ memory: 1, pattern: 0, check: 0, ai: 1, human: 1 });
    const bars = dailyFastPath([at(0, 'ai'), at(0, 'human')], 1, NOW);
    expect(bars[0]?.fast).toBe(0);
  });

  it('takes nearest-rank latency percentiles and skips a missing latency', () => {
    const rows = [1, 2, 3, 4, 100].map((ms) => at(0, 'memory', ms));
    rows.push(at(0, 'memory', null));
    expect(latencyPercentile(rows, 0.5)).toBe(3);
    expect(latencyPercentile(rows, 0.95)).toBe(100);
    expect(latencyPercentile([at(0, 'memory', null)], 0.5)).toBeNull();
  });

  it('tells you when the page reads only the newest decisions, and shows no token figure', async () => {
    mockApi((_m, url) => {
      if (url.startsWith('/api/decisions'))
        return { items: [decision()], total: 900, limit: 500, offset: 0 };
      return STATS;
    });
    renderAt('/analytics');
    await waitFor(() =>
      expect(screen.getByText(/Based on the newest 1 of 900 decisions/)).toBeTruthy(),
    );
    expect(screen.getByText(/No token count is stored/)).toBeTruthy();
  });

  it('explains an empty log', async () => {
    mockApi((_m, url) =>
      url.startsWith('/api/decisions') ? { items: [], total: 0, limit: 500, offset: 0 } : STATS,
    );
    renderAt('/analytics');
    await waitFor(() => expect(screen.getByText('No decisions to chart')).toBeTruthy());
  });
});

describe('learned', () => {
  const pattern = (overrides: Partial<Pattern>): Pattern => ({
    id: 'p',
    name: null,
    pack_id: null,
    decision_type: 'check',
    status: 'shadow',
    confidence: 0.9,
    is_safety: 0,
    created_at: '2026-10-01T10:00:00.000Z',
    updated_at: '2026-10-01T10:00:00.000Z',
    ...overrides,
  });

  it('filters by status and puts the newest change first', () => {
    const rows = [
      pattern({ id: 'old', status: 'active', updated_at: '2026-09-01T00:00:00.000Z' }),
      pattern({ id: 'new', status: 'active', updated_at: '2026-10-03T00:00:00.000Z' }),
      pattern({ id: 'sh', status: 'shadow' }),
    ];
    expect(filterPatterns(rows, 'active').map((p) => p.id)).toEqual(['new', 'old']);
    expect(filterPatterns(rows, 'all')).toHaveLength(3);
    expect(filterPatterns(rows, 'disabled')).toHaveLength(0);
  });

  it('knows whether a pattern changed today', () => {
    const now = new Date(2026, 9, 4, 12, 0, 0);
    expect(
      changedToday(pattern({ updated_at: new Date(2026, 9, 4, 8, 0, 0).toISOString() }), now),
    ).toBe(true);
    expect(
      changedToday(pattern({ updated_at: new Date(2026, 9, 3, 8, 0, 0).toISOString() }), now),
    ).toBe(false);
  });

  it('lists patterns, opens a drawer, and locks a safety rule', async () => {
    mockApi((_m, url) => {
      if (url.startsWith('/api/patterns'))
        return {
          items: [
            pattern({ id: 'learned-1', status: 'active' }),
            pattern({ id: 'pay', is_safety: 1, pack_id: 'browser' }),
          ],
          total: 2,
          limit: 500,
          offset: 0,
        };
      return STATS;
    });
    renderAt('/learned');
    await waitFor(() => expect(screen.getByText('learned-1')).toBeTruthy());
    fireEvent.click(screen.getByText('pay'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/A safety rule\. It cannot be changed/)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('explains an empty list', async () => {
    mockApi((_m, url) =>
      url.startsWith('/api/patterns') ? { items: [], total: 0, limit: 500, offset: 0 } : STATS,
    );
    renderAt('/learned');
    await waitFor(() => expect(screen.getByText('No patterns yet')).toBeTruthy());
  });
});

describe('setup wizard', () => {
  it('walks four steps, saves the mode, and finishes when the first decision arrives', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let total = 0;
    const calls = mockApi((_m, url) => {
      if (url === '/api/stats') return { ...STATS, decisions: { ...STATS.decisions, total } };
      if (url.startsWith('/api/packs'))
        return {
          items: [
            {
              id: 'browser',
              name: 'Browser pack',
              version: '1',
              description: 'Seven checks',
              source: 'builtin',
              active: 1,
            },
          ],
          total: 1,
          limit: 100,
          offset: 0,
        };
      return {};
    });
    renderAt('/setup');
    expect(screen.getByText('Connect your agent')).toBeTruthy();
    expect(screen.getByText(/not published yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('How should new questions be answered?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Your own key' }));
    expect(screen.getByText(/saves the mode, not the key/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByText('Pattern packs')).toBeTruthy());
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ key: 'mode', value: 'byok' });
    await waitFor(() => expect(screen.getByText('Browser pack')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Waiting for your agent')).toBeTruthy();
    total = 1;
    await vi.advanceTimersByTimeAsync(3100);
    await waitFor(() => expect(screen.getByText('First decision received')).toBeTruthy());
    expect(screen.getByRole('link', { name: 'Open the dashboard' })).toBeTruthy();
  });

  it('goes back and can be skipped', () => {
    mockApi(() => ({}));
    renderAt('/setup');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Connect your agent')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Skip setup' })).toBeTruthy();
  });
});
