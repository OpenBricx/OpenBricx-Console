import type { ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ThemeToggle } from './ThemeToggle';
import logoUrl from '../assets/openbricx-logo.jpeg';
import bmacUrl from '../assets/bmac-button.webp';

const BMAC_URL = 'https://buymeacoffee.com/openbricx';

export type Section = 'home' | 'devices' | 'flash' | 'plugins' | 'about';

interface Props {
  active: Section;
  onNav: (s: Section) => void;
  children: ReactNode;
}

const NAV_ITEMS: { id: Section; label: string; icon: string }[] = [
  { id: 'home',    label: 'Home',    icon: '⌂' },
  { id: 'devices', label: 'My Devices', icon: '⊞' },
  { id: 'flash',   label: 'Flash',   icon: '⚡' },
  { id: 'plugins', label: 'Plugins', icon: '🧩' },
  { id: 'about',   label: 'About',   icon: 'ⓘ' },
];

export function NavShell({ active, onNav, children }: Props) {
  return (
    <div className="nav-shell">
      <aside className="nav-sidebar">
        <div className="nav-brand">
          <img className="nav-brand-logo" src={logoUrl} alt="" width={22} height={22} />
          OpenBricx
        </div>
        <nav className="nav-items">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`nav-item${active === item.id ? ' nav-item--active' : ''}`}
              onClick={() => onNav(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="nav-footer">
          {/* Official Buy Me a Coffee artwork — brand assets must not be
              recoloured, so this stays an <img> rather than an inline SVG like
              the About-page socials. Opened via the OS browser: window.open is
              unreliable in the Tauri webview. */}
          <button
            className="nav-bmac"
            onClick={() =>
              invoke('open_external', { url: BMAC_URL }).catch((e) =>
                console.error('[nav] open failed:', e),
              )
            }
            title="Support OpenBricx on Buy Me a Coffee"
          >
            <img src={bmacUrl} alt="Buy me a coffee" />
          </button>
          <ThemeToggle />
        </div>
      </aside>
      <main className="nav-content">
        {children}
      </main>
    </div>
  );
}
