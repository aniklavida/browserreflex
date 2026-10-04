import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { api, type ApiStats } from '../api';
import { applyTheme, readStoredTheme, storeTheme, type Theme } from '../theme';
import { SegmentedControl } from './SegmentedControl';

interface NavEntry {
  label: string;
  to?: string;
}

interface NavGroup {
  label: string;
  items: NavEntry[];
}

/** An entry without a route is a page that is planned and not built yet. */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { label: 'Dashboard', to: '/' },
      { label: 'Review queue', to: '/review' },
    ],
  },
  {
    label: 'Learning',
    items: [{ label: 'Learned', to: '/learned' }, { label: 'Patterns' }, { label: 'Packs' }],
  },
  {
    label: 'History',
    items: [{ label: 'Analytics', to: '/analytics' }, { label: 'Logs' }, { label: 'Reports' }],
  },
  {
    label: 'Control',
    items: [
      { label: 'Thresholds + safety', to: '/thresholds' },
      { label: 'Engines + keys', to: '/engines' },
      { label: 'Settings' },
    ],
  },
];

export const PAGE_TITLES: Record<string, { title: string; subtitle: string }> = {
  '/': { title: 'Dashboard', subtitle: 'What BrowserReflex answered on its own.' },
  '/review': { title: 'Review queue', subtitle: 'Answers waiting for a person.' },
  '/learned': { title: 'Learned', subtitle: 'Patterns BrowserReflex has written or promoted.' },
  '/analytics': { title: 'Analytics', subtitle: 'Fast-path share and answer sources over time.' },
  '/thresholds': { title: 'Thresholds + safety', subtitle: 'Who answers at which confidence.' },
  '/engines': { title: 'Engines + keys', subtitle: 'Chat mode or your own provider key.' },
};

export function Shell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());
  const [menuOpen, setMenuOpen] = useState(false);
  const [stats, setStats] = useState<ApiStats | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    api
      .stats()
      .then((value) => {
        if (!cancelled) {
          setStats(value);
          setOnline(true);
        }
      })
      .catch(() => {
        if (!cancelled) setOnline(false);
      });
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  const changeTheme = (next: Theme) => {
    setTheme(next);
    storeTheme(next);
  };

  const page = PAGE_TITLES[location.pathname] ?? { title: 'BrowserReflex', subtitle: '' };
  const reviewCount = stats?.decisions.pending_review ?? 0;
  const driftCount = stats?.drift_alerts?.active ?? 0;

  return (
    <div className="shell">
      <nav className={`sidebar${menuOpen ? ' open' : ''}`} aria-label="Main">
        <div className="sidebar-logo">
          <span className="logo-mark" aria-hidden="true" />
          BrowserReflex <span className="chip">alpha</span>
        </div>
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="nav-group-label">{group.label}</div>
            {group.items.map((item) =>
              item.to === undefined ? (
                <div className="nav-item planned" key={item.label} aria-disabled="true">
                  {item.label} <span className="chip">planned</span>
                </div>
              ) : (
                <NavLink
                  key={item.label}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                >
                  {item.label}
                  {item.to === '/review' && reviewCount > 0 ? (
                    <span className="chip chip-review">{reviewCount}</span>
                  ) : null}
                  {item.to === '/' && driftCount > 0 ? (
                    <span className="chip chip-drift">drift</span>
                  ) : null}
                </NavLink>
              ),
            )}
          </div>
        ))}
        <div className="sidebar-footer">
          <NavLink
            to="/setup"
            className="btn"
            style={{ textAlign: 'center', textDecoration: 'none' }}
          >
            Setup wizard
          </NavLink>
          <SegmentedControl<Theme>
            label="Theme"
            value={theme}
            onChange={changeTheme}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
            ]}
          />
          <div className="local-line">Local only · this machine</div>
        </div>
      </nav>
      <div className="main">
        <header className="header">
          <div className="row">
            <button
              type="button"
              className="btn menu-button"
              onClick={() => setMenuOpen((value) => !value)}
              aria-expanded={menuOpen}
            >
              Menu
            </button>
            <div>
              <h1>{page.title}</h1>
              <div className="subtitle">{page.subtitle}</div>
            </div>
          </div>
          <div className="header-right">
            <div className="status-box" aria-live="polite">
              <span className={`status-dot${online === true ? '' : ' off'}`} />
              {online === null
                ? 'Checking API'
                : online
                  ? 'Local API online'
                  : 'Local API unreachable'}
            </div>
            <span className="badge-local">Local only</span>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
