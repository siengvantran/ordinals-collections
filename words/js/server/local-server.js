// Preview backend. Implements the words-api contract (docs/API.md) in the
// browser, on top of the shared core rules, with state kept in one JSON
// document. It lets the whole journey (play, earn, reserve, validate) run
// before Supabase is connected, and it is the reference the Node tests drive.
//
// It is NOT a security boundary: anything in the browser can be changed by
// the person using it. Production uses the Edge Function and SQL functions in
// ../../supabase, which enforce the same rules on the server.
import { ApiError } from '../core/errors.js';
import { isValidPath, wordFromPath } from '../core/grid.js';
import { wordScore, gameScore, MIN_WORD } from '../core/scoring.js';
import { generateChallenge, publicChallenge, solutionIndex, THEME_WORDS } from '../core/challenge.js';
import { hasWord } from '../core/solver.js';
import { DEFAULT_RULES, applyRulesPatch, gameAwards, keys } from '../core/rules.js';
import { MemoryLedger, LedgerError, balances } from '../core/ledger.js';
import {
  generateCode, formatCode, normaliseCode, sha256Hex, londonParts, londonDate,
  offerAvailability, reservationExpiry
} from '../core/redemption.js';
import { DEFAULT_BANDS, validateRule, recommend } from '../core/yield.js';
import { seedState } from './seed.js';
import {
  CATEGORIES, OFFER_STATUSES, bad, str, int, email, displayName, referralCode, merchantInput, offerInput
} from '../core/validate.js';

export const STATE_VERSION = 1;
const SUBMIT_GRACE_S = 90; // words that reach the server this long after time-up still count
const notFound = () => new ApiError(404, 'not_found');

export class LocalServer {
  /**
   * @param {object} opts
   * @param {() => Promise<string[]>} opts.loadWords  sorted dictionary
   * @param {{load(): object|null, save(state: object): void}} opts.store
   * @param {() => Date} [opts.now]
   * @param {boolean} [opts.seed]  add the demo merchants and offers to a new state
   */
  constructor({ loadWords, store, now = () => new Date(), seed = true }) {
    this.loadWords = loadWords;
    this.store = store;
    this.now = now;
    const saved = store.load();
    this.state = saved && saved.version === STATE_VERSION ? saved : this.freshState(seed);
    this.ledger = new MemoryLedger(this.state.ledger, { now: this.now });
    this.words = null;
    this.routes = this.buildRoutes();
  }

  freshState(seed) {
    const state = {
      version: STATE_VERSION,
      salt: Math.random().toString(36).slice(2),
      rules: { ...DEFAULT_RULES },
      users: {}, admins: [], games: {}, sessions: {}, submissions: [], ledger: [],
      merchants: {}, members: [], offers: {}, redemptions: {}, yield_rules: {},
      audit: [], fraud: [], events: []
    };
    if (seed) seedState(state, this.now());
    return state;
  }

  save() {
    this.store.save(this.state);
  }

  /** Pick up changes another tab saved (player and venue screens open side by side). */
  reload() {
    const saved = this.store.load();
    if (saved && saved.version === STATE_VERSION) {
      this.state = saved;
      this.ledger = new MemoryLedger(this.state.ledger, { now: this.now });
    }
  }

  id() {
    return crypto.randomUUID();
  }

  audit(actor, action, target, details = {}) {
    this.state.audit.push({ id: this.id(), actor, action, target, details, at: this.now().toISOString() });
  }

  async dictionary() {
    this.words ??= await this.loadWords();
    return this.words;
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  buildRoutes() {
    const r = [];
    const add = (method, pattern, fn, access = 'player') => {
      const names = [];
      const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)')) + '$');
      r.push({ method, re, names, fn: fn.bind(this), access });
    };
    // Players
    add('POST', '/auth/preview-sign-in', this.previewSignIn, 'public');
    add('GET', '/me', this.getMe, 'signed_in');
    add('POST', '/profile', this.saveProfile, 'signed_in');
    add('GET', '/game/today', this.getToday, 'public');
    add('POST', '/game/start', this.startGame);
    add('POST', '/game/word', this.submitWord);
    add('POST', '/game/finish', this.finishGame);
    add('GET', '/game/leaderboard', this.leaderboard, 'public');
    add('POST', '/game/explain', this.explain, 'public');
    add('GET', '/wallet', this.wallet);
    add('GET', '/offers', this.listOffers, 'public');
    add('GET', '/offers/:id', this.getOffer, 'public');
    add('POST', '/redemptions', this.reserve);
    add('GET', '/redemptions', this.myRedemptions);
    add('POST', '/redemptions/:id/code', this.reissueCode);
    add('POST', '/redemptions/:id/cancel', this.cancelReservation);
    // Merchants
    add('POST', '/merchant/register', this.registerMerchant, 'signed_in');
    add('GET', '/merchant/me', this.merchantMe, 'signed_in');
    add('POST', '/merchant/offers', this.saveOffer, 'merchant');
    add('POST', '/merchant/offers/:id/status', this.setOfferStatus, 'merchant');
    add('POST', '/merchant/validate', this.validateCode, 'merchant');
    add('GET', '/merchant/redemptions', this.merchantRedemptions, 'merchant');
    add('POST', '/merchant/redemptions/:id/spend', this.reportSpend, 'merchant');
    add('GET', '/merchant/stats', this.merchantStats, 'merchant');
    add('GET', '/merchant/yield', this.getYield, 'merchant');
    add('POST', '/merchant/yield/rules', this.saveYieldRule, 'merchant');
    add('POST', '/merchant/yield/recommend', this.yieldRecommend, 'merchant');
    add('POST', '/merchant/yield/apply', this.yieldApply, 'merchant');
    // Admin
    add('GET', '/admin/overview', this.adminOverview, 'admin');
    add('GET', '/admin/merchants', this.adminMerchants, 'admin');
    add('POST', '/admin/merchants/:id/status', this.adminMerchantStatus, 'admin');
    add('GET', '/admin/users', this.adminUsers, 'admin');
    add('POST', '/admin/users/:id/status', this.adminUserStatus, 'admin');
    add('GET', '/admin/users/:id/transactions', this.adminUserTransactions, 'admin');
    add('POST', '/admin/adjust', this.adminAdjust, 'admin');
    add('GET', '/admin/redemptions', this.adminRedemptions, 'admin');
    add('POST', '/admin/redemptions/:id/resolve', this.adminResolve, 'admin');
    add('GET', '/admin/offers', this.adminOffers, 'admin');
    add('POST', '/admin/offers/:id/suspend', this.adminSuspendOffer, 'admin');
    add('GET', '/admin/rules', this.adminGetRules, 'admin');
    add('POST', '/admin/rules', this.adminSetRules, 'admin');
    add('GET', '/admin/fraud', this.adminFraud, 'admin');
    add('POST', '/admin/fraud/:id/resolve', this.adminResolveFraud, 'admin');
    add('GET', '/admin/challenges', this.adminChallenges, 'admin');
    add('POST', '/admin/challenges/suggest', this.adminSuggestThemes, 'admin');
    add('POST', '/admin/challenges/preview', this.adminPreviewChallenge, 'admin');
    add('POST', '/admin/challenges/publish', this.adminPublishChallenge, 'admin');
    add('GET', '/admin/audit', this.adminAudit, 'admin');
    // Preview helpers
    add('POST', '/preview/become-admin', this.previewBecomeAdmin, 'signed_in');
    add('POST', '/preview/join-merchant', this.previewJoinMerchant, 'signed_in');
    add('POST', '/preview/reset', this.previewReset, 'public');
    return r;
  }

  /**
   * Handle a request. `auth` is {user_id} or null. Returns {status, body};
   * never throws for API errors.
   */
  async handle(method, path, body = {}, auth = null) {
    const [route, query = ''] = path.split('?');
    const params = Object.fromEntries(new URLSearchParams(query));
    try {
      this.housekeeping();
      const match = this.routes.find((r) => r.method === method && r.re.test(route));
      if (!match) throw notFound();
      const m = match.re.exec(route);
      match.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
      const ctx = await this.authorise(match.access, auth);
      const result = await match.fn({ body: body ?? {}, params, ...ctx });
      this.save();
      return { status: result?.__status ?? 200, body: result?.__status ? result.body : result };
    } catch (e) {
      if (e instanceof LedgerError) e = new ApiError(e.code === 'insufficient_points' ? 409 : 400, e.code);
      if (!(e instanceof ApiError)) {
        console.error(e);
        e = new ApiError(500, 'server_error', 'Something went wrong.');
      }
      this.save();
      return { status: e.status, body: { error: e.code, message: e.message, details: e.details } };
    }
  }

  async authorise(access, auth) {
    const user = auth?.user_id ? this.state.users[auth.user_id] : null;
    if (access === 'public') return { user };
    if (!user) throw new ApiError(401, 'unauthorised');
    if (user.status === 'suspended') throw new ApiError(403, 'account_suspended');
    user.last_active_at = this.now().toISOString();
    if (access === 'signed_in') return { user };
    if (access === 'player') {
      if (!user.display_name) throw new ApiError(403, 'profile_required');
      return { user };
    }
    if (access === 'admin') {
      if (!this.state.admins.includes(user.id)) throw new ApiError(403, 'forbidden');
      return { user };
    }
    if (access === 'merchant') {
      const member = this.state.members.find((m) => m.user_id === user.id);
      const merchant = member && this.state.merchants[member.merchant_id];
      if (!merchant) throw new ApiError(403, 'forbidden');
      return { user, member, merchant };
    }
    throw new ApiError(500, 'server_error');
  }

  /** Expire reservations and close timed-out games (pg_cron does this in production). */
  housekeeping() {
    const now = this.now();
    for (const r of Object.values(this.state.redemptions)) {
      if (r.status === 'reserved' && new Date(r.expires_at) <= now) this.releaseReservation(r, 'expired', 'system');
    }
    for (const s of Object.values(this.state.sessions)) {
      if (s.status === 'active' && now.getTime() > new Date(s.ends_at).getTime() + SUBMIT_GRACE_S * 1000) {
        this.completeSession(s);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------

  /** Preview only: there is no email check. Production uses Supabase Auth magic links. */
  async previewSignIn({ body }) {
    const address = email(body.email);
    let user = Object.values(this.state.users).find((u) => u.email === address);
    if (!user) {
      user = {
        id: this.id(), email: address, display_name: null, referral_code: null, referred_by: null,
        status: 'active', created_at: this.now().toISOString(), last_active_at: this.now().toISOString()
      };
      this.state.users[user.id] = user;
    }
    return { user_id: user.id };
  }

  referralCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (;;) {
      const bytes = crypto.getRandomValues(new Uint8Array(6));
      const code = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
      if (!Object.values(this.state.users).some((u) => u.referral_code === code)) return code;
    }
  }

  async saveProfile({ body, user }) {
    const name = displayName(body.display_name);
    const taken = Object.values(this.state.users).some((u) => u.id !== user.id && u.display_name?.toLowerCase() === name.toLowerCase());
    if (taken) throw new ApiError(409, 'name_taken', 'That name is taken.');
    const isNew = !user.display_name;
    user.display_name = name;
    if (isNew) {
      user.referral_code = this.referralCode();
      const ref = referralCode(body.referral_code);
      const referrer = ref && Object.values(this.state.users).find((u) => u.referral_code === ref);
      if (referrer && referrer.id !== user.id) user.referred_by = referrer.id;
      if (this.state.rules.welcome_bonus > 0) {
        this.ledger.post({
          user_id: user.id, type: 'earn', points: this.state.rules.welcome_bonus,
          idempotency_key: keys.welcome(user.id), reference_type: 'welcome', funding_source: 'platform', note: 'Welcome bonus'
        });
      }
    }
    return this.getMe({ user });
  }

  async getMe({ user }) {
    const sessions = Object.values(this.state.sessions).filter((s) => s.user_id === user.id && s.status === 'completed');
    const xp = sessions.reduce((a, s) => a + s.score + 50, 0);
    const member = this.state.members.find((m) => m.user_id === user.id);
    return {
      user_id: user.id,
      email: user.email,
      display_name: user.display_name,
      referral_code: user.referral_code,
      status: user.status,
      created_at: user.created_at,
      balance: this.ledger.balance(user.id),
      progress: {
        xp,
        level: Math.floor(Math.sqrt(xp / 100)) + 1,
        games_played: sessions.length,
        best_score: sessions.reduce((a, s) => Math.max(a, s.score), 0),
        streak: this.streak(sessions),
        words_found: this.state.submissions.filter((s) => s.user_id === user.id).length
      },
      roles: {
        admin: this.state.admins.includes(user.id),
        merchant: member ? { merchant_id: member.merchant_id, role: member.role } : null
      }
    };
  }

  streak(sessions) {
    const days = new Set(sessions.map((s) => s.game_id));
    let d = new Date(`${londonDate(this.now())}T12:00:00Z`);
    if (!days.has(d.toISOString().slice(0, 10))) d = new Date(d.getTime() - 86400000);
    let n = 0;
    while (days.has(d.toISOString().slice(0, 10))) {
      n++;
      d = new Date(d.getTime() - 86400000);
    }
    return n;
  }

  // -------------------------------------------------------------------------
  // Game
  // -------------------------------------------------------------------------

  async game(date) {
    if (!this.state.games[date]) {
      const def = generateChallenge({ date, words: await this.dictionary(), salt: this.state.salt });
      this.state.games[date] = { ...def, status: 'published', sponsored_by: null, created_by: 'auto' };
    }
    return this.state.games[date];
  }

  sessionView(s, def) {
    const subs = this.state.submissions.filter((x) => x.session_id === s.id);
    return {
      session_id: s.id,
      game_id: s.game_id,
      status: s.status,
      started_at: s.started_at,
      ends_at: s.ends_at,
      finished_at: s.finished_at,
      score: s.status === 'completed' ? s.score : gameScore(subs, def.theme_word),
      words: subs.map(({ word, score, path }) => ({ word, score, path })),
      awards: s.awards ?? [],
      theme_found: Boolean(def.theme_word && subs.some((x) => x.word === def.theme_word))
    };
  }

  async getToday({ user }) {
    const def = await this.game(londonDate(this.now()));
    const session = user && Object.values(this.state.sessions).find((s) => s.user_id === user.id && s.game_id === def.id);
    const out = { challenge: publicChallenge(def), session: session ? this.sessionView(session, def) : null, server_time: this.now().toISOString() };
    if (session?.status === 'completed') out.reveal = this.reveal(def);
    return out;
  }

  reveal(def) {
    return { theme_word: def.theme_word, top_words: [...def.solutions].sort((a, b) => b.score - a.score).slice(0, 12).map(({ word, score }) => ({ word, score })) };
  }

  async startGame({ user }) {
    const def = await this.game(londonDate(this.now()));
    const existing = Object.values(this.state.sessions).find((s) => s.user_id === user.id && s.game_id === def.id);
    if (existing) {
      if (existing.status === 'completed') throw new ApiError(409, 'already_played');
      return this.sessionView(existing, def);
    }
    const now = this.now();
    const s = {
      id: this.id(), user_id: user.id, game_id: def.id, mode: 'daily', status: 'active',
      started_at: now.toISOString(), ends_at: new Date(now.getTime() + def.time_limit_s * 1000).toISOString(),
      finished_at: null, score: 0, awards: []
    };
    this.state.sessions[s.id] = s;
    return this.sessionView(s, def);
  }

  ownSession(user, sessionId) {
    const s = this.state.sessions[sessionId];
    if (!s || s.user_id !== user.id) throw notFound();
    return s;
  }

  async submitWord({ body, user }) {
    const s = this.ownSession(user, body.session_id);
    const def = await this.game(s.game_id);
    if (s.status !== 'active' || this.now().getTime() > new Date(s.ends_at).getTime() + SUBMIT_GRACE_S * 1000) {
      throw new ApiError(409, 'session_closed');
    }
    const path = body.path;
    if (!isValidPath(path)) throw bad('invalid_path');
    const word = wordFromPath(def.tiles, path);
    if (word.length < MIN_WORD) throw bad('too_short');
    const index = solutionIndex(def);
    if (!index.has(word)) throw bad('not_a_word', { word });
    if (this.state.submissions.some((x) => x.session_id === s.id && x.word === word)) throw new ApiError(409, 'duplicate_word', undefined, { word });
    const sub = { id: this.id(), session_id: s.id, user_id: user.id, word, path, score: wordScore(word, path.includes(def.star)), created_at: this.now().toISOString() };
    this.state.submissions.push(sub);
    return { word, score: sub.score, theme_word: word === def.theme_word, session: this.sessionView(s, def) };
  }

  async finishGame({ body, user }) {
    const s = this.ownSession(user, body.session_id);
    if (s.status === 'active') this.completeSession(s);
    const def = await this.game(s.game_id);
    return { session: this.sessionView(s, def), reveal: this.reveal(def), balance: this.ledger.balance(user.id), rank: this.rankOf(s) };
  }

  /** Close a session, compute the score on the server and issue points exactly once. */
  completeSession(s) {
    const def = this.state.games[s.game_id];
    const subs = this.state.submissions.filter((x) => x.session_id === s.id);
    s.status = 'completed';
    s.finished_at = new Date(Math.min(this.now().getTime(), new Date(s.ends_at).getTime())).toISOString();
    s.score = gameScore(subs, def.theme_word);
    s.word_count = subs.length;
    const user = this.state.users[s.user_id];
    const previous = Object.values(this.state.sessions).filter((x) => x.user_id === s.user_id && x.status === 'completed' && x.id !== s.id);
    const previousBest = previous.length ? Math.max(...previous.map((x) => x.score)) : null;
    const today = londonDate(this.now());
    const earnedToday = this.ledger.forUser(s.user_id)
      .filter((t) => t.type === 'earn' && t.reference_type === 'game' && londonDate(new Date(t.created_at)) === today)
      .reduce((a, t) => a + t.points, 0);
    this.checkPlay(s, subs, def);
    s.awards = [];
    if (user.status === 'active') {
      for (const a of gameAwards(this.state.rules, { score: s.score, target: def.target_score, previousBest, sponsored: Boolean(def.sponsored_by), earnedToday })) {
        this.ledger.post({
          user_id: s.user_id, type: 'earn', points: a.points, idempotency_key: keys.game(a.kind, s.user_id, s.game_id),
          reference_type: 'game', reference_id: s.game_id, funding_source: a.kind === 'sponsored_challenge' ? `sponsor:${def.sponsored_by}` : 'platform',
          note: AWARD_LABELS[a.kind]
        });
        s.awards.push(a);
      }
      if (previous.length === 0) this.creditReferral(user);
    }
  }

  creditReferral(user) {
    const referrer = user.referred_by && this.state.users[user.referred_by];
    if (!referrer || referrer.status !== 'active' || this.state.rules.referral <= 0) return;
    const month = londonParts(this.now()).month;
    const thisMonth = this.ledger.forUser(referrer.id).filter((t) => t.reference_type === 'referral' && londonParts(new Date(t.created_at)).month === month).length;
    if (thisMonth >= this.state.rules.referral_monthly_cap) {
      this.flag(referrer.id, 'referral_cap', { referred: user.id });
      return;
    }
    this.ledger.post({
      user_id: referrer.id, type: 'earn', points: this.state.rules.referral, idempotency_key: keys.referral(user.id),
      reference_type: 'referral', reference_id: user.id, funding_source: 'platform', note: `Referral: ${user.display_name}`
    });
  }

  /** Simple bot signals. They flag for review; an admin decides. */
  checkPlay(s, subs, def) {
    if (!subs.length) return;
    const span = (new Date(subs.at(-1).created_at) - new Date(s.started_at)) / 1000;
    const perMinute = subs.length / Math.max(span / 60, 0.5);
    const share = subs.length / def.word_count;
    if (perMinute > 30) this.flag(s.user_id, 'fast_play', { session_id: s.id, words_per_minute: Math.round(perMinute) });
    if (share > 0.6 && subs.length >= 30) this.flag(s.user_id, 'implausible_coverage', { session_id: s.id, share: Math.round(share * 100) });
  }

  flag(userId, kind, details) {
    this.state.fraud.push({ id: this.id(), user_id: userId, kind, details, status: 'open', created_at: this.now().toISOString() });
  }

  rankOf(s) {
    const board = this.board(s.game_id);
    const i = board.findIndex((x) => x.session_id === s.id);
    return i < 0 ? null : { rank: i + 1, of: board.length };
  }

  board(gameId) {
    return Object.values(this.state.sessions)
      .filter((s) => s.game_id === gameId && s.status === 'completed' && this.state.users[s.user_id]?.status === 'active')
      .sort((a, b) => b.score - a.score || a.finished_at.localeCompare(b.finished_at))
      .map((s) => ({ session_id: s.id, user_id: s.user_id, score: s.score, words: s.word_count }));
  }

  async leaderboard({ params, user }) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(params.date ?? '') ? params.date : londonDate(this.now());
    const rows = this.board(date);
    const view = (x, i) => ({ rank: i + 1, display_name: this.state.users[x.user_id].display_name, score: x.score, words: x.words, me: x.user_id === user?.id });
    const mine = user ? rows.findIndex((x) => x.user_id === user.id) : -1;
    return { date, players: rows.length, top: rows.slice(0, 50).map(view), me: mine >= 0 ? view(rows[mine], mine) : null };
  }

  async explain({ body }) {
    const word = typeof body.word === 'string' ? body.word.toLowerCase().trim() : '';
    if (!/^[a-z]{3,10}$/.test(word) || !hasWord(await this.dictionary(), word)) throw bad('invalid_request', 'word: a dictionary word');
    return {
      word,
      source: 'preview',
      definition: null,
      note: 'Definitions, etymology and word facts come from the AI service once the backend is connected.',
      score: wordScore(word)
    };
  }

  // -------------------------------------------------------------------------
  // Wallet
  // -------------------------------------------------------------------------

  async wallet({ user }) {
    const txs = this.ledger.forUser(user.id).slice().reverse();
    return {
      balance: balances(txs),
      transactions: txs.slice(0, 200).map(({ id, type, points, amount, held_delta, note, reference_type, reference_id, created_at, status }) =>
        ({ id, type, points, amount, held_delta, note, reference_type, reference_id, created_at, status }))
    };
  }

  // -------------------------------------------------------------------------
  // Offers and redemption
  // -------------------------------------------------------------------------

  counts(offerId) {
    let reserved = 0, redeemed = 0;
    for (const r of Object.values(this.state.redemptions)) {
      if (r.offer_id !== offerId) continue;
      if (r.status === 'reserved') reserved++;
      if (r.status === 'redeemed') redeemed++;
    }
    return { reserved, redeemed };
  }

  userCount(offerId, userId) {
    return Object.values(this.state.redemptions).filter((r) => r.offer_id === offerId && r.user_id === userId && (r.status === 'reserved' || r.status === 'redeemed')).length;
  }

  offerView(o, user = null) {
    const m = this.state.merchants[o.merchant_id];
    const c = this.counts(o.id);
    const avail = offerAvailability(o, { at: this.now(), ...c, userCount: user ? this.userCount(o.id, user.id) : 0, merchantStatus: m?.status });
    return {
      id: o.id, title: o.title, description: o.description, category: o.category, image: o.image,
      points_price: o.points_price, quantity_total: o.quantity_total, remaining: avail.remaining,
      max_per_customer: o.max_per_customer, valid_from: o.valid_from, valid_until: o.valid_until,
      days: o.days, window_start: o.window_start, window_end: o.window_end, hold_minutes: o.hold_minutes,
      terms: o.terms, status: o.status, welcome: Boolean(o.welcome),
      merchant: m ? { id: m.id, name: m.name, area: m.area, address: m.address, lat: m.lat, lng: m.lng } : null,
      available: avail.ok, unavailable_reason: avail.reason
    };
  }

  async listOffers({ params, user }) {
    const now = this.now();
    let offers = Object.values(this.state.offers)
      .filter((o) => o.status === 'active' && this.state.merchants[o.merchant_id]?.status === 'approved' && (!o.valid_until || new Date(o.valid_until) > now))
      .map((o) => this.offerView(o, user));
    if (params.category && CATEGORIES.includes(params.category)) offers = offers.filter((o) => o.category === params.category);
    if (params.area) offers = offers.filter((o) => o.merchant?.area === params.area);
    if (params.available === 'now') offers = offers.filter((o) => o.available);
    offers.sort((a, b) => Number(b.available) - Number(a.available) || a.points_price - b.points_price);
    const areas = [...new Set(Object.values(this.state.merchants).filter((m) => m.status === 'approved').map((m) => m.area))].sort();
    return { offers, categories: CATEGORIES, areas, balance: user ? this.ledger.balance(user.id) : null };
  }

  async getOffer({ params, user }) {
    const o = this.state.offers[params.id];
    if (!o || this.state.merchants[o.merchant_id]?.status !== 'approved' || o.status === 'draft') throw notFound();
    return { offer: this.offerView(o, user), balance: user ? this.ledger.balance(user.id) : null };
  }

  redemptionView(r, code = null) {
    const o = this.state.offers[r.offer_id];
    const m = this.state.merchants[r.merchant_id];
    return {
      id: r.id, status: r.status, points: r.points, reserved_at: r.reserved_at, expires_at: r.expires_at,
      validated_at: r.validated_at, offer: { id: o.id, title: o.title, image: o.image, terms: o.terms },
      merchant: { id: m.id, name: m.name, address: m.address }, code: code ? formatCode(code) : null,
      qr_payload: code ? `WRD1-${code}` : null
    };
  }

  async reserve({ body, user }) {
    const clientKey = str(body.idempotency_key, { min: 8, max: 64, field: 'idempotency_key' });
    const prior = Object.values(this.state.redemptions).find((r) => r.user_id === user.id && r.client_key === clientKey);
    if (prior) {
      if (prior.offer_id !== body.offer_id) throw new ApiError(409, 'idempotency_conflict');
      return this.reissueCode({ params: { id: prior.id }, user });
    }
    const o = this.state.offers[body.offer_id];
    if (!o) throw notFound();
    const m = this.state.merchants[o.merchant_id];
    const avail = offerAvailability(o, { at: this.now(), ...this.counts(o.id), userCount: this.userCount(o.id, user.id), merchantStatus: m?.status });
    if (!avail.ok) throw new ApiError(409, avail.reason);
    const id = this.id();
    // Reserve the points first: this throws insufficient_points before anything is created.
    this.ledger.post({ user_id: user.id, type: 'reserve', points: o.points_price, idempotency_key: keys.reserve(id), reference_type: 'redemption', reference_id: id, note: o.title });
    const code = generateCode();
    const r = {
      id, user_id: user.id, offer_id: o.id, merchant_id: o.merchant_id, points: o.points_price, status: 'reserved',
      code_hash: await sha256Hex(code), client_key: clientKey, reserved_at: this.now().toISOString(),
      expires_at: reservationExpiry(o, this.now(), this.state.rules.reservation_minutes).toISOString(),
      validated_at: null, validated_by: null, reported_spend_pence: null
    };
    this.state.redemptions[id] = r;
    return { __status: 201, body: { redemption: this.redemptionView(r, code), balance: this.ledger.balance(user.id) } };
  }

  async myRedemptions({ user }) {
    const list = Object.values(this.state.redemptions).filter((r) => r.user_id === user.id).sort((a, b) => b.reserved_at.localeCompare(a.reserved_at));
    return { redemptions: list.map((r) => this.redemptionView(r)) };
  }

  /** Codes are stored only as hashes, so showing a code again issues a new one and the old one stops working. */
  async reissueCode({ params, user }) {
    const r = this.state.redemptions[params.id];
    if (!r || r.user_id !== user.id) throw notFound();
    if (r.status !== 'reserved') throw new ApiError(409, r.status === 'redeemed' ? 'already_redeemed' : r.status);
    const code = generateCode();
    r.code_hash = await sha256Hex(code);
    return { redemption: this.redemptionView(r, code), balance: this.ledger.balance(user.id) };
  }

  async cancelReservation({ params, user }) {
    const r = this.state.redemptions[params.id];
    if (!r || r.user_id !== user.id) throw notFound();
    if (r.status !== 'reserved') throw new ApiError(409, r.status === 'redeemed' ? 'already_redeemed' : r.status);
    this.releaseReservation(r, 'cancelled', user.id);
    return { redemption: this.redemptionView(r), balance: this.ledger.balance(user.id) };
  }

  releaseReservation(r, status, actor) {
    this.ledger.post({ user_id: r.user_id, type: 'release', points: r.points, idempotency_key: keys.release(r.id), reference_type: 'redemption', reference_id: r.id, actor, note: status === 'expired' ? 'Reservation expired' : 'Reservation cancelled' });
    r.status = status;
  }

  // -------------------------------------------------------------------------
  // Merchants
  // -------------------------------------------------------------------------

  async registerMerchant({ body, user }) {
    if (this.state.members.some((m) => m.user_id === user.id)) throw new ApiError(409, 'already_registered', 'You already belong to a venue.');
    const m = { id: this.id(), ...merchantInput(body, user.email), lat: null, lng: null, status: 'pending', created_at: this.now().toISOString() };
    this.state.merchants[m.id] = m;
    this.state.members.push({ user_id: user.id, merchant_id: m.id, role: 'owner' });
    this.audit(user.id, 'merchant.register', m.id);
    return { __status: 201, body: await this.merchantMe({ user }) };
  }

  async merchantMe({ user }) {
    const member = this.state.members.find((m) => m.user_id === user.id);
    if (!member) return { merchant: null };
    const merchant = this.state.merchants[member.merchant_id];
    const offers = Object.values(this.state.offers).filter((o) => o.merchant_id === merchant.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
    return {
      merchant, role: member.role,
      offers: offers.map((o) => ({ ...this.offerView(o), ...this.counts(o.id), standard_price_pence: o.standard_price_pence, fulfilment_cost_pence: o.fulfilment_cost_pence, suspended: Boolean(o.suspended) }))
    };
  }

  requireOwner(member) {
    if (member.role !== 'owner') throw new ApiError(403, 'forbidden', 'Only the venue owner can change offers.');
  }

  async saveOffer({ body, member, merchant, user }) {
    this.requireOwner(member);
    if (merchant.status !== 'approved') throw new ApiError(409, 'merchant_not_approved');
    const existing = body.id ? this.state.offers[body.id] : null;
    if (body.id && (!existing || existing.merchant_id !== merchant.id)) throw notFound();
    if (existing?.suspended) throw new ApiError(409, 'offer_suspended', 'An administrator has suspended this offer.');
    const fields = offerInput(body);
    if (existing) {
      const c = this.counts(existing.id);
      if (fields.quantity_total < c.reserved + c.redeemed) throw new ApiError(409, 'inventory_below_claimed');
      Object.assign(existing, fields, { updated_at: this.now().toISOString() });
      this.audit(user.id, 'offer.update', existing.id);
      return { offer: this.offerView(existing) };
    }
    const o = { id: this.id(), merchant_id: merchant.id, ...fields, status: body.status === 'active' ? 'active' : 'draft', funding: 'merchant', created_at: this.now().toISOString() };
    this.state.offers[o.id] = o;
    this.audit(user.id, 'offer.create', o.id);
    return { __status: 201, body: { offer: this.offerView(o) } };
  }

  async setOfferStatus({ params, body, member, merchant, user }) {
    this.requireOwner(member);
    const o = this.state.offers[params.id];
    if (!o || o.merchant_id !== merchant.id) throw notFound();
    if (!OFFER_STATUSES.includes(body.status)) throw bad('invalid_request', `status: ${OFFER_STATUSES.join(', ')}`);
    if (o.suspended) throw new ApiError(409, 'offer_suspended', 'An administrator has suspended this offer.');
    if (body.status === 'active' && merchant.status !== 'approved') throw new ApiError(409, 'merchant_not_approved');
    if (o.status === 'ended') throw new ApiError(409, 'offer_ended', 'Ended offers cannot be restarted. Create a new one.');
    // Pausing or ending never touches existing reservations: they stay valid until they expire.
    o.status = body.status;
    this.audit(user.id, `offer.${body.status}`, o.id);
    return { offer: this.offerView(o) };
  }

  async validateCode({ body, merchant, user }) {
    const code = normaliseCode(body.code);
    if (!code) throw bad('invalid_code');
    const hash = await sha256Hex(code);
    const r = Object.values(this.state.redemptions).find((x) => x.code_hash === hash);
    // A code for another venue looks exactly like an unknown code.
    if (!r || r.merchant_id !== merchant.id) throw new ApiError(404, 'invalid_code');
    const view = () => ({ redemption: { ...this.redemptionView(r), player: this.state.users[r.user_id]?.display_name } });
    if (r.status === 'redeemed') throw new ApiError(409, 'already_redeemed', undefined, { validated_at: r.validated_at });
    if (r.status !== 'reserved') throw new ApiError(409, r.status === 'expired' ? 'expired' : 'cancelled');
    if (new Date(r.expires_at) <= this.now()) {
      this.releaseReservation(r, 'expired', 'system');
      throw new ApiError(409, 'expired');
    }
    if (!body.confirm) return { valid: true, ...view() };
    this.ledger.post({ user_id: r.user_id, type: 'redeem', points: r.points, idempotency_key: keys.redeem(r.id), reference_type: 'redemption', reference_id: r.id, actor: user.id, note: this.state.offers[r.offer_id].title });
    r.status = 'redeemed';
    r.validated_at = this.now().toISOString();
    r.validated_by = user.id;
    this.audit(user.id, 'redemption.validate', r.id);
    return { valid: true, redeemed: true, ...view() };
  }

  async merchantRedemptions({ merchant, params }) {
    const list = Object.values(this.state.redemptions)
      .filter((r) => r.merchant_id === merchant.id && (!params.status || r.status === params.status))
      .sort((a, b) => (b.validated_at ?? b.reserved_at).localeCompare(a.validated_at ?? a.reserved_at));
    return { redemptions: list.slice(0, 200).map((r) => ({ ...this.redemptionView(r), player: this.state.users[r.user_id]?.display_name, reported_spend_pence: r.reported_spend_pence })) };
  }

  async reportSpend({ params, body, merchant, user }) {
    const r = this.state.redemptions[params.id];
    if (!r || r.merchant_id !== merchant.id) throw notFound();
    if (r.status !== 'redeemed') throw new ApiError(409, 'not_redeemed', 'Spend can only be reported for redeemed rewards.');
    r.reported_spend_pence = int(body.spend_pence, { max: 1e7, field: 'spend_pence' });
    this.audit(user.id, 'redemption.report_spend', r.id, { spend_pence: r.reported_spend_pence });
    return { ok: true };
  }

  async merchantStats({ merchant }) {
    const offers = Object.values(this.state.offers).filter((o) => o.merchant_id === merchant.id);
    const reds = Object.values(this.state.redemptions).filter((r) => r.merchant_id === merchant.id);
    const redeemed = reds.filter((r) => r.status === 'redeemed');
    const firstVisit = new Map();
    for (const r of redeemed.slice().sort((a, b) => a.validated_at.localeCompare(b.validated_at))) if (!firstVisit.has(r.user_id)) firstVisit.set(r.user_id, r);
    const reported = redeemed.filter((r) => r.reported_spend_pence !== null);
    const reportedSpend = reported.reduce((a, r) => a + r.reported_spend_pence, 0);
    const cost = redeemed.reduce((a, r) => a + (this.state.offers[r.offer_id].fulfilment_cost_pence ?? 0), 0);
    const avgSpend = reported.length ? reportedSpend / reported.length : null;
    return {
      verified: {
        offers_published: offers.filter((o) => o.status !== 'draft').length,
        offers_live: offers.filter((o) => o.status === 'active' && !o.suspended).length,
        rewards_claimed: reds.length,
        rewards_redeemed: redeemed.length,
        rewards_expired: reds.filter((r) => r.status === 'expired').length,
        redemption_conversion: reds.length ? redeemed.length / reds.length : null,
        unique_customers: firstVisit.size,
        points_redeemed: redeemed.reduce((a, r) => a + r.points, 0)
      },
      reported: {
        redemptions_with_spend: reported.length,
        customer_spend_pence: reportedSpend
      },
      estimated: {
        fulfilment_cost_pence: cost,
        incremental_revenue_pence: avgSpend === null ? null : Math.round(avgSpend * redeemed.length - cost),
        basis: 'Average reported spend × redemptions, minus your estimated fulfilment cost. Merchant-reported, not verified.'
      }
    };
  }

  // -------------------------------------------------------------------------
  // Yield engine (separate service in production: yield schema + /yield routes)
  // -------------------------------------------------------------------------

  async getYield({ merchant }) {
    const rules = Object.values(this.state.yield_rules).filter((r) => r.merchant_id === merchant.id);
    return { rules, default_bands: DEFAULT_BANDS };
  }

  async saveYieldRule({ body, member, merchant, user }) {
    this.requireOwner(member);
    const offer = this.state.offers[body.offer_id];
    if (!offer || offer.merchant_id !== merchant.id) throw notFound();
    const rule = {
      bands: Array.isArray(body.bands) ? body.bands.map((b) => ({ below: b?.below, points: b?.points })) : DEFAULT_BANDS.map((b) => ({ ...b })),
      capacity: body.capacity, target_utilisation: body.target_utilisation ?? 70, max_units: body.max_units, auto_apply: body.auto_apply === true
    };
    const errors = validateRule(rule);
    if (errors.length) throw bad('invalid_request', errors.join('; '));
    const existing = Object.values(this.state.yield_rules).find((r) => r.offer_id === offer.id);
    const saved = Object.assign(existing ?? { id: this.id(), merchant_id: merchant.id, offer_id: offer.id, created_at: this.now().toISOString() }, rule, { updated_at: this.now().toISOString() });
    this.state.yield_rules[saved.id] = saved;
    this.audit(user.id, 'yield.rule', saved.id, { auto_apply: rule.auto_apply });
    return { rule: saved };
  }

  async yieldRecommend({ body, member, merchant, user }) {
    const rule = this.state.yield_rules[body.rule_id];
    if (!rule || rule.merchant_id !== merchant.id) throw notFound();
    const utilisation = Number(body.utilisation);
    if (!Number.isFinite(utilisation) || utilisation < 0 || utilisation > 100) throw bad('invalid_request', 'utilisation: 0–100');
    const rec = { id: this.id(), rule_id: rule.id, offer_id: rule.offer_id, utilisation, ...recommend(rule, utilisation), created_at: this.now().toISOString(), applied: false };
    rule.last_recommendation = rec;
    if (rule.auto_apply && rec.action === 'release' && member.role === 'owner') {
      this.applyRecommendation(rule, rec, user.id);
    }
    return { recommendation: rec, offer: this.offerView(this.state.offers[rule.offer_id]) };
  }

  async yieldApply({ body, member, merchant, user }) {
    this.requireOwner(member);
    const rule = this.state.yield_rules[body.rule_id];
    if (!rule || rule.merchant_id !== merchant.id || !rule.last_recommendation) throw notFound();
    const rec = rule.last_recommendation;
    if (rec.action !== 'release') throw new ApiError(409, 'nothing_to_apply', 'The latest recommendation is to hold.');
    if (!rec.applied) this.applyRecommendation(rule, rec, user.id);
    return { recommendation: rec, offer: this.offerView(this.state.offers[rule.offer_id]) };
  }

  /** Price the offer at the band price and make `quantity` more units available now. */
  applyRecommendation(rule, rec, actor) {
    const o = this.state.offers[rule.offer_id];
    if (o.suspended || o.status === 'ended') throw new ApiError(409, 'offer_not_active');
    const c = this.counts(o.id);
    o.points_price = rec.points_price;
    o.quantity_total = c.reserved + c.redeemed + rec.quantity;
    if (o.status !== 'active') o.status = 'active';
    rec.applied = true;
    rec.applied_at = this.now().toISOString();
    this.audit(actor, 'yield.apply', o.id, { points_price: rec.points_price, quantity: rec.quantity, utilisation: rec.utilisation });
  }

  // -------------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------------

  async adminOverview() {
    const users = Object.values(this.state.users);
    const today = londonDate(this.now());
    const totals = { issued: 0, redeemed: 0, available: 0, held: 0 };
    const bySource = {};
    for (const t of this.state.ledger) {
      totals.available += t.amount;
      totals.held += t.held_delta;
      if (t.type === 'earn') {
        totals.issued += t.points;
        const src = (t.funding_source ?? 'platform').split(':')[0];
        bySource[src] = (bySource[src] ?? 0) + t.points;
      }
      if (t.type === 'redeem') totals.redeemed += t.points;
    }
    const reds = Object.values(this.state.redemptions);
    const redeemed = reds.filter((r) => r.status === 'redeemed');
    // Cost per point actually seen in redemptions, to put a value on what is outstanding.
    const cost = redeemed.reduce((a, r) => a + (this.state.offers[r.offer_id].fulfilment_cost_pence ?? 0), 0);
    const pts = redeemed.reduce((a, r) => a + r.points, 0);
    const pencePerPoint = pts ? cost / pts : null;
    const sessions = Object.values(this.state.sessions);
    const todays = sessions.filter((s) => s.game_id === today);
    const redeemers = new Set(redeemed.map((r) => r.user_id));
    return {
      players: { registered: users.filter((u) => u.display_name).length, suspended: users.filter((u) => u.status === 'suspended').length, active_today: new Set(todays.map((s) => s.user_id)).size, first_redemption_rate: users.length ? redeemers.size / users.filter((u) => u.display_name).length : null },
      games: { today, started_today: todays.length, completed_today: todays.filter((s) => s.status === 'completed').length, completed_all_time: sessions.filter((s) => s.status === 'completed').length },
      points: { ...totals, outstanding: totals.available + totals.held, issued_by_source: bySource, pence_per_point: pencePerPoint, outstanding_liability_pence: pencePerPoint === null ? null : Math.round((totals.available + totals.held) * pencePerPoint) },
      redemptions: { reserved: reds.filter((r) => r.status === 'reserved').length, redeemed: redeemed.length, expired: reds.filter((r) => r.status === 'expired').length, cancelled: reds.filter((r) => r.status === 'cancelled').length, refunded: reds.filter((r) => r.status === 'refunded').length },
      merchants: { approved: Object.values(this.state.merchants).filter((m) => m.status === 'approved').length, pending: Object.values(this.state.merchants).filter((m) => m.status === 'pending').length },
      offers: { live: Object.values(this.state.offers).filter((o) => o.status === 'active' && !o.suspended).length },
      fraud_open: this.state.fraud.filter((f) => f.status === 'open').length
    };
  }

  async adminMerchants() {
    return { merchants: Object.values(this.state.merchants).sort((a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name)).map((m) => ({ ...m, offers: Object.values(this.state.offers).filter((o) => o.merchant_id === m.id).length })) };
  }

  async adminMerchantStatus({ params, body, user }) {
    const m = this.state.merchants[params.id];
    if (!m) throw notFound();
    if (!['approved', 'suspended', 'pending'].includes(body.status)) throw bad('invalid_request', 'status: approved, suspended or pending');
    m.status = body.status;
    this.audit(user.id, `merchant.${body.status}`, m.id, { reason: body.reason ?? null });
    return { merchant: m };
  }

  async adminUsers({ params }) {
    const q = (params.q ?? '').toLowerCase();
    const list = Object.values(this.state.users)
      .filter((u) => !q || u.email.includes(q) || u.display_name?.toLowerCase().includes(q) || u.id === q)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 100)
      .map((u) => ({ id: u.id, email: u.email, display_name: u.display_name, status: u.status, created_at: u.created_at, last_active_at: u.last_active_at, balance: this.ledger.balance(u.id), flags: this.state.fraud.filter((f) => f.user_id === u.id && f.status === 'open').length }));
    return { users: list };
  }

  async adminUserStatus({ params, body, user }) {
    const u = this.state.users[params.id];
    if (!u) throw notFound();
    if (!['active', 'suspended'].includes(body.status)) throw bad('invalid_request', 'status: active or suspended');
    const reason = str(body.reason, { min: 3, max: 300, field: 'reason' });
    u.status = body.status;
    this.audit(user.id, `user.${body.status}`, u.id, { reason });
    return { ok: true };
  }

  async adminUserTransactions({ params }) {
    const u = this.state.users[params.id];
    if (!u) throw notFound();
    return { user: { id: u.id, email: u.email, display_name: u.display_name, status: u.status }, balance: this.ledger.balance(u.id), transactions: this.ledger.forUser(u.id).slice().reverse() };
  }

  async adminAdjust({ body, user }) {
    const target = this.state.users[body.user_id];
    if (!target) throw notFound();
    const points = int(body.points, { min: -100000, max: 100000, field: 'points' });
    const reason = str(body.reason, { min: 3, max: 300, field: 'reason' });
    const key = str(body.idempotency_key, { min: 8, max: 64, field: 'idempotency_key' });
    const { tx } = this.ledger.post({ user_id: target.id, type: 'adjust', points, idempotency_key: `adjust:${key}`, reference_type: 'admin', reference_id: user.id, actor: user.id, note: reason, funding_source: 'platform' });
    this.audit(user.id, 'points.adjust', target.id, { points, reason, transaction_id: tx.id });
    return { transaction: tx, balance: this.ledger.balance(target.id) };
  }

  async adminRedemptions({ params }) {
    const list = Object.values(this.state.redemptions)
      .filter((r) => !params.status || r.status === params.status)
      .sort((a, b) => b.reserved_at.localeCompare(a.reserved_at))
      .slice(0, 200)
      .map((r) => ({ ...this.redemptionView(r), user_id: r.user_id, player: this.state.users[r.user_id]?.display_name }));
    return { redemptions: list };
  }

  /** Resolve a failed redemption: release a stuck reservation, refund a completed one, or complete one the venue honoured but couldn't validate. */
  async adminResolve({ params, body, user }) {
    const r = this.state.redemptions[params.id];
    if (!r) throw notFound();
    const reason = str(body.reason, { min: 3, max: 300, field: 'reason' });
    if (body.action === 'release') {
      if (r.status !== 'reserved') throw new ApiError(409, 'invalid_state', 'Only active reservations can be released.');
      this.releaseReservation(r, 'cancelled', user.id);
    } else if (body.action === 'refund') {
      if (r.status !== 'redeemed') throw new ApiError(409, 'invalid_state', 'Only redeemed rewards can be refunded.');
      this.ledger.post({ user_id: r.user_id, type: 'refund', points: r.points, idempotency_key: keys.refund(r.id), reference_type: 'redemption', reference_id: r.id, actor: user.id, note: reason });
      r.status = 'refunded';
    } else if (body.action === 'complete') {
      if (r.status !== 'reserved') throw new ApiError(409, 'invalid_state', 'Only active reservations can be completed.');
      this.ledger.post({ user_id: r.user_id, type: 'redeem', points: r.points, idempotency_key: keys.redeem(r.id), reference_type: 'redemption', reference_id: r.id, actor: user.id, note: reason });
      r.status = 'redeemed';
      r.validated_at = this.now().toISOString();
      r.validated_by = user.id;
    } else throw bad('invalid_request', 'action: release, refund or complete');
    this.audit(user.id, `redemption.${body.action}`, r.id, { reason });
    return { redemption: this.redemptionView(r) };
  }

  async adminOffers() {
    return { offers: Object.values(this.state.offers).map((o) => ({ ...this.offerView(o), ...this.counts(o.id), suspended: Boolean(o.suspended), merchant_status: this.state.merchants[o.merchant_id]?.status })) };
  }

  async adminSuspendOffer({ params, body, user }) {
    const o = this.state.offers[params.id];
    if (!o) throw notFound();
    const reason = str(body.reason, { min: 3, max: 300, field: 'reason' });
    o.suspended = body.suspended !== false;
    if (o.suspended) o.status = 'paused';
    this.audit(user.id, o.suspended ? 'offer.suspend' : 'offer.unsuspend', o.id, { reason });
    return { offer: this.offerView(o) };
  }

  async adminGetRules() {
    return { rules: this.state.rules };
  }

  async adminSetRules({ body, user }) {
    try {
      this.state.rules = applyRulesPatch(this.state.rules, body.rules);
    } catch (e) {
      throw bad('invalid_request', e.message);
    }
    this.audit(user.id, 'rules.update', 'rules', body.rules);
    return { rules: this.state.rules };
  }

  async adminFraud() {
    return { signals: this.state.fraud.slice().reverse().map((f) => ({ ...f, display_name: this.state.users[f.user_id]?.display_name })) };
  }

  async adminResolveFraud({ params, body, user }) {
    const f = this.state.fraud.find((x) => x.id === params.id);
    if (!f) throw notFound();
    f.status = body.status === 'confirmed' ? 'confirmed' : 'dismissed';
    f.resolved_by = user.id;
    this.audit(user.id, `fraud.${f.status}`, f.id);
    return { signal: f };
  }

  async adminChallenges() {
    const today = londonDate(this.now());
    return {
      today,
      challenges: Object.values(this.state.games).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30)
        .map(({ date, theme_word, theme_hint, word_count, max_score, target_score, status, created_by, sponsored_by }) => ({ date, theme_word, theme_hint, word_count, max_score, target_score, status, created_by, sponsored_by, players: Object.values(this.state.sessions).filter((s) => s.game_id === date).length }))
    };
  }

  /** AI-assisted in production (Claude proposes themed words); in preview, picks from the built-in list. */
  async adminSuggestThemes({ body }) {
    const words = await this.dictionary();
    const pool = THEME_WORDS.filter((w) => hasWord(words, w) && w.length >= 6 && w.length <= 8);
    const picks = [];
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    for (const b of bytes) {
      const w = pool[b % pool.length];
      if (!picks.some((p) => p.word === w)) picks.push({ word: w, hint: null });
    }
    return { source: 'preview', theme: body.theme ?? null, suggestions: picks };
  }

  async adminPreviewChallenge({ body }) {
    const date = str(body.date, { min: 10, max: 10, field: 'date' });
    if (date < londonDate(this.now())) throw bad('invalid_request', 'date: today or later');
    try {
      const def = generateChallenge({ date, words: await this.dictionary(), salt: `${this.state.salt}|${body.attempt ?? 0}`, themeWord: body.theme_word || null, themeHint: body.theme_hint || null });
      return { challenge: def };
    } catch (e) {
      throw bad('invalid_request', e.message);
    }
  }

  async adminPublishChallenge({ body, user }) {
    const { challenge } = await this.adminPreviewChallenge({ body });
    if (Object.values(this.state.sessions).some((s) => s.game_id === challenge.date)) throw new ApiError(409, 'challenge_in_play', 'Players have already started this date’s challenge.');
    this.state.games[challenge.date] = { ...challenge, status: 'published', created_by: user.id, sponsored_by: body.sponsored_by || null };
    this.audit(user.id, 'challenge.publish', challenge.date, { theme_word: challenge.theme_word });
    return { challenge: publicChallenge(challenge) };
  }

  async adminAudit() {
    return { entries: this.state.audit.slice(-200).reverse() };
  }

  // -------------------------------------------------------------------------
  // Preview helpers: let one browser act as player, venue staff and admin.
  // -------------------------------------------------------------------------

  async previewBecomeAdmin({ user }) {
    if (!this.state.admins.includes(user.id)) this.state.admins.push(user.id);
    return { ok: true };
  }

  async previewJoinMerchant({ body, user }) {
    const m = this.state.merchants[body.merchant_id];
    if (!m) throw notFound();
    this.state.members = this.state.members.filter((x) => x.user_id !== user.id);
    this.state.members.push({ user_id: user.id, merchant_id: m.id, role: 'owner' });
    return { ok: true };
  }

  async previewReset() {
    this.state = this.freshState(true);
    this.ledger = new MemoryLedger(this.state.ledger, { now: this.now });
    return { ok: true };
  }
}

export const AWARD_LABELS = {
  complete_daily: 'Daily challenge completed',
  target_score: 'Target score reached',
  personal_best: 'New personal best',
  sponsored_challenge: 'Sponsored challenge'
};
