import { invoke } from '@tauri-apps/api/core';

// Core PC-host client — native actions and telemetry the host machine performs
// on a device's behalf (launch an app, open a URL, read volume/stats/media).
// Plugins call these instead of invoking the Rust commands directly
// (ARCHITECTURE.md layering: core is the only gateway to Rust).

export function launchApp(path: string): Promise<void> {
  return invoke('deck_launch_app', { path });
}

export function openLink(url: string, browser?: string): Promise<void> {
  return invoke('deck_open_link', { url, browser });
}

/** System master volume 0–100, or -1 when unavailable on this platform. */
export function getVolume(): Promise<number> {
  return invoke<number>('deck_volume');
}

/** CPU/GPU/RAM snapshot; the caller supplies its expected shape. */
export function getSystemInfo<T>(): Promise<T> {
  return invoke<T>('deck_system_info');
}

/** Current media session, or null when nothing is playing. */
export function getNowPlaying<T>(): Promise<T | null> {
  return invoke<T | null>('deck_now_playing');
}
