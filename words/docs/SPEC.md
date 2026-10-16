# WORDS — technical specification (MVP)

Version 1.0 · 16 October 2026 · companion to the development brief.
This document describes what is built in `words/`, the decisions taken where the brief left a choice,
and what remains before the pilot.

## 1. Scope

The MVP proves one transaction end to end:

> A player completes a word game, earns 100 WORDS, discovers a reward, reserves it and redeems it at a
> participating venue using a QR code.

Everything in the brief's sections 3–11 is implemented at MVP depth, except the items in §10 below.

## 2. Decisions on the brief's open points

| Brief | Decision | Why |
|---|---|---|
| Next.js / React, Vercel | **Static ES modules, no build step**, served from any static host at `/words/`. Backend on **Supabase** as recommended. | Needs no build pipeline, deploys anywhere, and is a fully installable PWA. The UI is plain modules and could be moved to Next.js later without changing the API. |
| OpenAI API | **Claude (Anthropic API)** behind one function (`claudeJson`) | Claude Haiku keeps short, cached answers cheap. AI is isolated to two features, so swapping provider touches one function. |
| "Seven letters" and "WORDS GRID" | **4×4 WORDS GRID** with a hidden 6–8-letter **word of the day** (+15) and a **★ star tile** (doubles a word) | Keeps the seven-letter idea as the daily hidden word, and is an original mechanic rather than a Scrabble board. |
| Scoring | Own four-tier letter values (1/2/3/5) + length bonus (0,1,3,6,10,15,20,25 for 3–10 letters) | Deterministic and original; `js/core/scoring.js`. |
| Dictionary | **ENABLE** word list (public domain), 3–10 letters, with a blocklist of slurs and profanity | No licensing cost for the pilot. It contains American spellings and obscure words; see §10. |
| Welcome reward | **250 WORDS welcome bonus** + 100 for the first game = 350, and a 300-point welcome reward | Brief recommendation 1: the full earn-and-redeem journey on day one. |
| Point value | **No fixed cash value.** Each offer records its normal price and the venue's fulfilment cost | Brief recommendation 2. The admin overview prices the outstanding liability from the cost per point seen in actual redemptions. |
| Yield engine | **Separate schema (`yield`) and module (`js/core/yield.js`)**, own API routes | Brief recommendation 3. It only reads and writes offers through one function (`yield.apply`). |
| QR codes | **Random 50-bit one-time codes**, stored only as SHA-256 hashes | Stronger than a signed token (nothing to forge offline, nothing to leak from the database). The QR holds a URL that opens the venue's validation screen, so any phone camera works. |
| Points expiry | Balance expires after **12 months without activity** | Simple to explain; configurable. |

## 3. Architecture

```
Browser (PWA)                       Supabase project "words"
┌──────────────────────┐   HTTPS    ┌──────────────────────────────────────────────┐
│ /words/          app │──────────▶ │ Edge Function words-api (Deno)               │
│ /words/merchant/     │  Bearer    │  · authenticates (Supabase Auth)             │
│ /words/admin/        │  token     │  · validates input (core/validate.js)        │
│                      │            │  · traces + scores words (core/grid, scoring)│
│ js/core  ◀── same ──▶│            │  · generates challenges (core/challenge)     │
│ code as the server   │            │  · AI: explanations, theme suggestions       │
│                      │            │        │ service role, svc_* only            │
│ preview mode:        │            │        ▼                                     │
│ js/server/local-…    │            │ PostgreSQL                                   │
│ (same API, browser)  │            │  game · loyalty · market · yield · identity  │
└──────────────────────┘            │  · ops   (RLS on, no grants, svc_* API)      │
                                    │  pg_cron: expiry, auto-close, balance expiry │
                                    └──────────────────────────────────────────────┘
```

- **One rulebook, three runtimes.** `js/core` is pure ES modules used by the browser (preview), the Edge
  Function (synced copy, checked by `npm test`) and the tests.
- **Money-like state lives in SQL.** Every balance, inventory and status change happens inside one
  `svc_*` function call, in one transaction, with row locks. The Edge Function never computes a balance.
- **Preview mode** (`supabaseUrl` empty) runs the whole API in the browser for demos and design work.
  It is not a security boundary and is labelled on every screen.

### Modules (brief §19)

| Product | Schemas / code | Could run alone because… |
|---|---|---|
| Game Engine | `game.*`, `js/core/{grid,solver,scoring,challenge}.js` | It only calls `loyalty.post()` to issue points |
| Loyalty Engine | `loyalty.*`, `js/core/{ledger,rules}.js` | `loyalty.post()` is the single entry point; any game or partner can call it with its own reference type and funding source |
| Yield Marketplace | `market.*`, `yield.*`, `js/core/{redemption,yield}.js` | Offers and redemptions reference players and the ledger only through `loyalty.post()` |

## 4. Data model

See `supabase/migrations/20261016000000_words.sql` for exact definitions.

| Table | Key columns | Notes |
|---|---|---|
| `identity.players` | user_id, email, display_name (unique, case-insensitive), referral_code, referred_by, status, terms_version | One row per Supabase Auth user |
| `game.games` | id (date), rules_version, puzzle (jsonb), solutions (jsonb), sponsored_by, created_by | Solutions never leave the server |
| `game.sessions` | user_id, game_id, status, started_at, ends_at, score, awards | **unique (user_id, game_id)**: no replays |
| `game.submissions` | session_id, word, path, score | **unique (session_id, word)** |
| `game.word_explanations` | word, data | AI cache |
| `loyalty.transactions` | user_id, type, points, amount, held_delta, reference_type/id, funding_source, actor, **idempotency_key (unique)** | Append-only (trigger); CHECK ties amount/held_delta to type |
| `loyalty.wallets` | user_id | Row lock that serialises a player's ledger writes |
| `loyalty.rules` | rules (jsonb) | Admin-editable earning rules |
| `market.merchants` / `market.locations` / `market.members` | status pending/approved/suspended; owner/staff roles | Locations ready for multi-site and POS references |
| `market.offers` | points_price, standard_price_pence, fulfilment_cost_pence, quantity_total, max_per_customer, valid_from/until, days, window_start/end, hold_minutes, status, suspended, funding | |
| `market.redemptions` | user_id, offer_id, points, status, **code_hash (unique)**, client_key (unique per user), expires_at, validated_at/by, reported_spend_pence | |
| `yield.rules` / `yield.recommendations` | bands, capacity, target, max_units, auto_apply; recommendation history with applied flag | |
| `ops.admins`, `ops.audit_log`, `ops.fraud_signals`, `ops.rate_limits` | | |

### The ledger

Each transaction has two signed effects: `amount` on the available balance and `held_delta` on the held
balance (full table in `js/core/ledger.js`). Reserving moves points from available to held; validation
removes them from held for good; expiry or cancellation moves them back. Balances are always sums of the
ledger. Invariants enforced in `loyalty.post()` under the wallet lock: available ≥ 0, held ≥ 0, one row
per idempotency key.

## 5. User journeys

1. **First visit** → onboarding (3 steps) → email → display name (+ optional invite code) → **250 WORDS**.
2. **Play** → 5-minute timer from the server's clock → drag or tap tiles → each word checked by the server
   (offline words queue on the device and sync on reconnect, accepted up to 90 s after time-up) → finish →
   server score → awards (100 complete, +25 target, +25 personal best; daily cap 250) → results with the
   word of the day, best words, AI explanations and a share card.
3. **Redeem** → rewards list (category, area, "available now") → detail with conditions, times, stock,
   map link → reserve (points held) → QR + 10-character code with expiry countdown → venue scans → venue
   sees reward and player name, confirms → player's screen turns to "Enjoy!" within 3 s.
4. **Venue** → register → admin approves → create offers (price, cost, stock, per-player limit, dates,
   daily hours, days, hold time, terms) → validate codes (camera scan or typing) → record customer spend
   (optional) → performance split into verified / reported / estimated → yield rules.
5. **Admin** → overview (players, completion, liability, marketplace) → approve venues → investigate a
   player's ledger → adjust with reason → resolve failed redemptions (release, mark redeemed, refund) →
   suspend players/offers → edit earning rules → review fraud signals → prepare and publish challenges with
   AI-suggested themes → audit log.

## 6. Game engine

- **Generation** (`challenge.js`): seeded PRNG (`salt|date|theme|attempt`) → place the word of the day on a
  random self-avoiding path → fill other tiles by weighted letter frequency → choose a star tile → solve with
  the full dictionary → accept only if 4–7 vowels, 40–400 words, at least one 6+ letter word and the hidden
  word traceable. 365 consecutive days generate in tests; a grid takes ~2 ms.
- **Target score**: 7% of the maximum possible, in steps of 5, clamped to 40–150.
- **Validation**: the server traces the submitted path on the stored grid, so a client can't submit a word
  that isn't there; scores come from the server.
- **Fairness**: everyone gets the same grid; tie-break is earlier finish.

## 7. AI

| Feature | Where | Guardrails |
|---|---|---|
| Word explanations | `POST /game/explain` | Only dictionary words are accepted (not a free-text prompt); one model call per word ever (cached in `game.word_explanations`); never affects scores |
| Challenge themes | `POST /admin/challenges/suggest` | Admin-only; theme text passed as data; every suggestion must be a dictionary word of 6–8 letters without q; the grid itself is generated and checked deterministically; an admin publishes |
| Personalisation | — | Phase 2 (needs play history) |
| AI opponents, AI yield pricing | — | Phase 2. Recommendations will use the same `yield.recommendations` table and must be applied by the merchant |

## 8. Yield engine (Phase 1)

Per offer: price bands by utilisation (default <30% → 300, <50% → 500, <70% → 800, otherwise hold),
capacity, target utilisation and a cap on units. The venue reports how full it is; the engine recommends
`quantity = min(max_units, ⌊(target − utilisation) × capacity⌋)` at the band's price. Nothing changes
until the owner presses **Apply**, unless they switched on auto-apply for that rule beforehand (recorded
in the audit log). Every recommendation is stored, building the dataset Phase 2 needs.

## 9. Testing

| Suite | Command | Covers |
|---|---|---|
| Unit + journeys | `npm test` | Grid, solver, scoring, generation (a year of days), rules, ledger invariants, codes, London time windows (BST/GMT, overnight), yield; 12 journeys through the preview server: the critical journey, replay protection, server-side word checks, time limit + grace, daily cap, personal best, referral, reservation idempotency, stock, expiry, venue isolation, admin resolution, yield authorisation |
| SQL | `npm run test:sql` | Both migrations on PostgreSQL; ledger idempotency, append-only, CHECKs, game awards exactly once, auto-close, daily cap, offers, reservations, validation, expiry, refunds, yield, admin, grants; **8 parallel reserves on one balance → 1 succeeds; 8 parallel confirmations of one code → 1 redemption** |
| Integration | `npm run test:integration` | The real Edge Function under Deno against the real SQL, through HTTP |
| Browser | manual / Playwright | The three apps at 390 px and desktop widths |

## 10. Known gaps before pilot (prioritised backlog)

**Must do (pilot blockers)**
1. Legal review of programme terms, privacy notice and promotional rules (brief §15). Draft terms are in the app.
2. Custom SMTP for magic links; decide the production domain and host, then set `ALLOWED_ORIGINS` and the Auth URLs.
3. Dictionary review: ENABLE includes obscure and American-only words. Consider a licensed UK list
   (e.g. Collins) or an allow-list of common words for the hidden word and target scoring.
4. Onboard real venues: approve, create offers, train staff on validation (see `PILOT.md`).
5. Set `GAME_SALT`, first admin, `pg_cron`, Sentry and PostHog keys (not yet wired: add the two SDK
   snippets to the three HTML pages).
6. Accessibility pass (WCAG 2.2 AA): tiles are buttons with labels and keyboard play works, but a
   screen-reader-first way to play (type a word, server finds a path) should be added.

**Should do**
7. Merchant staff invitations from the dashboard (today: SQL).
8. Points-expiry reminder emails before `expire` runs.
9. Bot detection beyond the current signals (fast play, implausible coverage, rate limits, referral cap):
   device fingerprinting or a CAPTCHA on sign-up if abuse appears.
10. Sponsored challenges: UI for sponsors; the data model and award already exist (`sponsored_by`).
11. Push notifications for "your reward is about to expire" and "today's grid is live".

**Phase 2**
12. AI practice challenges and personalisation; AI opponents.
13. AI yield recommendations from history (time of day, day of week, conversion, margin), applied only with
    merchant authorisation.
14. POS and ticketing integrations (`market.locations.external_ref`, `market.offers.external_ref`).
15. Partner API for third-party games to issue points through `loyalty.post()`, with per-partner funding
    sources and keys.
