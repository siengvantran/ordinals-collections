// Builds data/dictionary.txt from the ENABLE word list (public domain).
//
//   node scripts/build-dictionary.mjs path/to/enable1.txt
//
// ENABLE: https://github.com/dolph/dictionary/blob/master/enable1.txt
// Keeps lower-case a–z words of 3–10 letters and drops everything matched by
// data/blocklist.txt (including simple inflections).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MIN_WORD, MAX_WORD } from '../js/core/scoring.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2];
if (!src) {
  console.error('usage: node scripts/build-dictionary.mjs path/to/enable1.txt');
  process.exit(1);
}

const blocked = new Set();
for (const line of readFileSync(join(root, 'data/blocklist.txt'), 'utf8').split('\n')) {
  const w = line.trim().toLowerCase();
  if (!w || w.startsWith('#')) continue;
  for (const suffix of ['', 's', 'es', 'ed', 'ing', 'er', 'ers', 'y']) blocked.add(w + suffix);
}

const words = readFileSync(src, 'utf8')
  .split(/\r?\n/)
  .map((w) => w.trim().toLowerCase())
  .filter((w) => w.length >= MIN_WORD && w.length <= MAX_WORD && /^[a-z]+$/.test(w) && !blocked.has(w));

const unique = [...new Set(words)].sort();
writeFileSync(join(root, 'data/dictionary.txt'), unique.join('\n') + '\n');
console.log(`data/dictionary.txt: ${unique.length} words (${blocked.size} blocked forms)`);
