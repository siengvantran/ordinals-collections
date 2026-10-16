import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictionary } from './helpers.mjs';
import { isValidPath, isAdjacent, wordFromPath, neighbours } from '../js/core/grid.js';
import { solve, hasWord, hasPrefix } from '../js/core/solver.js';
import { wordScore, baseWordScore, gameScore, LETTER_VALUES, THEME_WORD_BONUS } from '../js/core/scoring.js';
import { generateChallenge, publicChallenge, checkSolvable, THEME_WORDS, targetScore } from '../js/core/challenge.js';
import { gameAwards, DEFAULT_RULES, applyRulesPatch } from '../js/core/rules.js';
import { MemoryLedger, effects, balances } from '../js/core/ledger.js';
import { generateCode, normaliseCode, formatCode, offerAvailability, inDailyWindow, reservationExpiry, londonParts, CODE_ALPHABET } from '../js/core/redemption.js';
import { recommend, validateRule, DEFAULT_BANDS } from '../js/core/yield.js';

test('grid adjacency covers diagonals and edges', () => {
  assert.deepEqual(neighbours(0).sort((a, b) => a - b), [1, 4, 5]);
  assert.equal(neighbours(5).length, 8);
  assert.ok(isAdjacent(0, 5));
  assert.ok(!isAdjacent(3, 4)); // row wrap is not adjacent
});

test('path validation rejects repeats, gaps and junk', () => {
  assert.ok(isValidPath([0, 1, 2, 6]));
  assert.ok(!isValidPath([0, 1, 0]));
  assert.ok(!isValidPath([0, 2]));
  assert.ok(!isValidPath([0, 1.5]));
  assert.ok(!isValidPath([-1, 0]));
  assert.ok(!isValidPath([]));
  assert.ok(!isValidPath('0,1,2'));
});

test('q tiles read as qu', () => {
  const tiles = 'quitxxxxxxxxxxxx'.split('');
  assert.equal(wordFromPath(tiles, [0, 1, 2, 3]), 'quuit');
  tiles[1] = 'i'; tiles[2] = 't';
  assert.equal(wordFromPath(tiles, [0, 1, 2]), 'quit');
});

test('dictionary is sorted, filtered and blocks offensive words', () => {
  const words = dictionary();
  assert.ok(words.length > 100000);
  for (let i = 1; i < 2000; i++) assert.ok(words[i - 1] < words[i]);
  assert.ok(hasWord(words, 'coffee'));
  assert.ok(!hasWord(words, 'ab'));
  assert.ok(hasPrefix(words, 'coff'));
  for (const w of ['shit', 'shits', 'fucking', 'cunt']) assert.ok(!hasWord(words, w), w);
});

test('scoring is deterministic and uses WORDS tiers', () => {
  assert.equal(LETTER_VALUES.e, 1);
  assert.equal(LETTER_VALUES.z, 5);
  assert.equal(baseWordScore('cat'), 2 + 1 + 1);          // c2 a1 t1, length 3 bonus 0
  assert.equal(baseWordScore('coffee'), 2 + 1 + 3 + 3 + 1 + 1 + 6);
  assert.equal(wordScore('cat', true), 8);
  assert.equal(gameScore([{ word: 'cat', score: 4 }, { word: 'theatre', score: 20 }], 'theatre'), 24 + THEME_WORD_BONUS);
});

test('solver finds every word along valid paths', () => {
  const tiles = 'catsxxxxxxxxxxxx'.split('');
  const found = solve(tiles, dictionary());
  const words = found.map((f) => f.word);
  assert.ok(words.includes('cat') && words.includes('cats') && words.includes('act') === false);
  for (const f of found) {
    assert.ok(isValidPath(f.path));
    assert.equal(wordFromPath(tiles, f.path), f.word);
  }
});

test('challenge generation is reproducible and solvable', () => {
  const words = dictionary();
  const a = generateChallenge({ date: '2026-11-20', words, salt: 's' });
  const b = generateChallenge({ date: '2026-11-20', words, salt: 's' });
  const c = generateChallenge({ date: '2026-11-20', words, salt: 'other' });
  assert.deepEqual(a.tiles, b.tiles);
  assert.notDeepEqual(a.tiles, c.tiles);
  assert.ok(a.word_count >= 40 && a.word_count <= 400);
  assert.ok(a.solutions.some((s) => s.word === a.theme_word));
  assert.equal(checkSolvable(a.tiles, a.star, words, { themeWord: a.theme_word }).ok, true);
  for (const s of a.solutions) {
    assert.equal(wordFromPath(a.tiles, s.path), s.word);
    assert.equal(s.score, wordScore(s.word, s.path.includes(a.star)));
  }
  const pub = publicChallenge(a);
  assert.equal(pub.solutions, undefined);
  assert.equal(pub.theme_word, undefined);
  assert.equal(pub.theme_length, a.theme_word.length);
});

test('every built-in theme word is usable and a chosen theme word is placed', () => {
  const words = dictionary();
  for (const w of THEME_WORDS) assert.ok(hasWord(words, w) && w.length >= 6 && w.length <= 8 && !w.includes('q'), w);
  const ch = generateChallenge({ date: '2026-12-01', words, themeWord: 'elephant' });
  assert.equal(ch.theme_word, 'elephant');
  assert.throws(() => generateChallenge({ date: '2026-12-01', words, themeWord: 'zzzzzzz' }));
});

test('a year of daily challenges all generate', () => {
  const words = dictionary();
  const d = new Date('2027-01-01T00:00:00Z');
  for (let i = 0; i < 365; i++) {
    const date = new Date(d.getTime() + i * 86400000).toISOString().slice(0, 10);
    const ch = generateChallenge({ date, words, salt: 'year' });
    assert.ok(ch.target_score >= 40 && ch.target_score <= 150);
  }
  assert.equal(targetScore(10), 40);
  assert.equal(targetScore(100000), 150);
});

test('game awards respect target, personal best and the daily cap', () => {
  const r = DEFAULT_RULES;
  assert.deepEqual(gameAwards(r, { score: 10, target: 50, previousBest: null }), [{ kind: 'complete_daily', points: 100 }]);
  assert.deepEqual(gameAwards(r, { score: 60, target: 50, previousBest: 40 }).map((a) => a.kind), ['complete_daily', 'target_score', 'personal_best']);
  assert.deepEqual(gameAwards(r, { score: 60, target: 50, previousBest: 60 }).map((a) => a.kind), ['complete_daily', 'target_score']);
  assert.deepEqual(gameAwards(r, { score: 60, target: 50, previousBest: 40, earnedToday: 220 }), [{ kind: 'complete_daily', points: 30 }]);
  assert.deepEqual(gameAwards(r, { score: 60, target: 50, previousBest: 40, earnedToday: 250 }), []);
  assert.throws(() => applyRulesPatch(r, { complete_daily: -1 }));
  assert.throws(() => applyRulesPatch(r, { free_money: 10 }));
  assert.equal(applyRulesPatch(r, { complete_daily: 120 }).complete_daily, 120);
});

test('ledger: effects, balances, idempotency and no negative balances', () => {
  assert.deepEqual(effects('reserve', 300), { amount: -300, held_delta: 300 });
  assert.deepEqual(effects('redeem', 300), { amount: 0, held_delta: -300 });
  assert.throws(() => effects('earn', -5));
  assert.throws(() => effects('earn', 1.5));
  const l = new MemoryLedger();
  l.post({ user_id: 'u', type: 'earn', points: 350, idempotency_key: 'k1' });
  const again = l.post({ user_id: 'u', type: 'earn', points: 350, idempotency_key: 'k1' });
  assert.equal(again.duplicate, true);
  assert.equal(l.balance('u').available, 350);
  assert.throws(() => l.post({ user_id: 'u', type: 'earn', points: 999, idempotency_key: 'k1' }), /idempotency_conflict/);
  l.post({ user_id: 'u', type: 'reserve', points: 300, idempotency_key: 'r1' });
  assert.deepEqual([l.balance('u').available, l.balance('u').held], [50, 300]);
  assert.throws(() => l.post({ user_id: 'u', type: 'reserve', points: 300, idempotency_key: 'r2' }), /insufficient_points/);
  l.post({ user_id: 'u', type: 'redeem', points: 300, idempotency_key: 'd1' });
  assert.throws(() => l.post({ user_id: 'u', type: 'redeem', points: 300, idempotency_key: 'd2' }), /insufficient_held/);
  assert.throws(() => l.post({ user_id: 'u', type: 'adjust', points: -51, idempotency_key: 'a1' }), /insufficient_points/);
  const b = balances(l.forUser('u'));
  assert.deepEqual(b, { available: 50, held: 0, total: 50, earned: 350, redeemed: 300 });
  assert.throws(() => l.post({ user_id: 'u', type: 'earn', points: 1 }), /idempotency_key_required/);
});

test('redemption codes are well-formed and normalise from any form', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const c = generateCode();
    assert.equal(c.length, 10);
    for (const ch of c) assert.ok(CODE_ALPHABET.includes(ch));
    seen.add(c);
    assert.equal(normaliseCode(formatCode(c).toLowerCase()), c);
    assert.equal(normaliseCode(`WRD1-${c}`), c);
    assert.equal(normaliseCode(`https://example.com/words/merchant/#/validate?code=${formatCode(c)}`), c);
  }
  assert.equal(seen.size, 500);
  assert.equal(normaliseCode('ABC'), null);
  assert.equal(normaliseCode('OOOOO-11111'), null);
  assert.equal(normaliseCode(null), null);
});

test('offer availability: status, dates, windows, stock and per-customer limits', () => {
  const at = new Date('2026-11-02T15:00:00Z'); // Monday 3 pm London (GMT)
  assert.equal(londonParts(at).dow, 1);
  const o = { status: 'active', quantity_total: 2, max_per_customer: 1, window_start: '14:00', window_end: '17:00', days: [1, 2, 3, 4, 5] };
  assert.equal(offerAvailability(o, { at }).ok, true);
  assert.equal(offerAvailability(o, { at, reserved: 1, redeemed: 1 }).reason, 'sold_out');
  assert.equal(offerAvailability(o, { at, userCount: 1 }).reason, 'limit_reached');
  assert.equal(offerAvailability({ ...o, status: 'paused' }, { at }).reason, 'offer_not_active');
  assert.equal(offerAvailability(o, { at, merchantStatus: 'suspended' }).reason, 'merchant_unavailable');
  assert.equal(offerAvailability(o, { at: new Date('2026-11-02T18:00:00Z') }).reason, 'outside_window');
  assert.equal(offerAvailability(o, { at: new Date('2026-11-07T15:00:00Z') }).reason, 'outside_window'); // Saturday
  assert.equal(offerAvailability({ ...o, valid_until: '2026-11-02T14:00:00Z' }, { at }).reason, 'ended');
  assert.equal(offerAvailability({ ...o, valid_from: '2026-11-03T00:00:00Z' }, { at }).reason, 'not_started');
  // Overnight window and British Summer Time
  assert.ok(inDailyWindow({ window_start: '22:00', window_end: '02:00' }, new Date('2026-11-02T23:30:00Z')));
  assert.ok(!inDailyWindow({ window_start: '14:00', window_end: '17:00' }, new Date('2026-07-01T16:30:00Z'))); // 17:30 BST
  // Expiry never passes the offer's end
  const exp = reservationExpiry({ hold_minutes: 480, valid_until: '2026-11-02T20:00:00Z' }, at);
  assert.equal(exp.toISOString(), '2026-11-02T20:00:00.000Z');
  assert.equal(reservationExpiry({}, at, 30).toISOString(), '2026-11-02T15:30:00.000Z');
});

test('yield engine recommends by band and never above the target', () => {
  const rule = { bands: DEFAULT_BANDS, capacity: 100, target_utilisation: 70, max_units: 20 };
  assert.deepEqual(validateRule(rule), []);
  assert.deepEqual(recommend(rule, 20), { action: 'release', points_price: 300, quantity: 20, band: DEFAULT_BANDS[0], reason: 'spare_capacity' });
  assert.equal(recommend(rule, 45).points_price, 500);
  assert.equal(recommend(rule, 65).quantity, 5);
  assert.equal(recommend(rule, 70).action, 'hold');
  assert.equal(recommend({ ...rule, target_utilisation: 60 }, 65).reason, 'at_target');
  assert.ok(validateRule({ ...rule, bands: [{ below: 50, points: 1 }, { below: 40, points: 2 }] }).length);
  assert.throws(() => recommend(rule, 120));
});
