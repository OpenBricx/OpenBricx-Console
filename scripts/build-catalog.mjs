// Build a catalog.json from a set of built plugin directories.
//
//   node scripts/build-catalog.mjs --base-url <url> --out <catalog.json> <dir> [<dir> ...]
//
// Each <dir> must already have been built (`npm run plugin:build <dir>`), so it
// contains its source manifest.json and a <product>-<version>.obxplugin archive.
// The catalog entry's `url` is `<base-url>/<archive-name>` and `sha256` is the hash
// of that archive. Sign the result with `npm run plugin:sign-file <catalog.json>`.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}

const baseUrl = (flag('--base-url') || '').replace(/\/$/, '');
const out = flag('--out') || 'catalog.json';
const dirs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--base-url' && args[i - 1] !== '--out');

if (!baseUrl || dirs.length === 0) {
  console.error('usage: node scripts/build-catalog.mjs --base-url <url> --out <file> <dir>...');
  process.exit(1);
}

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

const plugins = dirs.map((d) => {
  const dir = resolve(d);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const archiveName = `${manifest.product}-${manifest.version}.obxplugin`;
  const archivePath = join(dir, archiveName);
  if (!existsSync(archivePath)) {
    throw new Error(`missing archive ${archivePath} — run \`npm run plugin:build ${d}\` first`);
  }
  return {
    product: manifest.product,
    name: manifest.name,
    version: manifest.version,
    minAppVersion: manifest.minAppVersion ?? '',
    description: manifest.description ?? '',
    url: `${baseUrl}/${archiveName}`,
    sha256: sha256Hex(readFileSync(archivePath)),
  };
});

writeFileSync(out, JSON.stringify({ schema: 1, plugins }, null, 2) + '\n');
console.log(`Wrote ${out} with ${plugins.length} plugin(s):`);
for (const p of plugins) console.log(`  ${p.product} v${p.version} -> ${p.url}`);
