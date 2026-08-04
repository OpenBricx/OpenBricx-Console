// Local plugin-catalog server — test the REAL signed distribution path with no
// GitHub: build → sign → serve, then install from the running Console.
//
//   npm run catalog:dev            build all plugins + catalog, serve on :8787
//   npm run catalog:dev -- --no-build   serve what's already staged
//
// Then in the Console's Plugins tab, paste:  http://localhost:8787/catalog.json
// (works in `npm run tauri dev` AND in a release build — the exact same
// fetch → Ed25519 verify → download → install → obxplugin:// load path as
// production, just pointed at this server instead of GitHub Releases.)
//
// Signing uses your local .plugin-keys/private.pem, which matches the public key
// embedded in the app — so verification is the real thing, not bypassed.

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const stage = join(repoRoot, '.dev-catalog');
const PORT = 8787;
const noBuild = process.argv.includes('--no-build');

// Same discovery rule as .github/workflows/publish-plugins.yml.
function pluginDirs() {
  const out = [];
  for (const parent of ['src/plugins', 'examples']) {
    const abs = join(repoRoot, parent);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      const dir = join(abs, name);
      if (existsSync(join(dir, 'manifest.json')) && existsSync(join(dir, 'index.tsx'))) {
        out.push(dir);
      }
    }
  }
  return out;
}

if (!noBuild) {
  const dirs = pluginDirs();
  if (dirs.length === 0) {
    console.error('No plugin dirs found (need manifest.json + index.tsx).');
    process.exit(1);
  }

  mkdirSync(stage, { recursive: true });

  for (const dir of dirs) {
    console.log(`\n── build ${dir}`);
    execSync(`node scripts/build-plugin.mjs "${dir}"`, { cwd: repoRoot, stdio: 'inherit' });
  }

  console.log('\n── catalog');
  const dirArgs = dirs.map((d) => `"${d}"`).join(' ');
  execSync(
    `node scripts/build-catalog.mjs --base-url http://localhost:${PORT} --out "${join(stage, 'catalog.json')}" ${dirArgs}`,
    { cwd: repoRoot, stdio: 'inherit' },
  );
  execSync(`node scripts/sign-file.mjs "${join(stage, 'catalog.json')}"`, {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  // Stage the archives next to the catalog (catalog URLs are <base>/<archive>).
  for (const dir of dirs) {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const archive = `${manifest.product}-${manifest.version}.obxplugin`;
    copyFileSync(join(dir, archive), join(stage, archive));
  }
}

if (!existsSync(join(stage, 'catalog.json'))) {
  console.error(`Nothing staged in ${stage} — run without --no-build first.`);
  process.exit(1);
}

const TYPES = { '.json': 'application/json', '.sig': 'application/octet-stream' };

createServer((req, res) => {
  const name = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
  // Flat directory — refuse anything that isn't a plain staged file name.
  const file = join(stage, name);
  if (!name || name.includes('/') || name.includes('..') || !existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  const ext = name.slice(name.lastIndexOf('.'));
  res.writeHead(200, { 'Content-Type': TYPES[ext] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
  console.log(`  GET /${name}`);
}).listen(PORT, () => {
  console.log(`\nServing ${readdirSync(stage).length} file(s) from ${stage}`);
  console.log(`\n  Catalog URL to paste into the Console's Plugins tab:`);
  console.log(`\n    http://localhost:${PORT}/catalog.json\n`);
  console.log('Ctrl+C to stop.');
});
