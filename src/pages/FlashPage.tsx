import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { ESPLoader, Transport } from 'esptool-js';
import { listSerialPorts, connectSerial } from '../core/transport';
import {
  downloadFirmware,
  fetchFirmwareCatalog,
  onFirmwareDownloadProgress,
  type FirmwareEntry,
} from '../core/firmware';
import { DEFAULT_FIRMWARE_CATALOG_URL } from '../core/config';
import type { SerialPortInfo } from '../core/transport';
import type { Connection, Plugin, DeviceHandshake } from '../core/types';

interface Props {
  plugins: Plugin[];
  onEnterPlugin: (plugin: Plugin, connection: Connection, handshake?: DeviceHandshake) => void;
}

// Per-port state during and after a flash attempt.
interface PortFlashState {
  flashing: boolean;
  stage: string;
  percent: number;
  error: string | null;
  done: boolean;
}

// The sentinel value for "pick a local .bin with the file dialog" in the
// firmware-source selector; every other value is a catalog entry's URL.
const SOURCE_LOCAL = 'local';

// Decode a base64 string into the binary string esptool-js expects (each char
// code is one byte). `atob` already produces exactly that.
function base64ToBinaryString(b64: string): string {
  return atob(b64);
}

function fwLabel(e: FirmwareEntry): string {
  const hw = e.hwRev ? ` ${e.hwRev}` : '';
  return `${e.product} v${e.version} · ${e.chip}${hw}`;
}

export function FlashPage({ plugins, onEnterPlugin }: Props) {
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanError, setScanError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectErrors, setConnectErrors] = useState<Record<string, string>>({});
  const [flashStates, setFlashStates] = useState<Record<string, PortFlashState>>({});

  // ── Firmware library (signed catalog on GitHub) ──────────────────────────
  // kind === 'flash' entries only: these are the merged cold-flash images this
  // page writes at 0x0. OTA images live in each plugin's Settings tab instead.
  const [fwCatalog, setFwCatalog] = useState<FirmwareEntry[] | null>(null);
  const [fwLoading, setFwLoading] = useState(false);
  const [fwError, setFwError] = useState<string | null>(null);
  const [fwSource, setFwSource] = useState<string>(SOURCE_LOCAL);

  async function loadFirmwareLibrary() {
    setFwLoading(true);
    setFwError(null);
    try {
      const catalog = await fetchFirmwareCatalog(DEFAULT_FIRMWARE_CATALOG_URL);
      const flashImages = catalog.firmware
        .filter((e) => e.kind === 'flash')
        .sort((a, b) => a.product.localeCompare(b.product));
      setFwCatalog(flashImages);
      if (flashImages.length === 0) setFwError('The catalog has no cold-flash images yet.');
    } catch (e) {
      setFwError(`Could not load the firmware library: ${e}`);
      setFwCatalog(null);
      setFwSource(SOURCE_LOCAL);
    } finally {
      setFwLoading(false);
    }
  }

  async function refreshPorts() {
    setLoading(true);
    setScanError(null);
    try {
      setPorts(await listSerialPorts());
    } catch (e) {
      setScanError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshPorts();
  }, []);

  function setFlash(port: string, patch: Partial<PortFlashState>) {
    setFlashStates((prev) => {
      const base: PortFlashState =
        prev[port] ?? { flashing: false, stage: '', percent: 0, error: null, done: false };
      return { ...prev, [port]: { ...base, ...patch } };
    });
  }

  // ── Connect (OBX handshake) ──────────────────────────────────────────────

  async function handleConnect(portName: string) {
    setConnecting(portName);
    setConnectErrors((prev) => { const next = { ...prev }; delete next[portName]; return next; });

    try {
      const { connection, handshake } = await connectSerial(portName);
      const plugin = plugins.find((p) => p.manifest.product === handshake.product);

      if (!plugin) {
        await connection.close().catch(console.error);
        setConnectErrors((prev) => ({
          ...prev,
          [portName]: `No plugin for "${handshake.product}" — device responded but product is unrecognised. Install its plugin on the Plugins tab.`,
        }));
        return;
      }

      onEnterPlugin(plugin, connection, handshake);
    } catch (e) {
      setConnectErrors((prev) => ({ ...prev, [portName]: String(e) }));
    } finally {
      setConnecting(null);
    }
  }

  // ── Resolve the firmware to write ─────────────────────────────────────────
  // Either a verified download from the signed catalog (progress surfaces on the
  // port card) or a local .bin via the file dialog. Returns null on cancel.
  async function resolveFirmwarePath(portName: string): Promise<string | null> {
    const entry = fwCatalog?.find((e) => e.url === fwSource);
    if (entry) {
      setFlash(portName, { flashing: true, stage: 'downloading', percent: 0, error: null, done: false });
      const unlisten = await onFirmwareDownloadProgress((url, percent) => {
        if (url === entry.url) setFlash(portName, { stage: 'downloading', percent });
      });
      try {
        // Hash-verified against the signed catalog inside the Rust host.
        return await downloadFirmware(entry);
      } finally {
        unlisten();
      }
    }

    const path = await openDialog({
      title: 'Select firmware (.bin)',
      filters: [{ name: 'Firmware binary', extensions: ['bin'] }],
    });
    return typeof path === 'string' ? path : null;
  }

  // ── Flash firmware (esptool-js over Web Serial) ──────────────────────────
  //
  // This mirrors the proven MochiBridge flow:
  //   1. (auto-DFU) Rust reboots the running device into the ROM bootloader via
  //      the 1200-baud touch + OBX `DFU` command.
  //   2. The user picks the now-in-download-mode port from the Web Serial picker.
  //   3. esptool-js connects to the ROM and writes the merged image at 0x0.
  // esptool-js is the same battle-tested esptool protocol that connects reliably
  // to the ESP32-S3 USB-Serial/JTAG download port (where espflash was choking).
  async function handleFlash(portName: string, autoDfu: boolean) {
    const serial = (navigator as unknown as { serial?: any }).serial;
    if (!serial) {
      setFlash(portName, {
        flashing: false, stage: 'error', percent: 0, done: false,
        error: 'Web Serial is not available in this build. Update the app/WebView2.',
      });
      return;
    }

    // 1. Acquire the Web Serial port FIRST. requestPort() needs the click's user
    //    activation, which expires after a few seconds — so it must run before the
    //    file dialog / download (either can outlive the activation window,
    //    which caused the intermittent "Must be handling a user gesture" error).
    //    Auto-DFU has to reboot into the ROM first so the download port exists.
    let serialPort: any;
    try {
      if (autoDfu) {
        setFlash(portName, { flashing: true, stage: 'rebooting', percent: 5, error: null, done: false });
        try {
          await invoke<string>('reboot_to_bootloader', { portName });
        } catch (e) {
          console.warn('reboot_to_bootloader failed (continuing to manual pick):', e);
        }
        await new Promise((r) => setTimeout(r, 600)); // let Windows enumerate the download port
      }
      serialPort = await serial.requestPort({ filters: [{ usbVendorId: 0x303a }] });
    } catch {
      // Picker cancelled or no port chosen — not a hard error.
      setFlash(portName, { flashing: false, stage: 'idle', percent: 0, error: null, done: false });
      return;
    }

    // 2. Resolve the image: verified catalog download or local .bin pick.
    let path: string | null;
    try {
      path = await resolveFirmwarePath(portName);
    } catch (e) {
      setFlash(portName, { flashing: false, stage: 'error', percent: 0, error: String(e), done: false });
      return;
    }
    if (!path) {
      setFlash(portName, { flashing: false, stage: 'idle', percent: 0, error: null, done: false });
      return; // cancelled
    }

    setFlash(portName, { flashing: true, stage: 'preparing', percent: 0, error: null, done: false });

    let transport: Transport | undefined;
    try {
      const b64 = await invoke<string>('read_firmware_file', { path });
      const firmware = base64ToBinaryString(b64);

      // 3. esptool-js: connect to ROM and flash.
      setFlash(portName, { stage: 'connecting', percent: 10 });
      transport = new Transport(serialPort);
      const esploader = new ESPLoader({
        transport,
        baudrate: 115200,
        romBaudrate: 115200,
        terminal: {
          clean: () => {},
          writeLine: (data: string) => console.log('[esptool]', data),
          write: (data: string) => console.log('[esptool]', data),
        },
      } as any);

      await esploader.main_fn();

      setFlash(portName, { stage: 'writing', percent: 0 });
      await esploader.write_flash({
        fileArray: [{ data: firmware, address: 0x0 }],
        flashSize: 'keep',
        flashMode: 'keep',
        flashFreq: 'keep',
        eraseAll: false,
        compress: true,
        reportProgress: (_fileIndex: number, written: number, total: number) => {
          const percent = total > 0 ? Math.round((written / total) * 100) : 0;
          setFlash(portName, { flashing: true, stage: 'writing', percent, done: false });
        },
      } as any);

      await esploader.hard_reset();
      setFlash(portName, { flashing: false, stage: 'done', percent: 100, error: null, done: true });

      await transport.disconnect().catch(() => {});
    } catch (e) {
      setFlash(portName, { flashing: false, stage: 'error', percent: 0, error: String(e), done: false });
      if (transport) {
        await transport.disconnect().catch(() => {});
      }
    } finally {
      // The device just rebooted (or re-enumerated); refresh the list.
      setTimeout(refreshPorts, 1500);
    }
  }

  const anyBusy = connecting !== null || Object.values(flashStates).some((s) => s.flashing);
  const selectedEntry = fwCatalog?.find((e) => e.url === fwSource) ?? null;

  return (
    <div className="container">
      <header className="app-header">
        <h1>Firmware Flasher</h1>
        <button className="refresh-btn" onClick={refreshPorts} disabled={loading || anyBusy}>
          {loading ? 'Scanning…' : 'Refresh'}
        </button>
      </header>

      <p className="flash-hint">
        Connect a device via USB. <strong>Enter Flash Mode</strong> reboots a running OpenBricx
        device and writes new firmware (you'll pick the device in the system port prompt).
        <strong> Flash</strong> writes to a device already in download mode (hold BOOT, tap
        RESET). <strong>Connect</strong> opens a device that already has working firmware.
      </p>

      {/* ── Firmware source: signed GitHub catalog or a local file ─────────── */}
      <section className="fw-lib">
        <div className="fw-lib-head">
          <h2>Firmware</h2>
          <button
            className="refresh-btn"
            onClick={loadFirmwareLibrary}
            disabled={fwLoading || anyBusy}
          >
            {fwLoading ? 'Loading…' : fwCatalog ? 'Refresh library' : 'Load online library'}
          </button>
        </div>

        {fwError && <p className="flash-error">{fwError}</p>}

        <div className="fw-lib-options">
          <label className={`fw-lib-option${fwSource === SOURCE_LOCAL ? ' fw-lib-option--on' : ''}`}>
            <input
              type="radio"
              name="fw-source"
              checked={fwSource === SOURCE_LOCAL}
              onChange={() => setFwSource(SOURCE_LOCAL)}
            />
            <span className="fw-lib-name">Local .bin file…</span>
            <span className="fw-lib-notes">pick the image with a file dialog when flashing</span>
          </label>

          {(fwCatalog ?? []).map((e) => (
            <label
              key={e.url}
              className={`fw-lib-option${fwSource === e.url ? ' fw-lib-option--on' : ''}`}
            >
              <input
                type="radio"
                name="fw-source"
                checked={fwSource === e.url}
                onChange={() => setFwSource(e.url)}
              />
              <span className="fw-lib-name">{fwLabel(e)}</span>
              {e.notes && <span className="fw-lib-notes">{e.notes}</span>}
            </label>
          ))}
        </div>

        {!fwCatalog && !fwError && (
          <p className="empty-hint" style={{ marginTop: '0.4rem' }}>
            Load the online library to flash official images straight from GitHub — downloads are
            signature-verified before they ever touch a device.
          </p>
        )}
        {selectedEntry && (
          <p className="fw-lib-selected">
            Flash buttons below will write <strong>{fwLabel(selectedEntry)}</strong> (verified
            download).
          </p>
        )}
      </section>

      {scanError && <p className="flash-error">{scanError}</p>}

      {!loading && ports.length === 0 && !scanError && (
        <p className="empty-hint">No USB serial devices detected.</p>
      )}

      {ports.length > 0 && (
        <div className="port-list">
          {ports.map((port) => {
            const isConnecting = connecting === port.name;
            const fs = flashStates[port.name];
            const isFlashing = fs?.flashing ?? false;
            const isBusy = isConnecting || isFlashing;
            // Espressif native-USB devices (VID 0x303A) running OpenBricx firmware
            // own their USB port, so offer the auto-DFU "Enter Flash Mode" path.
            const supportsDfu = port.vid === 0x303a;

            return (
              <div
                key={port.name}
                className={`port-card${isBusy ? ' port-card--connecting' : ''}`}
              >
                <div className="port-header">
                  <span className="port-name">{port.name}</span>
                  <div className="port-actions">
                    {port.vid != null && port.pid != null && (
                      <span className="port-ids">
                        {port.vid.toString(16).toUpperCase().padStart(4, '0')}:
                        {port.pid.toString(16).toUpperCase().padStart(4, '0')}
                      </span>
                    )}
                    {supportsDfu && (
                      <button
                        className="flash-bin-btn flash-dfu-btn"
                        onClick={() => handleFlash(port.name, true)}
                        disabled={anyBusy}
                        title="Reboot a running OpenBricx device into flash mode and write firmware — no BOOT+RESET needed"
                      >
                        {isFlashing ? 'Flashing…' : 'Enter Flash Mode'}
                      </button>
                    )}
                    <button
                      className="flash-bin-btn"
                      onClick={() => handleFlash(port.name, false)}
                      disabled={anyBusy}
                      title={
                        supportsDfu
                          ? 'Flash the selected firmware directly (device must already be in download mode — hold BOOT, press RESET)'
                          : 'Flash the selected firmware image to this device'
                      }
                    >
                      {isFlashing ? 'Flashing…' : 'Flash'}
                    </button>
                    <button
                      className="connect-btn"
                      onClick={() => handleConnect(port.name)}
                      disabled={anyBusy}
                      title="Connect to a device that already has OpenBricx firmware"
                    >
                      {isConnecting ? 'Connecting…' : 'Connect'}
                    </button>
                  </div>
                </div>

                {port.description && (
                  <span className="port-description">{port.description}</span>
                )}

                {/* Flash progress bar */}
                {fs && (fs.flashing || fs.done) && (
                  <div className="flash-progress">
                    <div className="flash-progress-track">
                      <div
                        className="flash-progress-fill"
                        style={{ width: `${fs.percent}%` }}
                      />
                    </div>
                    <span className="flash-progress-label">
                      {fs.done
                        ? 'Done — device is rebooting'
                        : fs.stage === 'rebooting'
                          ? 'Rebooting into flash mode…'
                          : fs.stage === 'select-port'
                            ? 'Select the OpenBricx device in the prompt…'
                            : fs.stage === 'downloading'
                              ? `Downloading firmware ${fs.percent}%`
                              : fs.stage === 'connecting'
                                ? 'Connecting to bootloader…'
                                : fs.stage === 'writing'
                                  ? `Writing ${fs.percent}%`
                                  : `${fs.stage} ${fs.percent}%`}
                    </span>
                  </div>
                )}

                {/* Per-card errors */}
                {connectErrors[port.name] && (
                  <span className="port-error">{connectErrors[port.name]}</span>
                )}
                {fs?.error && (
                  <span className="port-error">{fs.error}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
