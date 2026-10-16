# WORDS API

One HTTP API, implemented twice with the same contract:

- **Production:** the `words-api` Supabase Edge Function (`supabase/functions/words-api`), backed by the
  `public.svc_*` SQL functions (`supabase/migrations`).
- **Preview:** `js/server/local-server.js`, running in the browser when no backend is configured, and in
  the Node tests.

Base URL (production): `https://<project-ref>.supabase.co/functions/v1/words-api`

## Conventions

- **Auth:** `Authorization: Bearer <Supabase access token>` (players, venue staff and admins all sign in with
  Supabase Auth magic links). Routes marked *public* also work without a token.
- **Bodies:** JSON objects, at most 32 KB. Responses are JSON with `Cache-Control: no-store`.
- **Errors:** `{ "error": "<code>", "message": "<for people>", "details": … }` with a 4xx/5xx status.
  Codes are stable; see `js/core/errors.js`. Common ones:

  | Status | Codes |
  |---|---|
  | 400 | `invalid_request`, `invalid_path`, `too_short`, `not_a_word`, `invalid_code` |
  | 401 | `unauthorised` |
  | 403 | `forbidden`, `account_suspended`, `profile_required` |
  | 404 | `not_found`, `invalid_code` (a code for another venue looks unknown) |
  | 409 | `already_played`, `session_closed`, `duplicate_word`, `insufficient_points`, `sold_out`, `limit_reached`, `outside_window`, `offer_not_active`, `ended`, `not_started`, `merchant_unavailable`, `already_redeemed`, `expired`, `cancelled`, `inventory_below_claimed`, `merchant_not_approved`, `idempotency_conflict`, `name_taken` |
  | 429 | `rate_limited` |
  | 503 | `ai_unavailable` |

- **Idempotency:** every request that moves points carries a key. Reservations and admin adjustments take a
  client `idempotency_key` (8–64 characters, a UUID is ideal); game awards, welcome bonus, referrals,
  releases, redemptions and refunds use server keys (`game:<kind>:<user>:<date>`, `redeem:<redemption>`, …).
  Repeating a request never posts twice.
- **Rate limits (per user per minute):** game words 120, reservations and code reissues 10, validations 60,
  explanations 20, admin 120, everything else 300.
- **Time:** ISO-8601 UTC. Days, daily windows and "today" are London time (`Europe/London`).
- **Balances** are always `{available, held, total, earned, redeemed}`, computed from the ledger.

## Players

| Route | Body / query | Response |
|---|---|---|
| `GET /me` | | `{user_id, email, display_name, referral_code, status, created_at, balance, progress{xp, level, games_played, best_score, streak, words_found}, roles{admin, merchant}}` |
| `POST /profile` | `{display_name, referral_code?}` | as `/me`. The first save creates the referral code, links the referrer and pays the welcome bonus (once). |

## Game

| Route | Body / query | Response |
|---|---|---|
| `GET /game/today` *public* | | `{challenge, session \| null, reveal \| null, server_time}`. `challenge` = `{id, date, rules_version, size, tiles[16], star, theme_length, theme_hint, time_limit_s, word_count, max_score, target_score}` (never the solutions or the hidden word). `reveal` only after the player finished. |
| `POST /game/start` | | session view. Idempotent while active; `409 already_played` once completed. |
| `POST /game/word` | `{session_id, path: [tile indexes]}` | `{word, score, theme_word: bool, session}`. The server traces the path, checks the word against the stored challenge, scores it and records it. Accepted until `ends_at` + 90 s grace (for offline catch-up). |
| `POST /game/finish` | `{session_id}` | `{session, reveal, balance, rank{rank, of}}`. Computes the score on the server and issues points exactly once. Sessions left open are closed by a job after the grace period. |
| `GET /game/leaderboard` *public* | `?date=YYYY-MM-DD` | `{date, players, top[≤50]{rank, display_name, score, words, me}, me}` |
| `POST /game/explain` *public* | `{word}` | `{word, source, score, part_of_speech, definition, etymology, fun_fact}`. Dictionary words only; AI result cached forever per word. |

**Session view:** `{session_id, game_id, status, started_at, ends_at, finished_at, score, words[{word, score, path}], awards[{kind, points}], theme_found}`

## Wallet and rewards

| Route | Body / query | Response |
|---|---|---|
| `GET /wallet` | | `{balance, transactions[≤200]{id, type, points, amount, held_delta, note, reference_type, reference_id, created_at, status}}` |
| `GET /offers` *public* | `?category=&area=&available=now` | `{offers[], categories[], areas[], balance \| null}` |
| `GET /offers/:id` *public* | | `{offer, balance \| null}` |
| `POST /redemptions` | `{offer_id, idempotency_key}` | `201 {redemption, balance}` with `redemption.code` (`XXXXX-XXXXX`) and `qr_payload` (`WRD1-…`). Retrying with the same key returns the same reservation with a **new** code. |
| `GET /redemptions` | | `{redemptions[]}` (codes are not included: only hashes are stored) |
| `POST /redemptions/:id/code` | | `{redemption, balance}` with a fresh code. The previous code stops working. |
| `POST /redemptions/:id/cancel` | | `{redemption, balance}`; the points are released. |

**Offer:** `{id, title, description, category, image, points_price, quantity_total, remaining, max_per_customer, valid_from, valid_until, days[1–7], window_start, window_end, hold_minutes, terms, status, welcome, merchant{id, name, area, address, lat, lng}, available, unavailable_reason}`

**Redemption:** `{id, status: reserved|redeemed|expired|cancelled|refunded, points, reserved_at, expires_at, validated_at, offer{id, title, image, terms}, merchant{id, name, address}, code, qr_payload}`

## Venues

The caller must belong to a venue (`market.members`). Changing offers and yield rules needs the `owner` role.

| Route | Body / query | Response |
|---|---|---|
| `POST /merchant/register` | `{name, category, address, area?, description?, contact_email?}` | `201`, as `/merchant/me`. Status starts `pending`. |
| `GET /merchant/me` | | `{merchant, role, offers[] (with reserved, redeemed, standard_price_pence, fulfilment_cost_pence, suspended)}` or `{merchant: null}` |
| `POST /merchant/offers` | offer fields (+ `id` to update, `status: "active"` to publish on create) | `{offer}` (`201` on create). Quantity can't drop below reserved + redeemed. |
| `POST /merchant/offers/:id/status` | `{status: draft\|active\|paused\|ended}` | `{offer}`. Existing reservations stay valid. |
| `POST /merchant/validate` | `{code, confirm?: true}` | `{valid, redeemed?, redemption{…, player}}`. Without `confirm` it only checks. `code` may be the code, the QR payload or the validation URL. |
| `GET /merchant/redemptions` | `?status=` | `{redemptions[] (with player, reported_spend_pence)}` |
| `POST /merchant/redemptions/:id/spend` | `{spend_pence}` | `{ok}`; merchant-reported, shown separately from verified data |
| `GET /merchant/stats` | | `{verified{…}, reported{…}, estimated{…, basis}}` |
| `GET /merchant/yield` | | `{rules[] (with last_recommendation), default_bands}` |
| `POST /merchant/yield/rules` | `{offer_id, bands[{below, points}], capacity, target_utilisation, max_units, auto_apply}` | `{rule}` |
| `POST /merchant/yield/recommend` | `{rule_id, utilisation}` | `{recommendation{action, points_price, quantity, band, reason, applied}, offer}`. Applied straight away only if the owner switched on `auto_apply` beforehand. |
| `POST /merchant/yield/apply` | `{rule_id}` | applies the latest recommendation: sets the price and makes `quantity` more units available |

## Admin

The caller must be in `ops.admins`. Every change is written to the audit log; most take a `reason`.

| Route | Body / query |
|---|---|
| `GET /admin/overview` | players, games, points liability (issued, redeemed, outstanding, by funding source, estimated cost), redemptions, merchants, fraud |
| `GET /admin/merchants`, `POST /admin/merchants/:id/status` | `{status: approved\|suspended\|pending, reason}` |
| `GET /admin/users?q=`, `POST /admin/users/:id/status` | `{status: active\|suspended, reason}` |
| `GET /admin/users/:id/transactions` | full ledger for one player |
| `POST /admin/adjust` | `{user_id, points (±), reason, idempotency_key}` |
| `GET /admin/redemptions?status=`, `POST /admin/redemptions/:id/resolve` | `{action: release\|complete\|refund, reason}` |
| `GET /admin/offers`, `POST /admin/offers/:id/suspend` | `{suspended: bool, reason}` |
| `GET /admin/rules`, `POST /admin/rules` | `{rules: {key: whole number}}`; unknown keys and out-of-range values are refused |
| `GET /admin/fraud`, `POST /admin/fraud/:id/resolve` | `{status: dismissed\|confirmed}` |
| `GET /admin/challenges` | recent and upcoming challenges |
| `POST /admin/challenges/suggest` | `{theme?}` → AI-suggested words of the day (dictionary-checked), built-in list as fallback |
| `POST /admin/challenges/preview` | `{date, theme_word?, theme_hint?, attempt?}` → full challenge including solutions, for review |
| `POST /admin/challenges/publish` | same body; stores it. Refused once anyone has played that date. |
| `GET /admin/audit` | last 200 entries |

## Preview-only routes

`POST /auth/preview-sign-in {email}`, `POST /preview/become-admin`, `POST /preview/join-merchant {merchant_id}`,
`POST /preview/reset`. They exist only in `local-server.js`.
