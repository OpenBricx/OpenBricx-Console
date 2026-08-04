// Prove the React-singleton path without a GUI.
//
//   node scripts/verify-singleton.mjs <path-to-plugin.mjs>
//
// Stands up a fake host SDK (this script's own React) on globalThis, imports the
// built plugin, and server-renders its Root. The plugin's `import ... from 'react'`
// resolves — via the build-time shims — to *this* React. If the plugin had bundled
// its own React instead, calling a hook (useState) during render would throw
// "Invalid hook call". A clean render therefore proves the single-instance wiring.

import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const built = process.argv[2] && resolve(process.argv[2]);
if (!built) {
  console.error('usage: node scripts/verify-singleton.mjs <plugin.mjs>');
  process.exit(1);
}

// The SDK shape from src/host/install.ts. The shims read globalThis.__OPENBRICX__.
globalThis.__OPENBRICX__ = { version: 'test-harness', react: React, jsxRuntime };

const fakeConnection = {
  send: async () => {},
  onMessage: () => () => {},
  status: 'connected',
  onStatusChange: () => () => {},
  close: async () => {},
};

const mod = await import(pathToFileURL(built).href);
if (typeof mod.Root !== 'function') {
  console.error('plugin has no Root export');
  process.exit(1);
}

const html = renderToStaticMarkup(React.createElement(mod.Root, { connection: fakeConnection }));
console.log('Rendered HTML:\n' + html + '\n');

if (!html.includes('external, signed plugin')) {
  console.error('FAIL: unexpected render output');
  process.exit(1);
}
console.log('SINGLETON OK — plugin rendered using the host React instance (hooks resolved).');
