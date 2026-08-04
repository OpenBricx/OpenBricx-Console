import { useCallback, useEffect, useState } from 'react';
import { registry as builtinRegistry } from '../../registry';
import {
  fetchCatalog,
  installPlugin,
  listInstalledPlugins,
  newerThan,
  requiresNewerApp,
} from './plugins';
import { APP_VERSION, DEFAULT_PLUGIN_CATALOG_URL } from './config';
import { loadInstalledPlugin } from '../host/loadPlugin';
import type { Plugin } from './types';

export interface PluginRegistry {
  /** Built-in plugins plus every installed plugin that loaded successfully. */
  plugins: Plugin[];
  loading: boolean;
  /** True while the startup catalog sync is downloading/installing. */
  syncing: boolean;
  /** Re-scan installed plugins (call after install/uninstall). */
  refresh: () => Promise<void>;
}

/**
 * Startup sync against the signed GitHub catalog: install anything missing and
 * upgrade anything outdated. Resolves true if the installed set changed.
 *
 * The app ships with an empty builtin registry, so without this a fresh install
 * would show no products until the user found the Plugins tab. Safety is not
 * weakened by doing it automatically — `fetch_catalog` verifies the catalog's
 * Ed25519 signature and `install_plugin` verifies each bundle against the key
 * embedded in the Rust host, exactly as the manual button does.
 */
async function syncFromCatalog(): Promise<boolean> {
  const catalog = await fetchCatalog(DEFAULT_PLUGIN_CATALOG_URL);
  const installed = await listInstalledPlugins();
  let changed = false;

  for (const entry of catalog.plugins) {
    // A builtin always wins, so installing over it would just be dead bytes.
    if (builtinRegistry.some((b) => b.manifest.product === entry.product)) continue;

    // Never auto-install a plugin this Console is too old for — it would install
    // cleanly and then fail at import. Leaves any working older copy in place.
    if (requiresNewerApp(entry)) {
      console.warn(
        `[plugins] skipping ${entry.product} ${entry.version}: needs Console ` +
          `>= ${entry.minAppVersion}, running ${APP_VERSION}`,
      );
      continue;
    }

    const have = installed.find((i) => i.manifest.product === entry.product);
    if (have && !newerThan(entry.version, have.manifest.version)) continue;

    try {
      await installPlugin(entry.url);
      changed = true;
    } catch (e) {
      // One bad entry must not stop the rest (or startup).
      console.error(`[plugins] auto-install ${entry.product} failed:`, e);
    }
  }
  return changed;
}

/** Compiled-in plugins: the (lean) release registry, plus — in dev builds only —
 *  every in-repo plugin from registry.dev.ts so `tauri dev` has them all with hot
 *  reload. The guard is statically false in production, so the dynamic import
 *  (and all plugin code behind it) is eliminated from release bundles. */
async function loadBuiltins(): Promise<Plugin[]> {
  let base = builtinRegistry;
  if (import.meta.env.DEV) {
    try {
      const { devRegistry } = await import('../../registry.dev');
      const extra = devRegistry.filter(
        (d) => !base.some((b) => b.manifest.product === d.manifest.product),
      );
      base = [...base, ...extra];
    } catch (e) {
      console.error('[plugins] dev registry failed to load:', e);
    }
  }
  return base;
}

// The app's live plugin set: the compiled-in builtins merged with verified,
// dynamically-loaded installed plugins. A built-in always wins over an installed
// plugin claiming the same product, so a downloaded bundle can never shadow one we
// ship. Failures to load are logged and skipped — they never take down the app.
export function usePlugins(): PluginRegistry {
  const [plugins, setPlugins] = useState<Plugin[]>(builtinRegistry);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const builtins = await loadBuiltins();
    try {
      const installed = await listInstalledPlugins();
      const loaded: Plugin[] = [];
      for (const info of installed) {
        if (builtins.some((b) => b.manifest.product === info.manifest.product)) continue;
        try {
          loaded.push(await loadInstalledPlugin(info));
        } catch (e) {
          console.error(`[plugins] failed to load ${info.manifest.product}:`, e);
        }
      }
      setPlugins([...builtins, ...loaded]);
    } catch (e) {
      // No host (e.g. plain browser dev) or the command failed — fall back to builtins.
      console.error('[plugins] could not list installed plugins:', e);
      setPlugins(builtins);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Fetch the GitHub catalog once on startup. Deliberately runs AFTER the local
  // load above rather than inside it: installed plugins must appear immediately
  // and work offline, so a slow or unreachable catalog can never delay or break
  // startup — a failure here just leaves the local set as-is.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setSyncing(true);
      try {
        const changed = await syncFromCatalog();
        if (changed && !cancelled) await refresh();
      } catch (e) {
        console.warn('[plugins] catalog sync skipped (offline?):', e);
      } finally {
        if (!cancelled) setSyncing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  return { plugins, loading, syncing, refresh };
}
