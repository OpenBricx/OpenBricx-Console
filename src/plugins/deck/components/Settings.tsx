import { useEffect, useState } from 'react';
import { dialog, firmware, ota, type FirmwareEntry } from '@openbricx/host';
import { DISPLAY_MODES } from '../types';
import type { DeckDriver } from '../driver';

// The deck's SoftAP (must match the firmware's wifi.c).
const AP_SSID = 'OpenBricx-Deck';
const AP_PASS = 'openbricx';
const AP_IP = '192.168.4.1';

const PRODUCT = 'openbricx-deck';

interface Props {
  driver: DeckDriver;
  online: boolean;
  firmwareVersion: string | null;
  telemetryEnabled: boolean;
  onToggleTelemetry: (on: boolean) => void;
  showToast: (msg: string) => void;
}

/** Loose semver compare: positive when a > b (mirrors core/firmware.ts). */
function newerThan(a: string, b: string): boolean {
  const pa = a.replace(/^v/i, '').split(/[.+-]/);
  const pb = b.replace(/^v/i, '').split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i] ?? '0');
    const nb = Number(pb[i] ?? '0');
    if (na !== nb) return na > nb;
  }
  return false;
}

export function Settings({ driver, online, firmwareVersion, telemetryEnabled, onToggleTelemetry, showToast }: Props) {
  const [displayMode, setDisplayMode] = useState(0);
  const [brightness, setBrightness] = useState(80);
  const [otaBusy, setOtaBusy] = useState(false);
  const [otaStage, setOtaStage] = useState<string>('');
  const [otaPercent, setOtaPercent] = useState(0);

  // Latest published OTA image for the deck, from the signed GitHub catalog.
  // null = not checked / nothing found; the local-file path stays as fallback.
  const [latest, setLatest] = useState<FirmwareEntry | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const un = ota.onProgress((percent) => setOtaPercent(percent));
    return () => {
      un.then((f) => f());
    };
  }, []);

  async function checkLatest() {
    setChecking(true);
    try {
      const catalog = await firmware.fetchCatalog();
      const entries = catalog.firmware
        .filter((e) => e.product === PRODUCT && e.kind === 'ota')
        .sort((a, b) => (newerThan(a.version, b.version) ? -1 : 1));
      setLatest(entries[0] ?? null);
      if (!entries.length) showToast('No published deck firmware found in the catalog.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`Could not check for updates (${msg}). Are you online?`);
    } finally {
      setChecking(false);
    }
  }

  /** Push an already-local image to the deck's SoftAP OTA endpoint. */
  async function pushOta(path: string) {
    setOtaStage('uploading');
    setOtaPercent(0);
    showToast('Uploading firmware to the deck…');
    await ota.updateFirmwareWifi(AP_IP, path);
    showToast('Firmware updated — deck rebooting ✨');
  }

  async function updateFromGitHub() {
    if (!latest) return;
    try {
      setOtaBusy(true);
      setOtaStage('downloading');
      setOtaPercent(0);
      const un = await firmware.onDownloadProgress((url, percent) => {
        if (url === latest.url) setOtaPercent(percent);
      });
      let path: string;
      try {
        // Hash-verified against the signed catalog inside the Rust host.
        path = await firmware.download(latest);
      } finally {
        un();
      }
      await pushOta(path);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`Update failed (${msg}). Are you on the "${AP_SSID}" Wi-Fi with Update open on the deck?`);
    } finally {
      setOtaBusy(false);
      setOtaStage('');
    }
  }

  async function updateFromFile() {
    const path = await dialog.open({
      title: 'Select the OTA image (openbricx-deck-ota-vX.Y.Z.bin)',
      filters: [{ name: 'OpenBricx Deck OTA image', extensions: ['bin'] }],
    });
    if (!path) return;
    try {
      setOtaBusy(true);
      await pushOta(path);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`Update failed (${msg}). Are you on the "${AP_SSID}" Wi-Fi with Update open on the deck?`);
    } finally {
      setOtaBusy(false);
      setOtaStage('');
    }
  }

  function changeDisplayMode(mode: number) {
    setDisplayMode(mode);
    driver.setDisplayMode(mode);
  }

  function changeBrightness(val: number) {
    setBrightness(val);
    driver.setBrightness(val);
  }

  function confirmWipe() {
    if (confirm('Wipe all macros from the device NVS and reboot? This cannot be undone.')) {
      driver.wipe();
      showToast('Wiping device memory…');
    }
  }

  const updateAvailable =
    latest !== null && (!firmwareVersion || newerThan(latest.version, firmwareVersion));

  return (
    <div className="ob-page">
      <header className="ob-page-head">
        <h2>⚙️ Settings</h2>
        <p className="muted">Configure your OpenBricx Deck.</p>
      </header>

      <div className="ob-cardgrid">
        <section className="deck-card ob-panel">
          <h3>🖥️ Mochi Display Mode</h3>
          <div className="radio-col">
            {DISPLAY_MODES.map((m) => (
              <label key={m.id} className="radio-row">
                <input
                  type="radio"
                  name="displayMode"
                  checked={displayMode === m.id}
                  onChange={() => changeDisplayMode(m.id)}
                />
                {m.label}
              </label>
            ))}
          </div>
        </section>

        <section className="deck-card ob-panel">
          <h3>🔆 Brightness</h3>
          <div className="setting-row">
            <span>Mochi Backlight</span>
            {/* min must be a multiple of step: a range input steps FROM min, so
                min=1/step=5 topped out at 96 (1,6,…,96 — 101 overshoots max). */}
            <input
              type="range"
              min={5}
              max={100}
              step={5}
              value={brightness}
              onChange={(e) => changeBrightness(Number(e.target.value))}
            />
            <span className="muted">{brightness}%</span>
          </div>
        </section>

        <section className="deck-card ob-panel">
          <h3>🔄 PC Telemetry</h3>
          <div className="setting-row">
            <span>Stream CPU / GPU / now-playing / volume to the device</span>
            <button
              className={`toggle${telemetryEnabled ? ' on' : ''}`}
              onClick={() => onToggleTelemetry(!telemetryEnabled)}
            >
              <span className="toggle-knob" />
            </button>
          </div>
        </section>

        <section className="deck-card ob-panel">
          <h3>🔌 Device Info</h3>
          <div className="info-grid">
            <span className="muted">Firmware</span>
            <span>{online ? (firmwareVersion ?? 'Querying…') : 'Not connected'}</span>
            <span className="muted">Hardware</span>
            <span>ESP32-S3 SuperMini</span>
            <span className="muted">Transport</span>
            <span>{online ? 'USB serial — connected' : 'Not connected'}</span>
          </div>
        </section>

        <section className="deck-card ob-panel">
          <h3>📡 Firmware Update (Wi-Fi)</h3>
          <ol className="muted" style={{ margin: '0 0 0.8rem', paddingLeft: '1.1rem', lineHeight: 1.8 }}>
            <li>On the deck: <strong>double-click the encoder → Settings → Update</strong>. The screen shows the hotspot.</li>
            <li>
              Connect this PC's Wi-Fi to <strong>{AP_SSID}</strong> (password <code>{AP_PASS}</code>).
            </li>
            <li>Update from GitHub below (or pick a local <code>…-ota-….bin</code>).</li>
          </ol>

          {/* Latest-from-GitHub — the normal end-user path. */}
          <div className="btn-row" style={{ marginBottom: '0.5rem' }}>
            {latest === null ? (
              <button className="deck-btn" onClick={checkLatest} disabled={checking || otaBusy}>
                {checking ? 'Checking…' : '🔎 Check GitHub for updates'}
              </button>
            ) : (
              <button className="deck-btn primary" onClick={updateFromGitHub} disabled={otaBusy}>
                {otaBusy
                  ? otaStage === 'downloading'
                    ? `Downloading… ${otaPercent}%`
                    : `Updating… ${otaPercent}%`
                  : updateAvailable
                    ? `⬆️ Update to v${latest.version}`
                    : `Reinstall v${latest.version}`}
              </button>
            )}
            <button className="deck-btn" onClick={updateFromFile} disabled={otaBusy}>
              Local .bin…
            </button>
          </div>

          {latest !== null && !otaBusy && (
            <p className="muted" style={{ fontSize: '0.78rem' }}>
              {updateAvailable
                ? `New firmware v${latest.version} is available${latest.notes ? ` — ${latest.notes}` : ''}.`
                : `You're on the latest published firmware (v${latest.version}).`}
            </p>
          )}
          <p className="muted" style={{ marginTop: '0.4rem', fontSize: '0.78rem' }}>
            Pushes to {AP_IP}. GitHub downloads are signature-verified before they touch the deck.
            Your PC briefly loses internet while on the deck's hotspot — check for updates{' '}
            <em>before</em> joining it.
          </p>
        </section>

        <section className="deck-card ob-panel">
          <h3>⚠️ Maintenance</h3>
          <div className="btn-row">
            <button className="deck-btn" onClick={() => { driver.reboot(); showToast('Rebooting device…'); }}>
              Reboot Device
            </button>
            <button className="deck-btn danger" onClick={confirmWipe}>
              Wipe Device Memory
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
