// Sign a single file with the publisher key, writing a detached `<file>.sig`
// (raw 64-byte Ed25519). Used for catalog.json.
//
//   node scripts/sign-file.mjs <file> [--key <private.pem>]

import { sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadPrivateKey } from './lib/key.mjs';

const args = process.argv.slice(2);
const keyFlag = args.indexOf('--key');
const keyPath = keyFlag !== -1 ? args[keyFlag + 1] : null;
const file = args.find((a, i) => !a.startsWith('--') && (keyFlag === -1 || i !== keyFlag + 1));

if (!file) {
  console.error('usage: node scripts/sign-file.mjs <file> [--key <private.pem>]');
  process.exit(1);
}

const bytes = readFileSync(file);
const signature = sign(null, bytes, loadPrivateKey(keyPath));
writeFileSync(`${file}.sig`, signature);
console.log(`Signed ${file} -> ${file}.sig (${signature.length} bytes)`);
