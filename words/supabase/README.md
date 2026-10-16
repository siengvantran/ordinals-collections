# WORDS backend (Supabase)

Run every CLI command from the `words/` folder. `https://words.example.com` below stands for the domain the app is served from.

```
words/supabase/
├── config.toml
├── migrations/
│   ├── 20261016000000_words.sql       # schemas, tables, ledger, game, marketplace, yield, RLS
│   └── 20261016000100_words_api.sql   # public.svc_* API functions, grants, pg_cron jobs
└── functions/
    ├── _shared/http.ts                # CORS, JSON, svc_* calls with error mapping
    ├── _shared/core/                  # GENERATED copy of js/core + the dictionary (npm run sync)
    └── words-api/index.ts             # the HTTP API (docs/API.md)
```

## 1. Create and link the project

1. Create a project at <https://supabase.com/dashboard> in an EU region (London `eu-west-2`). Note the ref.
2. Database → Extensions: enable `pg_cron` (and `pgcrypto`, usually on already).
3. From `words/`:
   ```bash
   supabase login
   supabase link --project-ref <ref>
   supabase db push
   ```
   If `pg_cron` wasn't enabled before the push, enable it and re-run the last `do $$ … cron.schedule … $$`
   block of `20261016000100_words_api.sql` in the SQL editor.

## 2. Secrets and deploy

```bash
npm run sync      # copy js/core and the dictionary into functions/_shared/core
supabase secrets set \
  GAME_SALT="$(openssl rand -hex 32)" \
  ANTHROPIC_API_KEY=sk-ant-... \
  ALLOWED_ORIGINS="https://words.example.com"
supabase functions deploy words-api
```

| Secret | Required | Purpose |
|---|---|---|
| `GAME_SALT` | **yes** | Mixed into the daily grid seed so grids can't be computed before their day. Never change it mid-pilot (today's grid is already stored, but tomorrow's would differ from any preview). |
| `ANTHROPIC_API_KEY` | for AI features | Word explanations and theme-word suggestions. Without it explanations return `503 ai_unavailable` and theme suggestions fall back to the built-in list. Gameplay and scoring never depend on it. |
| `WORDS_AI_MODEL` | optional | Default `claude-haiku-5-5`: short, cached answers keep cost per word to one call ever. |
| `ALLOWED_ORIGINS` | **yes** | CORS allow-list: the site's origin. Without it only `http://localhost:8765` may call the API. |
| `TERMS_VERSION` | optional | Programme terms version recorded when a player creates their profile. |

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ANON_KEY` are provided automatically.

## 3. Auth

Dashboard → Authentication:
- Email provider on (magic links). Site URL `https://words.example.com/words/`.
- Redirect URLs: `https://words.example.com/words/`, `…/words/merchant/`, `…/words/admin/` and
  `http://localhost:8765/words/` for development.
- Set up a custom SMTP sender before the pilot (Supabase's default sender is rate-limited).

## 4. First admin

The person signs in once at `/words/admin/`, then in the SQL editor:

```sql
insert into ops.admins (user_id) select id from auth.users where email = 'you@example.com';
```

Venue owners register themselves at `/words/merchant/`; admins approve them. To add a member of staff
to a venue (they can validate codes but not change offers), after they have signed in once:

```sql
insert into market.members (user_id, merchant_id, role)
select u.id, m.id, 'staff' from auth.users u, market.merchants m
where u.email = 'barista@example.com' and m.name = 'Castle Bean Coffee';
```

## 5. Connect the frontend

Put the Project URL and the anon/publishable key in `words/js/config.js`. The anon key is safe to publish:
`anon` can't read any table or call any function.

## Scheduled jobs

| Job | Schedule | What it does |
|---|---|---|
| `words-expire-reservations` | every minute | Expires reservations past `expires_at` and releases their points (reads also do this on demand). |
| `words-close-sessions` | every minute | Closes games 90 s after time-up and issues their points. |
| `words-expire-balances` | daily 03:17 | Expires balances after `expiry_inactive_days` without activity (an `expire` ledger entry). |
| `words-purge-rate-limits` | hourly | Deletes rate-limit counters older than two hours. |

## Checks

```sql
-- Ledger consistency: no negative balances, no stuck holds
select user_id, sum(amount) available, sum(held_delta) held from loyalty.transactions group by 1 having sum(amount) < 0 or sum(held_delta) < 0;
select r.id from market.redemptions r where r.status = 'reserved' and r.expires_at < now() - interval '5 minutes';
-- Holds match open reservations
select (select coalesce(sum(held_delta), 0) from loyalty.transactions) = (select coalesce(sum(points), 0) from market.redemptions where status = 'reserved');
select jobname, schedule, active from cron.job;
```

## Tests

From `words/`: `npm test` (Node), `npm run test:sql` (migrations + SQL tests on a throwaway PostgreSQL,
including parallel reserve/redeem races) and `npm run test:integration` (the Edge Function under Deno
against that database). See `../README.md`.
