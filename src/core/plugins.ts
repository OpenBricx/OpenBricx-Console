import { invoke } from '@tauri-apps/api/core';
import { APP_VERSION } from './config';
import type { PluginManifest } from './types';

/** `a` is a strictly newer version than `b`. Numeric segment compare; tolerates a
 *  leading `v` and pre-release/build suffixes. */
export function newerThan(a: string, b: string): boolean {
  const pa = a.replace(/^v/i, '').split(/[.+-]/);
  const pb = b.replace(/^v/i, '').split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i] ?? '0');
    const nb = Number(pb[i] ?? '0');
    if (na !== nb) return na > nb;
  }
  return false;
}

/**
 * True when this Console is older than the plugin's declared `minAppVersion`.
 *
 * The Rust host parses `min_app_version` but does not enforce it — signature and
 * hash verification are its job, compatibility is ours. Without this check a
 * plugin built against a newer SDK installs happily and then fails at import
 * time with an opaque error.
 */
export function requiresNewerApp(entry: { minAppVersion?: string }): boolean {
  return !!entry.minAppVersion && newerThan(entry.minAppVersion, APP_VERSION);
}

// A plugin bundle's full, signed manifest as returned by the Rust host. Extends
// the routing-time `PluginManifest` with the fields the loader/installer care about.
export interface InstalledManifest extends PluginManifest {
  version: string;
  minAppVersion: string;
  capabilities: string[];
  /** Relative path -> sha256, as committed to by the signature. */
  files: Record<string, string>;
}

export interface InstalledPluginInfo {
  manifest: InstalledManifest;
  /** `obxplugin://<product>/plugin.mjs` — pass to `loadInstalledPlugin`. */
  entryUrl: string;
}

/// Installed plugins whose bundle currently verifies. The host silently drops any
/// directory that fails signature/hash checks, so everything here is safe to load.
export function listInstalledPlugins(): Promise<InstalledPluginInfo[]> {
  return invoke<InstalledPluginInfo[]>('list_installed_plugins');
}

export interface CatalogEntry {
  product: string;
  name: string;
  version: string;
  minAppVersion?: string;
  description?: string;
  url: string;
  sha256?: string;
}

export interface Catalog {
  schema: number;
  plugins: CatalogEntry[];
}

/// Fetch and signature-verify a plugin catalog (the host checks `<url>.sig`).
export function fetchCatalog(url: string): Promise<Catalog> {
  return invoke<Catalog>('fetch_catalog', { url });
}

/// Download, verify, and install a `.obxplugin`. Resolves with the verified
/// manifest; rejects if the signature/hash check fails.
export function installPlugin(url: string): Promise<InstalledManifest> {
  return invoke<InstalledManifest>('install_plugin', { url });
}

export function uninstallPlugin(product: string): Promise<void> {
  return invoke<void>('uninstall_plugin', { product });
}
