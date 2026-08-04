import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '../core/files';
import { onOtaProgress, updateFirmwareWifi } from '../core/ota';
import {
  getNowPlaying,
  getSystemInfo,
  getVolume,
  launchApp,
  openLink,
} from '../core/pcHost';
import {
  downloadFirmware,
  fetchFirmwareCatalog,
  onFirmwareDownloadProgress,
} from '../core/firmware';
import { DEFAULT_FIRMWARE_CATALOG_URL } from '../core/config';
import type { HostFileDialogOptions, OpenBricxHost } from './types';

// Bump when the plugin-facing SDK surface changes in a way plugins can observe.
// 0.2.0: added dialog / files / ota / pcHost / firmware namespaces (the surface
//        the Deck plugin needs to run as an external bundle).
const HOST_SDK_VERSION = '0.2.0';

// The dialog plugin can return string[] when `multiple` is set; the SDK contract
// is single-file, so normalize defensively.
function single(v: string | string[] | null): string | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/// Publish the host SDK on `window.__OPENBRICX__`. Must run before any plugin
/// module is imported, so call it once at startup (see main.tsx).
///
/// Everything here goes through the `src/core` clients — the same gateway the
/// built-in UI uses — so a plugin can never reach a Tauri command the core
/// doesn't deliberately expose.
export function installHostSdk(): void {
  const host: OpenBricxHost = {
    version: HOST_SDK_VERSION,
    react: React,
    jsxRuntime,
    dialog: {
      open: (opts?: HostFileDialogOptions) =>
        openDialog({ ...opts, multiple: false, directory: false }).then(single),
      save: (opts?: HostFileDialogOptions) => saveDialog({ ...opts }).then((v) => v ?? null),
    },
    files: {
      readText: readTextFile,
      writeText: writeTextFile,
    },
    ota: {
      updateFirmwareWifi,
      onProgress: onOtaProgress,
    },
    pcHost: {
      launchApp,
      openLink,
      getVolume,
      getSystemInfo,
      getNowPlaying,
    },
    firmware: {
      defaultCatalogUrl: DEFAULT_FIRMWARE_CATALOG_URL,
      fetchCatalog: fetchFirmwareCatalog,
      download: downloadFirmware,
      onDownloadProgress: onFirmwareDownloadProgress,
    },
  };
  window.__OPENBRICX__ = host;
}
