import { useEffect, useRef } from 'react';
import { pcHost } from '@openbricx/host';
import type { DeckDriver } from './driver';
import { Mode, type MacroConfig, type NowPlaying, type SystemInfo } from './types';

// PC-side host bridge.
//
// Mirrors what the old MochiBridge Rust thread did, but driven from the plugin:
// poll native telemetry (system stats, now-playing, volume) on timers and push
// it to the device via the driver, and when the device asks the host to run a
// PC action (mode 5/6) execute it natively.

interface Options {
  driver: DeckDriver | null;
  /** Resolve a macro slot so E-events can find the app path / URL. */
  getMacro: (profile: number, btn: number) => MacroConfig;
  /** Push display-mode state to the UI when the device changes profile locally. */
  onProfileChanged?: (page: number) => void;
  onVersion?: (version: string) => void;
  /** Device's Wi-Fi address after provisioning ('0.0.0.0' when it drops). */
  onWifiIp?: (ip: string) => void;
  /** Wi-Fi join progress: connecting, or a failure with a reason code. */
  onWifiStatus?: (connecting: boolean, reason?: number) => void;
  /** When true, native polling pushes telemetry to the device. */
  enableTelemetry: boolean;
}

export function useDeckHost({ driver, getMacro, onProfileChanged, onVersion, onWifiIp, onWifiStatus, enableTelemetry }: Options) {
  // Keep the latest getMacro without re-subscribing the event listener.
  const getMacroRef = useRef(getMacro);
  getMacroRef.current = getMacro;
  const onProfileRef = useRef(onProfileChanged);
  onProfileRef.current = onProfileChanged;
  const onVersionRef = useRef(onVersion);
  onVersionRef.current = onVersion;
  const onWifiIpRef = useRef(onWifiIp);
  onWifiIpRef.current = onWifiIp;
  const onWifiStatusRef = useRef(onWifiStatus);
  onWifiStatusRef.current = onWifiStatus;

  // ── Device → host events ────────────────────────────────────────────────────
  useEffect(() => {
    if (!driver) return;
    const unsub = driver.onEvent((e) => {
      if (e.kind === 'pcAction') {
        const cfg = getMacroRef.current(e.profile, e.button);
        if (cfg.mode === Mode.LaunchApp && cfg.pcPath) {
          pcHost.launchApp(cfg.pcPath).catch(console.error);
        } else if (cfg.mode === Mode.OpenLink && cfg.pcPath) {
          pcHost.openLink(cfg.pcPath, cfg.pcBrowser).catch(console.error);
        }
      } else if (e.kind === 'profileChanged') {
        onProfileRef.current?.(e.page);
      } else if (e.kind === 'version') {
        onVersionRef.current?.(e.version);
      } else if (e.kind === 'wifiIp') {
        onWifiIpRef.current?.(e.ip);
      } else if (e.kind === 'wifiStatus') {
        onWifiStatusRef.current?.(e.connecting, e.reason);
      }
    });
    // Ask the device for its firmware version on connect.
    driver.queryVersion();
    return unsub;
  }, [driver]);

  // ── Host → device telemetry ─────────────────────────────────────────────────
  useEffect(() => {
    if (!driver || !enableTelemetry) return;
    let cancelled = false;

    // Only push what CHANGED since the last tick — an idle PC otherwise streams
    // identical volume/stats/media frames forever, and the device parses (and
    // may redraw) every one. The polls stay (they're how change is detected);
    // the serial writes are skipped.
    const last = { vol: -1, sys: '', media: '' };

    // Volume — fast (500 ms) so the on-device dial tracks the encoder closely.
    const volTimer = setInterval(async () => {
      try {
        const vol = await pcHost.getVolume();
        if (!cancelled && vol >= 0 && vol !== last.vol) {
          last.vol = vol;
          driver.sendVolume(vol);
        }
      } catch { /* unavailable on this platform */ }
    }, 500);

    // System stats — every 2 s.
    const sysTimer = setInterval(async () => {
      try {
        const s = await pcHost.getSystemInfo<SystemInfo>();
        const key = `${s.cpu}:${s.cpuTemp}:${s.ramUsed}:${s.ramTotal}:${s.gpu}:${s.gpuTemp}`;
        if (!cancelled && key !== last.sys) {
          last.sys = key;
          driver.sendSystemInfo(s.cpu, s.cpuTemp, s.ramUsed, s.ramTotal, s.gpu, s.gpuTemp);
        }
      } catch { /* ignore */ }
    }, 2000);

    // Now playing — every 1 s (posMs advances while playing, so this still
    // streams once a second during playback; paused/idle media goes quiet).
    const mediaTimer = setInterval(async () => {
      try {
        const n = await pcHost.getNowPlaying<NowPlaying>();
        if (!cancelled && n && n.title) {
          const key = `${n.title}|${n.artist}|${n.posMs}|${n.durMs}|${n.playing}`;
          if (key !== last.media) {
            last.media = key;
            driver.sendNowPlaying(n.title, n.artist, n.posMs, n.durMs, n.playing);
          }
        }
      } catch { /* ignore */ }
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(volTimer);
      clearInterval(sysTimer);
      clearInterval(mediaTimer);
    };
  }, [driver, enableTelemetry]);
}
