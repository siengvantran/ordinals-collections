// WORDS player app: onboarding, sign-in, the daily game, results, wallet,
// rewards, QR redemption, profile and leaderboard. Hash routes, no build step.
import { api, auth, PREVIEW, resetPreview } from './api.js';
import { CONFIG } from './config.js';
import { mountGame } from './game.js';
import {
  $, $$, html, raw, render, toast, fmt, availabilityLabel, REASON_TEXT, CATEGORY_LABELS,
  uuid, qrSvg, confirmDialog
} from './ui.js';

const view = $('#view');
const tabbar = $('#tabbar');
let me = null;          // /me response, or null when signed out
let cleanup = null;     // teardown for the current screen
const CODES_KEY = 'words_codes';

const ICONS = {
  today: '<path d="M4 5h16v15H4zM4 9h16M9 3v4M15 3v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  play: '<path d="M5 5h6v6H5zM13 5h6v6h-6zM5 13h6v6H5zM13 13h6v6h-6z" fill="currentColor"/>',
  rewards: '<path d="M4 10h16v10H4zM2 7h20v3H2zM12 7v13M12 7c-2-4-6-4-6-1s6 1 6 1zm0 0c2-4 6-4 6-1s-6 1-6 1z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  wallet: '<path d="M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l12-4v4M16 13h2" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  me: '<circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
};

// ---------------------------------------------------------------------------
// Local copies of redemption codes (the server keeps only hashes)
// ---------------------------------------------------------------------------

function codes() {
  try { return JSON.parse(localStorage.getItem(CODES_KEY) || '{}'); } catch { return {}; }
}
function rememberCode(r) {
  if (!r.code) return;
  const all = codes();
  all[r.id] = { code: r.code, qr_payload: r.qr_payload };
  try { localStorage.setItem(CODES_KEY, JSON.stringify(all)); } catch { /* ignore */ }
}

function validationUrl(code) {
  return new URL(`${CONFIG.basePath}merchant/#/validate?code=${code}`, location.origin).href;
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function topbar(extra = '') {
  const bal = me?.balance;
  return html`<header class="topbar">
    <a class="logo" href="#/" aria-label="WORDS home"><span>W</span><span>O</span><span>R</span><span>D</span><span>S</span></a>
    ${bal ? html`<a class="balance-pill" href="#/wallet" aria-label="Your balance: ${fmt.points(bal.available)} WORDS">${fmt.points(bal.available)} <small>WORDS</small></a>` : raw(extra)}
  </header>${PREVIEW ? html`<p class="preview-flag"><b>Preview</b> · demo venues, saved in this browser only</p>` : ''}`;
}

function drawTabs(active) {
  if (!me?.display_name) { tabbar.hidden = true; return; }
  tabbar.hidden = false;
  const tabs = [['today', '#/', 'Today'], ['play', '#/play', 'Play'], ['rewards', '#/rewards', 'Rewards'], ['wallet', '#/wallet', 'Wallet'], ['me', '#/profile', 'Me']];
  render(tabbar, html`<nav aria-label="Main">${tabs.map(([k, href, label]) => html`<a href="${href}" class="${k === 'play' ? 'play-tab' : ''}" ${k === active ? raw('aria-current="page"') : ''}>
    ${k === 'play' ? html`<span class="ic"><svg viewBox="0 0 24 24" aria-hidden="true">${raw(ICONS[k])}</svg></span>` : html`<svg viewBox="0 0 24 24" aria-hidden="true">${raw(ICONS[k])}</svg>`}${label}</a>`)}</nav>`);
}

async function refreshMe() {
  const a = await auth.current();
  if (!a) { me = null; return null; }
  try {
    me = await api('GET', '/me');
  } catch (e) {
    if (e.status === 401) { await auth.signOut(); me = null; }
    else throw e;
  }
  return me;
}

function screen(content, tab) {
  if (cleanup) { cleanup(); cleanup = null; }
  render(view, content);
  drawTabs(tab);
  window.scrollTo(0, 0);
  view.focus({ preventScroll: true });
}

function errorScreen(e) {
  screen(html`${topbar()}<div class="card stack"><h2>Something went wrong</h2><p class="muted">${e.message}</p><a class="btn primary" href="#/">Back to today</a></div>`);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const ROUTES = [
  [/^\/?$/, today, 'today'],
  [/^\/welcome$/, welcome],
  [/^\/signin$/, signIn],
  [/^\/setup$/, setup],
  [/^\/play$/, play, 'play'],
  [/^\/results$/, results, 'play'],
  [/^\/rewards$/, rewards, 'rewards'],
  [/^\/rewards\/([\w-]+)$/, rewardDetail, 'rewards'],
  [/^\/redemption\/([\w-]+)$/, redemption, 'wallet'],
  [/^\/wallet$/, wallet, 'wallet'],
  [/^\/leaderboard$/, leaderboard, 'today'],
  [/^\/profile$/, profile, 'me'],
  [/^\/terms$/, terms]
];
const PUBLIC = new Set([welcome, signIn, rewards, rewardDetail, leaderboard, terms]);

async function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = hash.split('?');
  const params = new URLSearchParams(query);
  const match = ROUTES.find(([re]) => re.test(path));
  if (!match) { location.hash = '#/'; return; }
  const [re, fn, tab] = match;
  try {
    if (!PUBLIC.has(fn)) {
      if (!me) return go(fn === today ? '#/welcome' : '#/signin');
      if (!me.display_name && fn !== setup) return go('#/setup');
    }
    await fn({ args: re.exec(path).slice(1), params, tab });
  } catch (e) {
    if (e.code === 'profile_required') return go('#/setup');
    if (e.status === 401) { me = null; return go('#/signin'); }
    errorScreen(e);
  }
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

// ---------------------------------------------------------------------------
// Onboarding and accounts
// ---------------------------------------------------------------------------

async function welcome() {
  screen(html`<div class="onboard">
    <a class="logo" href="#/welcome" aria-label="WORDS"><span>W</span><span>O</span><span>R</span><span>D</span><span>S</span></a>
    <div><h1>Play words.<br>Earn points.<br>Enjoy real rewards.</h1></div>
    <div class="demo-tiles" aria-hidden="true"><span class="on">P</span><span class="on">L</span><span class="on">A</span><span class="on">Y</span><span>S</span></div>
    <ol class="steps">
      <li><div><b>Find words in the grid</b><br><span class="muted">Drag across touching letters. One five-minute challenge a day, the same for everyone.</span></div></li>
      <li><div><b>Earn WORDS points</b><br><span class="muted">100 for finishing, more for hitting the target. 250 to start you off.</span></div></li>
      <li><div><b>Spend them nearby</b><br><span class="muted">Coffee, food, live music and theatre around Elephant &amp; Castle. Show a QR code at the venue.</span></div></li>
    </ol>
    <a class="btn primary block" href="#/signin">Get started</a>
    <a class="btn ghost block" href="#/rewards">Browse rewards first</a>
  </div>`);
}

async function signIn() {
  if (me?.display_name) return go('#/');
  screen(html`${topbar()}<div class="stack">
    <h1>Sign in</h1>
    <p class="muted">${PREVIEW ? 'Preview mode: enter any email. Nothing is sent.' : 'We’ll email you a link. No password needed.'}</p>
    <form id="f" class="stack" novalidate>
      <label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" inputmode="email" required></label>
      <label class="check"><input type="checkbox" name="terms" required><span>I agree to the <a href="#/terms">programme terms</a>: WORDS points have no cash value, can’t be transferred and are redeemable only for listed rewards.</span></label>
      <button class="btn primary block">${PREVIEW ? 'Continue' : 'Email me a sign-in link'}</button>
    </form>
    <div id="sent" hidden class="card"><h3>Check your email</h3><p class="muted">Open the link on this device to sign in.</p></div>
  </div>`);
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!f.terms.checked) return toast('Please agree to the programme terms.', 'error');
    if (!f.email.value.includes('@')) return toast('Enter your email address.', 'error');
    try {
      const res = await auth.signIn(f.email.value.trim(), `${CONFIG.basePath}#/setup`);
      if (res.sent) { f.hidden = true; $('#sent').hidden = false; return; }
      await refreshMe();
      go(me.display_name ? '#/' : '#/setup');
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function setup() {
  if (!me) return go('#/signin');
  if (me.display_name) return go('#/');
  let ref = '';
  try { ref = sessionStorage.getItem('words_ref') || ''; } catch { /* ignore */ }
  screen(html`${topbar()}<div class="stack">
    <h1>Choose your name</h1>
    <p class="muted">It appears on leaderboards. Don’t use your full name.</p>
    <form id="f" class="stack">
      <label class="field"><span>Display name</span><input name="name" maxlength="24" minlength="2" autocomplete="nickname" required></label>
      <label class="field"><span>Friend’s invite code (optional)</span><input name="ref" maxlength="12" value="${ref}" autocapitalize="characters"></label>
      <button class="btn primary block">Start playing</button>
    </form>
  </div>`);
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      me = await api('POST', '/profile', { display_name: e.target.name.value, referral_code: e.target.ref.value || undefined });
      toast(`Welcome! ${fmt.points(me.balance.available)} WORDS to start you off.`, 'success');
      go('#/');
    } catch (err) { toast(err.details || err.message, 'error'); }
  });
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

function nextRewardCard(offers, balance) {
  const affordable = offers.filter((o) => o.available && o.points_price <= balance.available);
  if (affordable.length) {
    return html`<a class="card brand stack" href="#/rewards" style="text-decoration:none">
      <span class="eyebrow" style="color:inherit;opacity:.8">Ready to redeem</span>
      <h2>You can claim ${affordable.length === 1 ? affordable[0].title : `${affordable.length} rewards`} now</h2>
      <span>See rewards →</span></a>`;
  }
  const next = offers.filter((o) => o.available).sort((a, b) => a.points_price - b.points_price)[0];
  if (!next) return '';
  const pct = Math.min(100, Math.round((balance.available / next.points_price) * 100));
  return html`<a class="card stack" href="#/rewards/${next.id}" style="text-decoration:none">
    <span class="eyebrow">Next reward</span>
    <div class="row gap"><div class="offer-img">${next.image}</div><div class="grow"><h3>${next.title}</h3><span class="muted small">${next.merchant?.name}</span></div></div>
    <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
    <span class="small"><b>${fmt.points(next.points_price - balance.available)} more WORDS</b> to go</span></a>`;
}

async function today() {
  const [t, o, lb] = await Promise.all([api('GET', '/game/today'), api('GET', '/offers'), api('GET', '/game/leaderboard')]);
  await refreshMe();
  const s = t.session;
  const ch = t.challenge;
  let card;
  if (!s) {
    card = html`<div class="card hero stack">
      <span class="eyebrow" style="color:inherit;opacity:.7">${fmt.dayName(ch.date)}</span>
      <h1>Today’s WORDS GRID</h1>
      <p class="muted">${ch.word_count} words hidden, including one ${ch.theme_length}-letter word of the day. Target: ${ch.target_score}.</p>
      <a class="btn primary block" href="#/play">Play · 5 minutes</a>
      <p class="small muted center">+${100} WORDS for finishing · +25 for hitting the target</p></div>`;
  } else if (s.status === 'active') {
    card = html`<div class="card hero stack"><span class="eyebrow" style="color:inherit;opacity:.7">In progress</span><h1>${fmt.duration(new Date(s.ends_at) - Date.now())} left</h1>
      <p class="muted">${s.words.length} words · ${s.score} points so far</p><a class="btn primary block" href="#/play">Continue</a></div>`;
  } else {
    const earned = s.awards.reduce((a, x) => a + x.points, 0);
    card = html`<a class="card hero stack" href="#/results" style="text-decoration:none"><span class="eyebrow" style="color:inherit;opacity:.7">Today’s result</span>
      <div class="row between"><div><div class="big-number">${s.score}</div><span class="muted">${s.words.length} words${lb.me ? ` · #${lb.me.rank} of ${lb.players}` : ''}</span></div>
      <span class="badge mint">+${earned} WORDS</span></div><span>See results →</span></a>`;
  }
  screen(html`${topbar()}<div class="stack">
    <p class="muted">Hi ${me.display_name}${me.progress.streak > 1 ? html` · 🔥 ${me.progress.streak}-day streak` : ''}</p>
    ${card}
    ${nextRewardCard(o.offers, me.balance)}
    <section class="card stack"><div class="row between"><h3>Today’s leaderboard</h3><a class="small" href="#/leaderboard">See all</a></div>
      ${lb.top.length ? html`<ol class="list">${lb.top.slice(0, 3).map((r) => html`<li><b>#${r.rank}</b><span class="grow">${r.display_name}${r.me ? ' (you)' : ''}</span><b>${r.score}</b></li>`)}</ol>` : html`<p class="muted small">No scores yet today. Be the first.</p>`}
    </section>
    <section class="stack"><div class="row between"><h3>Rewards near you</h3><a class="small" href="#/rewards">All rewards</a></div>
      ${o.offers.slice(0, 3).map((x) => offerCard(x, me.balance))}</section>
  </div>`, 'today');
}

// ---------------------------------------------------------------------------
// Game and results
// ---------------------------------------------------------------------------

async function play() {
  const t = await api('GET', '/game/today');
  if (t.session?.status === 'completed') return go('#/results');
  const session = t.session ?? await api('POST', '/game/start', {});
  const clockOffset = new Date(t.server_time).getTime() - Date.now();
  screen(html`${topbar()}<div id="game"></div>`, 'play');
  cleanup = mountGame($('#game'), {
    challenge: t.challenge, session, clockOffset,
    onFinish: () => go('#/results')
  });
}

async function results() {
  const [t, lb] = await Promise.all([api('GET', '/game/today'), api('GET', '/game/leaderboard')]);
  await refreshMe();
  const s = t.session;
  if (!s || s.status !== 'completed') return go('#/play');
  const earned = s.awards.reduce((a, x) => a + x.points, 0);
  const labels = { complete_daily: 'Challenge complete', target_score: 'Target score reached', personal_best: 'New personal best', sponsored_challenge: 'Sponsored challenge' };
  const foundSet = new Set(s.words.map((w) => w.word));
  const share = `WORDS · ${t.challenge.date}\n${s.score} points · ${s.words.length}/${t.challenge.word_count} words${s.theme_found ? ' · ★ found the word of the day' : ''}\n${new URL(CONFIG.basePath, location.origin).href}`;
  screen(html`${topbar()}<div class="stack">
    <div class="card hero stack center"><span class="eyebrow" style="color:inherit;opacity:.7">${fmt.dayName(t.challenge.date)}</span>
      <div class="big-number">${s.score}</div><p class="muted">${s.words.length} of ${t.challenge.word_count} words${lb.me ? ` · #${lb.me.rank} of ${lb.players} today` : ''}</p>
      ${s.score >= t.challenge.target_score ? html`<span class="badge sun" style="margin:0 auto">Target ${t.challenge.target_score} reached</span>` : html`<span class="small muted">Target was ${t.challenge.target_score}</span>`}</div>
    <div class="card stack"><div class="row between"><h3>WORDS earned</h3><b class="pos">+${earned}</b></div>
      ${s.awards.length ? html`<ul class="list">${s.awards.map((a) => html`<li><span class="grow">${labels[a.kind] ?? a.kind}</span><b>+${a.points}</b></li>`)}</ul>` : html`<p class="small muted">You’ve reached today’s earning limit. Your score still counts on the leaderboard.</p>`}
      <div class="row between"><span class="muted">Balance</span><b>${fmt.points(me.balance.available)} WORDS</b></div>
      <a class="btn primary block" href="#/rewards">Spend your WORDS</a></div>
    <div class="card stack"><h3>Word of the day</h3>
      <p><button class="btn sm dark explain" data-w="${t.reveal.theme_word}">${t.reveal.theme_word.toUpperCase()}</button> ${s.theme_found ? html`<span class="badge mint">You found it</span>` : html`<span class="muted small">Missed it this time</span>`}</p>
      <h3>Best words today</h3>
      <div class="row wrap gap">${t.reveal.top_words.map((w) => html`<button class="btn sm ${foundSet.has(w.word) ? 'mint' : 'ghost'} explain" data-w="${w.word}">${w.word} · ${w.score}</button>`)}</div>
      <p class="small muted">Tap a word to learn about it.</p></div>
    <div class="card stack"><h3>Your words</h3><div class="row wrap gap">${s.words.map((w) => html`<button class="btn sm ghost explain" data-w="${w.word}">${w.word} · ${w.score}</button>`)}</div></div>
    <div class="row gap"><button class="btn ghost grow" id="share">Share result</button><a class="btn ghost grow" href="#/leaderboard">Leaderboard</a></div>
  </div>`, 'play');
  $('#share').addEventListener('click', async () => {
    try {
      if (navigator.share) await navigator.share({ text: share });
      else { await navigator.clipboard.writeText(share); toast('Copied to clipboard', 'success'); }
    } catch { /* cancelled */ }
  });
  $$('.explain').forEach((b) => b.addEventListener('click', () => explain(b.dataset.w)));
}

async function explain(word) {
  const d = document.createElement('dialog');
  d.className = 'sheet';
  d.innerHTML = String(html`<h2>${word.toUpperCase()}</h2><div class="sheet-body" id="ex">Looking it up…</div><form method="dialog"><button class="btn block">Close</button></form>`);
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  d.showModal();
  try {
    const x = await api('POST', '/game/explain', { word });
    render($('#ex', d), x.definition
      ? html`<p><b>${x.part_of_speech ?? ''}</b> ${x.definition}</p>${x.etymology ? html`<p class="small" style="margin-top:8px"><b>Origin:</b> ${x.etymology}</p>` : ''}${x.fun_fact ? html`<p class="small" style="margin-top:8px">${x.fun_fact}</p>` : ''}<p class="small muted" style="margin-top:8px">AI-generated explanation · worth ${x.score} points</p>`
      : html`<p>Worth ${x.score} points.</p><p class="small" style="margin-top:8px">${x.note}</p>`);
  } catch (e) {
    render($('#ex', d), html`<p>${e.message}</p>`);
  }
}

async function leaderboard() {
  const lb = await api('GET', '/game/leaderboard');
  screen(html`${topbar()}<div class="stack"><h1>Leaderboard</h1><p class="muted">${fmt.dayName(lb.date)} · ${lb.players} players</p>
    <div class="card">${lb.top.length ? html`<ol class="list">${lb.top.map((r) => html`<li style="${r.me ? 'font-weight:800' : ''}"><b style="width:36px">#${r.rank}</b><span class="grow">${r.display_name}${r.me ? ' (you)' : ''}</span><span class="muted small">${r.words} words</span><b>${r.score}</b></li>`)}</ol>` : html`<p class="empty">No finished games yet today.</p>`}
    ${lb.me && lb.me.rank > 50 ? html`<p class="small" style="margin-top:10px">You: #${lb.me.rank} · ${lb.me.score}</p>` : ''}</div>
    <p class="small muted">Ties are broken by who finished first. Everyone plays the same grid.</p></div>`, 'today');
}

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

function offerCard(o, balance) {
  const short = balance && o.available ? o.points_price - balance.available : 0;
  return html`<a class="card offer${o.available ? '' : ' unavailable'}" href="#/rewards/${o.id}">
    <div class="offer-img">${o.image?.startsWith('http') ? html`<img src="${o.image}" alt="">` : o.image}</div>
    <div class="grow"><h3>${o.title}</h3><div class="small muted">${o.merchant?.name}</div>
      <div class="row gap wrap small" style="margin-top:4px"><span class="badge">${o.available ? availabilityLabel(o) : REASON_TEXT[o.unavailable_reason] ?? 'Unavailable'}</span>${o.available && o.remaining <= 5 ? html`<span class="badge brand">${o.remaining} left</span>` : ''}${o.welcome ? html`<span class="badge sun">Welcome reward</span>` : ''}</div>
      ${short > 0 ? html`<div class="small muted" style="margin-top:4px">${fmt.points(short)} more WORDS needed</div>` : ''}</div>
    <div class="pts">${fmt.points(o.points_price)}<small>WORDS</small></div></a>`;
}

async function rewards({ params }) {
  const q = new URLSearchParams();
  if (params.get('category')) q.set('category', params.get('category'));
  if (params.get('area')) q.set('area', params.get('area'));
  if (params.get('available')) q.set('available', 'now');
  const data = await api('GET', `/offers?${q}`);
  const link = (patch) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v ? p.set(k, v) : p.delete(k);
    return `#/rewards${p.toString() ? `?${p}` : ''}`;
  };
  const cat = params.get('category');
  screen(html`${topbar(me ? '' : '<a class="btn sm primary" href="#/signin">Sign in</a>')}<div class="stack">
    <h1>Rewards</h1>
    ${data.balance ? html`<div class="card hero row between"><div><span class="eyebrow" style="color:inherit;opacity:.7">Your balance</span><div class="big-number">${fmt.points(data.balance.available)}</div></div><span class="muted">WORDS</span></div>` : ''}
    <div class="chips" role="group" aria-label="Category">
      <a class="chip" href="${link({ category: null })}" aria-pressed="${!cat}">All</a>
      ${data.categories.filter((c) => data.offers.some((o) => o.category === c) || c === cat).map((c) => html`<a class="chip" href="${link({ category: c })}" aria-pressed="${cat === c}">${CATEGORY_LABELS[c]}</a>`)}
    </div>
    <div class="row gap wrap">
      <a class="chip" href="${link({ available: params.get('available') ? null : 'now' })}" aria-pressed="${Boolean(params.get('available'))}">Available now</a>
      <select class="chip" id="area" aria-label="Area"><option value="">All areas</option>${data.areas.map((a) => html`<option ${params.get('area') === a ? raw('selected') : ''}>${a}</option>`)}</select>
    </div>
    <div class="stack">${data.offers.length ? data.offers.map((o) => offerCard(o, data.balance)) : html`<p class="empty">No rewards match. Try another filter.</p>`}</div>
  </div>`, 'rewards');
  $('#area').addEventListener('change', (e) => (location.hash = link({ area: e.target.value || null })));
}

async function rewardDetail({ args }) {
  const { offer: o, balance } = await api('GET', `/offers/${args[0]}`);
  const canAfford = balance && balance.available >= o.points_price;
  const maps = o.merchant?.lat ? `https://www.google.com/maps/search/?api=1&query=${o.merchant.lat},${o.merchant.lng}` : null;
  screen(html`${topbar()}<div class="stack">
    <a class="small" href="#/rewards">← All rewards</a>
    <div class="offer-img lg">${o.image?.startsWith('http') ? html`<img src="${o.image}" alt="">` : o.image}</div>
    <div><h1>${o.title}</h1><p class="muted">${o.merchant.name}</p></div>
    <div class="card stack">
      <div class="row between"><span class="muted">Price</span><b class="display" style="font-size:22px">${fmt.points(o.points_price)} WORDS</b></div>
      <div class="row between"><span class="muted">When</span><span>${availabilityLabel(o)}</span></div>
      <div class="row between"><span class="muted">Left</span><span>${o.remaining} of ${o.quantity_total}</span></div>
      ${o.valid_until ? html`<div class="row between"><span class="muted">Ends</span><span>${fmt.dateTime(o.valid_until)}</span></div>` : ''}
      <div class="row between"><span class="muted">Code valid for</span><span>${o.hold_minutes >= 60 ? `${Math.round(o.hold_minutes / 60)} hours` : `${o.hold_minutes} minutes`} after you reserve</span></div>
      ${o.max_per_customer ? html`<div class="row between"><span class="muted">Limit</span><span>${o.max_per_customer} per player</span></div>` : ''}
    </div>
    ${o.description ? html`<p>${o.description}</p>` : ''}
    ${o.terms ? html`<div class="card flat small"><b>Conditions</b><p class="muted">${o.terms}</p></div>` : ''}
    <div class="card flat small row between gap"><span>${o.merchant.address}</span>${maps ? html`<a class="btn sm ghost" href="${maps}" target="_blank" rel="noopener">Map</a>` : ''}</div>
    ${!me ? html`<a class="btn primary block" href="#/signin">Sign in to reserve</a>`
      : !o.available ? html`<button class="btn block" disabled>${REASON_TEXT[o.unavailable_reason] ?? 'Unavailable'}</button>`
      : canAfford ? html`<button class="btn primary block" id="reserve">Reserve for ${fmt.points(o.points_price)} WORDS</button>`
      : html`<button class="btn block" disabled>${fmt.points(o.points_price - balance.available)} more WORDS needed</button><a class="btn ghost block" href="#/play">Play to earn more</a>`}
  </div>`, 'rewards');
  $('#reserve')?.addEventListener('click', async (e) => {
    const ok = await confirmDialog({
      title: `Reserve ${o.title}?`,
      body: html`<p>${fmt.points(o.points_price)} WORDS are held now and only taken when ${o.merchant.name} scans your code. If you don’t use it within ${o.hold_minutes >= 60 ? `${Math.round(o.hold_minutes / 60)} hours` : `${o.hold_minutes} minutes`}, they come back to you.</p>`,
      confirm: 'Reserve'
    });
    if (!ok) return;
    e.target.disabled = true;
    try {
      const res = await api('POST', '/redemptions', { offer_id: o.id, idempotency_key: uuid() });
      rememberCode(res.redemption);
      go(`#/redemption/${res.redemption.id}`);
    } catch (err) {
      toast(err.message, 'error');
      e.target.disabled = false;
    }
  });
}

async function redemption({ args }) {
  const id = args[0];
  await refreshMe();
  const list = (await api('GET', '/redemptions')).redemptions;
  let r = list.find((x) => x.id === id);
  if (!r) throw Object.assign(new Error('We couldn’t find that reservation.'), { code: 'not_found' });
  if (r.status === 'reserved' && !codes()[id]) {
    r = (await api('POST', `/redemptions/${id}/code`, {})).redemption;
    rememberCode(r);
  }
  const local = codes()[id];
  const draw = async (r) => {
    if (r.status === 'reserved') {
      const svg = await qrSvg(validationUrl(local.code));
      screen(html`${topbar()}<div class="stack center">
        <h1>${r.offer.title}</h1><p class="muted">${r.merchant.name}</p>
        <div class="qr-box" aria-label="QR code for your reward">${raw(svg)}</div>
        <div><span class="eyebrow">Or tell staff this code</span><div class="code-text">${local.code}</div></div>
        <div class="card"><span class="muted">Expires in</span> <b id="left"></b><br><span class="small muted">${fmt.points(r.points)} WORDS reserved</span></div>
        <p class="small muted">Show this screen at the counter. Staff scan it or type the code.</p>
        <button class="btn ghost block" id="cancel">Cancel reservation</button>
      </div>`, 'wallet');
      const tick = () => { const el = $('#left'); if (el) el.textContent = fmt.duration(new Date(r.expires_at) - Date.now()); };
      tick();
      const t1 = setInterval(tick, 1000);
      // Poll so the player sees the venue's confirmation straight away.
      const t2 = setInterval(async () => {
        try {
          const now = (await api('GET', '/redemptions')).redemptions.find((x) => x.id === id);
          if (now && now.status !== 'reserved') { clearInterval(t1); clearInterval(t2); await refreshMe(); draw(now); }
        } catch { /* offline: keep showing the code */ }
      }, 3000);
      cleanup = () => { clearInterval(t1); clearInterval(t2); };
      $('#cancel').addEventListener('click', async () => {
        if (!(await confirmDialog({ title: 'Cancel this reservation?', body: 'Your WORDS go straight back to your balance.', confirm: 'Cancel reservation', cancel: 'Keep it', danger: true }))) return;
        try { const res = await api('POST', `/redemptions/${id}/cancel`, {}); await refreshMe(); draw(res.redemption); } catch (e) { toast(e.message, 'error'); }
      });
      return;
    }
    const done = r.status === 'redeemed';
    screen(html`${topbar()}<div class="stack center" style="padding-top:20px">
      ${done ? html`<div class="success-tick" aria-hidden="true">✓</div><h1>Enjoy!</h1><p>${r.offer.title} at ${r.merchant.name}</p><p class="muted small">Redeemed ${fmt.dateTime(r.validated_at)} · ${fmt.points(r.points)} WORDS</p>`
        : html`<h1>${r.status === 'expired' ? 'This code expired' : r.status === 'refunded' ? 'Refunded' : 'Reservation cancelled'}</h1><p class="muted">${fmt.points(r.points)} WORDS ${r.status === 'refunded' ? 'were refunded' : 'went back to your balance'}.</p>`}
      <a class="btn primary block" href="#/rewards">More rewards</a><a class="btn ghost block" href="#/wallet">Wallet</a></div>`, 'wallet');
  };
  await draw(r);
}

// ---------------------------------------------------------------------------
// Wallet and profile
// ---------------------------------------------------------------------------

const TX_LABEL = { earn: 'Earned', reserve: 'Reserved', release: 'Returned', redeem: 'Redeemed', refund: 'Refunded', expire: 'Expired', adjust: 'Adjustment' };

async function wallet() {
  const [w, r] = await Promise.all([api('GET', '/wallet'), api('GET', '/redemptions')]);
  const active = r.redemptions.filter((x) => x.status === 'reserved');
  screen(html`${topbar()}<div class="stack">
    <h1>Wallet</h1>
    <div class="card hero stack"><span class="eyebrow" style="color:inherit;opacity:.7">Available</span><div class="big-number">${fmt.points(w.balance.available)} <span style="font-size:18px">WORDS</span></div>
      <div class="grid3 small"><div><span class="muted">Reserved</span><br><b>${fmt.points(w.balance.held)}</b></div><div><span class="muted">Earned</span><br><b>${fmt.points(w.balance.earned)}</b></div><div><span class="muted">Redeemed</span><br><b>${fmt.points(w.balance.redeemed)}</b></div></div></div>
    ${active.length ? html`<section class="stack"><h3>Ready to use</h3>${active.map((x) => html`<a class="card offer" href="#/redemption/${x.id}"><div class="offer-img">${x.offer.image}</div><div class="grow"><h3>${x.offer.title}</h3><span class="small muted">${x.merchant.name} · expires ${fmt.time(x.expires_at)}</span></div><span class="btn sm primary">Show code</span></a>`)}</section>` : ''}
    <section class="card"><h3>History</h3>
      ${w.transactions.length ? html`<ul class="list">${w.transactions.map((t) => html`<li><div class="grow"><b>${TX_LABEL[t.type]}</b> <span class="muted small">${t.note ?? ''}</span><br><span class="small muted">${fmt.dateTime(t.created_at)}</span></div>
        <b class="${t.amount > 0 ? 'pos' : t.amount < 0 ? 'neg' : ''}">${t.type === 'redeem' ? html`<span class="small muted">${fmt.points(t.points)} used</span>` : fmt.signed(t.amount)}</b></li>`)}</ul>` : html`<p class="empty">No transactions yet.</p>`}
    </section>
    <p class="small muted">Your balance is calculated from this history. Reserved WORDS are held until the venue scans your code, then used; if not, they come back.</p>
  </div>`, 'wallet');
}

async function profile() {
  await refreshMe();
  const p = me.progress;
  const nextLevelXp = Math.pow(p.level, 2) * 100;
  const prevLevelXp = Math.pow(p.level - 1, 2) * 100;
  const pct = Math.round(((p.xp - prevLevelXp) / (nextLevelXp - prevLevelXp)) * 100);
  const invite = `${new URL(CONFIG.basePath, location.origin).href}?ref=${me.referral_code}`;
  const badges = [
    [p.games_played >= 1, '🎯', 'First game'], [p.streak >= 3, '🔥', '3-day streak'], [p.streak >= 7, '🏅', '7-day streak'],
    [p.words_found >= 100, '📚', '100 words'], [me.balance.redeemed > 0, '🎁', 'First reward']
  ];
  screen(html`${topbar()}<div class="stack">
    <h1>${me.display_name}</h1>
    <div class="card stack"><div class="row between"><b>Level ${p.level}</b><span class="small muted">${fmt.points(p.xp)} XP</span></div>
      <div class="progress"><i style="width:${pct}%"></i></div><span class="small muted">XP tracks your progress. It can’t be spent: WORDS points can.</span></div>
    <div class="grid3"><div class="kpi"><b>${p.games_played}</b><span>Games</span></div><div class="kpi"><b>${p.best_score}</b><span>Best score</span></div><div class="kpi"><b>${p.streak}</b><span>Day streak</span></div></div>
    <div class="card"><h3>Achievements</h3><div class="row wrap gap" style="margin-top:8px">${badges.map(([on, icon, label]) => html`<span class="badge ${on ? 'sun' : ''}" style="${on ? '' : 'opacity:.45'}">${icon} ${label}</span>`)}</div></div>
    <div class="card stack"><h3>Invite friends</h3><p class="small muted">You get 100 WORDS when a friend joins with your code and finishes their first daily challenge (up to 10 a month).</p>
      <div class="row gap"><code class="grow display" style="font-size:22px">${me.referral_code}</code><button class="btn sm primary" id="invite">Share invite</button></div></div>
    <div class="card"><ul class="list">
      <li><a class="grow" href="#/leaderboard">Leaderboard</a></li>
      <li><a class="grow" href="#/terms">Programme terms &amp; privacy</a></li>
      <li><a class="grow" href="${CONFIG.basePath}merchant/">Venue dashboard</a></li>
      ${me.roles.admin || PREVIEW ? html`<li><a class="grow" href="${CONFIG.basePath}admin/">Admin dashboard</a></li>` : ''}
    </ul></div>
    <button class="btn ghost block" id="signout">Sign out</button>
    ${PREVIEW ? html`<button class="btn ghost block" id="reset">Reset preview data</button>` : ''}
    <p class="small muted center">${me.email ?? ''}</p>
  </div>`, 'me');
  $('#invite').addEventListener('click', async () => {
    const text = `Play WORDS with me and earn rewards around Elephant & Castle. Use my code ${me.referral_code}: ${invite}`;
    try {
      if (navigator.share) await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); toast('Invite copied', 'success'); }
    } catch { /* cancelled */ }
  });
  $('#signout').addEventListener('click', async () => { await auth.signOut(); me = null; go('#/welcome'); });
  $('#reset')?.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Reset preview?', body: 'Deletes every account, game and reward in this browser.', confirm: 'Reset', danger: true }))) return;
    resetPreview();
    location.href = CONFIG.basePath;
  });
}

async function terms() {
  screen(html`${topbar()}<article class="stack">
    <h1>Programme terms</h1>
    <p class="small muted">Version ${CONFIG.programmeTermsVersion} · pilot draft, subject to legal review before launch</p>
    <h3>WORDS points</h3>
    <ul class="stack" style="padding-left:18px">
      <li>WORDS points are loyalty points. They have no cash value and cannot be exchanged for money, sold or transferred to another person.</li>
      <li>You earn them by completing eligible gameplay, for example finishing the daily challenge. There is a daily limit on points from gameplay. Your game score and XP are separate and cannot be spent.</li>
      <li>You can only spend them on rewards listed in the app, while those rewards are available. Each reward shows its conditions, times and limits.</li>
      <li>When you reserve a reward, its points are held. They are used when the venue scans your code. If you cancel, or the code expires unused, they are returned.</li>
      <li>Your balance expires if you have no activity on your account for 12 months. We will remind you before this happens.</li>
      <li>We may withhold or remove points obtained through automated play, multiple accounts, abuse of referrals or errors, and may suspend accounts involved.</li>
      <li>If a venue cannot honour a reward you have reserved, your points are returned.</li>
    </ul>
    <h3>Privacy (summary)</h3>
    <p>We store your email address, your display name, your games, your points history and your redemptions, to run the programme and prevent fraud. Venues see your display name and the reward you redeem, not your email. We do not sell your data. You can ask us to delete your account at ${CONFIG.supportEmail}.</p>
    <p class="small muted">${PREVIEW ? 'In preview mode everything stays in this browser.' : ''}</p>
  </article>`);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function boot() {
  const ref = new URLSearchParams(location.search).get('ref');
  if (ref) try { sessionStorage.setItem('words_ref', ref.toUpperCase().slice(0, 12)); } catch { /* ignore */ }
  try { await refreshMe(); } catch (e) { console.error(e); }
  window.addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register(`${CONFIG.basePath}sw.js`).catch(() => {});
})();
