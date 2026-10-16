# WORDS — security and privacy review checklist

Status at MVP. ✅ done and tested · ⚠️ partly done · ⬜ to do before the pilot.

## Points and money-like state

| | Control | Where |
|---|---|---|
| ✅ | Scores computed on the server from server-traced paths; clients can't submit scores | `words-api /game/word`, `game.complete_session` |
| ✅ | One daily session per player (unique constraint): no replay farming | `game.sessions` |
| ✅ | Points issued exactly once per award (idempotency keys, unique index) | `loyalty.post`, `game.complete_session` |
| ✅ | No negative available or held balance, checked under a per-player row lock | `loyalty.post` |
| ✅ | Ledger is append-only (trigger) and each row's effects must match its type (CHECK) | `loyalty.transactions` |
| ✅ | Reservations lock the offer row: no overbooking (tested with 8 parallel requests) | `svc_reserve` |
| ✅ | Validation is conditional on `status = 'reserved'` under a row lock: one redemption per code (tested in parallel) | `svc_validate` |
| ✅ | Redemption codes: 50 random bits, stored only as SHA-256, replaced on reissue, expire | `redemption.js`, `market.redemptions` |
| ✅ | A code presented at another venue looks unknown | `svc_validate` |
| ✅ | Venue staff can't create or adjust balances; only admins can, with a reason, idempotently, audited | `svc_admin_adjust` |
| ✅ | Daily earning cap, monthly referral cap, referral only after the friend's first completed game, no self-referral | `game.complete_session`, `identity.players` CHECK |
| ✅ | Reversal procedures: release, mark redeemed, refund (each once) | `svc_admin_resolve` |
| ⚠️ | Bot detection: fast-play and implausible-coverage signals, rate-limit signals; review queue | `ops.fraud_signals`. Add CAPTCHA / device signals if abuse appears. |
| ⬜ | Reconciliation job alerting on the checks in `supabase/README.md` | |

## Access control

| | Control |
|---|---|
| ✅ | Only `public` exposed; all tables in private schemas with RLS on, no policies, no grants to `anon`/`authenticated` (tested) |
| ✅ | `svc_*` functions executable only by `service_role` (tested); `SECURITY DEFINER` with `search_path = ''` |
| ✅ | Every privileged function re-checks the role in SQL (admin, venue member, owner) even though the Edge Function also routes by role |
| ✅ | Suspended accounts can't play, reserve or use the wallet |
| ✅ | Rate limits per user per route group (fixed one-minute windows) |
| ✅ | CORS allow-list; request bodies ≤ 32 KB; strict input validation shared with tests (`core/validate.js`) |
| ⬜ | Supabase Auth: custom SMTP, sign-up abuse protection (CAPTCHA), session length policy |
| ⬜ | Admin accounts: require MFA in Supabase Auth |

## AI

| | Control |
|---|---|
| ✅ | Explanations accept dictionary words only, so the endpoint can't be used as a general prompt |
| ✅ | Theme input is passed as escaped data; output is filtered to dictionary words of 6–8 letters |
| ✅ | AI never decides scores, points, prices or inventory; responses cached to bound cost |
| ✅ | No personal data is sent to the AI provider |

## Privacy (UK GDPR)

| | Item |
|---|---|
| ✅ | Data minimisation: email, display name, gameplay, ledger, redemptions. No location tracking, no IP storage |
| ✅ | Venues see display name and reward, not email |
| ✅ | Programme terms version recorded at sign-up |
| ⚠️ | Draft privacy summary in the app; full privacy notice, lawful bases and retention periods need writing |
| ⬜ | Data-subject requests: deletion (`auth.users` delete cascades player data; ledger rows for redeemed rewards should be pseudonymised rather than deleted if needed for venue reconciliation: decide with legal) |
| ⬜ | DPA with Supabase and Anthropic; record of processing; sub-processor list in the notice |
| ⬜ | Cookie/analytics consent if PostHog is added |

## Frontend

| | Item |
|---|---|
| ✅ | All dynamic text escaped by the `html` template helper; no `innerHTML` with unescaped data |
| ✅ | Preview mode is clearly labelled and can't talk to a backend |
| ⬜ | Content-Security-Policy (GitHub Pages can't set headers: use a `<meta http-equiv>` CSP or move hosting) |
| ⬜ | Sentry error monitoring |
