// The WORDS GRID: 16 tiles in a 4×4 square. A word is a path through
// touching tiles (including diagonals) that uses each tile at most once.
// Tiles may be reused across different words. A "q" tile reads "qu".

export const SIZE = 4;
export const TILE_COUNT = SIZE * SIZE;

const NEIGHBOURS = Array.from({ length: TILE_COUNT }, (_, i) => {
  const r = Math.floor(i / SIZE), c = i % SIZE;
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE) out.push(rr * SIZE + cc);
    }
  }
  return out;
});

export function neighbours(i) {
  return NEIGHBOURS[i];
}

export function isAdjacent(a, b) {
  return NEIGHBOURS[a]?.includes(b) ?? false;
}

/** Letters a tile contributes to a word. */
export function tileText(tile) {
  return tile === 'q' ? 'qu' : tile;
}

/** A path is valid if it has integer tile indexes, no repeats and only adjacent steps. */
export function isValidPath(path) {
  if (!Array.isArray(path) || path.length === 0 || path.length > TILE_COUNT) return false;
  const seen = new Set();
  for (let k = 0; k < path.length; k++) {
    const i = path[k];
    if (!Number.isInteger(i) || i < 0 || i >= TILE_COUNT || seen.has(i)) return false;
    if (k > 0 && !isAdjacent(path[k - 1], i)) return false;
    seen.add(i);
  }
  return true;
}

export function wordFromPath(tiles, path) {
  return path.map((i) => tileText(tiles[i])).join('');
}

export function isValidTiles(tiles) {
  return Array.isArray(tiles) && tiles.length === TILE_COUNT && tiles.every((t) => /^[a-z]$/.test(t));
}
