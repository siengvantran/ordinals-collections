-- WORDS API functions. One public.svc_* function per words-api route that
-- touches the database. Each takes the authenticated user id from the Edge
-- Function as p_user, and is executable only by service_role.
-- Response shapes match docs/API.md and js/server/local-server.js.

-- ---------------------------------------------------------------------------
-- Access checks
-- ---------------------------------------------------------------------------

create or replace function ops.require_player(p_user uuid, p_need_profile boolean default true) returns identity.players
language plpgsql as $$
declare p identity.players;
begin
  select * into p from identity.players where user_id = p_user;
  if not found then perform ops.fail('unauthorised', 401); end if;
  if p.status = 'suspended' then perform ops.fail('account_suspended', 403); end if;
  if p_need_profile and p.display_name is null then perform ops.fail('profile_required', 403); end if;
  update identity.players set last_active_at = now() where user_id = p_user and last_active_at < now() - interval '5 minutes';
  return p;
end $$;

create or replace function ops.require_admin(p_user uuid) returns void language plpgsql as $$
begin
  perform ops.require_player(p_user, false);
  if not ops.is_admin(p_user) then perform ops.fail('forbidden', 403); end if;
end $$;

create or replace function ops.require_member(p_user uuid, p_owner boolean default false) returns market.members
language plpgsql as $$
declare m market.members;
begin
  perform ops.require_player(p_user, false);
  select * into m from market.members where user_id = p_user;
  if not found then perform ops.fail('forbidden', 403); end if;
  if p_owner and m.role <> 'owner' then perform ops.fail('forbidden', 403, 'Only the venue owner can do this.'); end if;
  return m;
end $$;

/** Fixed-window rate limit. Returns false (and records a signal once per window) when over. */
create or replace function public.svc_rate_limit(p_user uuid, p_bucket text, p_limit int, p_window_s int)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_s) * p_window_s);
  v_count int;
begin
  insert into ops.rate_limits (user_id, bucket, window_start, count) values (p_user, p_bucket, v_start, 1)
  on conflict (user_id, bucket, window_start) do update set count = ops.rate_limits.count + 1
  returning count into v_count;
  if v_count = p_limit + 1 and exists (select 1 from identity.players where user_id = p_user) then
    perform ops.flag(p_user, 'rate_limited', jsonb_build_object('bucket', p_bucket, 'limit', p_limit, 'window_s', p_window_s));
  end if;
  return v_count <= p_limit;
end $$;

-- ---------------------------------------------------------------------------
-- Players
-- ---------------------------------------------------------------------------

create or replace function public.svc_ensure_player(p_user uuid, p_email text) returns void
language sql security definer set search_path = '' as $$
  insert into identity.players (user_id, email) values (p_user, lower(p_email)) on conflict (user_id) do nothing;
$$;

create or replace function public.svc_me(p_user uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p identity.players;
  v_xp int;
  v_games int;
  v_best int;
  v_streak int := 0;
  v_day date := ops.london_date();
  m market.members;
begin
  p := ops.require_player(p_user, false);
  select coalesce(sum(score + 50), 0), count(*), coalesce(max(score), 0) into v_xp, v_games, v_best
  from game.sessions where user_id = p_user and status = 'completed';
  if not exists (select 1 from game.sessions where user_id = p_user and game_id = v_day and status = 'completed') then v_day := v_day - 1; end if;
  while exists (select 1 from game.sessions where user_id = p_user and game_id = v_day and status = 'completed') loop
    v_streak := v_streak + 1;
    v_day := v_day - 1;
  end loop;
  select * into m from market.members where user_id = p_user;
  return jsonb_build_object(
    'user_id', p.user_id, 'email', p.email, 'display_name', p.display_name, 'referral_code', p.referral_code,
    'status', p.status, 'created_at', p.created_at, 'balance', loyalty.balance(p_user),
    'progress', jsonb_build_object('xp', v_xp, 'level', floor(sqrt(v_xp / 100.0))::int + 1, 'games_played', v_games,
      'best_score', v_best, 'streak', v_streak,
      'words_found', (select count(*) from game.submissions where user_id = p_user)),
    'roles', jsonb_build_object('admin', ops.is_admin(p_user),
      'merchant', case when m.user_id is null then null else jsonb_build_object('merchant_id', m.merchant_id, 'role', m.role) end));
end $$;

create or replace function public.svc_save_profile(p_user uuid, p_display_name text, p_referral_code text, p_terms_version text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p identity.players;
  v_code text;
  v_ref uuid;
  v_bonus int := loyalty.rule('welcome_bonus');
begin
  p := ops.require_player(p_user, false);
  if exists (select 1 from identity.players where lower(display_name) = lower(p_display_name) and user_id <> p_user) then
    perform ops.fail('name_taken', 409, 'That name is taken.');
  end if;
  if p.display_name is not null then
    update identity.players set display_name = p_display_name where user_id = p_user;
    return public.svc_me(p_user);
  end if;
  loop
    v_code := (select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + (get_byte(b, i) % 32), 1), '')
               from (select extensions.gen_random_bytes(6) b) x, generate_series(0, 5) i);
    exit when not exists (select 1 from identity.players where referral_code = v_code);
  end loop;
  if p_referral_code is not null then
    select user_id into v_ref from identity.players where referral_code = upper(p_referral_code) and user_id <> p_user;
  end if;
  update identity.players set display_name = p_display_name, referral_code = v_code, referred_by = v_ref, terms_version = p_terms_version
   where user_id = p_user;
  if v_bonus > 0 then
    perform loyalty.post(p_user, 'earn', v_bonus, 'welcome:' || p_user, 'welcome', null, 'platform', 'Welcome bonus');
  end if;
  return public.svc_me(p_user);
end $$;

-- ---------------------------------------------------------------------------
-- Game
-- ---------------------------------------------------------------------------

/** The full game row for the Edge Function (includes solutions: never send to players). */
create or replace function public.svc_get_game(p_date date) returns jsonb language sql security definer set search_path = '' as $$
  select to_jsonb(g) from game.games g where g.id = p_date
$$;

create or replace function public.svc_put_game(p_date date, p_puzzle jsonb, p_solutions jsonb, p_rules_version int,
  p_created_by text, p_sponsored_by uuid default null, p_replace boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_replace then
    if exists (select 1 from game.sessions where game_id = p_date) then
      perform ops.fail('challenge_in_play', 409, 'Players have already started this date’s challenge.');
    end if;
    insert into game.games (id, rules_version, puzzle, solutions, created_by, sponsored_by)
    values (p_date, p_rules_version, p_puzzle, p_solutions, p_created_by, p_sponsored_by)
    on conflict (id) do update set rules_version = excluded.rules_version, puzzle = excluded.puzzle, solutions = excluded.solutions,
      created_by = excluded.created_by, sponsored_by = excluded.sponsored_by, created_at = now();
    perform ops.audit(p_created_by, 'challenge.publish', p_date::text, jsonb_build_object('theme_word', p_puzzle ->> 'theme_word'));
  else
    insert into game.games (id, rules_version, puzzle, solutions, created_by, sponsored_by)
    values (p_date, p_rules_version, p_puzzle, p_solutions, p_created_by, p_sponsored_by)
    on conflict (id) do nothing;
  end if;
  return (select to_jsonb(g) - 'solutions' from game.games g where g.id = p_date);
end $$;

create or replace function public.svc_today(p_user uuid, p_date date) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_session uuid;
  v_status text;
begin
  perform game.close_expired_sessions();
  if p_user is not null then
    select id, status into v_session, v_status from game.sessions where user_id = p_user and game_id = p_date;
  end if;
  return jsonb_build_object(
    'session', case when v_session is null then null else game.session_view(v_session) end,
    'reveal', case when v_status = 'completed' then game.reveal(p_date) else null end,
    'server_time', now());
end $$;

create or replace function public.svc_start_session(p_user uuid, p_date date) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s game.sessions;
  g game.games;
begin
  perform ops.require_player(p_user);
  select * into g from game.games where id = p_date and status = 'published';
  if not found then perform ops.fail('not_found', 404); end if;
  select * into s from game.sessions where user_id = p_user and game_id = p_date;
  if found then
    if s.status = 'completed' then perform ops.fail('already_played', 409); end if;
    return game.session_view(s.id);
  end if;
  insert into game.sessions (user_id, game_id, ends_at)
  values (p_user, p_date, now() + make_interval(secs => (g.puzzle ->> 'time_limit_s')::int))
  on conflict (user_id, game_id) do nothing
  returning * into s;
  if s.id is null then select * into s from game.sessions where user_id = p_user and game_id = p_date; end if;
  return game.session_view(s.id);
end $$;

create or replace function public.svc_session_game(p_user uuid, p_session uuid) returns date language plpgsql security definer set search_path = '' as $$
declare v date;
begin
  perform ops.require_player(p_user);
  select game_id into v from game.sessions where id = p_session and user_id = p_user;
  if not found then perform ops.fail('not_found', 404); end if;
  return v;
end $$;

/** Record a word the Edge Function has already traced and scored. Time and duplicates are checked here, atomically. */
create or replace function public.svc_submit_word(p_user uuid, p_session uuid, p_word text, p_path int[], p_score int, p_grace_s int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s game.sessions;
begin
  perform ops.require_player(p_user);
  select * into s from game.sessions where id = p_session and user_id = p_user for update;
  if not found then perform ops.fail('not_found', 404); end if;
  if s.status <> 'active' or now() > s.ends_at + make_interval(secs => p_grace_s) then perform ops.fail('session_closed', 409); end if;
  insert into game.submissions (session_id, user_id, word, path, score) values (s.id, p_user, p_word, p_path, p_score)
  on conflict (session_id, word) do nothing;
  if not found then perform ops.fail('duplicate_word', 409, p_word); end if;
  return game.session_view(s.id);
end $$;

create or replace function public.svc_finish_session(p_user uuid, p_session uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s game.sessions;
  v_rank int;
  v_of int;
begin
  perform ops.require_player(p_user);
  select * into s from game.sessions where id = p_session and user_id = p_user;
  if not found then perform ops.fail('not_found', 404); end if;
  perform game.complete_session(s.id);
  select rank, total into v_rank, v_of from (
    select x.id, row_number() over (order by x.score desc, x.finished_at) rank, count(*) over () total
    from game.sessions x join identity.players p on p.user_id = x.user_id
    where x.game_id = s.game_id and x.status = 'completed' and p.status = 'active') t where t.id = s.id;
  return jsonb_build_object('session', game.session_view(s.id), 'reveal', game.reveal(s.game_id),
    'balance', loyalty.balance(p_user), 'rank', case when v_rank is null then null else jsonb_build_object('rank', v_rank, 'of', v_of) end);
end $$;

create or replace function public.svc_leaderboard(p_user uuid, p_date date) returns jsonb language sql security definer set search_path = '' as $$
  with board as (
    select row_number() over (order by s.score desc, s.finished_at) rank, p.display_name, s.score, s.word_count words, s.user_id
    from game.sessions s join identity.players p on p.user_id = s.user_id
    where s.game_id = p_date and s.status = 'completed' and p.status = 'active')
  select jsonb_build_object('date', p_date, 'players', (select count(*) from board),
    'top', coalesce((select jsonb_agg(jsonb_build_object('rank', rank, 'display_name', display_name, 'score', score, 'words', words, 'me', user_id = p_user) order by rank)
                     from board where rank <= 50), '[]'::jsonb),
    'me', (select jsonb_build_object('rank', rank, 'display_name', display_name, 'score', score, 'words', words, 'me', true) from board where user_id = p_user))
$$;

create or replace function public.svc_get_explanation(p_word text) returns jsonb language sql security definer set search_path = '' as $$
  select data from game.word_explanations where word = p_word
$$;

create or replace function public.svc_put_explanation(p_word text, p_data jsonb, p_model text) returns void language sql security definer set search_path = '' as $$
  insert into game.word_explanations (word, data, model) values (p_word, p_data, p_model) on conflict (word) do nothing;
$$;

-- ---------------------------------------------------------------------------
-- Wallet, offers, redemption
-- ---------------------------------------------------------------------------

create or replace function public.svc_wallet(p_user uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform ops.require_player(p_user);
  perform market.expire_reservations();
  return jsonb_build_object('balance', loyalty.balance(p_user),
    'transactions', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'type', type, 'points', points, 'amount', amount, 'held_delta', held_delta,
        'note', note, 'reference_type', reference_type, 'reference_id', reference_id, 'created_at', created_at, 'status', status) order by created_at desc)
      from (select * from loyalty.transactions where user_id = p_user order by created_at desc limit 200) t), '[]'::jsonb));
end $$;

create or replace function public.svc_offers(p_user uuid, p_category text, p_area text, p_available_now boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v jsonb;
begin
  select coalesce(jsonb_agg(x order by (x ->> 'available')::boolean desc, (x ->> 'points_price')::int), '[]'::jsonb) into v
  from (select market.offer_view(o, p_user) x
        from market.offers o join market.merchants m on m.id = o.merchant_id
        where o.status = 'active' and not o.suspended and m.status = 'approved'
          and (o.valid_until is null or o.valid_until > now())
          and (p_category is null or o.category = p_category)
          and (p_area is null or m.area = p_area)) t
  where not coalesce(p_available_now, false) or (x ->> 'available')::boolean;
  return jsonb_build_object('offers', v,
    'categories', jsonb_build_array('coffee', 'food', 'drinks', 'music', 'theatre', 'comedy', 'experience', 'other'),
    'areas', coalesce((select jsonb_agg(distinct area order by area) from market.merchants where status = 'approved'), '[]'::jsonb),
    'balance', case when p_user is null then null else loyalty.balance(p_user) end);
end $$;

create or replace function public.svc_offer(p_user uuid, p_offer uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare o market.offers;
begin
  select o2.* into o from market.offers o2 join market.merchants m on m.id = o2.merchant_id
   where o2.id = p_offer and m.status = 'approved' and o2.status <> 'draft';
  if not found then perform ops.fail('not_found', 404); end if;
  return jsonb_build_object('offer', market.offer_view(o, p_user), 'balance', case when p_user is null then null else loyalty.balance(p_user) end);
end $$;

/**
 * Reserve a reward. Locks the offer row (no overbooking) and the wallet (no
 * double spend). A retry with the same client key returns the existing
 * reservation with existing = true; the Edge Function then issues a new code.
 */
create or replace function public.svc_reserve(p_user uuid, p_offer uuid, p_client_key text, p_code_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  o market.offers;
  r market.redemptions;
  v_reason text;
  v_id uuid := gen_random_uuid();
  v_hold int;
begin
  perform ops.require_player(p_user);
  select * into r from market.redemptions where user_id = p_user and client_key = p_client_key;
  if found then
    if r.offer_id <> p_offer then perform ops.fail('idempotency_conflict', 409); end if;
    return jsonb_build_object('existing', true, 'redemption', market.redemption_view(r));
  end if;
  perform market.expire_reservations();
  select * into o from market.offers where id = p_offer for update;
  if not found then perform ops.fail('not_found', 404); end if;
  v_reason := market.unavailable_reason(o, p_user);
  if v_reason is not null then perform ops.fail(v_reason, 409); end if;
  perform loyalty.post(p_user, 'reserve', o.points_price, 'reserve:' || v_id, 'redemption', v_id::text, null, o.title, p_user::text);
  v_hold := coalesce(o.hold_minutes, loyalty.rule('reservation_minutes'));
  insert into market.redemptions (id, user_id, offer_id, merchant_id, points, status, code_hash, client_key, expires_at)
  values (v_id, p_user, o.id, o.merchant_id, o.points_price, 'reserved', p_code_hash, p_client_key,
          least(now() + make_interval(mins => v_hold), coalesce(o.valid_until, 'infinity'::timestamptz)))
  returning * into r;
  return jsonb_build_object('existing', false, 'redemption', market.redemption_view(r), 'balance', loyalty.balance(p_user));
end $$;

create or replace function public.svc_my_redemptions(p_user uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform ops.require_player(p_user);
  perform market.expire_reservations();
  return jsonb_build_object('redemptions', coalesce((select jsonb_agg(market.redemption_view(r) order by r.reserved_at desc)
    from (select * from market.redemptions where user_id = p_user order by reserved_at desc limit 100) r), '[]'::jsonb));
end $$;

/** Codes are stored only as hashes, so showing one again means replacing it. */
create or replace function public.svc_reissue_code(p_user uuid, p_redemption uuid, p_code_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r market.redemptions;
begin
  perform ops.require_player(p_user);
  perform market.expire_reservations();
  select * into r from market.redemptions where id = p_redemption and user_id = p_user for update;
  if not found then perform ops.fail('not_found', 404); end if;
  if r.status <> 'reserved' then perform ops.fail(case r.status when 'redeemed' then 'already_redeemed' else r.status end, 409); end if;
  update market.redemptions set code_hash = p_code_hash where id = r.id returning * into r;
  return jsonb_build_object('redemption', market.redemption_view(r), 'balance', loyalty.balance(p_user));
end $$;

create or replace function public.svc_cancel_reservation(p_user uuid, p_redemption uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r market.redemptions;
begin
  perform ops.require_player(p_user);
  perform market.expire_reservations();
  select * into r from market.redemptions where id = p_redemption and user_id = p_user for update;
  if not found then perform ops.fail('not_found', 404); end if;
  if r.status <> 'reserved' then perform ops.fail(case r.status when 'redeemed' then 'already_redeemed' else r.status end, 409); end if;
  perform market.release(r, 'cancelled', p_user::text);
  select * into r from market.redemptions where id = p_redemption;
  return jsonb_build_object('redemption', market.redemption_view(r), 'balance', loyalty.balance(p_user));
end $$;

-- ---------------------------------------------------------------------------
-- Merchants
-- ---------------------------------------------------------------------------

create or replace function public.svc_merchant_register(p_user uuid, p_merchant jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform ops.require_player(p_user, false);
  if exists (select 1 from market.members where user_id = p_user) then perform ops.fail('already_registered', 409, 'You already belong to a venue.'); end if;
  insert into market.merchants (name, category, description, area, address, contact_email)
  values (p_merchant ->> 'name', p_merchant ->> 'category', p_merchant ->> 'description', p_merchant ->> 'area', p_merchant ->> 'address', p_merchant ->> 'contact_email')
  returning id into v_id;
  insert into market.members (user_id, merchant_id, role) values (p_user, v_id, 'owner');
  perform ops.audit(p_user::text, 'merchant.register', v_id::text);
  return public.svc_merchant_me(p_user);
end $$;

create or replace function public.svc_merchant_me(p_user uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare m market.members;
begin
  perform ops.require_player(p_user, false);
  select * into m from market.members where user_id = p_user;
  if not found then return jsonb_build_object('merchant', null); end if;
  perform market.expire_reservations();
  return jsonb_build_object(
    'merchant', (select to_jsonb(x) from market.merchants x where x.id = m.merchant_id),
    'role', m.role,
    'offers', coalesce((select jsonb_agg(market.offer_view(o) || jsonb_build_object(
        'reserved', (select count(*) from market.redemptions r where r.offer_id = o.id and r.status = 'reserved'),
        'redeemed', (select count(*) from market.redemptions r where r.offer_id = o.id and r.status = 'redeemed'),
        'standard_price_pence', o.standard_price_pence, 'fulfilment_cost_pence', o.fulfilment_cost_pence, 'suspended', o.suspended)
      order by o.created_at desc) from market.offers o where o.merchant_id = m.merchant_id), '[]'::jsonb));
end $$;

/** Create (p_offer_id null) or update an offer. p_fields is already validated by the Edge Function (js/core/validate.js). */
create or replace function public.svc_save_offer(p_user uuid, p_offer_id uuid, p_fields jsonb, p_publish boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  mem market.members;
  o market.offers;
  v_days int[];
begin
  mem := ops.require_member(p_user, true);
  if (select status from market.merchants where id = mem.merchant_id) <> 'approved' then perform ops.fail('merchant_not_approved', 409); end if;
  v_days := case when jsonb_typeof(p_fields -> 'days') = 'array' then array(select jsonb_array_elements_text(p_fields -> 'days')::int) else null end;
  if p_offer_id is not null then
    select * into o from market.offers where id = p_offer_id and merchant_id = mem.merchant_id for update;
    if not found then perform ops.fail('not_found', 404); end if;
    if o.suspended then perform ops.fail('offer_suspended', 409, 'An administrator has suspended this offer.'); end if;
    if (p_fields ->> 'quantity_total')::int < market.claimed(o.id) then perform ops.fail('inventory_below_claimed', 409); end if;
  end if;
  insert into market.offers as t (id, merchant_id, title, description, category, image, points_price, standard_price_pence, fulfilment_cost_pence,
    quantity_total, max_per_customer, valid_from, valid_until, days, window_start, window_end, hold_minutes, terms, status)
  values (coalesce(p_offer_id, gen_random_uuid()), mem.merchant_id, p_fields ->> 'title', p_fields ->> 'description', p_fields ->> 'category', p_fields ->> 'image',
    (p_fields ->> 'points_price')::int, (p_fields ->> 'standard_price_pence')::int, (p_fields ->> 'fulfilment_cost_pence')::int,
    (p_fields ->> 'quantity_total')::int, (p_fields ->> 'max_per_customer')::int, (p_fields ->> 'valid_from')::timestamptz,
    (p_fields ->> 'valid_until')::timestamptz, v_days, (p_fields ->> 'window_start')::time, (p_fields ->> 'window_end')::time,
    (p_fields ->> 'hold_minutes')::int, p_fields ->> 'terms', case when p_publish then 'active' else 'draft' end)
  on conflict (id) do update set title = excluded.title, description = excluded.description, category = excluded.category, image = excluded.image,
    points_price = excluded.points_price, standard_price_pence = excluded.standard_price_pence, fulfilment_cost_pence = excluded.fulfilment_cost_pence,
    quantity_total = excluded.quantity_total, max_per_customer = excluded.max_per_customer, valid_from = excluded.valid_from,
    valid_until = excluded.valid_until, days = excluded.days, window_start = excluded.window_start, window_end = excluded.window_end,
    hold_minutes = excluded.hold_minutes, terms = excluded.terms, updated_at = now()
  returning * into o;
  perform ops.audit(p_user::text, case when p_offer_id is null then 'offer.create' else 'offer.update' end, o.id::text);
  return jsonb_build_object('offer', market.offer_view(o));
end $$;

create or replace function public.svc_set_offer_status(p_user uuid, p_offer uuid, p_status text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  mem market.members;
  o market.offers;
begin
  mem := ops.require_member(p_user, true);
  if p_status not in ('draft', 'active', 'paused', 'ended') then perform ops.fail('invalid_request', 400, 'status: draft, active, paused, ended'); end if;
  select * into o from market.offers where id = p_offer and merchant_id = mem.merchant_id for update;
  if not found then perform ops.fail('not_found', 404); end if;
  if o.suspended then perform ops.fail('offer_suspended', 409, 'An administrator has suspended this offer.'); end if;
  if o.status = 'ended' then perform ops.fail('offer_ended', 409, 'Ended offers cannot be restarted. Create a new one.'); end if;
  if p_status = 'active' and (select status from market.merchants where id = mem.merchant_id) <> 'approved' then perform ops.fail('merchant_not_approved', 409); end if;
  -- Existing reservations are untouched: they stay valid until they expire.
  update market.offers set status = p_status, updated_at = now() where id = o.id returning * into o;
  perform ops.audit(p_user::text, 'offer.' || p_status, o.id::text);
  return jsonb_build_object('offer', market.offer_view(o));
end $$;

/**
 * Check (p_confirm false) or redeem (true) a code at the venue. The update
 * is conditional on status = 'reserved' under a row lock, so a code can only
 * ever be redeemed once. A code for another venue looks like an unknown one.
 */
create or replace function public.svc_validate(p_user uuid, p_code_hash text, p_confirm boolean) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  mem market.members;
  r market.redemptions;
  v jsonb;
begin
  mem := ops.require_member(p_user);
  select * into r from market.redemptions where code_hash = p_code_hash for update;
  if not found or r.merchant_id <> mem.merchant_id then perform ops.fail('invalid_code', 404); end if;
  if r.status = 'redeemed' then perform ops.fail('already_redeemed', 409, r.validated_at::text); end if;
  if r.status = 'reserved' and r.expires_at <= now() then
    perform market.release(r, 'expired', 'system');
    -- Commit the release even though we report an error: return instead of raising.
    return jsonb_build_object('error', 'expired');
  end if;
  if r.status <> 'reserved' then perform ops.fail(case r.status when 'expired' then 'expired' else 'cancelled' end, 409); end if;
  if p_confirm then
    perform loyalty.post(r.user_id, 'redeem', r.points, 'redeem:' || r.id, 'redemption', r.id::text, null,
      (select title from market.offers where id = r.offer_id), p_user::text);
    update market.redemptions set status = 'redeemed', validated_at = now(), validated_by = p_user where id = r.id returning * into r;
    perform ops.audit(p_user::text, 'redemption.validate', r.id::text);
  end if;
  v := market.redemption_view(r) || jsonb_build_object('player', (select display_name from identity.players where user_id = r.user_id));
  return jsonb_build_object('valid', true, 'redeemed', case when p_confirm then true else null end, 'redemption', v);
end $$;

create or replace function public.svc_merchant_redemptions(p_user uuid, p_status text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare mem market.members;
begin
  mem := ops.require_member(p_user);
  perform market.expire_reservations();
  return jsonb_build_object('redemptions', coalesce((select jsonb_agg(market.redemption_view(r) || jsonb_build_object(
      'player', (select display_name from identity.players where user_id = r.user_id), 'reported_spend_pence', r.reported_spend_pence)
      order by coalesce(r.validated_at, r.reserved_at) desc)
    from (select * from market.redemptions where merchant_id = mem.merchant_id and (p_status is null or status = p_status)
          order by coalesce(validated_at, reserved_at) desc limit 200) r), '[]'::jsonb));
end $$;

create or replace function public.svc_report_spend(p_user uuid, p_redemption uuid, p_spend_pence int) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  mem market.members;
  r market.redemptions;
begin
  mem := ops.require_member(p_user);
  select * into r from market.redemptions where id = p_redemption and merchant_id = mem.merchant_id for update;
  if not found then perform ops.fail('not_found', 404); end if;
  if r.status <> 'redeemed' then perform ops.fail('not_redeemed', 409, 'Spend can only be reported for redeemed rewards.'); end if;
  update market.redemptions set reported_spend_pence = p_spend_pence where id = r.id;
  perform ops.audit(p_user::text, 'redemption.report_spend', r.id::text, jsonb_build_object('spend_pence', p_spend_pence));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.svc_merchant_stats(p_user uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  mem market.members;
  v_claimed int; v_redeemed int; v_expired int; v_customers int; v_points int;
  v_reported int; v_spend bigint; v_cost bigint;
begin
  mem := ops.require_member(p_user);
  select count(*), count(*) filter (where r.status = 'redeemed'), count(*) filter (where r.status = 'expired'),
         count(distinct r.user_id) filter (where r.status = 'redeemed'), coalesce(sum(r.points) filter (where r.status = 'redeemed'), 0),
         count(*) filter (where r.status = 'redeemed' and r.reported_spend_pence is not null),
         coalesce(sum(r.reported_spend_pence) filter (where r.status = 'redeemed'), 0),
         coalesce(sum(o.fulfilment_cost_pence) filter (where r.status = 'redeemed'), 0)
    into v_claimed, v_redeemed, v_expired, v_customers, v_points, v_reported, v_spend, v_cost
  from market.redemptions r join market.offers o on o.id = r.offer_id where r.merchant_id = mem.merchant_id;
  return jsonb_build_object(
    'verified', jsonb_build_object(
      'offers_published', (select count(*) from market.offers where merchant_id = mem.merchant_id and status <> 'draft'),
      'offers_live', (select count(*) from market.offers where merchant_id = mem.merchant_id and status = 'active' and not suspended),
      'rewards_claimed', v_claimed, 'rewards_redeemed', v_redeemed, 'rewards_expired', v_expired,
      'redemption_conversion', case when v_claimed > 0 then v_redeemed::numeric / v_claimed end,
      'unique_customers', v_customers, 'points_redeemed', v_points),
    'reported', jsonb_build_object('redemptions_with_spend', v_reported, 'customer_spend_pence', v_spend),
    'estimated', jsonb_build_object('fulfilment_cost_pence', v_cost,
      'incremental_revenue_pence', case when v_reported > 0 then round(v_spend::numeric / v_reported * v_redeemed - v_cost) end,
      'basis', 'Average reported spend × redemptions, minus your estimated fulfilment cost. Merchant-reported, not verified.'));
end $$;

-- ---------------------------------------------------------------------------
-- Yield
-- ---------------------------------------------------------------------------

create or replace function public.svc_yield_get(p_user uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare mem market.members;
begin
  mem := ops.require_member(p_user);
  return jsonb_build_object('rules', coalesce((select jsonb_agg(to_jsonb(y) || jsonb_build_object('last_recommendation',
      (select yield.rec_view(rc) from yield.recommendations rc where rc.rule_id = y.id order by rc.created_at desc limit 1)))
    from yield.rules y where y.merchant_id = mem.merchant_id), '[]'::jsonb),
    'default_bands', '[{"below":30,"points":300},{"below":50,"points":500},{"below":70,"points":800}]'::jsonb);
end $$;

create or replace function public.svc_yield_save_rule(p_user uuid, p_offer uuid, p_rule jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  mem market.members;
  y yield.rules;
begin
  mem := ops.require_member(p_user, true);
  if not exists (select 1 from market.offers where id = p_offer and merchant_id = mem.merchant_id) then perform ops.fail('not_found', 404); end if;
  insert into yield.rules (merchant_id, offer_id, bands, capacity, target_utilisation, max_units, auto_apply)
  values (mem.merchant_id, p_offer, p_rule -> 'bands', (p_rule ->> 'capacity')::int, (p_rule ->> 'target_utilisation')::int,
          (p_rule ->> 'max_units')::int, coalesce((p_rule ->> 'auto_apply')::boolean, false))
  on conflict (offer_id) do update set bands = excluded.bands, capacity = excluded.capacity, target_utilisation = excluded.target_utilisation,
    max_units = excluded.max_units, auto_apply = excluded.auto_apply, updated_at = now()
  returning * into y;
  perform ops.audit(p_user::text, 'yield.rule', y.id::text, jsonb_build_object('auto_apply', y.auto_apply));
  return jsonb_build_object('rule', to_jsonb(y));
end $$;

/** The rule, for the Edge Function to compute a recommendation with js/core/yield.js. */
create or replace function public.svc_yield_rule(p_user uuid, p_rule uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare mem market.members;
begin
  mem := ops.require_member(p_user);
  return (select to_jsonb(y) from yield.rules y where y.id = p_rule and y.merchant_id = mem.merchant_id);
end $$;

/** Store a recommendation; apply it now if the owner switched on auto-apply beforehand. */
create or replace function public.svc_yield_record(p_user uuid, p_rule uuid, p_rec jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  mem market.members;
  y yield.rules;
  rc yield.recommendations;
begin
  mem := ops.require_member(p_user);
  select * into y from yield.rules where id = p_rule and merchant_id = mem.merchant_id;
  if not found then perform ops.fail('not_found', 404); end if;
  insert into yield.recommendations (rule_id, offer_id, utilisation, action, points_price, quantity, band, reason, created_by)
  values (y.id, y.offer_id, (p_rec ->> 'utilisation')::numeric, p_rec ->> 'action', (p_rec ->> 'points_price')::int,
          (p_rec ->> 'quantity')::int, p_rec -> 'band', p_rec ->> 'reason', p_user)
  returning * into rc;
  if y.auto_apply and rc.action = 'release' and mem.role = 'owner' then perform yield.apply(rc.id, p_user); end if;
  select * into rc from yield.recommendations where id = rc.id;
  return jsonb_build_object('recommendation', yield.rec_view(rc),
    'offer', (select market.offer_view(o) from market.offers o where o.id = y.offer_id));
end $$;

create or replace function public.svc_yield_apply(p_user uuid, p_rule uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  mem market.members;
  y yield.rules;
  rc yield.recommendations;
begin
  mem := ops.require_member(p_user, true);
  select * into y from yield.rules where id = p_rule and merchant_id = mem.merchant_id;
  if not found then perform ops.fail('not_found', 404); end if;
  select * into rc from yield.recommendations where rule_id = y.id order by created_at desc limit 1;
  if not found then perform ops.fail('not_found', 404); end if;
  perform yield.apply(rc.id, p_user);
  select * into rc from yield.recommendations where id = rc.id;
  return jsonb_build_object('recommendation', yield.rec_view(rc),
    'offer', (select market.offer_view(o) from market.offers o where o.id = y.offer_id));
end $$;

-- ---------------------------------------------------------------------------
-- Admin
-- ---------------------------------------------------------------------------

create or replace function public.svc_admin_overview(p_user uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_today date := ops.london_date();
  v_ppp numeric;
  v_out bigint;
  v_registered int;
begin
  perform ops.require_admin(p_user);
  select sum(o.fulfilment_cost_pence)::numeric / nullif(sum(r.points), 0) into v_ppp
  from market.redemptions r join market.offers o on o.id = r.offer_id where r.status = 'redeemed';
  select coalesce(sum(amount + held_delta), 0) into v_out from loyalty.transactions;
  select count(*) into v_registered from identity.players where display_name is not null;
  return jsonb_build_object(
    'players', jsonb_build_object('registered', v_registered,
      'suspended', (select count(*) from identity.players where status = 'suspended'),
      'active_today', (select count(distinct user_id) from game.sessions where game_id = v_today),
      'first_redemption_rate', case when v_registered > 0 then (select count(distinct user_id) from market.redemptions where status = 'redeemed')::numeric / v_registered end),
    'games', jsonb_build_object('today', v_today,
      'started_today', (select count(*) from game.sessions where game_id = v_today),
      'completed_today', (select count(*) from game.sessions where game_id = v_today and status = 'completed'),
      'completed_all_time', (select count(*) from game.sessions where status = 'completed')),
    'points', jsonb_build_object(
      'issued', (select coalesce(sum(points), 0) from loyalty.transactions where type = 'earn'),
      'redeemed', (select coalesce(sum(points), 0) from loyalty.transactions where type = 'redeem'),
      'available', (select coalesce(sum(amount), 0) from loyalty.transactions),
      'held', (select coalesce(sum(held_delta), 0) from loyalty.transactions),
      'outstanding', v_out,
      'issued_by_source', coalesce((select jsonb_object_agg(src, n) from (select split_part(coalesce(funding_source, 'platform'), ':', 1) src, sum(points) n
                                    from loyalty.transactions where type = 'earn' group by 1) s), '{}'::jsonb),
      'pence_per_point', v_ppp,
      'outstanding_liability_pence', case when v_ppp is not null then round(v_out * v_ppp) end),
    'redemptions', (select jsonb_build_object('reserved', count(*) filter (where status = 'reserved'), 'redeemed', count(*) filter (where status = 'redeemed'),
      'expired', count(*) filter (where status = 'expired'), 'cancelled', count(*) filter (where status = 'cancelled'),
      'refunded', count(*) filter (where status = 'refunded')) from market.redemptions),
    'merchants', (select jsonb_build_object('approved', count(*) filter (where status = 'approved'), 'pending', count(*) filter (where status = 'pending')) from market.merchants),
    'offers', jsonb_build_object('live', (select count(*) from market.offers where status = 'active' and not suspended)),
    'fraud_open', (select count(*) from ops.fraud_signals where status = 'open'));
end $$;

create or replace function public.svc_admin_merchants(p_user uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform ops.require_admin(p_user);
  return jsonb_build_object('merchants', coalesce((select jsonb_agg(to_jsonb(m) || jsonb_build_object('offers', (select count(*) from market.offers o where o.merchant_id = m.id))
    order by m.status, m.name) from market.merchants m), '[]'::jsonb));
end $$;

create or replace function public.svc_admin_merchant_status(p_user uuid, p_merchant uuid, p_status text, p_reason text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare m market.merchants;
begin
  perform ops.require_admin(p_user);
  if p_status not in ('approved', 'suspended', 'pending') then perform ops.fail('invalid_request', 400, 'status: approved, suspended or pending'); end if;
  update market.merchants set status = p_status where id = p_merchant returning * into m;
  if not found then perform ops.fail('not_found', 404); end if;
  perform ops.audit(p_user::text, 'merchant.' || p_status, m.id::text, jsonb_build_object('reason', p_reason));
  return jsonb_build_object('merchant', to_jsonb(m));
end $$;

create or replace function public.svc_admin_users(p_user uuid, p_q text) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform ops.require_admin(p_user);
  return jsonb_build_object('users', coalesce((select jsonb_agg(jsonb_build_object('id', p.user_id, 'email', p.email, 'display_name', p.display_name,
      'status', p.status, 'created_at', p.created_at, 'last_active_at', p.last_active_at, 'balance', loyalty.balance(p.user_id),
      'flags', (select count(*) from ops.fraud_signals f where f.user_id = p.user_id and f.status = 'open')) order by p.created_at desc)
    from (select * from identity.players p
          where p_q is null or p_q = '' or p.email ilike '%' || p_q || '%' or p.display_name ilike '%' || p_q || '%' or p.user_id::text = p_q
          order by created_at desc limit 100) p), '[]'::jsonb));
end $$;

create or replace function public.svc_admin_user_status(p_user uuid, p_target uuid, p_status text, p_reason text) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform ops.require_admin(p_user);
  if p_status not in ('active', 'suspended') then perform ops.fail('invalid_request', 400, 'status: active or suspended'); end if;
  update identity.players set status = p_status where user_id = p_target;
  if not found then perform ops.fail('not_found', 404); end if;
  perform ops.audit(p_user::text, 'user.' || p_status, p_target::text, jsonb_build_object('reason', p_reason));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.svc_admin_user_transactions(p_user uuid, p_target uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare p identity.players;
begin
  perform ops.require_admin(p_user);
  select * into p from identity.players where user_id = p_target;
  if not found then perform ops.fail('not_found', 404); end if;
  return jsonb_build_object('user', jsonb_build_object('id', p.user_id, 'email', p.email, 'display_name', p.display_name, 'status', p.status),
    'balance', loyalty.balance(p_target),
    'transactions', coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at desc) from loyalty.transactions t where t.user_id = p_target), '[]'::jsonb));
end $$;

create or replace function public.svc_admin_adjust(p_user uuid, p_target uuid, p_points int, p_reason text, p_key text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare t loyalty.transactions;
begin
  perform ops.require_admin(p_user);
  if not exists (select 1 from identity.players where user_id = p_target) then perform ops.fail('not_found', 404); end if;
  t := loyalty.post(p_target, 'adjust', p_points, 'adjust:' || p_key, 'admin', p_user::text, 'platform', p_reason, p_user::text);
  perform ops.audit(p_user::text, 'points.adjust', p_target::text, jsonb_build_object('points', p_points, 'reason', p_reason, 'transaction_id', t.id));
  return jsonb_build_object('transaction', to_jsonb(t), 'balance', loyalty.balance(p_target));
end $$;

create or replace function public.svc_admin_redemptions(p_user uuid, p_status text) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform ops.require_admin(p_user);
  perform market.expire_reservations();
  return jsonb_build_object('redemptions', coalesce((select jsonb_agg(market.redemption_view(r) || jsonb_build_object('user_id', r.user_id,
      'player', (select display_name from identity.players where user_id = r.user_id)) order by r.reserved_at desc)
    from (select * from market.redemptions where p_status is null or status = p_status order by reserved_at desc limit 200) r), '[]'::jsonb));
end $$;

create or replace function public.svc_admin_resolve(p_user uuid, p_redemption uuid, p_action text, p_reason text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r market.redemptions;
begin
  perform ops.require_admin(p_user);
  select * into r from market.redemptions where id = p_redemption for update;
  if not found then perform ops.fail('not_found', 404); end if;
  if p_action = 'release' then
    if r.status <> 'reserved' then perform ops.fail('invalid_state', 409, 'Only active reservations can be released.'); end if;
    perform market.release(r, 'cancelled', p_user::text);
  elsif p_action = 'refund' then
    if r.status <> 'redeemed' then perform ops.fail('invalid_state', 409, 'Only redeemed rewards can be refunded.'); end if;
    perform loyalty.post(r.user_id, 'refund', r.points, 'refund:' || r.id, 'redemption', r.id::text, null, p_reason, p_user::text);
    update market.redemptions set status = 'refunded' where id = r.id;
  elsif p_action = 'complete' then
    if r.status <> 'reserved' then perform ops.fail('invalid_state', 409, 'Only active reservations can be completed.'); end if;
    perform loyalty.post(r.user_id, 'redeem', r.points, 'redeem:' || r.id, 'redemption', r.id::text, null, p_reason, p_user::text);
    update market.redemptions set status = 'redeemed', validated_at = now(), validated_by = p_user where id = r.id;
  else
    perform ops.fail('invalid_request', 400, 'action: release, refund or complete');
  end if;
  perform ops.audit(p_user::text, 'redemption.' || p_action, r.id::text, jsonb_build_object('reason', p_reason));
  select * into r from market.redemptions where id = p_redemption;
  return jsonb_build_object('redemption', market.redemption_view(r));
end $$;

create or replace function public.svc_admin_offers(p_user uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform ops.require_admin(p_user);
  return jsonb_build_object('offers', coalesce((select jsonb_agg(market.offer_view(o) || jsonb_build_object(
      'reserved', (select count(*) from market.redemptions r where r.offer_id = o.id and r.status = 'reserved'),
      'redeemed', (select count(*) from market.redemptions r where r.offer_id = o.id and r.status = 'redeemed'),
      'suspended', o.suspended, 'merchant_status', (select status from market.merchants m where m.id = o.merchant_id)) order by o.created_at desc)
    from market.offers o), '[]'::jsonb));
end $$;

create or replace function public.svc_admin_suspend_offer(p_user uuid, p_offer uuid, p_suspended boolean, p_reason text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare o market.offers;
begin
  perform ops.require_admin(p_user);
  update market.offers set suspended = p_suspended, status = case when p_suspended then 'paused' else status end, updated_at = now()
   where id = p_offer returning * into o;
  if not found then perform ops.fail('not_found', 404); end if;
  perform ops.audit(p_user::text, case when p_suspended then 'offer.suspend' else 'offer.unsuspend' end, o.id::text, jsonb_build_object('reason', p_reason));
  return jsonb_build_object('offer', market.offer_view(o));
end $$;

create or replace function public.svc_admin_get_rules(p_user uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform ops.require_admin(p_user);
  return jsonb_build_object('rules', (select rules from loyalty.rules));
end $$;

/** p_rules is the full merged rule set, validated by the Edge Function (applyRulesPatch in js/core/rules.js). */
create or replace function public.svc_admin_set_rules(p_user uuid, p_rules jsonb, p_patch jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform ops.require_admin(p_user);
  update loyalty.rules set rules = p_rules, updated_at = now(), updated_by = p_user;
  perform ops.audit(p_user::text, 'rules.update', 'rules', p_patch);
  return jsonb_build_object('rules', p_rules);
end $$;

create or replace function public.svc_admin_fraud(p_user uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform ops.require_admin(p_user);
  return jsonb_build_object('signals', coalesce((select jsonb_agg(to_jsonb(f) || jsonb_build_object('display_name', (select display_name from identity.players p where p.user_id = f.user_id))
    order by f.created_at desc) from (select * from ops.fraud_signals order by created_at desc limit 200) f), '[]'::jsonb));
end $$;

create or replace function public.svc_admin_resolve_fraud(p_user uuid, p_signal uuid, p_status text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare f ops.fraud_signals;
begin
  perform ops.require_admin(p_user);
  update ops.fraud_signals set status = case when p_status = 'confirmed' then 'confirmed' else 'dismissed' end, resolved_by = p_user, resolved_at = now()
   where id = p_signal returning * into f;
  if not found then perform ops.fail('not_found', 404); end if;
  perform ops.audit(p_user::text, 'fraud.' || f.status, f.id::text);
  return jsonb_build_object('signal', to_jsonb(f));
end $$;

create or replace function public.svc_admin_challenges(p_user uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform ops.require_admin(p_user);
  return jsonb_build_object('today', ops.london_date(), 'challenges', coalesce((select jsonb_agg(jsonb_build_object('date', g.id,
      'theme_word', g.puzzle ->> 'theme_word', 'theme_hint', g.puzzle ->> 'theme_hint', 'word_count', (g.puzzle ->> 'word_count')::int,
      'max_score', (g.puzzle ->> 'max_score')::int, 'target_score', (g.puzzle ->> 'target_score')::int, 'status', g.status,
      'created_by', g.created_by, 'sponsored_by', g.sponsored_by, 'players', (select count(*) from game.sessions s where s.game_id = g.id)) order by g.id desc)
    from (select * from game.games order by id desc limit 30) g), '[]'::jsonb));
end $$;

create or replace function public.svc_admin_audit(p_user uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform ops.require_admin(p_user);
  return jsonb_build_object('entries', coalesce((select jsonb_agg(to_jsonb(a) order by a.at desc) from (select * from ops.audit_log order by at desc limit 200) a), '[]'::jsonb));
end $$;

create or replace function public.svc_is_admin(p_user uuid) returns boolean language sql security definer set search_path = '' as $$
  select ops.is_admin(p_user)
$$;

-- ---------------------------------------------------------------------------
-- Grants: svc_* only for service_role. Internal schemas: nothing for anyone.
-- ---------------------------------------------------------------------------

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'svc\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('identity', 'game', 'loyalty', 'market', 'yield', 'ops') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Scheduled jobs (pg_cron). Skipped if the extension isn't enabled; enable it
-- and re-run this block.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('words-expire-reservations', '* * * * *', 'select market.expire_reservations()');
    perform cron.schedule('words-close-sessions', '* * * * *', 'select game.close_expired_sessions()');
    perform cron.schedule('words-expire-balances', '17 3 * * *', 'select loyalty.expire_inactive()');
    perform cron.schedule('words-purge-rate-limits', '7 * * * *', $c$delete from ops.rate_limits where window_start < now() - interval '2 hours'$c$);
  end if;
end $$;
