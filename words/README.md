# WORDS

**Play. Earn. Experience.** A five-minute daily word game whose players earn WORDS points and spend them
on food, drink, live music and theatre at nearby venues, which use it to fill spare capacity.

This folder is the MVP described in the development brief: a mobile-first PWA, a venue dashboard, an
admin dashboard and a Supabase backend. It is self-contained and independent of the Ordinals Collections
registry in the rest of this repository.

**Hosting:** the pages use absolute paths, so serve the repository (or just this folder) with `words/` at
the root of the site, e.g. `https://words.example.com/words/`. Any static host works (GitHub Pages,
Netlify, Vercel, S3); there is no build step.

| | |
|---|---|
| Player app | `/words/` |
| Venue dashboard | `/words/merchant/` |
| Admin dashboard | `/words/admin/` |
| Specification | [`docs/SPEC.md`](docs/SPEC.md) |
| API | [`docs/API.md`](docs/API.md) |
| Security and privacy checklist | [`docs/SECURITY.md`](docs/SECURITY.md) |
| Pilot operating instructions | [`docs/PILOT.md`](docs/PILOT.md) |
| Backend deployment | [`supabase/README.md`](supabase/README.md) |

## Try it

```bash
cd words
npm run serve          # http://localhost:8765/words/
```

With `supabaseUrl` empty in `js/config.js` the app runs in **preview mode**: the whole API runs in your
browser with six fictional demo venues around Elephant & Castle, and nothing is sent anywhere. Sign in
with any email, play, reserve a reward, then open `/words/merchant/` in another tab, pick the venue and
validate the code: the player tab turns to "Enjoy!". `/words/admin/` offers to make you an admin. Reset
from the player's **Me** tab.

## How it fits together

```
words/
├── index.html, merchant/, admin/   the three apps (static HTML + ES modules, no build)
├── css/words.css                   one stylesheet, light and dark
├── js/
│   ├── core/                       the rules: grid, solver, scoring, challenges, earning rules,
│   │                               ledger, redemption codes and windows, yield, validation
│   ├── server/local-server.js      preview backend (same API, in the browser)
│   ├── api.js                      client: preview or words-api
│   ├── app.js, game.js             player app
│   ├── merchant.js, admin.js       dashboards
├── data/dictionary.txt             ENABLE word list (public domain), filtered
├── supabase/                       migrations (schema + SQL API) and the words-api Edge Function
├── scripts/                        dictionary build, core sync, dev server
├── tests/                          Node tests, SQL tests, integration test
└── docs/
```

The same `js/core` modules run in the browser, in the Edge Function (copied by `npm run sync`) and in the
tests, so a word, a score or an availability rule can't mean different things in different places.
Points, inventory and redemption status only ever change inside SQL functions, in a transaction, under
row locks.

## Tests

```bash
npm test                  # unit tests and 12 end-to-end journeys (Node 20+)
npm run test:sql          # migrations + SQL tests + parallel race checks (PostgreSQL 15+ binaries)
npm run test:integration  # the Edge Function under Deno against that database
```

## Changing things

- **Rules** (points per action, caps, hold times, expiry): Admin → Rules. Defaults in `js/core/rules.js`.
- **Scoring or grid rules**: `js/core/scoring.js` / `challenge.js`; bump `RULES_VERSION`, then
  `npm run sync`.
- **Dictionary**: edit `data/blocklist.txt`, then `npm run dictionary -- path/to/enable1.txt` and `npm run sync`.
- **Backend URL**: `js/config.js`.
