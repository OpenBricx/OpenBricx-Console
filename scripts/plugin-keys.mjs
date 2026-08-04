// Mint the OpenBricx plugin publisher keypair (Ed25519).
//
//   npm run plugin:keygen
//
// Writes the keypair to .plugin-keys/ (gitignored) and prints:
//   • the Rust literal to paste into TRUSTED_KEYS in src-tauri/src/plugins_host.rs
//   • the base64 public key for catalog.json
//   • the base64 PKCS8 private key to store as the OBX_PLUGIN_PRIVATE_KEY CI secret
//
// The PRIVATE key signs every plugin bundle you publish. Keep it out of git and off
// shared machines — anyone holding it can publish plugins your app will trust. The
// PUBLIC key is safe to embed and share; rotating means adding a new public key to
// TRUSTED_KEYS (keep the old one until all bundles are re-signed).

import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const keyDir = join(root, '.plugin-keys');
const privPath = join(keyDir, 'private.pem');
const pubPath = join(keyDir, 'public.b64');

if (existsSync(privPath) && !process.argv.includes('--force')) {
  console.error(`Refusing to overwrite ${privPath}\nPass --force if you really mean to mint a new key (invalidates every bundle signed with the old one).`);
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const privDerB64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');

// Raw 32-byte public key: the JWK `x` field is its base64url encoding.
const pubRaw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
const pubB64 = pubRaw.toString('base64');
const rustLiteral = '[' + [...pubRaw].map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ') + ']';

mkdirSync(keyDir, { recursive: true });
writeFileSync(privPath, privPem, { mode: 0o600 });
writeFileSync(pubPath, pubB64 + '\n');

console.log(`\nKeypair written to ${keyDir}/ (gitignored)\n`);
console.log('1. Paste this into TRUSTED_KEYS in src-tauri/src/plugins_host.rs:\n');
console.log(`    ${rustLiteral},\n`);
console.log('2. Public key (base64) for catalog.json "publicKey":\n');
console.log(`    ${pubB64}\n`);
console.log('3. CI secret OBX_PLUGIN_PRIVATE_KEY (base64 PKCS8 — for signing in GitHub Actions):\n');
console.log(`    ${privDerB64}\n`);
