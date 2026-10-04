/**
 * The colour theme choice. Dark by default; the choice is kept in `localStorage`, which can
 * be missing or throw (a private window, blocked site data), so every access is guarded and
 * the page renders correctly without it.
 */

export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'browserreflex-theme';
export const DEFAULT_THEME: Theme = 'dark';

export function readStoredTheme(): Theme {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

export function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The choice still applies for this session; it is just not remembered.
  }
}
