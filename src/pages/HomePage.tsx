import type { CSSProperties } from 'react';
import { OfflineConnection } from '../core/transport';
import type { Plugin, Connection } from '../core/types';

interface Props {
  plugins: Plugin[];
  onEnterPlugin: (plugin: Plugin, connection: Connection) => void;
}

/** Map plugin icon keys to emoji glyphs */
const ICON_MAP: Record<string, string> = {
  deck: '🎛️',
  pixels: '💡',
  mods: '⌨️',
  irblaster: '📡',
  simrig: '🏎️',
};

/** Per-product cover hue so each card reads as its own thing (MakerWorld cards
   are colour-coded by category). Falls back to the brand green. */
const TINT_MAP: Record<string, string> = {
  deck: '#2e90fa',      // vibrant brand blue — the flagship
  pixels: '#e05299',    // magenta — it's the RGB lighting product
  mods: '#f49d40',      // brand orange — the RC product (secondary brand pop)
  irblaster: '#b492ff', // violet — the signal product
  simrig: '#f2544b',    // racing red — the sim-rig wheel
};

export function HomePage({ plugins, onEnterPlugin }: Props) {
  function handleLaunch(plugin: Plugin) {
    onEnterPlugin(plugin, new OfflineConnection());
  }

  return (
    <div className="home-page">
      <header className="home-header">
        <h1>Home</h1>
        <p className="home-subtitle">
          Installed plugins &middot; {plugins.length}
        </p>
      </header>

      <div className="home-grid">
        {plugins.map((plugin) => (
          <PluginCard
            key={plugin.manifest.product}
            plugin={plugin}
            onLaunch={() => handleLaunch(plugin)}
          />
        ))}
      </div>

      {plugins.length === 0 && (
        <p className="empty-hint">
          No plugins installed yet — grab your product's plugin from the <strong>Plugins</strong>{' '}
          tab to get started.
        </p>
      )}
    </div>
  );
}

function PluginCard({ plugin, onLaunch }: { plugin: Plugin; onLaunch: () => void }) {
  const m = plugin.manifest;
  const emoji = ICON_MAP[m.icon] ?? '🔌';
  const tint = TINT_MAP[m.icon];

  return (
    <div
      className="home-card"
      style={tint ? ({ '--card-tint': tint } as CSSProperties) : undefined}
      tabIndex={0}
      role="button"
      onClick={onLaunch}
      onKeyDown={(e) => e.key === 'Enter' && onLaunch()}
    >
      <div className="home-card-cover">
        <div className="home-card-icon">{emoji}</div>
      </div>
      <div className="home-card-body">
        <div className="home-card-titlerow">
          <span className="home-card-name">{m.name}</span>
          <span className="home-open-badge" aria-hidden="true">→</span>
        </div>
        <span className="home-card-product">{m.product}</span>
        <div className="home-card-transports">
          {m.transports.map((t) => (
            <span key={t} className={`home-transport-badge transport-${t}`}>
              {t}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
