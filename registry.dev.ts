import type { Plugin } from './src/core/types';

import { manifest as deckManifest } from './src/plugins/deck/manifest';
import DeckPlugin from './src/plugins/deck/index';

// DEV-ONLY registry: every in-repo plugin, compiled in with hot reload — the
// day-to-day development loop (`npm run tauri dev`). Loaded via a dynamic
// import guarded by `import.meta.env.DEV` (src/core/usePlugins.ts), so release
// builds eliminate this module — and all plugin code — entirely; production
// ships the lean registry.ts and installs plugins from the signed catalog.
//
// The guarded *dynamic* import also matters for correctness: it defers module
// evaluation until after installHostSdk() has published window.__OPENBRICX__,
// which plugin sources (via @openbricx/host) read at import time.
export const devRegistry: Plugin[] = [
  { manifest: deckManifest, Root: DeckPlugin },
];
