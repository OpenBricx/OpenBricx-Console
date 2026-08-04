// Build + sign an external OpenBricx plugin.
//
//   npm run plugin:build <plugin-dir>
//
// <plugin-dir> must contain:
//   index.tsx       the plugin entry, exporting { manifest, Root, createDriver? }
//   manifest.json   product/name/icon/transports/version/minAppVersion/capabilities
//
// Produces <plugin-dir>/dist/ holding plugin.mjs + manifest.json + manifest.json.sig,
// ready to zip into an .obxplugin and publish. The dist dir is what the Console
// installs and the obxplugin:// handler serves.

import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from './lib/zip.mjs';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const dir = process.argv[2] && resolve(process.argv[2]);
if (!dir) {
  console.error('usage: npm run plugin:build <plugin-dir>');
  process.exit(1);
}

const entry = join(dir, 'index.tsx');
const manifestSrc = join(dir, 'manifest.json');
for (const [label, p] of [['entry', entry], ['manifest', manifestSrc]]) {
  if (!existsSync(p)) {
    console.error(`missing ${label}: ${p}`);
    process.exit(1);
  }
}

const out = join(dir, 'dist');
mkdirSync(out, { recursive: true });

console.log(`Building ${dir} -> ${out}/plugin.mjs`);
execSync('npx vite build --config vite.plugin.config.ts', {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, OBX_PLUGIN_ENTRY: entry, OBX_PLUGIN_OUT: out },
});

copyFileSync(manifestSrc, join(out, 'manifest.json'));

console.log('Signing bundle…');
execSync(`node scripts/sign-plugin.mjs "${out}"`, { cwd: repoRoot, stdio: 'inherit' });

// Pack the signed dist/ into a single `<product>-<version>.obxplugin` for upload.
const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
const files = readdirSync(out).map((name) => ({ name, data: readFileSync(join(out, name)) }));
const archiveName = `${manifest.product}-${manifest.version}.obxplugin`;
const archivePath = join(dir, archiveName);
writeFileSync(archivePath, createZip(files));

console.log(`\nDone.`);
console.log(`  bundle dir: ${out}`);
console.log(`  archive:    ${archivePath} (${files.length} files)`);
