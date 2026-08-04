// Sign a plugin bundle directory with the OpenBricx publisher key.
//
//   node scripts/sign-plugin.mjs <bundle-dir>
//
// The directory must already contain a manifest.json (product/name/icon/transports/
// version/minAppVersion/capabilities) and the built plugin.mjs (+ any assets/). This
// script:
//   1. hashes every file in the bundle except manifest.json and manifest.json.sig,
//   2. writes that path -> sha256 map into manifest.json as `files`,
//   3. signs the exact bytes of the rewritten manifest.json -> manifest.json.sig.
//
// The Rust host (src-tauri/src/plugins_host.rs) verifies the signature over those
// same bytes, then re-checks every file hash — so the single signature covers all
// of the plugin's code.
//
// The private key is read from, in order: --key <path>, $OBX_PLUGIN_PRIVATE_KEY
// (base64 PKCS8, for CI), or .plugin-keys/private.pem (local default).

import { sign, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { loadPrivateKey } from './lib/key.mjs';

const args = process.argv.slice(2);
const keyFlag = args.indexOf('--key');
const keyPath = keyFlag !== -1 ? args[keyFlag + 1] : null;
const bundleDir = args.find((a, i) => !a.startsWith('--') && (keyFlag === -1 || i !== keyFlag + 1));

if (!bundleDir) {
  console.error('usage: node scripts/sign-plugin.mjs <bundle-dir> [--key <private.pem>]');
  process.exit(1);
}

const EXCLUDED = new Set(['manifest.json', 'manifest.json.sig']);

// Recursively list bundle files as forward-slashed relative paths (stable across OS).
function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs));
    else out.push(abs);
  }
  return out;
}

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

const manifestPath = join(bundleDir, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`No manifest.json in ${bundleDir}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const files = {};
for (const abs of listFiles(bundleDir)) {
  const rel = relative(bundleDir, abs).split(sep).join('/');
  if (EXCLUDED.has(rel)) continue;
  files[rel] = sha256Hex(readFileSync(abs));
}
// Sort keys so the signed bytes are deterministic regardless of FS order.
manifest.files = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]]));

// Write the canonical manifest, then sign its exact on-disk bytes.
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
writeFileSync(manifestPath, manifestBytes);

const signature = sign(null, manifestBytes, loadPrivateKey(keyPath)); // 64-byte raw Ed25519
writeFileSync(join(bundleDir, 'manifest.json.sig'), signature);

console.log(`Signed ${manifest.product} v${manifest.version}`);
console.log(`  files hashed: ${Object.keys(manifest.files).length}`);
console.log(`  signature:    ${signature.length} bytes -> manifest.json.sig`);
