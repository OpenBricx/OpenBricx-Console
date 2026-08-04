import type { PluginManifest, TransportKind } from '../../core/types';
import manifestJson from './manifest.json';

// manifest.json is the single source of truth — it's what gets signed into the
// downloadable bundle (npm run plugin:build src/plugins/deck). This wrapper just
// retypes it for the builtin registry, so re-adding Deck as a compiled-in plugin
// stays a one-line registry change.
export const manifest: PluginManifest = {
  product: manifestJson.product,
  name: manifestJson.name,
  icon: manifestJson.icon,
  transports: manifestJson.transports as TransportKind[],
};
