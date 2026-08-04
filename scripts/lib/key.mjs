// Shared private-key loader for the signing scripts. Resolution order:
//   1. an explicit path,
//   2. $OBX_PLUGIN_PRIVATE_KEY (base64 PKCS8 — for CI),
//   3. .plugin-keys/private.pem (local default, from `npm run plugin:keygen`).

import { createPrivateKey } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

export function loadPrivateKey(keyPath = null) {
  if (keyPath) return createPrivateKey(readFileSync(keyPath));
  if (process.env.OBX_PLUGIN_PRIVATE_KEY) {
    const der = Buffer.from(process.env.OBX_PLUGIN_PRIVATE_KEY.trim(), 'base64');
    return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  }
  const def = join(repoRoot, '.plugin-keys', 'private.pem');
  if (existsSync(def)) return createPrivateKey(readFileSync(def));
  throw new Error(
    'No private key. Run `npm run plugin:keygen`, pass --key <pem>, or set OBX_PLUGIN_PRIVATE_KEY.',
  );
}
