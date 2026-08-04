import './Deck.css';
import { useEffect, useMemo, useState } from 'react';
import type { Connection, DeviceHandshake } from '@openbricx/host';
import { DeckDriver } from './driver';
import { useDeckConfig } from './useDeckConfig';
import { useDeckHost } from './useDeckHost';
import { Dashboard } from './components/Dashboard';
import { Profiles } from './components/Profiles';
import { Settings } from './components/Settings';

interface Props {
  connection: Connection;
  handshake?: DeviceHandshake;
}

type Tab = 'dashboard' | 'profiles' | 'settings';

// Fallback config key for connections that arrive without a handshake (the
// handshake's deviceId is the real per-device key — without it, two different
// Decks would share one config and the connect-time syncAll would clobber
// Deck B's NVS with Deck A's macros).
const FALLBACK_DEVICE_KEY = 'openbricx-deck';

const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: 'dashboard', icon: '🎛️', label: 'Dashboard' },
  { id: 'profiles', icon: '👤', label: 'Profiles' },
  { id: 'settings', icon: '⚙️', label: 'Settings' },
];

// Named `Root` is the external-loader contract (loadPlugin.ts requires it); the
// default export keeps the builtin-registry path working if Deck is compiled in.
export function Root({ connection, handshake }: Props) {
  // One driver per connection lifetime. The byte-stream subscription lives in
  // the effect (attach/detach), not the constructor: StrictMode's phantom
  // cleanup would otherwise permanently deafen the memoized driver.
  const driver = useMemo(() => new DeckDriver(connection), [connection]);
  useEffect(() => {
    driver.attach();
    return () => driver.detach();
  }, [driver]);

  const cfg = useDeckConfig(handshake?.deviceId || FALLBACK_DEVICE_KEY, driver);
  const [tab, setTab] = useState<Tab>('dashboard');
  const [activeProfile, setActiveProfile] = useState(0);
  // Seed the firmware version from the connect handshake (authoritative and
  // already in hand) so it shows immediately; the `I` query just re-confirms it.
  const [firmwareVersion, setFirmwareVersion] = useState<string | null>(handshake?.fwVersion ?? null);
  const [telemetryEnabled, setTelemetryEnabled] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [online, setOnline] = useState(connection.status === 'connected');

  // Track the live link so the Save button can disable itself with no device.
  useEffect(() => {
    setOnline(connection.status === 'connected');
    return connection.onStatusChange((s) => setOnline(s === 'connected'));
  }, [connection]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 2500);
  };

  async function handleSave() {
    const before = cfg.pendingCount;
    const n = await cfg.saveToDevice();
    if (n > 0 && n >= before) showToast(`Saved ${n} change${n === 1 ? '' : 's'} to Deck ✨`);
    else if (n > 0) showToast(`Saved ${n} — ${before - n} still pending (link hiccup or new edits)`);
    else if (before > 0) showToast('Save failed — the Deck isn’t responding. Check the connection.');
    else showToast('Nothing to save');
  }

  // Host bridge: telemetry push + E-event execution + device→host events.
  useDeckHost({
    driver,
    getMacro: cfg.getMacro,
    enableTelemetry: telemetryEnabled,
    onProfileChanged: (page) => setActiveProfile(page),
    onVersion: (v) => setFirmwareVersion(v),
  });

  // On connect, mirror the full host config into the device's NVS.
  useEffect(() => {
    driver.syncAll(cfg.config).catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driver]);

  function handleSwitchProfile(page: number) {
    setActiveProfile(page);
    driver.switchProfile(page);
  }

  return (
    <div className="deck">
      <div className="deck-tabbar">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`deck-tab${tab === t.id ? ' deck-tab--active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <span className="deck-tab-icon">{t.icon}</span>
            {t.label}
          </button>
        ))}
        <div className="deck-tabbar-actions">
          {!online && <span className="deck-offline-tag" title="Connect your Deck on the Devices tab">offline</span>}
          <button
            className="deck-btn primary"
            disabled={!online || cfg.pendingCount === 0}
            onClick={handleSave}
            title={online ? 'Push staged changes to the device' : 'No device connected'}
          >
            💾 Save to Deck{cfg.pendingCount > 0 ? ` (${cfg.pendingCount})` : ''}
          </button>
        </div>
      </div>

      <div className="deck-content">
        {tab === 'dashboard' && (
          <Dashboard
            cfg={cfg}
            activeProfile={activeProfile}
            online={online}
            onSwitchProfile={handleSwitchProfile}
            showToast={showToast}
          />
        )}
        {tab === 'profiles' && (
          <Profiles
            cfg={cfg}
            activeProfile={activeProfile}
            onSwitchProfile={handleSwitchProfile}
            showToast={showToast}
          />
        )}
        {tab === 'settings' && (
          <Settings
            driver={driver}
            online={online}
            firmwareVersion={firmwareVersion}
            telemetryEnabled={telemetryEnabled}
            onToggleTelemetry={setTelemetryEnabled}
            showToast={showToast}
          />
        )}
      </div>

      {toast && <div className="deck-toast">{toast}</div>}
    </div>
  );
}

export default Root;
