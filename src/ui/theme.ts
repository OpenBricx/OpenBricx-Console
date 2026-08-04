// App theme (dark / light). The whole UI is driven by the --pcb-* CSS variables
// in App.css; a light palette overrides them under :root[data-theme="light"].
// The choice persists in localStorage and is applied to <html> before React
// renders (initTheme in main.tsx) so there's no dark flash on a light start.
export type Theme = 'dark' | 'light';

const KEY = 'obx-theme';

export function getStoredTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(t: Theme): void {
  document.documentElement.setAttribute('data-theme', t);
}

export function storeTheme(t: Theme): void {
  try { localStorage.setItem(KEY, t); } catch { /* private mode — session only */ }
  applyTheme(t);
}

/** Apply the saved theme once at startup. */
export function initTheme(): void {
  applyTheme(getStoredTheme());
}
