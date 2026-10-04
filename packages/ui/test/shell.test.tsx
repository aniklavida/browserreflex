import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { NAV_GROUPS } from '../src/components/Shell';
import { THEME_STORAGE_KEY } from '../src/theme';
import { STATS, mockApi, useCleanup } from './helpers';

useCleanup();

function renderAt(path: string, stats: unknown = STATS) {
  mockApi((_method, url) => {
    if (url === '/api/stats') return stats;
    if (url.startsWith('/api/decisions')) return { items: [], total: 0, limit: 6, offset: 0 };
    return {};
  });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('app shell', () => {
  it('shows the title, the Local only badge and the API status', async () => {
    renderAt('/');
    expect(screen.getAllByText('Dashboard').length).toBeGreaterThan(0);
    expect(document.querySelector('.header .badge-local')?.textContent).toBe('Local only');
    expect(document.querySelector('.sidebar-footer')?.textContent).toMatch(/local only/i);
    await waitFor(() => expect(screen.getByText('Local API online')).toBeTruthy());
  });

  it('reports an unreachable API instead of claiming it is online', async () => {
    mockApi(() => new Error('down'));
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Local API unreachable')).toBeTruthy());
  });

  it('has four nav groups, and every entry goes to a page that is built', () => {
    renderAt('/');
    expect(NAV_GROUPS.map((group) => group.label)).toEqual([
      'Overview',
      'Learning',
      'History',
      'Control',
    ]);
    const entries = NAV_GROUPS.flatMap((group) => group.items);
    expect(entries.length).toBeGreaterThanOrEqual(13);
    for (const item of entries) {
      expect(item.to, `${item.label} has no route`).toBeDefined();
    }
    expect(document.querySelectorAll('.nav-item.planned')).toHaveLength(0);
  });

  it('shows the review count as a badge on the Review queue item', async () => {
    renderAt('/');
    await waitFor(() => {
      const link = screen.getByRole('link', { name: /Review queue/ });
      expect(link.querySelector('.chip-review')?.textContent).toBe('3');
    });
  });

  it('shows a DRIFT badge when a drift alert is active', async () => {
    renderAt('/', { ...STATS, drift_alerts: { active: 1 } });
    await waitFor(() => {
      const patterns = screen.getByRole('link', { name: /Patterns/ });
      expect(patterns.querySelector('.chip-drift')?.textContent).toBe('drift');
    });
  });

  it('switches the theme, persists it, and keeps it across a re-render', async () => {
    renderAt('/');
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('opens and closes the sidebar behind the Menu button', () => {
    renderAt('/');
    const sidebar = document.querySelector('.sidebar') as HTMLElement;
    expect(sidebar.className).not.toContain('open');
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(sidebar.className).toContain('open');
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(sidebar.className).not.toContain('open');
  });

  it('shows a plain message on an address with no page', () => {
    renderAt('/nowhere');
    expect(screen.getByText('Nothing here')).toBeTruthy();
  });
});
