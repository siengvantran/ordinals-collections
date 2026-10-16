# WORDS core

Pure, dependency-free ES modules shared by the browser (preview mode), the
`words-api` Edge Function (Deno) and the Node tests. Nothing here touches the
network, storage or the DOM, so the same rules run everywhere.

| Module | What it owns |
|---|---|
| `rng.js` | Seeded PRNG used for deterministic challenge generation |
| `scoring.js` | Letter values, length bonus, star tile, word scores |
| `grid.js` | The 4×4 WORDS GRID: adjacency and path validation |
| `solver.js` | Trie and solver that lists every valid word in a grid |
| `challenge.js` | Daily challenge generation and solvability checks |
| `rules.js` | Default earning rules, daily cap, game awards |
| `ledger.js` | Points ledger effects, balances and the in-memory ledger |
| `redemption.js` | Redemption codes, offer availability, London time windows |
| `yield.js` | Rules-based yield engine (Phase 1) |

The Edge Function gets a copy of this folder: run `npm run sync` after editing
(`npm test` fails if the copy is stale).
