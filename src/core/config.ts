// Launch configuration — the default distribution endpoints baked into the app.
//
// ⚠️ TODO(launch): the GitHub org `OpenBricx` must exist and own both repos
// below before cutting the first release. Both catalogs are Ed25519-signed and
// verified in the Rust host, so a wrong URL fails safe (fetch error), never
// unsafe.

/// Running Console version, injected from package.json by vite.config.ts so the
/// About page and the plugin `minAppVersion` gate share one source of truth.
declare const __APP_VERSION__: string;
export const APP_VERSION = __APP_VERSION__;

/// GitHub owner/org that publishes the Console + plugins + firmware.
export const GITHUB_OWNER = 'OpenBricx';

/// Repo holding the Console app + plugin releases.
export const CONSOLE_REPO = 'OpenBricx-Console';

/// Repo holding device firmware releases.
export const FIRMWARE_REPO = 'OpenBricx-Firmware';

/// Dev/test override: point a catalog at a local server without editing code —
/// run in the webview DevTools console, then reload:
///   localStorage.setItem('obx:plugin-catalog-url', 'http://localhost:8787/catalog.json')
///   localStorage.setItem('obx:firmware-catalog-url', 'http://localhost:8788/firmware.json')
///   localStorage.removeItem('obx:plugin-catalog-url')   // back to the default
/// Safe by design: whatever the URL, the payload must still pass the Ed25519
/// signature check in the Rust host, so this can't be used to sideload unsigned
/// content — it only changes where signed content is fetched from.
function withOverride(key: string, fallback: string): string {
  try {
    return globalThis.localStorage?.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/// Default plugin catalog — published by `.github/workflows/publish-plugins.yml`
/// to a rolling `plugins-latest` GitHub Release (assets are replaced in place, so
/// this URL stays stable across plugin releases).
export const DEFAULT_PLUGIN_CATALOG_URL = withOverride(
  'obx:plugin-catalog-url',
  `https://github.com/${GITHUB_OWNER}/${CONSOLE_REPO}/releases/download/plugins-latest/catalog.json`,
);

/// Default firmware catalog — published by the firmware repo's
/// `publish-firmware.yml` to a rolling `firmware-latest` GitHub Release.
export const DEFAULT_FIRMWARE_CATALOG_URL = withOverride(
  'obx:firmware-catalog-url',
  `https://github.com/${GITHUB_OWNER}/${FIRMWARE_REPO}/releases/download/firmware-latest/firmware.json`,
);
