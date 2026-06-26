// hono-preact 0.8.0 incorrectly imports `exec` from 'preact-iso' (main entry).
// exec has only ever been exported from 'preact-iso/router'. This patch fixes
// the import so the module loads correctly under Node.js ESM.
//
// preact-iso#v3 (2.11.1 from GitHub) ships src/router.js but omits it from
// the exports field, so the Cloudflare Vite plugin rejects it. We add it.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Patch 1: fix hono-preact's bad import
const honoFile = resolve(root, 'node_modules/hono-preact/dist/iso/route-active.js');
let src = readFileSync(honoFile, 'utf-8');
const bad = "import { useLocation, exec } from 'preact-iso';";
const good = "import { useLocation } from 'preact-iso';\nimport { exec } from 'preact-iso/router';";
if (src.includes(bad)) {
  writeFileSync(honoFile, src.replace(bad, good));
  console.log('patched hono-preact/dist/iso/route-active.js');
} else {
  console.log('hono-preact patch: already applied or not needed');
}

// Patch 2: add missing ./router export to preact-iso's package.json
const isoFile = resolve(root, 'node_modules/preact-iso/package.json');
const isoPkg = JSON.parse(readFileSync(isoFile, 'utf-8'));
if (!isoPkg.exports['./router']) {
  isoPkg.exports['./router'] = './src/router.js';
  writeFileSync(isoFile, JSON.stringify(isoPkg, null, '\t') + '\n');
  console.log('patched preact-iso/package.json: added ./router export');
} else {
  console.log('preact-iso patch: already applied or not needed');
}
