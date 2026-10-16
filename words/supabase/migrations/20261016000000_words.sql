-- WORDS: schema, security and server-side rules.
--
-- Three products, each in its own schemas so they can be split later:
--   game          the word game (challenges, sessions, submissions)
--   loyalty       the points ledger and earning rules
--   market, yield the rewards marketplace and the yield engine
-- plus identity (players) and ops (admins, audit log, fraud signals, rate limits).
--
-- Security model:
--   * Only `public` is exposed through the API. Every table is in a private
--     schema with RLS on and no policies, and no grants to anon/authenticated.
--   * public.svc_* functions are SECURITY DEFINER and executable only by
--     service_role, i.e. only by the words-api Edge Function, which
--     authenticates the user and passes their id.
--   * Errors: RAISE with MESSAGE = a stable error code (see js/core/errors.js),
--     HINT = the HTTP status, DETAIL = optional details.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists identity;
create schema if not exists game;
create schema if not exists loyalty;
create schema if not exists market;
create schema if not exists yield;
create schema if not exists ops;

revoke all on schema identity, game, loyalty, market, yield, ops from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function ops.fail(p_code text, p_status int default 400, p_detail text default null)
returns void language plpgsql as $$
begin
  raise exception using message = p_code, hint = p_status::text, detail = coalesce(p_detail, '');
end $$;

create or replace function ops.london_now() returns timestamp language sql stable as $$
  select (now() at time zone 'Europe/London')
$$;

create or replace function ops.london_date(p_at timestamptz default now()) returns date language sql stable as $$
  select (p_at at time zone 'Europe/London')::date
$$;

-- ---------------------------------------------------------------------------
-- Identity and operations
-- ---------------------------------------------------------------------------

create table identity.players (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  email          text not null,
  display_name   text,
  referral_code  text unique,
  referred_by    uuid references identity.players (user_id) on delete set null,
  status         text not null default 'active' check (status in ('active', 'suspended')),
  terms_version  text,
  created_at     timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  check (display_name is null or char_length(display_name) between 2 and 24),
  check (referred_by is distinct from user_id)
);
create unique index players_display_name_ci on identity.players (lower(display_name));

create table ops.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table ops.audit_log (
  id      bigserial primary key,
  actor   text not null,
  action  text not null,
  target  text,
  details jsonb not null default '{}'::jsonb,
  at      timestamptz not null default now()
);
create index audit_log_at on ops.audit_log (at desc);

create table ops.fraud_signals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references identity.players (user_id) on delete cascade,
  kind        text not null,
  details     jsonb not null default '{}'::jsonb,
  status      text not null default 'open' check (status in ('open', 'dismissed', 'confirmed')),
  created_at  timestamptz not null default now(),
  resolved_by uuid,
  resolved_at timestamptz
);
create index fraud_open on ops.fraud_signals (status, created_at desc);

create table ops.rate_limits (
  user_id      uuid not null,
  bucket       text not null,
  window_start timestamptz not null,
  count        int not null default 0,
  primary key (user_id, bucket, window_start)
);

create or replace function ops.audit(p_actor text, p_action text, p_target text, p_details jsonb default '{}'::jsonb)
returns void language sql as $$
  insert into ops.audit_log (actor, action, target, details) values (p_actor, p_action, p_target, coalesce(p_details, '{}'::jsonb));
$$;

create or replace function ops.is_admin(p_user uuid) returns boolean language sql stable as $$
  select exists (select 1 from ops.admins where user_id = p_user)
$$;

create or replace function ops.flag(p_user uuid, p_kind text, p_details jsonb) returns void language sql as $$
  insert into ops.fraud_signals (user_id, kind, details) values (p_user, p_kind, p_details);
$$;

-- ---------------------------------------------------------------------------
-- Loyalty: rules and the ledger
-- ---------------------------------------------------------------------------

create table loyalty.rules (
  id         boolean primary key default true check (id),
  rules      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into loyalty.rules (rules) values ('{
  "welcome_bonus": 250, "complete_daily": 100, "target_score": 25, "personal_best": 25,
  "sponsored_challenge": 50, "referral": 100, "daily_game_cap": 250, "referral_monthly_cap": 10,
  "reservation_minutes": 30, "expiry_inactive_days": 365
}'::jsonb);

create or replace function loyalty.rule(p_key text) returns int language sql stable as $$
  select (rules ->> p_key)::int from loyalty.rules
$$;

-- One row per player: the lock that serialises their ledger writes.
create table loyalty.wallets (
  user_id    uuid primary key references identity.players (user_id) on delete cascade,
  created_at timestamptz not null default now()
);

-- See js/core/ledger.js for the meaning of amount / held_delta.
create table loyalty.transactions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references identity.players (user_id) on delete cascade,
  type            text not null check (type in ('earn', 'reserve', 'release', 'redeem', 'refund', 'expire', 'adjust')),
  points          int not null,
  amount          int not null,
  held_delta      int not null,
  status          text not null default 'posted' check (status = 'posted'),
  reference_type  text,
  reference_id    text,
  funding_source  text,
  note            text,
  actor           text not null default 'system',
  idempotency_key text not null unique,
  created_at      timestamptz not null default now(),
  check (case type
    when 'earn'    then points > 0 and amount = points  and held_delta = 0
    when 'refund'  then points > 0 and amount = points  and held_delta = 0
    when 'reserve' then points > 0 and amount = -points and held_delta = points
    when 'release' then points > 0 and amount = points  and held_delta = -points
    when 'redeem'  then points > 0 and amount = 0       and held_delta = -points
    when 'expire'  then points > 0 and amount = -points and held_delta = 0
    when 'adjust'  then points <> 0 and amount = points and held_delta = 0
  end)
);
create index transactions_user on loyalty.transactions (user_id, created_at);
create index transactions_ref on loyalty.transactions (reference_type, reference_id);

-- The ledger is append-only.
create or replace function loyalty.no_change() returns trigger language plpgsql as $$
begin
  raise exception 'loyalty.transactions is append-only';
end $$;
create trigger transactions_append_only before update or delete on loyalty.transactions
  for each row execute function loyalty.no_change();

create or replace function loyalty.balance(p_user uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'available', coalesce(sum(amount), 0),
    'held', coalesce(sum(held_delta), 0),
    'total', coalesce(sum(amount + held_delta), 0),
    'earned', coalesce(sum(amount) filter (where type = 'earn' or (type = 'adjust' and amount > 0)), 0),
    'redeemed', coalesce(-sum(held_delta) filter (where type = 'redeem'), 0))
  from loyalty.transactions where user_id = p_user
$$;

/**
 * Post a transaction. Locks the player's wallet, so concurrent posts for one
 * player run one at a time. Idempotent: the same key with the same user, type
 * and points returns the original row; with different values it fails.
 * Fails with insufficient_points / insufficient_held rather than letting a
 * balance go negative.
 */
create or replace function loyalty.post(
  p_user uuid, p_type text, p_points int, p_key text,
  p_ref_type text default null, p_ref_id text default null, p_funding text default null,
  p_note text default null, p_actor text default 'system'
) returns loyalty.transactions language plpgsql as $$
declare
  v_existing loyalty.transactions;
  v_amount int;
  v_held int;
  v_avail int;
  v_held_now int;
  v_row loyalty.transactions;
begin
  if p_key is null or p_key = '' then perform ops.fail('idempotency_key_required'); end if;
  insert into loyalty.wallets (user_id) values (p_user) on conflict do nothing;
  perform 1 from loyalty.wallets where user_id = p_user for update;

  select * into v_existing from loyalty.transactions where idempotency_key = p_key;
  if found then
    if v_existing.user_id <> p_user or v_existing.type <> p_type or v_existing.points <> p_points then
      perform ops.fail('idempotency_conflict', 409);
    end if;
    return v_existing;
  end if;

  v_amount := case p_type when 'earn' then p_points when 'refund' then p_points when 'reserve' then -p_points
    when 'release' then p_points when 'redeem' then 0 when 'expire' then -p_points when 'adjust' then p_points end;
  v_held := case p_type when 'reserve' then p_points when 'release' then -p_points when 'redeem' then -p_points else 0 end;
  if v_amount is null or (p_type <> 'adjust' and p_points <= 0) or p_points = 0 then perform ops.fail('invalid_points'); end if;

  select coalesce(sum(amount), 0), coalesce(sum(held_delta), 0) into v_avail, v_held_now
  from loyalty.transactions where user_id = p_user;
  if v_avail + v_amount < 0 then perform ops.fail('insufficient_points', 409); end if;
  if v_held_now + v_held < 0 then perform ops.fail('insufficient_held', 409); end if;

  insert into loyalty.transactions (user_id, type, points, amount, held_delta, reference_type, reference_id, funding_source, note, actor, idempotency_key)
  values (p_user, p_type, p_points, v_amount, v_held, p_ref_type, p_ref_id, p_funding, p_note, coalesce(p_actor, 'system'), p_key)
  returning * into v_row;
  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- Game
-- ---------------------------------------------------------------------------

create table game.games (
  id            date primary key,
  rules_version int not null,
  puzzle        jsonb not null,   -- tiles, star, time_limit_s, word_count, max_score, target_score, theme_word, theme_hint, theme_bonus
  solutions     jsonb not null,   -- {"word": best score, …}
  status        text not null default 'published' check (status in ('draft', 'published')),
  sponsored_by  uuid,
  created_by    text not null default 'auto',
  created_at    timestamptz not null default now()
);

create table game.sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references identity.players (user_id) on delete cascade,
  game_id     date not null references game.games (id),
  mode        text not null default 'daily' check (mode in ('daily')),
  status      text not null default 'active' check (status in ('active', 'completed')),
  started_at  timestamptz not null default now(),
  ends_at     timestamptz not null,
  finished_at timestamptz,
  score       int not null default 0,
  word_count  int not null default 0,
  awards      jsonb not null default '[]'::jsonb,
  unique (user_id, game_id)          -- one daily session per player: no replays
);
create index sessions_board on game.sessions (game_id, status, score desc, finished_at);
create index sessions_open on game.sessions (status, ends_at) where status = 'active';

create table game.submissions (
  id         bigserial primary key,
  session_id uuid not null references game.sessions (id) on delete cascade,
  user_id    uuid not null,
  word       text not null,
  path       int[] not null,
  score      int not null check (score > 0),
  created_at timestamptz not null default now(),
  unique (session_id, word)
);

create table game.word_explanations (
  word       text primary key,
  data       jsonb not null,
  model      text,
  created_at timestamptz not null default now()
);

create or replace function game.session_view(p_session uuid) returns jsonb language sql stable as $$
  with s as (select * from game.sessions where id = p_session),
       g as (select g.* from game.games g join s on s.game_id = g.id),
       w as (select word, score, path, created_at from game.submissions where session_id = p_session)
  select jsonb_build_object(
    'session_id', s.id, 'game_id', s.game_id, 'status', s.status, 'started_at', s.started_at, 'ends_at', s.ends_at,
    'finished_at', s.finished_at,
    'score', case when s.status = 'completed' then s.score
                  else coalesce((select sum(score) from w), 0)
                       + case when exists (select 1 from w where word = (select puzzle ->> 'theme_word' from g)) then (select (puzzle ->> 'theme_bonus')::int from g) else 0 end end,
    'words', coalesce((select jsonb_agg(jsonb_build_object('word', word, 'score', score, 'path', to_jsonb(path)) order by created_at) from w), '[]'::jsonb),
    'awards', s.awards,
    'theme_found', exists (select 1 from w where word = (select puzzle ->> 'theme_word' from g)))
  from s
$$;

create or replace function game.reveal(p_game date) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'theme_word', g.puzzle ->> 'theme_word',
    'top_words', (select jsonb_agg(jsonb_build_object('word', key, 'score', value::int) order by value::int desc, key)
                  from (select key, value from jsonb_each_text(g.solutions) order by value::int desc, key limit 12) t))
  from game.games g where g.id = p_game
$$;

/** Close a session: server-side score, points issued exactly once, referral, bot signals. */
create or replace function game.complete_session(p_session uuid) returns void language plpgsql as $$
declare
  s game.sessions;
  g game.games;
  v_score int;
  v_words int;
  v_prev_best int;
  v_prev_count int;
  v_earned_today int;
  v_room int;
  v_pts int;
  v_awards jsonb := '[]'::jsonb;
  v_kind text;
  v_want int;
  v_player identity.players;
  v_referrer identity.players;
  v_ref_count int;
  v_span numeric;
begin
  select * into s from game.sessions where id = p_session for update;
  if not found or s.status = 'completed' then return; end if;
  select * into g from game.games where id = s.game_id;
  select coalesce(sum(score), 0), count(*) into v_score, v_words from game.submissions where session_id = s.id;
  if exists (select 1 from game.submissions where session_id = s.id and word = g.puzzle ->> 'theme_word') then
    v_score := v_score + (g.puzzle ->> 'theme_bonus')::int;
  end if;
  select max(score), count(*) into v_prev_best, v_prev_count from game.sessions
   where user_id = s.user_id and status = 'completed' and id <> s.id;

  update game.sessions set status = 'completed', score = v_score, word_count = v_words,
         finished_at = least(now(), ends_at) where id = s.id;

  -- Bot signals: flag for review, never decide.
  if v_words > 0 then
    select extract(epoch from (max(created_at) - s.started_at)) into v_span from game.submissions where session_id = s.id;
    if v_words / greatest(v_span / 60.0, 0.5) > 30 then
      perform ops.flag(s.user_id, 'fast_play', jsonb_build_object('session_id', s.id, 'words_per_minute', round(v_words / greatest(v_span / 60.0, 0.5))));
    end if;
    if v_words >= 30 and v_words::numeric / (g.puzzle ->> 'word_count')::int > 0.6 then
      perform ops.flag(s.user_id, 'implausible_coverage', jsonb_build_object('session_id', s.id, 'share', round(100.0 * v_words / (g.puzzle ->> 'word_count')::int)));
    end if;
  end if;

  select * into v_player from identity.players where user_id = s.user_id;
  if v_player.status <> 'active' then return; end if;

  select coalesce(sum(points), 0) into v_earned_today from loyalty.transactions
   where user_id = s.user_id and type = 'earn' and reference_type = 'game' and ops.london_date(created_at) = ops.london_date();
  v_room := greatest(0, loyalty.rule('daily_game_cap') - v_earned_today);

  -- Same order and rules as gameAwards() in js/core/rules.js.
  foreach v_kind in array array['complete_daily', 'target_score', 'personal_best', 'sponsored_challenge'] loop
    v_want := case v_kind
      when 'complete_daily' then loyalty.rule('complete_daily')
      when 'target_score' then case when v_score >= (g.puzzle ->> 'target_score')::int then loyalty.rule('target_score') else 0 end
      when 'personal_best' then case when v_prev_count > 0 and v_score > v_prev_best then loyalty.rule('personal_best') else 0 end
      when 'sponsored_challenge' then case when g.sponsored_by is not null then loyalty.rule('sponsored_challenge') else 0 end
    end;
    v_pts := least(v_want, v_room);
    if v_pts > 0 then
      perform loyalty.post(s.user_id, 'earn', v_pts, format('game:%s:%s:%s', v_kind, s.user_id, s.game_id), 'game', s.game_id::text,
        case when v_kind = 'sponsored_challenge' then 'sponsor:' || g.sponsored_by else 'platform' end,
        case v_kind when 'complete_daily' then 'Daily challenge completed' when 'target_score' then 'Target score reached'
          when 'personal_best' then 'New personal best' else 'Sponsored challenge' end);
      v_awards := v_awards || jsonb_build_object('kind', v_kind, 'points', v_pts);
      v_room := v_room - v_pts;
    end if;
  end loop;
  update game.sessions set awards = v_awards where id = s.id;

  -- Referral: paid to the referrer when the friend completes their first daily challenge.
  if v_prev_count = 0 and v_player.referred_by is not null and loyalty.rule('referral') > 0 then
    select * into v_referrer from identity.players where user_id = v_player.referred_by;
    if found and v_referrer.status = 'active' then
      select count(*) into v_ref_count from loyalty.transactions
       where user_id = v_referrer.user_id and reference_type = 'referral'
         and date_trunc('month', created_at at time zone 'Europe/London') = date_trunc('month', ops.london_now());
      if v_ref_count >= loyalty.rule('referral_monthly_cap') then
        perform ops.flag(v_referrer.user_id, 'referral_cap', jsonb_build_object('referred', s.user_id));
      else
        perform loyalty.post(v_referrer.user_id, 'earn', loyalty.rule('referral'), 'referral:' || s.user_id, 'referral', s.user_id::text,
          'platform', 'Referral: ' || v_player.display_name);
      end if;
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Marketplace
-- ---------------------------------------------------------------------------

create table market.merchants (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(name) between 2 and 80),
  category      text not null default 'other',
  description   text not null default '',
  area          text not null,
  address       text not null,
  contact_email text not null,
  lat           double precision,
  lng           double precision,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'suspended')),
  created_at    timestamptz not null default now()
);

-- Further locations for multi-site merchants (offers may point at one).
create table market.locations (
  id          uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references market.merchants (id) on delete cascade,
  name        text not null,
  address     text not null,
  area        text,
  lat         double precision,
  lng         double precision,
  external_ref text,          -- future POS / ticketing integration id
  created_at  timestamptz not null default now()
);

create table market.members (
  user_id     uuid primary key references auth.users (id) on delete cascade,   -- one venue per account in the MVP
  merchant_id uuid not null references market.merchants (id) on delete cascade,
  role        text not null check (role in ('owner', 'staff')),
  created_at  timestamptz not null default now()
);

create table market.offers (
  id                    uuid primary key default gen_random_uuid(),
  merchant_id           uuid not null references market.merchants (id) on delete cascade,
  location_id           uuid references market.locations (id) on delete set null,
  title                 text not null,
  description           text not null default '',
  category              text not null default 'other',
  image                 text not null default '🎁',
  points_price          int not null check (points_price between 50 and 100000),
  standard_price_pence  int check (standard_price_pence >= 0),
  fulfilment_cost_pence int check (fulfilment_cost_pence >= 0),
  quantity_total        int not null check (quantity_total between 1 and 100000),
  max_per_customer      int check (max_per_customer between 1 and 100),
  valid_from            timestamptz,
  valid_until           timestamptz,
  days                  int[],
  window_start          time,
  window_end            time,
  hold_minutes          int check (hold_minutes between 5 and 1440),
  terms                 text not null default '',
  status                text not null default 'draft' check (status in ('draft', 'active', 'paused', 'ended')),
  suspended             boolean not null default false,
  welcome               boolean not null default false,
  funding               text not null default 'merchant' check (funding in ('merchant', 'sponsor', 'platform')),
  external_ref          text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check ((window_start is null) = (window_end is null)),
  check (valid_until is null or valid_from is null or valid_until > valid_from)
);
create index offers_live on market.offers (status, merchant_id);

create table market.redemptions (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references identity.players (user_id) on delete cascade,
  offer_id             uuid not null references market.offers (id),
  merchant_id          uuid not null references market.merchants (id),
  points               int not null check (points > 0),
  status               text not null check (status in ('reserved', 'redeemed', 'expired', 'cancelled', 'refunded')),
  code_hash            text not null unique,
  client_key           text not null,
  reserved_at          timestamptz not null default now(),
  expires_at           timestamptz not null,
  validated_at         timestamptz,
  validated_by         uuid,
  reported_spend_pence int check (reported_spend_pence >= 0),
  unique (user_id, client_key)
);
create index redemptions_offer on market.redemptions (offer_id, status);
create index redemptions_open on market.redemptions (expires_at) where status = 'reserved';
create index redemptions_merchant on market.redemptions (merchant_id, reserved_at desc);

/** Why a player can't reserve this offer now, or null if they can. Mirrors offerAvailability() in js/core/redemption.js. */
create or replace function market.unavailable_reason(o market.offers, p_user uuid default null) returns text language plpgsql stable as $$
declare
  v_local timestamp := ops.london_now();
  v_t time := v_local::time;
  v_dow int := extract(isodow from v_local);
  v_used int;
  m_status text;
begin
  select status into m_status from market.merchants where id = o.merchant_id;
  if m_status is distinct from 'approved' then return 'merchant_unavailable'; end if;
  if o.status <> 'active' or o.suspended then return 'offer_not_active'; end if;
  if o.valid_from is not null and now() < o.valid_from then return 'not_started'; end if;
  if o.valid_until is not null and now() >= o.valid_until then return 'ended'; end if;
  if o.days is not null and cardinality(o.days) > 0 and not (v_dow = any (o.days)) then return 'outside_window'; end if;
  if o.window_start is not null then
    if o.window_start <= o.window_end then
      if not (v_t >= o.window_start and v_t < o.window_end) then return 'outside_window'; end if;
    elsif not (v_t >= o.window_start or v_t < o.window_end) then return 'outside_window';
    end if;
  end if;
  if market.remaining(o) <= 0 then return 'sold_out'; end if;
  if p_user is not null and o.max_per_customer is not null then
    select count(*) into v_used from market.redemptions where offer_id = o.id and user_id = p_user and status in ('reserved', 'redeemed');
    if v_used >= o.max_per_customer then return 'limit_reached'; end if;
  end if;
  return null;
end $$;

create or replace function market.claimed(p_offer uuid) returns int language sql stable as $$
  select count(*)::int from market.redemptions where offer_id = p_offer and status in ('reserved', 'redeemed')
$$;

create or replace function market.remaining(o market.offers) returns int language sql stable as $$
  select greatest(0, o.quantity_total - market.claimed(o.id))
$$;

create or replace function market.offer_view(o market.offers, p_user uuid default null) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', o.id, 'title', o.title, 'description', o.description, 'category', o.category, 'image', o.image,
    'points_price', o.points_price, 'quantity_total', o.quantity_total, 'remaining', market.remaining(o),
    'max_per_customer', o.max_per_customer, 'valid_from', o.valid_from, 'valid_until', o.valid_until, 'days', to_jsonb(o.days),
    'window_start', to_char(o.window_start, 'HH24:MI'), 'window_end', to_char(o.window_end, 'HH24:MI'),
    'hold_minutes', coalesce(o.hold_minutes, loyalty.rule('reservation_minutes')), 'terms', o.terms, 'status', o.status,
    'welcome', o.welcome,
    'merchant', (select jsonb_build_object('id', m.id, 'name', m.name, 'area', m.area, 'address', m.address, 'lat', m.lat, 'lng', m.lng)
                 from market.merchants m where m.id = o.merchant_id),
    'available', market.unavailable_reason(o, p_user) is null,
    'unavailable_reason', market.unavailable_reason(o, p_user))
$$;

create or replace function market.redemption_view(r market.redemptions) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', r.id, 'status', r.status, 'points', r.points, 'reserved_at', r.reserved_at, 'expires_at', r.expires_at,
    'validated_at', r.validated_at,
    'offer', (select jsonb_build_object('id', o.id, 'title', o.title, 'image', o.image, 'terms', o.terms) from market.offers o where o.id = r.offer_id),
    'merchant', (select jsonb_build_object('id', m.id, 'name', m.name, 'address', m.address) from market.merchants m where m.id = r.merchant_id),
    'code', null, 'qr_payload', null)
$$;

/** Release a reservation's points (cancelled or expired). Caller holds the row lock. */
create or replace function market.release(r market.redemptions, p_status text, p_actor text) returns void language plpgsql as $$
begin
  perform loyalty.post(r.user_id, 'release', r.points, 'release:' || r.id, 'redemption', r.id::text, null,
    case when p_status = 'expired' then 'Reservation expired' else 'Reservation cancelled' end, p_actor);
  update market.redemptions set status = p_status where id = r.id;
end $$;

/** Expire every reservation past its time. Run by pg_cron each minute and before reads that depend on it. */
create or replace function market.expire_reservations() returns int language plpgsql as $$
declare
  r market.redemptions;
  n int := 0;
begin
  for r in select * from market.redemptions where status = 'reserved' and expires_at <= now() for update skip locked loop
    perform market.release(r, 'expired', 'system');
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function game.close_expired_sessions(p_grace_s int default 90) returns int language plpgsql as $$
declare
  v_id uuid;
  n int := 0;
begin
  for v_id in select id from game.sessions where status = 'active' and ends_at + make_interval(secs => p_grace_s) < now() loop
    perform game.complete_session(v_id);
    n := n + 1;
  end loop;
  return n;
end $$;

/** Expire balances after the configured period with no ledger or game activity. */
create or replace function loyalty.expire_inactive() returns int language plpgsql as $$
declare
  p record;
  v_avail int;
  n int := 0;
begin
  for p in select pl.user_id from identity.players pl
           where pl.last_active_at < now() - make_interval(days => loyalty.rule('expiry_inactive_days')) loop
    select coalesce(sum(amount), 0) into v_avail from loyalty.transactions where user_id = p.user_id;
    if v_avail > 0 then
      perform loyalty.post(p.user_id, 'expire', v_avail, format('expire:%s:%s', p.user_id, ops.london_date()), 'expiry', null, null, 'Balance expired after inactivity');
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Yield engine (Phase 1, rules-based). Recommendations are computed by
-- js/core/yield.js in the Edge Function and recorded and applied here.
-- ---------------------------------------------------------------------------

create table yield.rules (
  id                 uuid primary key default gen_random_uuid(),
  merchant_id        uuid not null references market.merchants (id) on delete cascade,
  offer_id           uuid not null unique references market.offers (id) on delete cascade,
  bands              jsonb not null,
  capacity           int not null check (capacity > 0),
  target_utilisation int not null check (target_utilisation between 1 and 100),
  max_units          int not null check (max_units > 0),
  auto_apply         boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table yield.recommendations (
  id           uuid primary key default gen_random_uuid(),
  rule_id      uuid not null references yield.rules (id) on delete cascade,
  offer_id     uuid not null,
  utilisation  numeric not null check (utilisation between 0 and 100),
  action       text not null check (action in ('release', 'hold')),
  points_price int,
  quantity     int not null default 0,
  band         jsonb,
  reason       text not null,
  applied      boolean not null default false,
  applied_at   timestamptz,
  applied_by   uuid,
  created_by   uuid,
  created_at   timestamptz not null default now()
);
create index recommendations_rule on yield.recommendations (rule_id, created_at desc);

create or replace function yield.rec_view(r yield.recommendations) returns jsonb language sql stable as $$
  select jsonb_build_object('id', r.id, 'rule_id', r.rule_id, 'offer_id', r.offer_id, 'utilisation', r.utilisation, 'action', r.action,
    'points_price', r.points_price, 'quantity', r.quantity, 'band', r.band, 'reason', r.reason, 'applied', r.applied,
    'applied_at', r.applied_at, 'created_at', r.created_at)
$$;

create or replace function yield.apply(p_rec uuid, p_actor uuid) returns void language plpgsql as $$
declare
  rec yield.recommendations;
  o market.offers;
begin
  select * into rec from yield.recommendations where id = p_rec for update;
  if rec.applied then return; end if;
  if rec.action <> 'release' then perform ops.fail('nothing_to_apply', 409); end if;
  select * into o from market.offers where id = rec.offer_id for update;
  if o.suspended or o.status = 'ended' then perform ops.fail('offer_not_active', 409); end if;
  update market.offers set points_price = rec.points_price, quantity_total = market.claimed(o.id) + rec.quantity,
         status = 'active', updated_at = now() where id = o.id;
  update yield.recommendations set applied = true, applied_at = now(), applied_by = p_actor where id = rec.id;
  perform ops.audit(p_actor::text, 'yield.apply', o.id::text, jsonb_build_object('points_price', rec.points_price, 'quantity', rec.quantity, 'utilisation', rec.utilisation));
end $$;

-- ---------------------------------------------------------------------------
-- RLS: on everywhere, no policies. Nothing is reachable except through svc_*.
-- ---------------------------------------------------------------------------

do $$
declare t record;
begin
  for t in select schemaname, tablename from pg_tables where schemaname in ('identity', 'game', 'loyalty', 'market', 'yield', 'ops') loop
    execute format('alter table %I.%I enable row level security', t.schemaname, t.tablename);
    execute format('revoke all on %I.%I from public, anon, authenticated', t.schemaname, t.tablename);
  end loop;
end $$;
