import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Build config for an *external* OpenBricx plugin: one entry -> a single
// `plugin.mjs` ESM bundle, with React, the JSX runtime, and `@openbricx/host`
// aliased to the runtime shims in plugin-sdk/. Those resolve to the Console's live
// SDK at load time, so a plugin never bundles its own React (which would break
// hooks) and never reaches raw Tauri IPC.
//
// Driven by scripts/build-plugin.mjs via env vars so it can build any plugin dir.

const root = fileURLToPath(new URL('.', import.meta.url));
const shim = (p: string) => resolve(root, p);

const entry = process.env.OBX_PLUGIN_ENTRY;
const outDir = process.env.OBX_PLUGIN_OUT;
if (!entry || !outDir) {
  throw new Error('set OBX_PLUGIN_ENTRY and OBX_PLUGIN_OUT (use: npm run plugin:build <dir>)');
}

export default defineConfig({
  plugins: [react()],
  // Don't copy the Console's public/ assets into every plugin bundle.
  publicDir: false,
  resolve: {
    alias: {
      'react/jsx-dev-runtime': shim('plugin-sdk/shims/react-jsx-runtime.ts'),
      'react/jsx-runtime': shim('plugin-sdk/shims/react-jsx-runtime.ts'),
      react: shim('plugin-sdk/shims/react.ts'),
      '@openbricx/host': shim('plugin-sdk/host.ts'),
    },
  },
  build: {
    outDir,
    emptyOutDir: false,
    minify: false, // keep output readable so the bundle is auditable
    // Inline EVERY imported asset (images…) as a base64 data URI instead of
    // emitting it into an assets/ subdirectory. Two reasons, both load-bearing:
    //   1. scripts/build-plugin.mjs packages the bundle with a NON-recursive
    //      readdirSync + readFileSync, so a subdirectory makes it throw EISDIR.
    //   2. a signed bundle stays self-contained — one plugin.mjs to verify and
    //      serve, with no extra files to resolve over obxplugin://.
    // Cost: a plugin's images land in plugin.mjs at ~4/3 their byte size, so keep
    // artwork reasonably sized (the Mods board renders are ~150 KB each).
    assetsInlineLimit: 8 * 1024 * 1024,
    lib: {
      entry,
      formats: ['es'],
      fileName: () => 'plugin.mjs',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        // A plugin's imported CSS is extracted (lib mode can't inject it), so pin
        // the asset name: the Console's loader looks for `plugin.css` in the
        // signed manifest and injects a <link> for it before importing the module.
        assetFileNames: (info) =>
          info.name?.endsWith('.css') ? 'plugin.css' : 'assets/[name][extname]',
      },
    },
  },
});
