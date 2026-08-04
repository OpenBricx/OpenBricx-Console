import { invoke } from '@tauri-apps/api/core';
import { APP_VERSION, GITHUB_OWNER, CONSOLE_REPO } from '../core/config';
import logoUrl from '../assets/openbricx-logo.jpeg';
import bmacUrl from '../assets/bmac-button.webp';

// Source repo, derived from the same constants the plugin/firmware catalogs use
// (src/core/config.ts) so the GPL "where's the source" link can never drift from
// the URLs the app actually fetches from.
const REPO_URL = `https://github.com/${GITHUB_OWNER}/${CONSOLE_REPO}`;

const LINKS = {
  github: REPO_URL,
  license: `${REPO_URL}/blob/main/LICENSE`,
  // TODO: confirm these handles exist before release.
  makerworld: 'https://makerworld.com/@OpenBricx',
  instagram: 'https://instagram.com/openbricx',
  youtube: 'https://youtube.com/@OpenBricx',
  bmac: 'https://buymeacoffee.com/openbricx',
};

/**
 * Hand the URL to the OS. `open_external` calls Rust's `open::that`, which
 * launches the user's default browser (or the brand's native app, if it has
 * registered the URL scheme).
 *
 * This is also what keeps the app tracking-free: no link is ever rendered in the
 * webview, so no third-party script, cookie, or analytics pixel executes inside
 * the Console. Do NOT replace this with an <a href> or an iframe.
 */
function openExternal(url: string) {
  invoke('open_external', { url }).catch((e) => console.error('[about] open failed:', e));
}

interface LinkDef {
  id: string;
  label: string;
  url: string;
  icon: JSX.Element;
}

const PROJECT_LINKS: LinkDef[] = [
  {
    id: 'github',
    label: 'GitHub',
    url: LINKS.github,
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
        <path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.2.8-.5v-1.7c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.7 18.3 5 18.3 5c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.6.8.5 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z" />
      </svg>
    ),
  },
  {
    id: 'makerworld',
    label: 'MakerWorld',
    url: LINKS.makerworld,
    // Official mark, kept at its native 28x28 viewBox. The source SVG's clipPath
    // was dropped: its rect is 82x28 (wider than the viewBox, so it clipped
    // nothing) and inline ids can collide across icons.
    icon: (
      <svg viewBox="0 0 28 28" width="18" height="18" fill="currentColor" aria-hidden="true">
        <path d="M27.2867 2.68142L20.8492 0.160571L20.4386 0L20.0257 0.160571L13.9977 2.51861L7.96978 0.160571L7.56139 0L7.15188 0.160571L0.713275 2.68142L0 2.96102V25.0401L0.713275 25.3186L7.15188 27.8394L7.56139 28L7.97091 27.8394L14 25.4814L20.028 27.8394L20.4386 28L20.8492 27.8394L27.2867 25.3186L28 25.0401V2.96102L27.2867 2.68142ZM20.4386 1.20372L26.8772 3.7257V12.8356L20.4386 10.3158V1.20372ZM14.4095 13.8787L20.4386 11.5207L26.4677 13.8787L26.7748 13.9989L26.4677 14.119L20.4386 16.4771L14.4095 14.119L14.1024 13.9989L14.4095 13.8787ZM7.56139 1.20372L14 3.7257V12.8356L7.56139 10.3147V1.20372ZM1.53343 13.8787L7.56139 11.5207L13.5905 13.8787L13.8976 13.9989L13.5905 14.119L7.56139 16.4771L1.53343 14.119L1.22629 13.9989L1.53343 13.8787ZM1.12504 24.2732V15.1588L7.56365 17.6785V26.7895L1.12504 24.2732ZM14.0022 24.2732V15.1588L20.4409 17.6785V26.7895L14.0022 24.2732Z" />
      </svg>
    ),
  },
];

const SOCIAL_LINKS: LinkDef[] = [
  {
    id: 'youtube',
    label: 'YouTube',
    url: LINKS.youtube,
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
        <path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2C0 8.1 0 12 0 12s0 3.9.5 5.8a3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1c.5-1.9.5-5.8.5-5.8s0-3.9-.5-5.8zM9.6 15.6V8.4l6.3 3.6-6.3 3.6z" />
      </svg>
    ),
  },
  {
    id: 'instagram',
    label: 'Instagram',
    url: LINKS.instagram,
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <rect x="2" y="2" width="20" height="20" rx="5.5" />
        <circle cx="12" cy="12" r="4.2" />
        <circle cx="17.6" cy="6.4" r="1.2" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
];

function LinkRow({ links }: { links: LinkDef[] }) {
  return (
    <div className="about-socials">
      {links.map((l) => (
        <button
          key={l.id}
          className={`about-social about-social--${l.id}`}
          onClick={() => openExternal(l.url)}
          title={l.url}
        >
          {l.icon}
          <span>{l.label}</span>
        </button>
      ))}
    </div>
  );
}

export function AboutPage() {
  return (
    <div className="about-page">
      <div className="about-card">
        {/* ── Identity: name, version, licence ─────────────────────────────── */}
        <img className="about-logo" src={logoUrl} alt="OpenBricx" width={88} height={88} />
        <h1 className="about-title">OpenBricx Console</h1>
        <span className="about-version">v{APP_VERSION}</span>

        <p className="about-license">
          Free software under the{' '}
          <button className="about-inline-link" onClick={() => openExternal(LINKS.license)}>
            GNU General Public License v3.0
          </button>{' '}
          — derivatives stay under the same licence; plugins using only the
          documented SDK boundary are exempt.
        </p>

        <button className="about-source-btn" onClick={() => openExternal(LINKS.github)}>
          View the full source code
        </button>

        {/* ── Who we are ───────────────────────────────────────────────────── */}
        <section className="about-block">
          <h2 className="about-block-title">About the Project</h2>
          <p className="about-desc">
            OpenBricx is an open-source project — PCB designs, device firmware, and
            this Console, all published so you can read and change them. The boards
            are built around commodity ESP32 modules with a documented protocol,
            so nothing here is a black box: flash it, fork it,
            or build something we never imagined. The Console is the desktop hub —
            discover devices over USB, Bluetooth, or Wi-Fi, flash firmware, and
            configure your gear in one place.
          </p>
        </section>

        {/* Three groups side by side on a wide card; they stack on narrow ones. */}
        <div className="about-groups">
          <section className="about-block">
            <h2 className="about-block-title">Project</h2>
            <LinkRow links={PROJECT_LINKS} />
          </section>

          <section className="about-block">
            <h2 className="about-block-title">Connect with Us</h2>
            <LinkRow links={SOCIAL_LINKS} />
          </section>

          <section className="about-block">
            <h2 className="about-block-title">Support</h2>
            <button
              className="about-bmac"
              onClick={() => openExternal(LINKS.bmac)}
              title="Support OpenBricx on Buy Me a Coffee"
            >
              <img src={bmacUrl} alt="Buy me a coffee" />
            </button>
          </section>
        </div>

        <p className="about-credit">
          Built with <span className="about-heart">❤️</span> by the OpenBricx Community.
        </p>

        <p className="about-disclaimer">
          All product names, logos, and brands are property of their respective
          owners. Their use here identifies the linked service only and does not
          imply affiliation or endorsement. Links open in your default browser —
          the Console never loads third-party content or tracking scripts.
        </p>
      </div>
    </div>
  );
}
