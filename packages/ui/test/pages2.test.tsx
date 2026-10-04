import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { Decision, Pattern } from '../src/api';
import { TEST_ERRORS } from '../src/components/KeySection';
import { MAX_LIVE_ROWS, addLive, addTail } from '../src/pages/Live';
import { dayRange } from '../src/pages/Logs';
import { pathMix } from '../src/pages/Replay';
import { summariseWeek } from '../src/pages/Reports';
import { PURGE_WORD, formatBytes } from '../src/pages/Settings';
import { accuracyOf, applyFilter, kindOf } from '../src/pages/Patterns';
import { sinceIso } from '../src/pages/Analytics';
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

const page = (items: unknown[], total = items.length) => ({ items, total, limit: 50, offset: 0 });

function runtimeKey(): string {
  return ['sk', 'ant', 'api03', 'ABCDEFGHIJ1234567890abcdef', 'WXYZ'].join('-');
}

describe('key section', () => {
  const setup = (extra: (m: string, u: string, b: unknown) => unknown = () => undefined) => {
    let stored = false;
    const calls = mockApi((method, url, body) => {
      const custom = extra(method, url, body);
      if (custom !== undefined) return custom;
      if (url === '/api/settings') return { settings: [{ key: 'mode', value: 'byok' }] };
      if (url === '/api/keys' && method === 'GET') {
        return {
          items: [
            {
              provider: 'anthropic',
              has_key: stored,
              masked: stored ? 'sk-ant-••••WXYZ' : '',
              backend: 'file',
            },
          ],
        };
      }
      if (url === '/api/keys' && method === 'PUT') {
        stored = true;
        return { provider: 'anthropic', has_key: true, masked: 'sk-ant-••••WXYZ', backend: 'file' };
      }
      return STATS;
    });
    return calls;
  };

  it('sends the key to the keys route only, clears the input, and shows the masked form', async () => {
    const key = runtimeKey();
    const calls = setup();
    renderAt('/engines');
    const input = (await screen.findByLabelText('Provider key')) as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    fireEvent.change(input, { target: { value: key } });
    fireEvent.click(screen.getByRole('button', { name: 'Store key' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Stored key').textContent).toBe('sk-ant-••••WXYZ'),
    );
    expect(input.value).toBe('');
    expect(document.body.textContent).not.toContain(key);

    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.path).toBe('/api/keys');
    expect(puts[0]?.body).toEqual({ provider: 'anthropic', key });
    // The key is in no other request: not in a setting, not in a query.
    expect(JSON.stringify(calls.filter((c) => c !== puts[0]))).not.toContain(key);
  });

  it('disables the store button until there is something to store', async () => {
    setup();
    renderAt('/engines');
    await screen.findByLabelText('Provider key');
    expect(screen.getByRole('button', { name: 'Store key' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Test connection' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('reports a connection test result in plain words', async () => {
    let result: unknown = { ok: true, provider: 'anthropic', model: 'a-model', latency_ms: 80 };
    mockApi((method, url) => {
      if (url === '/api/settings') return { settings: [{ key: 'mode', value: 'byok' }] };
      if (url === '/api/keys') {
        return {
          items: [
            { provider: 'anthropic', has_key: true, masked: 'sk-ant-••••WXYZ', backend: 'file' },
          ],
        };
      }
      if (url === '/api/keys/test' && method === 'POST') return result;
      return STATS;
    });
    renderAt('/engines');
    const test = await screen.findByRole('button', { name: 'Test connection' });
    await waitFor(() => expect(test.hasAttribute('disabled')).toBe(false));
    fireEvent.click(test);
    await waitFor(() =>
      expect(screen.getByText(/Connected: a-model answered in 80 ms/)).toBeTruthy(),
    );

    result = { ok: false, provider: 'anthropic', error: 'auth' };
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByText(TEST_ERRORS.auth!)).toBeTruthy());
  });

  it('removes a key', async () => {
    const calls = mockApi((method, url) => {
      if (url === '/api/settings') return { settings: [{ key: 'mode', value: 'byok' }] };
      if (url === '/api/keys' && method === 'GET') {
        return {
          items: [
            { provider: 'anthropic', has_key: true, masked: 'sk-ant-••••WXYZ', backend: 'file' },
          ],
        };
      }
      if (method === 'DELETE') return { removed: true };
      return STATS;
    });
    renderAt('/engines');
    const remove = await screen.findByRole('button', { name: 'Remove key' });
    await waitFor(() => expect(remove.hasAttribute('disabled')).toBe(false));
    fireEvent.click(remove);
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/keys/anthropic')).toBe(
        true,
      ),
    );
  });
});

describe('live activity', () => {
  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    listeners: Record<string, ((event: { data: string }) => void)[]> = {};
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(public url: string) {
      FakeEventSource.instances.push(this);
    }
    addEventListener(name: string, listener: (event: { data: string }) => void) {
      (this.listeners[name] ??= []).push(listener);
    }
    emit(name: string, data: unknown) {
      for (const listener of this.listeners[name] ?? []) listener({ data: JSON.stringify(data) });
    }
    close() {
      this.closed = true;
    }
  }

  afterEach(() => {
    FakeEventSource.instances = [];
  });

  it('adds a streamed decision once, bounds the list, and closes the stream when left', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    mockApi((_m, url) => {
      if (url.startsWith('/api/decisions'))
        return page([asDecision({ id: 'old', question: 'old question' })]);
      if (url.startsWith('/api/sessions')) return { items: [] };
      return STATS;
    });
    const { unmount } = renderAt('/live');
    await waitFor(() => expect(screen.getByText('old question')).toBeTruthy());
    expect(screen.getByText('Not connected')).toBeTruthy();
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe('/api/stream');
    act(() => source.onopen?.());
    expect(screen.getByText('Live')).toBeTruthy();

    act(() => source.emit('decision', decision({ id: 'new', question: 'streamed question' })));
    await waitFor(() => expect(screen.getByText('streamed question')).toBeTruthy());
    act(() => source.emit('decision', decision({ id: 'new', question: 'streamed question' })));
    expect(screen.getAllByText('streamed question')).toHaveLength(1);

    fireEvent.click(screen.getByText('streamed question'));
    expect(screen.getByRole('dialog', { name: 'Decision' })).toBeTruthy();

    unmount();
    expect(source.closed).toBe(true);
  });

  it('keeps a malformed event from breaking the stream', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    mockApi((_m, url) =>
      url.startsWith('/api/decisions')
        ? page([])
        : url.startsWith('/api/sessions')
          ? { items: [] }
          : STATS,
    );
    renderAt('/live');
    await screen.findByText('Waiting for decisions');
    const source = FakeEventSource.instances[0]!;
    act(() => {
      for (const listener of source.listeners.decision ?? []) listener({ data: '{not json' });
    });
    expect(screen.getByText('Waiting for decisions')).toBeTruthy();
  });

  it('keeps a streamed decision when the first page arrives later, without a duplicate', () => {
    const streamed = asDecision({ id: 'streamed' });
    const merged = [asDecision({ id: 'a' }), streamed, asDecision({ id: 'b' })].reduce(
      (rows, row) => addTail(rows, row),
      [streamed],
    );
    expect(merged.map((row) => row.id)).toEqual(['streamed', 'a', 'b']);
  });

  it('bounds the live list and does not add the same decision twice', () => {
    const many = Array.from({ length: MAX_LIVE_ROWS }, (_unused, index) =>
      asDecision({ id: `d${index}` }),
    );
    const grown = addLive(many, asDecision({ id: 'fresh' }));
    expect(grown).toHaveLength(MAX_LIVE_ROWS);
    expect(grown[0]?.id).toBe('fresh');
    expect(addLive(grown, asDecision({ id: 'fresh' }))).toHaveLength(MAX_LIVE_ROWS);
  });
});

describe('logs', () => {
  it('turns a calendar day into a local range with an exclusive end, and refuses a bad day', () => {
    const range = dayRange('2026-10-04')!;
    expect(new Date(range.to).getTime() - new Date(range.from).getTime()).toBeGreaterThanOrEqual(
      23 * 3_600_000,
    );
    expect(dayRange('yesterday')).toBeNull();
  });

  it('searches, filters by path, pages, and exports with the same search', async () => {
    const calls = mockApi((_m, url) =>
      url.startsWith('/api/decisions') ? page([asDecision()], 120) : STATS,
    );
    renderAt('/logs');
    await screen.findByText('Is this a cookie banner?');

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: '50%' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(calls.some((c) => c.path.includes('q=50%25'))).toBe(true));
    expect(screen.getByRole('link', { name: 'Export CSV' }).getAttribute('href')).toContain(
      'q=50%25',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    await waitFor(() => expect(calls.some((c) => c.path.includes('path=ai'))).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Older' }));
    await waitFor(() => expect(calls.some((c) => c.path.includes('offset=50'))).toBe(true));
    expect(screen.getByText(/51–51 of 120/)).toBeTruthy();
  });

  it('opens a day from the address, shows a chip that clears it, and sends the range', async () => {
    const calls = mockApi((_m, url) =>
      url.startsWith('/api/decisions') ? page([asDecision()]) : STATS,
    );
    renderAt('/logs?day=2026-10-04');
    await screen.findByText('Is this a cookie banner?');
    expect(calls.some((c) => c.path.includes('from=') && c.path.includes('to='))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Day 2026-10-04/ }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Day 2026-10-04/ })).toBeNull(),
    );
  });

  it('opens the record in a drawer and links to the replay of its session', async () => {
    mockApi((_m, url) =>
      url.startsWith('/api/decisions') ? page([asDecision({ session_id: 's1' })]) : STATS,
    );
    renderAt('/logs');
    fireEvent.click(await screen.findByText('Is this a cookie banner?'));
    const link = screen.getByRole('link', { name: 'Open in task replay' });
    expect(link.getAttribute('href')).toBe('/replay?session=s1');
  });

  it('explains an empty result', async () => {
    mockApi((_m, url) => (url.startsWith('/api/decisions') ? page([]) : STATS));
    renderAt('/logs');
    await screen.findByText('No decisions match');
  });
});

describe('task replay', () => {
  it('counts the path mix of a run, with the fast paths together', () => {
    expect(
      pathMix([
        asDecision({ path: 'memory' }),
        asDecision({ path: 'check' }),
        asDecision({ path: 'ai' }),
      ]),
    ).toEqual({
      fast: 2,
      ai: 1,
      human: 0,
    });
  });

  it('lists steps oldest first, explains one, and records a correction through the review answer route', async () => {
    const calls = mockApi((method, url) => {
      if (url.startsWith('/api/sessions'))
        return {
          items: [
            {
              id: 's1',
              agent_name: 'codex',
              decisions: 2,
              fast: 1,
              ai: 1,
              human: 0,
              first_at: '',
              last_at: '',
            },
          ],
        };
      if (url.startsWith('/api/decisions'))
        return page([
          asDecision({
            id: 'newer',
            question: 'second step',
            created_at: '2026-10-04T10:05:00.000Z',
          }),
          asDecision({
            id: 'older',
            question: 'first step',
            created_at: '2026-10-04T10:00:00.000Z',
            pattern_id: 'rule.a',
          }),
        ]);
      if (method === 'POST') return { recorded: { status: 'recorded' } };
      return STATS;
    });
    renderAt('/replay');
    await screen.findByText('first step');
    const rows = document.querySelectorAll('tbody tr');
    expect(rows[0]?.textContent).toContain('1');
    expect(screen.getByText('Answered by rule.a')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '→ false' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/reviews/older/answer')).toBe(
        true,
      ),
    );
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ correct_value: false });
  });

  it('explains an empty log', async () => {
    mockApi((_m, url) => (url.startsWith('/api/sessions') ? { items: [] } : STATS));
    renderAt('/replay');
    await screen.findByText('No task to replay');
  });
});

describe('patterns', () => {
  const pattern = (overrides: Partial<Pattern>): Pattern => ({
    id: 'p',
    name: null,
    pack_id: null,
    decision_type: 'check',
    status: 'shadow',
    confidence: 0.9,
    is_safety: 0,
    rules: '{"id":"p"}',
    created_at: '2026-10-01T10:00:00.000Z',
    updated_at: '2026-10-01T10:00:00.000Z',
    ...overrides,
  });

  it('tells a learned pattern from a pack rule, filters, and computes accuracy', () => {
    expect(kindOf(pattern({}))).toBe('learned');
    expect(kindOf(pattern({ rules: '{}' }))).toBe('pack rule');
    const rows = [
      pattern({ id: 'a', status: 'active' }),
      pattern({ id: 'b', status: 'shadow' }),
      pattern({ id: 'c', status: 'active', is_safety: 1 }),
    ];
    expect(applyFilter(rows, 'active').map((p) => p.id)).toEqual(['a', 'c']);
    expect(applyFilter(rows, 'safety').map((p) => p.id)).toEqual(['c']);
    expect(applyFilter(rows, 'all')).toHaveLength(3);
    expect(
      accuracyOf({ pattern_id: 'a', sample_count: 10, agreed_count: 9, disagreed_count: 1 }),
    ).toBe(0.9);
    expect(
      accuracyOf({ pattern_id: 'a', sample_count: 0, agreed_count: 0, disagreed_count: 0 }),
    ).toBeNull();
    expect(accuracyOf(undefined)).toBeNull();
  });

  const patternApi = (switchResult: unknown = undefined) =>
    mockApi((method, url) => {
      if (url.startsWith('/api/patterns') && method === 'GET')
        return page([
          pattern({ id: 'active-one', status: 'active' }),
          pattern({ id: 'shadow-one', status: 'shadow' }),
          pattern({ id: 'safe', status: 'active', is_safety: 1 }),
        ]);
      if (url === '/api/pattern-stats')
        return {
          items: [
            { pattern_id: 'shadow-one', sample_count: 5, agreed_count: 5, disagreed_count: 0 },
          ],
        };
      if (method === 'PUT')
        return switchResult ?? { pattern: pattern({ id: 'active-one', status: 'disabled' }) };
      return STATS;
    });

  it('shows shadow progress and no switch for a shadow candidate', async () => {
    patternApi();
    renderAt('/patterns');
    fireEvent.click(await screen.findByText('shadow-one'));
    expect(screen.getByText(/5 of 20 samples/)).toBeTruthy();
    expect(screen.getByText(/earns its promotion from samples/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull();
  });

  it('disables an active pattern through the API', async () => {
    const calls = patternApi();
    renderAt('/patterns');
    fireEvent.click(await screen.findByText('active-one'));
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/patterns/active-one')).toBe(
        true,
      ),
    );
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ status: 'disabled' });
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Pattern switched off'),
    );
  });

  it('shows a written pack rule with a pointer to its pack and no switch', async () => {
    mockApi((method, url) => {
      if (url.startsWith('/api/patterns') && method === 'GET')
        return page([pattern({ id: 'browser.cookie.accept', status: 'active', rules: '{}' })]);
      if (url === '/api/pattern-stats') return { items: [] };
      return STATS;
    });
    renderAt('/patterns');
    fireEvent.click(await screen.findByText('browser.cookie.accept'));
    expect(screen.getByText(/Switch its pack on or off from the Packs page/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull();
  });

  it('locks a safety rule: no switch, and a note that says so', async () => {
    patternApi();
    renderAt('/patterns');
    fireEvent.click(await screen.findByText('safe'));
    expect(screen.getByText(/A safety rule\. It cannot be switched/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull();
  });

  it('shows the reason when the server refuses a switch', async () => {
    let refuse = false;
    mockApi((method, url) => {
      if (url.startsWith('/api/patterns') && method === 'GET')
        return page([pattern({ id: 'off', status: 'disabled' })]);
      if (url === '/api/pattern-stats') return { items: [] };
      if (method === 'PUT') {
        refuse = true;
        return new Error('Only a pattern that promotion made active can be switched on');
      }
      return STATS;
    });
    renderAt('/patterns');
    fireEvent.click(await screen.findByText('off'));
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(
        /Only a pattern that promotion made active/,
      ),
    );
    expect(refuse).toBe(true);
  });
});

describe('packs', () => {
  it('switches a pack and says what an off pack does', async () => {
    const calls = mockApi((method, url) => {
      if (url.startsWith('/api/packs') && method === 'GET')
        return page([
          {
            id: 'browser',
            name: 'Browser pack',
            version: '1.0.0',
            description: 'Seven checks',
            is_active: 1,
          },
        ]);
      if (method === 'PUT')
        return {
          pack: {},
          note: 'The pack is off: its non-safety rules stop answering and those questions go to the slow path. Its safety rules keep working.',
        };
      return STATS;
    });
    renderAt('/packs');
    expect(await screen.findByText('Browser pack')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Import pack file/ }).hasAttribute('disabled')).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Browser pack on' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ active: false }),
    );
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/safety rules keep working/),
    );
  });

  it('explains an empty list', async () => {
    mockApi((_m, url) => (url.startsWith('/api/packs') ? page([]) : STATS));
    renderAt('/packs');
    await screen.findByText('No packs registered');
  });
});

describe('reports', () => {
  it('counts only the last seven days, and never reports a share for an empty week', () => {
    const now = new Date('2026-10-04T12:00:00.000Z');
    const week = summariseWeek(
      [
        asDecision({ created_at: '2026-10-03T12:00:00.000Z', path: 'memory' }),
        asDecision({ created_at: '2026-10-02T12:00:00.000Z', path: 'ai', is_safety: 1 }),
        asDecision({ created_at: '2026-09-01T12:00:00.000Z', path: 'memory' }),
      ],
      now,
    );
    expect(week).toMatchObject({ total: 2, fast: 1, ai: 1, human: 0, safety: 1, fastShare: 0.5 });
    expect(summariseWeek([], now).fastShare).toBeNull();
  });

  it('says it is a measurement, claims no saving, lists the wrong patterns and disables one', async () => {
    const calls = mockApi((method, url) => {
      if (url.startsWith('/api/decisions'))
        return page([asDecision({ created_at: new Date().toISOString() })]);
      if (url.startsWith('/api/analytics/quality'))
        return {
          corrected_decisions: 3,
          bins: [],
          wrong_most: [{ pattern_id: 'bad-one', wrong: 2, total: 3 }],
        };
      if (method === 'PUT') return { pattern: {} };
      return STATS;
    });
    renderAt('/reports');
    expect(await screen.findByText(/A measurement, not a promise/)).toBeTruthy();
    expect(screen.getByText(/neither is measured here/)).toBeTruthy();
    expect(screen.getByText(/PDF export is planned/)).toBeTruthy();
    const row = (await screen.findByText('bad-one')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Disable' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/patterns/bad-one')).toBe(
        true,
      ),
    );
    expect(screen.getByRole('link', { name: 'This week as CSV' }).getAttribute('href')).toContain(
      'from=',
    );
  });

  it('explains an empty log', async () => {
    mockApi((_m, url) => (url.startsWith('/api/decisions') ? page([]) : STATS));
    renderAt('/reports');
    await screen.findByText('No report yet');
  });
});

describe('integrations', () => {
  it('shows each agent as configured, not configured or not found, and marks the rest planned', async () => {
    mockApi((_m, url) =>
      url === '/api/integrations'
        ? {
            clients: [
              {
                id: 'cursor',
                label: 'Cursor',
                config_file: '.cursor/mcp.json',
                found: true,
                configured: true,
              },
              {
                id: 'codex',
                label: 'Codex',
                config_file: '.codex/config.toml',
                found: true,
                configured: false,
              },
              {
                id: 'claude-code',
                label: 'Claude Code',
                config_file: '.claude.json',
                found: false,
                configured: false,
              },
            ],
          }
        : STATS,
    );
    renderAt('/integrations');
    const cursor = (await screen.findByText('Cursor')).closest('tr') as HTMLElement;
    expect(cursor.textContent).toContain('configured');
    expect((screen.getByText('Codex').closest('tr') as HTMLElement).textContent).toContain(
      'not configured',
    );
    expect((screen.getByText('Claude Code').closest('tr') as HTMLElement).textContent).toContain(
      'not found',
    );
    expect(screen.getByText(/planned/)).toBeTruthy();
    expect(screen.getByText(/curl .*\/api\/stats/)).toBeTruthy();
  });
});

describe('settings', () => {
  const data = {
    database_file: 'browserreflex.db',
    size_bytes: 2048,
    decisions: 7,
    oldest_decision: '2026-09-01T00:00:00.000Z',
    retention_days: null,
    backups: [
      { file: 'browserreflex-1.db', size_bytes: 1024, modified_at: '2026-10-04T00:00:00.000Z' },
    ],
  };

  it('formats sizes', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('shows the data, backs up on request, and says there is no telemetry', async () => {
    const calls = mockApi((method, url) => {
      if (url === '/api/data') return data;
      if (url === '/api/backup' && method === 'POST')
        return { file: 'browserreflex-2.db', size_bytes: 1, created_at: '' };
      return STATS;
    });
    renderAt('/settings');
    expect(await screen.findByText(/browserreflex.db · 2.0 KB/)).toBeTruthy();
    expect(screen.getByText('browserreflex-1.db · 1.0 KB')).toBeTruthy();
    expect(screen.getByText('No telemetry.')).toBeTruthy();
    expect(screen.getByText(/Restoring is not built/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back up now' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/backup')).toBe(true),
    );
  });

  it('deletes old decisions only after DELETE is typed', async () => {
    const calls = mockApi((method, url, body) => {
      if (url === '/api/data') return data;
      if (url === '/api/retention/purge' && method === 'POST') {
        expect(body).toEqual({ days: 30, confirm: true });
        return { deleted: 3, cutoff: '' };
      }
      return STATS;
    });
    renderAt('/settings');
    await screen.findByText(/browserreflex.db/);
    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete older…' }));
    const confirm = screen.getByRole('button', { name: 'Delete for good' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Type DELETE'), { target: { value: 'delete' } });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    expect(calls.some((c) => c.path === '/api/retention/purge')).toBe(false);
    fireEvent.change(screen.getByLabelText('Type DELETE'), { target: { value: PURGE_WORD } });
    expect(confirm.hasAttribute('disabled')).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Deleted 3 decisions'));
  });

  it('changes the theme from the page', async () => {
    mockApi((_m, url) => (url === '/api/data' ? data : STATS));
    renderAt('/settings');
    await screen.findByText(/browserreflex.db/);
    const appearance = screen.getByText('Appearance').closest('section') as HTMLElement;
    fireEvent.click(within(appearance).getByRole('button', { name: 'Light' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

describe('analytics sections', () => {
  const openTab = async (name: string) => {
    fireEvent.click(await screen.findByRole('button', { name }));
  };

  it('opens the decisions of a clicked day in the logs', async () => {
    mockApi((_m, url) =>
      url.startsWith('/api/decisions')
        ? page([asDecision({ created_at: new Date().toISOString() })])
        : STATS,
    );
    renderAt('/analytics');
    const bars = await screen.findAllByRole('button', { name: /: 100% of 1/ });
    fireEvent.click(bars[0]!);
    const link = screen.getByRole('link', { name: 'Open decisions →' });
    expect(link.getAttribute('href')).toMatch(/^\/logs\?day=\d{4}-\d{2}-\d{2}$/);
  });

  it('computes the start of a range', () => {
    expect(sinceIso(1, new Date(2026, 9, 4, 15))).toBe(new Date(2026, 9, 4).toISOString());
    expect(sinceIso(7, new Date(2026, 9, 4, 15))).toBe(new Date(2026, 9, 4 - 6).toISOString());
  });

  it('quality: shows stated against actual per bin and explains an empty one', async () => {
    mockApi((_m, url) => {
      if (url.startsWith('/api/analytics/quality'))
        return {
          corrected_decisions: 4,
          bins: [
            { lower: 0.9, upper: 1, count: 4, stated: 0.95, actual: 0.75 },
            { lower: 0, upper: 0.1, count: 0, stated: null, actual: null },
          ],
          wrong_most: [],
        };
      return page([asDecision()]);
    });
    renderAt('/analytics');
    await openTab('Quality');
    expect(await screen.findByText(/Only 4 corrected decisions/)).toBeTruthy();
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('quality: explains that nothing was corrected yet', async () => {
    mockApi((_m, url) =>
      url.startsWith('/api/analytics/quality')
        ? { corrected_decisions: 0, bins: [], wrong_most: [] }
        : page([asDecision()]),
    );
    renderAt('/analytics');
    await openTab('Quality');
    await screen.findByText('Nothing corrected yet');
  });

  it('safety: lists records by type and keeps the advisory note', async () => {
    mockApi((_m, url) => {
      if (url.startsWith('/api/analytics/safety'))
        return {
          note: 'The safety check is advisory: these are records of requests to the user, not blocks.',
          by_family: { payment: 3, destructive: 1 },
          by_answer: { ask_user: 4 },
          risky_places: [{ domain: 'shop.example', total: 4 }],
        };
      return page([asDecision()]);
    });
    renderAt('/analytics');
    await openTab('Safety');
    expect(await screen.findByText(/records of requests to the user, not blocks/)).toBeTruthy();
    expect(screen.getByText('payment')).toBeTruthy();
    expect(screen.getByText('shop.example')).toBeTruthy();
  });

  it('agents: lists agents and projects', async () => {
    mockApi((_m, url) => {
      if (url.startsWith('/api/analytics/agents'))
        return {
          agents: [{ agent: 'codex', decisions: 10, fast: 5 }],
          projects: [{ project: 'a.example', decisions: 4, fast: 4 }],
        };
      return page([asDecision()]);
    });
    renderAt('/analytics');
    await openTab('Agents + projects');
    expect(await screen.findByText('codex')).toBeTruthy();
    expect(screen.getByText('a.example')).toBeTruthy();
  });

  it('drift: marks a pattern under the limit and acknowledges an alert', async () => {
    const calls = mockApi((method, url) => {
      if (url === '/api/drift' && method === 'GET')
        return {
          threshold: 0.9,
          patterns: [
            { pattern_id: 'bad', rechecks: 20, accuracy: 0.5 },
            { pattern_id: 'fine', rechecks: 20, accuracy: 0.95 },
          ],
          alerts: [
            {
              id: 'a1',
              pattern_id: 'bad',
              accuracy: 0.5,
              threshold: 0.9,
              status: 'active',
              message: 'bad was disabled',
              created_at: '',
            },
          ],
        };
      if (method === 'PUT') return {};
      return page([asDecision()]);
    });
    renderAt('/analytics');
    await openTab('Drift');
    expect(await screen.findByText('below limit')).toBeTruthy();
    expect(screen.getAllByText('below limit')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ status: 'acknowledged' }),
    );
  });

  it('drift: explains an empty state', async () => {
    mockApi((_m, url) =>
      url === '/api/drift' ? { threshold: 0.9, patterns: [], alerts: [] } : page([asDecision()]),
    );
    renderAt('/analytics');
    await openTab('Drift');
    await screen.findByText('Nothing to watch yet');
  });
});
