import type { Plugin } from '../core/types';
import type { InstalledPluginInfo } from '../core/plugins';

// Dynamically load a verified, installed plugin into a runtime `Plugin`.
//
// Trust split: the *metadata* used for routing (product, name, transports) comes
// from `info.manifest`, which the Rust host already verified against the signature.
// Only the executable parts (`Root`, optional `createDriver`) are taken from the
// imported module — and that module is fetched over `obxplugin://`, which serves
// only from the verified directory. So the manifest a plugin's own JS might export
// is ignored; we never trust it for routing.

/** Inject a plugin's extracted stylesheets (any `.css` the signed manifest lists).
 *  Vite lib-mode builds can't inline CSS into plugin.mjs, so the bundle carries it
 *  as a sibling asset and the host links it in. Idempotent per href. */
function injectStylesheets(info: InstalledPluginInfo): void {
  const base = info.entryUrl.slice(0, info.entryUrl.lastIndexOf('/') + 1);
  for (const rel of Object.keys(info.manifest.files ?? {})) {
    if (!rel.endsWith('.css')) continue;
    const href = base + rel;
    if (document.querySelector(`link[data-obxplugin][href="${href}"]`)) continue;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-obxplugin', info.manifest.product);
    document.head.appendChild(link);
  }
}

export async function loadInstalledPlugin(info: InstalledPluginInfo): Promise<Plugin> {
  // Styles first, so the plugin doesn't flash unstyled on first paint.
  injectStylesheets(info);
  // `@vite-ignore` keeps Vite from trying to resolve/bundle this at build time —
  // it's an `obxplugin://` URL resolved by the webview at runtime.
  const mod = await import(/* @vite-ignore */ info.entryUrl);
  if (typeof mod.Root !== 'function') {
    throw new Error(`plugin "${info.manifest.product}" has no Root export`);
  }
  return { manifest: info.manifest, Root: mod.Root };
}
