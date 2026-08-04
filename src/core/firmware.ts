import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { DEFAULT_FIRMWARE_CATALOG_URL } from './config';
import type { DeviceHandshake } from './types';

// Core firmware-distribution client — the only gateway to the signed firmware
// catalog + verified downloads (ARCHITECTURE.md layering: plugins never invoke
// Rust commands directly).
//
// Trust model mirrors the plugin pipeline: `firmware.json` is Ed25519-signed
// (verified in Rust against the same publisher keys as plugin bundles), each
// entry carries a mandatory sha256, and `downloadFirmware` refuses bytes that
// don't match. What comes back is a *local path* that feeds the existing flasher
// / OTA commands unchanged.

/** `"flash"` = merged USB cold-flash image (0x0); `"ota"` = app image for /obx/ota. */
export type FirmwareKind = 'flash' | 'ota';

export interface FirmwareEntry {
  product: string;
  chip: string;
  hwRev: string;
  version: string;
  kind: FirmwareKind | string;
  url: string;
  sha256: string;
  size: number;
  notes: string;
}

export interface FirmwareCatalog {
  schema: number;
  firmware: FirmwareEntry[];
}

/// Fetch and signature-verify a firmware catalog (the host checks `<url>.sig`).
export function fetchFirmwareCatalog(url: string = DEFAULT_FIRMWARE_CATALOG_URL): Promise<FirmwareCatalog> {
  return invoke<FirmwareCatalog>('fetch_firmware_catalog', { url });
}

/// Download an image, verify its sha256 against the signed catalog entry, and
/// return the local cached path (ready for the flasher / OTA pusher).
export function downloadFirmware(entry: Pick<FirmwareEntry, 'url' | 'sha256'>): Promise<string> {
  return invoke<string>('download_firmware', { url: entry.url, sha256: entry.sha256 });
}

/// Download progress (percent 0–100 per url). Resolves to an unlisten fn.
export function onFirmwareDownloadProgress(
  cb: (url: string, percent: number) => void,
): Promise<() => void> {
  return listen<{ url: string; percent: number }>('obx://fw-download-progress', (e) =>
    cb(e.payload.url, e.payload.percent),
  );
}

// ── Catalog matching helpers ──────────────────────────────────────────────────

/** Loose semver compare: positive when a > b. Non-numeric tags compare lexically. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split(/[.+-]/);
  const pb = b.replace(/^v/i, '').split(/[.+-]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const xa = pa[i] ?? '0';
    const xb = pb[i] ?? '0';
    const na = Number(xa);
    const nb = Number(xb);
    const cmp =
      Number.isFinite(na) && Number.isFinite(nb) ? na - nb : xa.localeCompare(xb);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

export interface FirmwareFilter {
  product: string;
  kind: FirmwareKind;
  chip?: string;
  hwRev?: string;
}

/** Entries matching a product/kind (and chip / hwRev when known), newest first.
 *  An entry with an empty hwRev accepts any hardware revision. */
export function matchFirmware(catalog: FirmwareCatalog, f: FirmwareFilter): FirmwareEntry[] {
  return catalog.firmware
    .filter(
      (e) =>
        e.product === f.product &&
        e.kind === f.kind &&
        (!f.chip || !e.chip || e.chip === f.chip) &&
        (!f.hwRev || !e.hwRev || e.hwRev === f.hwRev),
    )
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** Newest matching entry, or null. */
export function latestFirmware(catalog: FirmwareCatalog, f: FirmwareFilter): FirmwareEntry | null {
  return matchFirmware(catalog, f)[0] ?? null;
}

/** The OTA image a connected device should update to, or null when it's already
 *  current (or the catalog has nothing for it). Uses the handshake's
 *  product/chip/hwRev to select and its fwVersion to compare — lifecycle step 5. */
export function updateAvailable(
  catalog: FirmwareCatalog,
  handshake: Pick<DeviceHandshake, 'product' | 'chip' | 'hwRev' | 'fwVersion'>,
): FirmwareEntry | null {
  const latest = latestFirmware(catalog, {
    product: handshake.product,
    kind: 'ota',
    chip: handshake.chip,
    hwRev: handshake.hwRev,
  });
  if (!latest) return null;
  return compareVersions(latest.version, handshake.fwVersion) > 0 ? latest : null;
}
