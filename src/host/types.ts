import type * as React from 'react';
import type * as JsxRuntime from 'react/jsx-runtime';
import type { FirmwareCatalog, FirmwareEntry } from '../core/firmware';

// The runtime SDK the Console publishes on `window.__OPENBRICX__` for dynamically
// loaded plugins. Its whole job is to hand a plugin the Console's *single* React
// instance (two Reacts in one page breaks hooks) plus a curated surface — never raw
// Tauri IPC. The plugin-side contract lives in `plugin-sdk/host.ts`; this is the
// host-side shape that fills it.
//
// Growing this surface is a compatibility promise: only ever add, never change or
// remove, and bump HOST_SDK_VERSION (install.ts) so plugins can feature-detect.

export interface HostFileFilter {
  name: string;
  extensions: string[];
}

export interface HostFileDialogOptions {
  title?: string;
  filters?: HostFileFilter[];
  defaultPath?: string;
}

/** Native file pickers (single-file). Resolve to a path, or null on cancel. */
export interface HostDialog {
  open(opts?: HostFileDialogOptions): Promise<string | null>;
  save(opts?: HostFileDialogOptions): Promise<string | null>;
}

/** Text-file I/O for paths obtained from the dialog (import/export flows). */
export interface HostFiles {
  readText(path: string): Promise<string>;
  writeText(path: string, contents: string): Promise<void>;
}

/** Push firmware to a device (`/obx/ota`) with upload progress. */
export interface HostOta {
  updateFirmwareWifi(ip: string, path: string): Promise<void>;
  onProgress(cb: (percent: number) => void): Promise<() => void>;
}

/** Native actions/telemetry the host PC performs on a device's behalf. */
export interface HostPc {
  launchApp(path: string): Promise<void>;
  openLink(url: string, browser?: string): Promise<void>;
  getVolume(): Promise<number>;
  getSystemInfo<T>(): Promise<T>;
  getNowPlaying<T>(): Promise<T | null>;
}

/** The signed firmware catalog + verified downloads (GitHub distribution). */
export interface HostFirmware {
  /** The catalog URL baked into this Console build. */
  defaultCatalogUrl: string;
  /** Fetch + signature-verify a catalog (defaults to `defaultCatalogUrl`). */
  fetchCatalog(url?: string): Promise<FirmwareCatalog>;
  /** Download + hash-verify an image; resolves to a local path for `ota`. */
  download(entry: Pick<FirmwareEntry, 'url' | 'sha256'>): Promise<string>;
  onDownloadProgress(cb: (url: string, percent: number) => void): Promise<() => void>;
}

export interface OpenBricxHost {
  /** SDK version, so a plugin can feature-detect / refuse an older host. */
  version: string;
  react: typeof React;
  jsxRuntime: typeof JsxRuntime;
  dialog: HostDialog;
  files: HostFiles;
  ota: HostOta;
  pcHost: HostPc;
  firmware: HostFirmware;
}

declare global {
  interface Window {
    __OPENBRICX__?: OpenBricxHost;
  }
}
