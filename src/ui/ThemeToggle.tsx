import { useState } from 'react';
import { getStoredTheme, storeTheme, type Theme } from './theme';

/** Light/dark switch. `icon` variant is a compact button for tight nav bars. */
export function ThemeToggle({ variant = 'full' }: { variant?: 'full' | 'icon' }) {
  const [theme, setTheme] = useState<Theme>(getStoredTheme);
  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    storeTheme(next);
  }
  const label = theme === 'dark' ? 'Light mode' : 'Dark mode';
  return (
    <button
      className={`theme-toggle${variant === 'icon' ? ' theme-toggle--icon' : ''}`}
      onClick={toggle}
      title={label}
      aria-label={label}
    >
      <span className="theme-toggle-icon">{theme === 'dark' ? '☀' : '☾'}</span>
      {variant === 'full' && <span>{label}</span>}
    </button>
  );
}
