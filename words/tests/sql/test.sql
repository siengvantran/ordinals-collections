-- SQL tests for the WORDS ledger, game, marketplace, yield and admin rules.
-- Each block raises on failure. Run with: npm run test:sql
\set QUIET on
set client_min_messages = warning;

create or replace function pg_temp.eq(a anyelement, b anyelement, what text) returns void language plpgsql as $$
begin
  if a is distinct from b then raise exception 'FAIL %: expected %, got %', what, b, a; end if;
end $$;

/** Run a statement that must fail with the given error code. */
create or replace function pg_temp.fails(p_sql text, p_code text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL expected error % from: %', p_code, p_sql;
exception when others then
  if sqlerrm like 'FAIL %' then raise; end if;
  if sqlerrm <> p_code then raise exception 'FAIL expected %, got % (%)', p_code, sqlerrm, p_sql; end if;
end $$;

-- Fixtures: players, an admin, a venue, a game
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@example.com'),
  ('00000000-0000-0000-0000-00000000000c', 'staff@example.com'),
  ('00000000-0000-0000-0000-00000000000d', 'admin@example.com'),
  ('00000000-0000-0000-0000-00000000000e', 'other@example.com');
do $$ begin perform public.svc_ensure_player(id, email) from auth.users; end $$;
insert into ops.admins values ('00000000-0000-0000-0000-00000000000d');

\echo profile and welcome bonus
do $$
declare v jsonb;
begin
  perform pg_temp.fails($q$select public.svc_start_session('00000000-0000-0000-0000-00000000000a', current_date)$q$, 'profile_required');
  v := public.svc_save_profile('00000000-0000-0000-0000-00000000000a', 'Alice', null, 't1');
  perform pg_temp.eq((v -> 'balance' ->> 'available')::int, 250, 'welcome bonus');
  -- Saving again does not pay again
  v := public.svc_save_profile('00000000-0000-0000-0000-00000000000a', 'Alice A', null, 't1');
  perform pg_temp.eq((v -> 'balance' ->> 'available')::int, 250, 'welcome bonus once');
  perform pg_temp.fails($q$select public.svc_save_profile('00000000-0000-0000-0000-00000000000b', 'alice a', null, 't1')$q$, 'name_taken');
  v := public.svc_save_profile('00000000-0000-0000-0000-00000000000b', 'Bob',
        (select referral_code from identity.players where user_id = '00000000-0000-0000-0000-00000000000a'), 't1');
  perform pg_temp.eq((select referred_by from identity.players where user_id = '00000000-0000-0000-0000-00000000000b'), '00000000-0000-0000-0000-00000000000a'::uuid, 'referral link');
  perform public.svc_save_profile('00000000-0000-0000-0000-00000000000c', 'Staff', null, 't1');
  perform public.svc_save_profile('00000000-0000-0000-0000-00000000000d', 'Admin', null, 't1');
  perform public.svc_save_profile('00000000-0000-0000-0000-00000000000e', 'Other', null, 't1');
end $$;

\echo ledger invariants
do $$
declare t loyalty.transactions;
begin
  t := loyalty.post('00000000-0000-0000-0000-00000000000e', 'earn', 10, 'test:k1');
  perform pg_temp.eq((loyalty.post('00000000-0000-0000-0000-00000000000e', 'earn', 10, 'test:k1')).id, t.id, 'idempotent repost');
  perform pg_temp.fails($q$select loyalty.post('00000000-0000-0000-0000-00000000000e', 'earn', 11, 'test:k1')$q$, 'idempotency_conflict');
  perform pg_temp.fails($q$select loyalty.post('00000000-0000-0000-0000-00000000000e', 'expire', 1000, 'test:k2')$q$, 'insufficient_points');
  perform pg_temp.fails($q$select loyalty.post('00000000-0000-0000-0000-00000000000e', 'redeem', 1, 'test:k3')$q$, 'insufficient_held');
  perform pg_temp.fails($q$select loyalty.post('00000000-0000-0000-0000-00000000000e', 'earn', -5, 'test:k4')$q$, 'invalid_points');
  begin
    update loyalty.transactions set points = 999 where id = t.id;
    raise exception 'FAIL ledger update allowed';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  begin
    insert into loyalty.transactions (user_id, type, points, amount, held_delta, idempotency_key)
    values ('00000000-0000-0000-0000-00000000000e', 'earn', 5, 500, 0, 'test:bad');
    raise exception 'FAIL inconsistent row accepted';
  exception when check_violation then null;
  end;
  perform pg_temp.eq((loyalty.balance('00000000-0000-0000-0000-00000000000e') ->> 'available')::int, 260, 'balance from ledger');
end $$;

\echo game: start, words, finish, awards exactly once, no replay
insert into game.games (id, rules_version, puzzle, solutions) values (ops.london_date(), 1,
  '{"tiles":["c","a","t","s","x","x","x","x","x","x","x","x","x","x","x","x"],"star":0,"time_limit_s":300,"word_count":3,
    "max_score":40,"target_score":40,"theme_word":"cats","theme_hint":null,"theme_bonus":15}',
  '{"cat":4,"cats":6,"act":4}');
do $$
declare v jsonb; sid uuid;
begin
  v := public.svc_start_session('00000000-0000-0000-0000-00000000000b', ops.london_date());
  sid := (v ->> 'session_id')::uuid;
  perform pg_temp.eq((public.svc_start_session('00000000-0000-0000-0000-00000000000b', ops.london_date()) ->> 'session_id')::uuid, sid, 'start is idempotent');
  v := public.svc_submit_word('00000000-0000-0000-0000-00000000000b', sid, 'cat', '{0,1,2}', 8, 90);
  v := public.svc_submit_word('00000000-0000-0000-0000-00000000000b', sid, 'cats', '{0,1,2,3}', 12, 90);
  perform pg_temp.eq((v ->> 'score')::int, 8 + 12 + 15, 'live score with theme bonus');
  perform pg_temp.eq((v ->> 'theme_found')::boolean, true, 'theme found');
  perform pg_temp.fails(format($q$select public.svc_submit_word('00000000-0000-0000-0000-00000000000b', %L, 'cat', '{0,1,2}', 8, 90)$q$, sid), 'duplicate_word');
  perform pg_temp.fails(format($q$select public.svc_submit_word('00000000-0000-0000-0000-00000000000a', %L, 'act', '{1,0,2}', 4, 90)$q$, sid), 'not_found');
  v := public.svc_finish_session('00000000-0000-0000-0000-00000000000b', sid);
  perform pg_temp.eq((v -> 'session' ->> 'score')::int, 35, 'final score');
  perform pg_temp.eq(jsonb_array_length(v -> 'session' -> 'awards'), 1, 'awards: complete only (target 40 missed, first game)');
  perform pg_temp.eq((v -> 'balance' ->> 'available')::int, 350, 'balance after game');
  v := public.svc_finish_session('00000000-0000-0000-0000-00000000000b', sid);
  perform pg_temp.eq((v -> 'balance' ->> 'available')::int, 350, 'finish twice pays once');
  perform pg_temp.fails($q$select public.svc_start_session('00000000-0000-0000-0000-00000000000b', ops.london_date())$q$, 'already_played');
  perform pg_temp.fails(format($q$select public.svc_submit_word('00000000-0000-0000-0000-00000000000b', %L, 'act', '{1,0,2}', 4, 90)$q$, sid), 'session_closed');
  -- Referral paid to Alice once Bob finished his first game
  perform pg_temp.eq((loyalty.balance('00000000-0000-0000-0000-00000000000a') ->> 'available')::int, 350, 'referral paid');
  v := public.svc_leaderboard('00000000-0000-0000-0000-00000000000b', ops.london_date());
  perform pg_temp.eq((v -> 'me' ->> 'rank')::int, 1, 'leaderboard rank');
end $$;

\echo time limit and automatic close
do $$
declare v jsonb; sid uuid;
begin
  v := public.svc_start_session('00000000-0000-0000-0000-00000000000a', ops.london_date());
  sid := (v ->> 'session_id')::uuid;
  update game.sessions set started_at = now() - interval '10 minutes', ends_at = now() - interval '5 minutes' where id = sid;
  perform pg_temp.fails(format($q$select public.svc_submit_word('00000000-0000-0000-0000-00000000000a', %L, 'cat', '{0,1,2}', 8, 90)$q$, sid), 'session_closed');
  perform game.close_expired_sessions();
  perform pg_temp.eq((select status from game.sessions where id = sid), 'completed', 'auto-closed');
  perform pg_temp.eq((loyalty.balance('00000000-0000-0000-0000-00000000000a') ->> 'available')::int, 450, 'completion paid on auto-close');
end $$;

\echo daily cap
do $$
begin
  update loyalty.rules set rules = rules || '{"daily_game_cap": 120}';
  insert into game.games (id, rules_version, puzzle, solutions) select ops.london_date() + 1, rules_version, puzzle, solutions from game.games where id = ops.london_date();
  -- A second game finishing the same London day only earns up to the cap
  perform public.svc_start_session('00000000-0000-0000-0000-00000000000e', ops.london_date());
  perform public.svc_finish_session('00000000-0000-0000-0000-00000000000e', (select id from game.sessions where user_id = '00000000-0000-0000-0000-00000000000e'));
  update game.sessions set game_id = ops.london_date() + 1, status = 'active', awards = '[]' where user_id = '00000000-0000-0000-0000-00000000000e';
  delete from game.sessions where user_id = '00000000-0000-0000-0000-00000000000e';
  perform public.svc_start_session('00000000-0000-0000-0000-00000000000e', ops.london_date() + 1);
  perform public.svc_finish_session('00000000-0000-0000-0000-00000000000e', (select id from game.sessions where user_id = '00000000-0000-0000-0000-00000000000e'));
  perform pg_temp.eq((select coalesce(sum(points), 0)::int from loyalty.transactions where user_id = '00000000-0000-0000-0000-00000000000e' and reference_type = 'game'), 120, 'daily cap');
  update loyalty.rules set rules = rules || '{"daily_game_cap": 250}';
end $$;

\echo venue, offers, reservation, validation
do $$
declare v jsonb; mid uuid; oid uuid; rid uuid; rid2 uuid;
begin
  v := public.svc_merchant_register('00000000-0000-0000-0000-00000000000c', '{"name":"Test Café","category":"coffee","description":"","area":"Elephant & Castle","address":"1 Test Street SE1","contact_email":"staff@example.com"}');
  mid := (v -> 'merchant' ->> 'id')::uuid;
  perform pg_temp.fails($q$select public.svc_save_offer('00000000-0000-0000-0000-00000000000c', null, '{"title":"Tea","points_price":300,"quantity_total":2}', true)$q$, 'merchant_not_approved');
  perform pg_temp.fails(format($q$select public.svc_admin_merchant_status('00000000-0000-0000-0000-00000000000c', %L, 'approved', 'self')$q$, mid), 'forbidden');
  perform public.svc_admin_merchant_status('00000000-0000-0000-0000-00000000000d', mid, 'approved', 'ok');
  v := public.svc_save_offer('00000000-0000-0000-0000-00000000000c', null,
    '{"title":"Tea","description":"","category":"coffee","image":"🍵","points_price":300,"quantity_total":2,"max_per_customer":1,"terms":"","days":null}', true);
  oid := (v -> 'offer' ->> 'id')::uuid;
  perform pg_temp.eq((v -> 'offer' ->> 'available')::boolean, true, 'offer live');

  -- Bob reserves (350 available)
  v := public.svc_reserve('00000000-0000-0000-0000-00000000000b', oid, 'client-key-1', 'hash-1');
  rid := (v -> 'redemption' ->> 'id')::uuid;
  perform pg_temp.eq((v -> 'balance' ->> 'held')::int, 300, 'points held');
  -- Retry with the same key returns the same reservation
  v := public.svc_reserve('00000000-0000-0000-0000-00000000000b', oid, 'client-key-1', 'hash-x');
  perform pg_temp.eq((v ->> 'existing')::boolean, true, 'idempotent reserve');
  perform pg_temp.eq((v -> 'redemption' ->> 'id')::uuid, rid, 'same reservation');
  -- Per-customer limit, then insufficient points
  perform pg_temp.fails(format($q$select public.svc_reserve('00000000-0000-0000-0000-00000000000b', %L, 'client-key-2', 'hash-2')$q$, oid), 'limit_reached');
  perform loyalty.post('00000000-0000-0000-0000-00000000000e', 'expire', (loyalty.balance('00000000-0000-0000-0000-00000000000e') ->> 'available')::int - 100, 'test:drain');
  perform pg_temp.fails(format($q$select public.svc_reserve('00000000-0000-0000-0000-00000000000e', %L, 'client-key-3', 'hash-3')$q$, oid), 'insufficient_points');
  -- Alice takes the last unit; then sold out
  v := public.svc_reserve('00000000-0000-0000-0000-00000000000a', oid, 'client-key-4', 'hash-4');
  rid2 := (v -> 'redemption' ->> 'id')::uuid;
  perform public.svc_admin_adjust('00000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-00000000000e', 500, 'test', 'adj-1');
  perform pg_temp.fails(format($q$select public.svc_reserve('00000000-0000-0000-0000-00000000000e', %L, 'client-key-5', 'hash-5')$q$, oid), 'sold_out');
  perform pg_temp.fails(format($q$select public.svc_save_offer('00000000-0000-0000-0000-00000000000c', %L, '{"title":"Tea","points_price":300,"quantity_total":1}', false)$q$, oid), 'inventory_below_claimed');

  -- Validation: wrong venue, check, confirm, twice
  perform public.svc_merchant_register('00000000-0000-0000-0000-00000000000e', '{"name":"Elsewhere","category":"food","description":"","area":"Borough","address":"2 Other Road SE1","contact_email":"o@example.com"}');
  perform pg_temp.fails($q$select public.svc_validate('00000000-0000-0000-0000-00000000000e', 'hash-1', true)$q$, 'invalid_code');
  perform pg_temp.fails($q$select public.svc_validate('00000000-0000-0000-0000-00000000000c', 'hash-nope', true)$q$, 'invalid_code');
  v := public.svc_validate('00000000-0000-0000-0000-00000000000c', 'hash-1', false);
  perform pg_temp.eq(v -> 'redemption' ->> 'player', 'Bob', 'check shows player');
  perform pg_temp.eq((select status from market.redemptions where id = rid), 'reserved', 'check does not redeem');
  v := public.svc_validate('00000000-0000-0000-0000-00000000000c', 'hash-1', true);
  perform pg_temp.eq((v ->> 'redeemed')::boolean, true, 'redeemed');
  perform pg_temp.fails($q$select public.svc_validate('00000000-0000-0000-0000-00000000000c', 'hash-1', true)$q$, 'already_redeemed');
  perform pg_temp.eq(loyalty.balance('00000000-0000-0000-0000-00000000000b'), '{"available":50,"held":0,"total":50,"earned":350,"redeemed":300}'::jsonb, 'bob balance');

  -- Expiry releases Alice's points; validating an expired code reports it
  update market.redemptions set expires_at = now() - interval '1 second' where id = rid2;
  v := public.svc_validate('00000000-0000-0000-0000-00000000000c', 'hash-4', true);
  perform pg_temp.eq(v ->> 'error', 'expired', 'expired code');
  perform pg_temp.eq((select status from market.redemptions where id = rid2), 'expired', 'expired status');
  perform pg_temp.eq((loyalty.balance('00000000-0000-0000-0000-00000000000a') ->> 'held')::int, 0, 'released');

  -- Staff can't adjust balances
  perform pg_temp.fails($q$select public.svc_admin_adjust('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000c', 1000, 'x', 'adj-x')$q$, 'forbidden');

  -- Admin refund of Bob's redemption, once
  perform public.svc_admin_resolve('00000000-0000-0000-0000-00000000000d', rid, 'refund', 'test');
  perform pg_temp.fails(format($q$select public.svc_admin_resolve('00000000-0000-0000-0000-00000000000d', %L, 'refund', 'again')$q$, rid), 'invalid_state');
  perform pg_temp.eq((loyalty.balance('00000000-0000-0000-0000-00000000000b') ->> 'available')::int, 350, 'refunded');

  -- Stats
  v := public.svc_merchant_stats('00000000-0000-0000-0000-00000000000c');
  perform pg_temp.eq((v -> 'verified' ->> 'rewards_claimed')::int, 2, 'claimed');
end $$;

\echo yield
do $$
declare v jsonb; oid uuid; yid uuid;
begin
  oid := (select id from market.offers where title = 'Tea');
  v := public.svc_yield_save_rule('00000000-0000-0000-0000-00000000000c', oid, '{"bands":[{"below":30,"points":300},{"below":50,"points":500}],"capacity":100,"target_utilisation":70,"max_units":10,"auto_apply":false}');
  yid := (v -> 'rule' ->> 'id')::uuid;
  v := public.svc_yield_record('00000000-0000-0000-0000-00000000000c', yid, '{"utilisation":20,"action":"release","points_price":300,"quantity":10,"band":{"below":30,"points":300},"reason":"spare_capacity"}');
  perform pg_temp.eq((v -> 'recommendation' ->> 'applied')::boolean, false, 'not applied without authorisation');
  v := public.svc_yield_apply('00000000-0000-0000-0000-00000000000c', yid);
  perform pg_temp.eq((v -> 'offer' ->> 'remaining')::int, 10, 'released units');
end $$;

\echo admin
do $$
declare v jsonb;
begin
  perform pg_temp.fails($q$select public.svc_admin_overview('00000000-0000-0000-0000-00000000000a')$q$, 'forbidden');
  v := public.svc_admin_overview('00000000-0000-0000-0000-00000000000d');
  perform pg_temp.eq((v -> 'players' ->> 'registered')::int, 5, 'registered');
  perform public.svc_admin_user_status('00000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-00000000000a', 'suspended', 'test');
  perform pg_temp.fails($q$select public.svc_wallet('00000000-0000-0000-0000-00000000000a')$q$, 'account_suspended');
  perform pg_temp.eq((select count(*) from ops.audit_log) > 5, true, 'audit log written');
end $$;

\echo grants
do $$
begin
  perform pg_temp.eq(has_function_privilege('anon', 'public.svc_wallet(uuid)', 'execute'), false, 'anon cannot execute svc');
  perform pg_temp.eq(has_function_privilege('authenticated', 'public.svc_admin_adjust(uuid,uuid,int,text,text)', 'execute'), false, 'authenticated cannot execute svc');
  perform pg_temp.eq(has_function_privilege('service_role', 'public.svc_wallet(uuid)', 'execute'), true, 'service role can');
  perform pg_temp.eq(has_table_privilege('authenticated', 'loyalty.transactions', 'select'), false, 'no table access');
  perform pg_temp.eq(has_schema_privilege('anon', 'loyalty', 'usage'), false, 'no schema access');
end $$;
