import type { Plugin } from './src/core/types';

// Built-in (compiled-in) plugins.
//
// Launch decision (2026-07): the app ships LEAN — no product plugins compiled in.
// Every product (Deck first) is distributed as a signed .obxplugin via the GitHub
// catalog (see src/core/config.ts) and loaded by usePlugins() at runtime.
//
// To compile a plugin back in (e.g. for local development without signing),
// import its manifest + Root and add it here — a builtin always wins over an
// installed bundle with the same product id (src/core/usePlugins.ts):
//
//   import { manifest as deckManifest } from './src/plugins/deck/manifest';
//   import DeckPlugin from './src/plugins/deck/index';
//   export const registry: Plugin[] = [{ manifest: deckManifest, Root: DeckPlugin }];
export const registry: Plugin[] = [];
