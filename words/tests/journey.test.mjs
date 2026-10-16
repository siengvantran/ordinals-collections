// End-to-end journeys through the preview server: the same API contract the
// Edge Function implements (docs/API.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testServer, newPlayer } from './helpers.mjs';

async function playToday(call, auth, { words = 12 } = {}) {
  const today = await call('GET', '/game/today', null, auth);
  const start = await call('POST', '/game/start', {}, auth);
  assert.equal(start.status, 200, JSON.stringify(start.body));
  return { today: today.body, session: start.body };
}

/** Submit the first n solutions, using the server's own solution list (test access). */
async function submitSome(server, call, auth, sessionId, n) {
  const def = server.state.games[server.state.sessions[sessionId].game_id];
  const out = [];
  for (const s of def.solutions.slice(0, n)) out.push(await call('POST', '/game/word', { session_id: sessionId, path: s.path }, auth));
  return out;
}

test('critical journey: play, earn, discover, reserve, redeem at the venue', async () => {
  const { server, call } = testServer({ at: '2026-11-02T12:00:00Z' }); // Monday noon
  const alice = await newPlayer(call, 'alice@example.com', 'Alice');

  // Welcome bonus makes a first reward reachable on day one.
  let me = (await call('GET', '/me', null, alice)).body;
  assert.equal(me.balance.available, 250);

  // Play
  const { session } = await playToday(call, alice);
  const results = await submitSome(server, call, alice, session.session_id, 10);
  assert.ok(results.every((r) => r.status === 200));
  const finish = await call('POST', '/game/finish', { session_id: session.session_id }, alice);
  assert.equal(finish.status, 200);
  assert.equal(finish.body.session.status, 'completed');
  assert.ok(finish.body.session.awards.some((a) => a.kind === 'complete_daily' && a.points === 100));
  me = (await call('GET', '/me', null, alice)).body;
  const earned = finish.body.session.awards.reduce((a, x) => a + x.points, 0);
  assert.equal(me.balance.available, 250 + earned);

  // Discover
  const offers = (await call('GET', '/offers', null, alice)).body.offers;
  const coffee = offers.find((o) => o.title === 'Welcome coffee');
  assert.ok(coffee.available);

  // Reserve
  const res = await call('POST', '/redemptions', { offer_id: coffee.id, idempotency_key: 'reserve-key-1' }, alice);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { redemption } = res.body;
  assert.match(redemption.code, /^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
  assert.equal(res.body.balance.held, 300);
  assert.equal(res.body.balance.available, 250 + earned - 300);

  // Validate at the venue: check, then confirm
  const staff = await newPlayer(call, 'barista@example.com', 'Barista');
  await call('POST', '/preview/join-merchant', { merchant_id: coffee.merchant.id }, staff);
  const check = await call('POST', '/merchant/validate', { code: redemption.qr_payload }, staff);
  assert.equal(check.status, 200);
  assert.equal(check.body.redeemed, undefined);
  assert.equal(check.body.redemption.player, 'Alice');
  const confirm = await call('POST', '/merchant/validate', { code: redemption.code, confirm: true }, staff);
  assert.equal(confirm.body.redeemed, true);

  // Points are gone for good; the code can't be used twice
  me = (await call('GET', '/me', null, alice)).body;
  assert.deepEqual([me.balance.held, me.balance.available, me.balance.redeemed], [0, 250 + earned - 300, 300]);
  const twice = await call('POST', '/merchant/validate', { code: redemption.code, confirm: true }, staff);
  assert.equal(twice.status, 409);
  assert.equal(twice.body.error, 'already_redeemed');

  // Wallet shows every step
  const wallet = (await call('GET', '/wallet', null, alice)).body;
  assert.deepEqual(wallet.transactions.map((t) => t.type).slice(0, 2), ['redeem', 'reserve']);

  // Merchant stats count it as verified
  const stats = (await call('GET', '/merchant/stats', null, staff)).body;
  assert.equal(stats.verified.rewards_redeemed, 1);
});

test('a completed challenge earns exactly once and cannot be replayed', async () => {
  const { server, call } = testServer();
  const bob = await newPlayer(call, 'bob@example.com', 'Bob');
  const { session } = await playToday(call, bob);
  await submitSome(server, call, bob, session.session_id, 5);
  const f1 = await call('POST', '/game/finish', { session_id: session.session_id }, bob);
  const f2 = await call('POST', '/game/finish', { session_id: session.session_id }, bob);
  assert.deepEqual(f1.body.balance, f2.body.balance);
  const again = await call('POST', '/game/start', {}, bob);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'already_played');
  const late = await call('POST', '/game/word', { session_id: session.session_id, path: [0, 1, 2] }, bob);
  assert.equal(late.body.error, 'session_closed');
  const earns = server.ledger.forUser(bob.user_id).filter((t) => t.reference_type === 'game');
  assert.equal(new Set(earns.map((t) => t.idempotency_key)).size, earns.length);
});

test('word submissions are validated on the server', async () => {
  const { server, call } = testServer();
  const cara = await newPlayer(call, 'cara@example.com', 'Cara');
  const { session } = await playToday(call, cara);
  const def = server.state.games[server.state.sessions[session.session_id].game_id];
  const sol = def.solutions[0];
  assert.equal((await call('POST', '/game/word', { session_id: session.session_id, path: sol.path }, cara)).status, 200);
  assert.equal((await call('POST', '/game/word', { session_id: session.session_id, path: sol.path }, cara)).body.error, 'duplicate_word');
  assert.equal((await call('POST', '/game/word', { session_id: session.session_id, path: [0, 2, 3] }, cara)).body.error, 'invalid_path');
  assert.equal((await call('POST', '/game/word', { session_id: session.session_id, path: [0, 1] }, cara)).body.error, 'too_short');
  // A path through tiles that does not spell a listed word
  const index = new Set(def.solutions.map((s) => s.word));
  const path = [0, 1, 2, 3].filter((_, i) => i < 3);
  const spelled = path.map((i) => (def.tiles[i] === 'q' ? 'qu' : def.tiles[i])).join('');
  if (!index.has(spelled)) assert.equal((await call('POST', '/game/word', { session_id: session.session_id, path }, cara)).body.error, 'not_a_word');
  // Someone else's session
  const dan = await newPlayer(call, 'dan@example.com', 'Dan');
  assert.equal((await call('POST', '/game/word', { session_id: session.session_id, path: sol.path }, dan)).status, 404);
});

test('time limit: words after time-up plus grace are refused, and the game closes itself', async () => {
  const { server, call, advance } = testServer();
  const eve = await newPlayer(call, 'eve@example.com', 'Eve');
  const { session } = await playToday(call, eve);
  const def = server.state.games[server.state.sessions[session.session_id].game_id];
  advance(300 + 60); // inside the grace period (offline sync)
  assert.equal((await call('POST', '/game/word', { session_id: session.session_id, path: def.solutions[0].path }, eve)).status, 200);
  advance(60); // now past grace
  const late = await call('POST', '/game/word', { session_id: session.session_id, path: def.solutions[1].path }, eve);
  assert.equal(late.body.error, 'session_closed');
  const today = (await call('GET', '/game/today', null, eve)).body;
  assert.equal(today.session.status, 'completed');
  assert.ok(today.reveal.theme_word);
  assert.equal(server.ledger.balance(eve.user_id).available, 250 + 100);
});

test('daily cap and personal best across days', async () => {
  const { server, call, advance } = testServer({ at: '2026-11-02T09:00:00Z' });
  const fay = await newPlayer(call, 'fay@example.com', 'Fay');
  await call('POST', '/admin/rules', {}, fay).then((r) => assert.equal(r.status, 403));
  // Day 1: low score
  let { session } = await playToday(call, fay);
  await submitSome(server, call, fay, session.session_id, 2);
  let f = await call('POST', '/game/finish', { session_id: session.session_id }, fay);
  assert.ok(!f.body.session.awards.some((a) => a.kind === 'personal_best'));
  // Day 2: higher score is a personal best
  advance(86400);
  ({ session } = await playToday(call, fay));
  await submitSome(server, call, fay, session.session_id, 40);
  f = await call('POST', '/game/finish', { session_id: session.session_id }, fay);
  assert.ok(f.body.session.awards.some((a) => a.kind === 'personal_best'));
  // Cap: lower it and play day 3
  await call('POST', '/preview/become-admin', {}, fay);
  assert.equal((await call('POST', '/admin/rules', { rules: { daily_game_cap: 110 } }, fay)).status, 200);
  advance(86400);
  ({ session } = await playToday(call, fay));
  await submitSome(server, call, fay, session.session_id, 60);
  f = await call('POST', '/game/finish', { session_id: session.session_id }, fay);
  assert.equal(f.body.session.awards.reduce((a, x) => a + x.points, 0), 110);
});

test('referral pays only after the friend completes a challenge, once', async () => {
  const { server, call } = testServer();
  const gus = await newPlayer(call, 'gus@example.com', 'Gus');
  const code = (await call('GET', '/me', null, gus)).body.referral_code;
  const hal = await newPlayer(call, 'hal@example.com', 'Hal', code);
  assert.equal(server.ledger.balance(gus.user_id).available, 250);
  const { session } = await playToday(call, hal);
  await call('POST', '/game/finish', { session_id: session.session_id }, hal);
  assert.equal(server.ledger.balance(gus.user_id).available, 350);
  // Self-referral does nothing
  const ivy = await newPlayer(call, 'ivy@example.com', 'Ivy', 'NOPE12');
  assert.equal(server.state.users[ivy.user_id].referred_by, null);
});

test('reservations: insufficient points, idempotent retries, stock and expiry release', async () => {
  const { server, call, advance } = testServer({ at: '2026-11-02T12:00:00Z' });
  server.state.rules.welcome_bonus = 400;
  const jo = await newPlayer(call, 'jo@example.com', 'Jo');
  const offers = (await call('GET', '/offers', null, jo)).body.offers;
  const theatre = offers.find((o) => o.points_price === 1200);
  assert.equal((await call('POST', '/redemptions', { offer_id: theatre.id, idempotency_key: 'k-theatre-1' }, jo)).body.error, 'insufficient_points');

  const pastry = offers.find((o) => o.title === 'Pastry upgrade');
  const r1 = await call('POST', '/redemptions', { offer_id: pastry.id, idempotency_key: 'k-pastry-1' }, jo);
  const r2 = await call('POST', '/redemptions', { offer_id: pastry.id, idempotency_key: 'k-pastry-1' }, jo);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 200);
  assert.equal(r1.body.redemption.id, r2.body.redemption.id);
  assert.notEqual(r1.body.redemption.code, r2.body.redemption.code); // re-issued; old code dead
  assert.equal(server.ledger.balance(jo.user_id).held, 300);

  const staff = await newPlayer(call, 'staff@example.com', 'Staff');
  await call('POST', '/preview/join-merchant', { merchant_id: pastry.merchant.id }, staff);
  assert.equal((await call('POST', '/merchant/validate', { code: r1.body.redemption.code }, staff)).body.error, 'invalid_code');

  advance(31 * 60);
  const mine = (await call('GET', '/redemptions', null, jo)).body.redemptions;
  assert.equal(mine[0].status, 'expired');
  assert.deepEqual([server.ledger.balance(jo.user_id).available, server.ledger.balance(jo.user_id).held], [400, 0]);
  assert.equal((await call('POST', '/merchant/validate', { code: r2.body.redemption.code }, staff)).body.error, 'expired');
});

test('inventory: no overbooking when stock runs out', async () => {
  const { server, call } = testServer({ at: '2026-11-02T12:00:00Z' });
  const owner = await newPlayer(call, 'owner@example.com', 'Owner');
  const pastry = Object.values(server.state.offers).find((o) => o.title === 'Pastry upgrade');
  await call('POST', '/preview/join-merchant', { merchant_id: pastry.merchant_id }, owner);
  const created = await call('POST', '/merchant/offers', { title: 'Last two croissants', points_price: 100, quantity_total: 2, status: 'active' }, owner);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const offerId = created.body.offer.id;
  const results = [];
  for (let i = 0; i < 4; i++) {
    const p = await newPlayer(call, `p${i}@example.com`, `Player ${i}`);
    results.push(await call('POST', '/redemptions', { offer_id: offerId, idempotency_key: `k-crois-${i}` }, p));
  }
  assert.deepEqual(results.map((r) => r.status), [201, 201, 409, 409]);
  assert.equal(results[2].body.error, 'sold_out');
  const lower = await call('POST', '/merchant/offers', { id: offerId, title: 'Last two croissants', points_price: 100, quantity_total: 1 }, owner);
  assert.equal(lower.body.error, 'inventory_below_claimed');
});

test('codes only validate at their own venue; staff cannot touch balances', async () => {
  const { server, call } = testServer({ at: '2026-11-02T12:00:00Z' });
  server.state.rules.welcome_bonus = 400;
  const kim = await newPlayer(call, 'kim@example.com', 'Kim');
  const pastry = Object.values(server.state.offers).find((o) => o.title === 'Pastry upgrade');
  const res = await call('POST', '/redemptions', { offer_id: pastry.id, idempotency_key: 'k-kim-0001' }, kim);
  const other = Object.values(server.state.merchants).find((m) => m.id !== pastry.merchant_id);
  const staff = await newPlayer(call, 'other@example.com', 'Other');
  await call('POST', '/preview/join-merchant', { merchant_id: other.id }, staff);
  assert.equal((await call('POST', '/merchant/validate', { code: res.body.redemption.code, confirm: true }, staff)).body.error, 'invalid_code');
  assert.equal((await call('POST', '/admin/adjust', { user_id: staff.user_id, points: 1000, reason: 'free', idempotency_key: 'kkkkkkkk' }, staff)).status, 403);
});

test('admin: approve merchants, adjust, resolve redemptions, suspend accounts', async () => {
  const { server, call } = testServer({ at: '2026-11-02T12:00:00Z' });
  server.state.rules.welcome_bonus = 400;
  const admin = await newPlayer(call, 'admin@example.com', 'Admin');
  await call('POST', '/preview/become-admin', {}, admin);
  const venue = await newPlayer(call, 'venue@example.com', 'Venue');
  const reg = await call('POST', '/merchant/register', { name: 'Test Café', address: '1 Test Street, London SE1', category: 'coffee' }, venue);
  assert.equal(reg.status, 201);
  const mid = reg.body.merchant.id;
  assert.equal((await call('POST', '/merchant/offers', { title: 'Tea', points_price: 100, quantity_total: 5 }, venue)).body.error, 'merchant_not_approved');
  await call('POST', '/admin/merchants/' + mid + '/status', { status: 'approved' }, admin);
  assert.equal((await call('POST', '/merchant/offers', { title: 'Tea', points_price: 100, quantity_total: 5, status: 'active' }, venue)).status, 201);

  const lee = await newPlayer(call, 'lee@example.com', 'Lee');
  const adj = await call('POST', '/admin/adjust', { user_id: lee.user_id, points: 50, reason: 'Goodwill', idempotency_key: 'adj-lee-1' }, admin);
  assert.equal(adj.body.balance.available, 450);
  await call('POST', '/admin/adjust', { user_id: lee.user_id, points: 50, reason: 'Goodwill', idempotency_key: 'adj-lee-1' }, admin);
  assert.equal(server.ledger.balance(lee.user_id).available, 450);

  const pastry = Object.values(server.state.offers).find((o) => o.title === 'Pastry upgrade');
  const r = (await call('POST', '/redemptions', { offer_id: pastry.id, idempotency_key: 'k-lee-0001' }, lee)).body.redemption;
  // Venue honoured it but the network was down: admin completes it
  assert.equal((await call('POST', `/admin/redemptions/${r.id}/resolve`, { action: 'complete', reason: 'Validated by phone' }, admin)).status, 200);
  assert.equal(server.ledger.balance(lee.user_id).redeemed, 300);
  // Then refunds it
  await call('POST', `/admin/redemptions/${r.id}/resolve`, { action: 'refund', reason: 'Item unavailable' }, admin);
  assert.equal(server.ledger.balance(lee.user_id).available, 450);
  assert.equal((await call('POST', `/admin/redemptions/${r.id}/resolve`, { action: 'refund', reason: 'again' }, admin)).status, 409);

  await call('POST', `/admin/users/${lee.user_id}/status`, { status: 'suspended', reason: 'Bot activity' }, admin);
  assert.equal((await call('POST', '/game/start', {}, lee)).body.error, 'account_suspended');
  const overview = (await call('GET', '/admin/overview', null, admin)).body;
  assert.equal(overview.players.suspended, 1);
  assert.ok(overview.points.outstanding > 0);
  assert.ok((await call('GET', '/admin/audit', null, admin)).body.entries.length >= 4);
});

test('yield: recommend, apply with authorisation, auto-apply only when switched on', async () => {
  const { server, call } = testServer({ at: '2026-11-02T12:00:00Z' });
  const owner = await newPlayer(call, 'jazz@example.com', 'Jazz');
  const jazz = Object.values(server.state.offers).find((o) => o.category === 'music');
  await call('POST', '/preview/join-merchant', { merchant_id: jazz.merchant_id }, owner);
  const rule = (await call('POST', '/merchant/yield/rules', { offer_id: jazz.id, capacity: 120, target_utilisation: 70, max_units: 30 }, owner)).body.rule;
  const rec = (await call('POST', '/merchant/yield/recommend', { rule_id: rule.id, utilisation: 25 }, owner)).body;
  assert.equal(rec.recommendation.action, 'release');
  assert.equal(rec.recommendation.points_price, 300);
  assert.equal(rec.recommendation.applied, false);
  assert.equal(server.state.offers[jazz.id].points_price, 600); // unchanged until applied
  const applied = (await call('POST', '/merchant/yield/apply', { rule_id: rule.id }, owner)).body;
  assert.equal(applied.offer.points_price, 300);
  assert.equal(applied.offer.remaining, 30);
  await call('POST', '/merchant/yield/rules', { offer_id: jazz.id, capacity: 120, target_utilisation: 70, max_units: 30, auto_apply: true }, owner);
  const auto = (await call('POST', '/merchant/yield/recommend', { rule_id: rule.id, utilisation: 40 }, owner)).body;
  assert.equal(auto.recommendation.applied, true);
  assert.equal(auto.offer.points_price, 500);
});

test('state survives a reload from storage', async () => {
  const { call, saved } = testServer();
  const auth = await newPlayer(call, 'mo@example.com', 'Mo');
  const { LocalServer } = await import('../js/server/local-server.js');
  const { dictionary } = await import('./helpers.mjs');
  const snapshot = saved();
  const reloaded = new LocalServer({ loadWords: async () => dictionary(), store: { load: () => snapshot, save() {} }, now: () => new Date('2026-11-02T12:00:00Z') });
  const me = await reloaded.handle('GET', '/me', null, auth);
  assert.equal(me.body.balance.available, 250);
});
