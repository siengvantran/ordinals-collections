-- Fixture for the parallel checks in run.sh: a player with exactly 300 WORDS,
-- an offer priced 300 with plenty of stock, and a reservation to validate.
do $$
declare oid uuid;
begin
  insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000f1', 'race@example.com'), ('00000000-0000-0000-0000-0000000000f2', 'race2@example.com');
  perform public.svc_ensure_player('00000000-0000-0000-0000-0000000000f1', 'race@example.com');
  perform public.svc_ensure_player('00000000-0000-0000-0000-0000000000f2', 'race2@example.com');
  update loyalty.rules set rules = rules || '{"welcome_bonus": 300}';
  perform public.svc_save_profile('00000000-0000-0000-0000-0000000000f1', 'Racer', null, 't1');
  perform public.svc_save_profile('00000000-0000-0000-0000-0000000000f2', 'Racer2', null, 't1');
  update identity.players set status = 'active';
  select id into oid from market.offers where title = 'Tea';
  update market.offers set quantity_total = 100, max_per_customer = null, points_price = 300 where id = oid;
  perform public.svc_reserve('00000000-0000-0000-0000-0000000000f2', oid, 'race-validate', 'hash-race');
end $$;
