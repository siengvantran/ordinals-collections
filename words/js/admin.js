// WORDS admin dashboard: platform analytics, merchants, players and their
// ledgers, redemptions, offers, earning rules, fraud signals, challenges and
// the audit log. Every action here is checked again on the server.
import { api, auth, PREVIEW } from './api.js';
import { CONFIG } from './config.js';
import { $, $$, html, raw, render, toast, fmt, uuid, confirmDialog, promptDialog } from './ui.js';

const view = $('#view');
const TABS = [['overview', 'Overview'], ['merchants', 'Merchants'], ['users', 'Players'], ['redemptions', 'Redemptions'], ['offers', 'Offers'], ['rules', 'Rules'], ['fraud', 'Fraud'], ['challenges', 'Challenges'], ['audit', 'Audit log']];

function shell(active, body) {
  render(view, html`<header class="topbar"><a class="logo" href="${CONFIG.basePath}" aria-label="WORDS"><span>W</span><span>O</span><span>R</span><span>D</span><span>S</span></a>
    <div class="row gap"><span class="badge">Admin</span><button class="btn sm ghost" id="out">Sign out</button></div></header>
    ${PREVIEW ? html`<p class="preview-flag"><b>Preview</b> · admin view of the demo data in this browser</p>` : ''}
    <nav class="tabs" aria-label="Admin">${TABS.map(([k, l]) => html`<a href="#/${k}" ${k === active ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>
    <div class="stack">${body}</div>`);
  $('#out').addEventListener('click', async () => { await auth.signOut(); route(); });
}

async function route() {
  const [path, query = ''] = (location.hash.replace(/^#/, '') || '/overview').split('?');
  const params = new URLSearchParams(query);
  try {
    if (!(await auth.current())) return signIn();
    const m = /^\/users\/([\w-]+)$/.exec(path);
    if (m) return userDetail(m[1]);
    const fn = { '/overview': overview, '/merchants': merchants, '/users': users, '/redemptions': redemptions, '/offers': offers, '/rules': rules, '/fraud': fraud, '/challenges': challenges, '/audit': audit }[path] ?? overview;
    await fn(params);
  } catch (e) {
    if (e.status === 401) { await auth.signOut(); return signIn(); }
    if (e.status === 403) return noAccess(e);
    render(view, html`<div class="card"><h2>Something went wrong</h2><p class="muted">${e.message}</p><a href="#/overview">Back</a></div>`);
  }
}

function signIn() {
  render(view, html`<header class="topbar"><a class="logo" href="${CONFIG.basePath}"><span>W</span><span>O</span><span>R</span><span>D</span><span>S</span></a></header>
    <div class="stack"><h1>Admin sign-in</h1><form id="f" class="stack"><label class="field"><span>Email</span><input name="email" type="email" required></label><button class="btn primary block">Continue</button></form><p id="sent" class="card" hidden>Check your email for the sign-in link.</p></div>`);
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await auth.signIn(e.target.email.value.trim(), `${CONFIG.basePath}admin/`);
      if (r.sent) { e.target.hidden = true; $('#sent').hidden = false; } else route();
    } catch (err) { toast(err.message, 'error'); }
  });
}

function noAccess(e) {
  render(view, html`<div class="stack" style="padding-top:40px"><h1>No admin access</h1><p class="muted">${e.message}</p>
    ${PREVIEW ? html`<button class="btn primary" id="grant">Preview: make me an admin</button>` : html`<p class="small">An existing admin adds you in the database (see supabase/README.md).</p>`}
    <button class="btn ghost" id="out">Sign out</button></div>`);
  $('#grant')?.addEventListener('click', async () => { await api('POST', '/preview/become-admin', {}); route(); });
  $('#out').addEventListener('click', async () => { await auth.signOut(); route(); });
}

const reason = (title) => promptDialog({ title, label: 'Reason (kept in the audit log)', confirm: 'Continue' });

// ---------------------------------------------------------------------------

async function overview() {
  const o = await api('GET', '/admin/overview');
  const kpi = (v, l) => html`<div class="kpi"><b>${v}</b><span>${l}</span></div>`;
  shell('overview', html`<h1>Overview</h1>
    <h3>Players</h3><div class="kpis">${kpi(o.players.registered, 'Registered')}${kpi(o.players.active_today, 'Played today')}${kpi(fmt.pct(o.players.first_redemption_rate), 'Have redeemed')}${kpi(o.players.suspended, 'Suspended')}</div>
    <h3>Games</h3><div class="kpis">${kpi(o.games.started_today, 'Started today')}${kpi(o.games.completed_today, 'Completed today')}${kpi(o.games.started_today ? fmt.pct(o.games.completed_today / o.games.started_today) : '—', 'Completion')}${kpi(o.games.completed_all_time, 'Completed (all time)')}</div>
    <h3>Points liability</h3><div class="kpis">${kpi(fmt.points(o.points.issued), 'Issued')}${kpi(fmt.points(o.points.redeemed), 'Redeemed')}${kpi(fmt.points(o.points.outstanding), 'Outstanding')}${kpi(fmt.points(o.points.held), 'Reserved now')}${kpi(fmt.pounds(o.points.outstanding_liability_pence), 'Outstanding (est. cost)')}</div>
    <p class="small muted">Issued by funding source: ${Object.entries(o.points.issued_by_source).map(([k, v]) => `${k} ${fmt.points(v)}`).join(' · ') || '—'}. Estimated cost uses the fulfilment cost per point seen in redemptions so far${o.points.pence_per_point !== null ? ` (${o.points.pence_per_point.toFixed(3)}p per point)` : ''}.</p>
    <h3>Marketplace</h3><div class="kpis">${kpi(o.merchants.approved, 'Approved venues')}${kpi(o.merchants.pending, 'Awaiting approval')}${kpi(o.offers.live, 'Live offers')}${kpi(o.redemptions.redeemed, 'Redeemed')}${kpi(o.redemptions.reserved, 'Reserved now')}${kpi(o.redemptions.expired, 'Expired')}</div>
    ${o.fraud_open ? html`<a class="banner" href="#/fraud">${o.fraud_open} open fraud signal${o.fraud_open > 1 ? 's' : ''} to review →</a>` : ''}`);
}

async function merchants() {
  const { merchants: list } = await api('GET', '/admin/merchants');
  shell('merchants', html`<h1>Merchants</h1><div class="card table-wrap"><table class="data"><thead><tr><th>Venue</th><th>Area</th><th>Offers</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map((m) => html`<tr><td><b>${m.name}</b><br><span class="small muted">${m.address} · ${m.contact_email}</span></td><td>${m.area}</td><td>${m.offers}</td><td><span class="badge ${m.status === 'approved' ? 'mint' : m.status === 'pending' ? 'sun' : 'danger'}">${m.status}</span></td>
      <td class="row gap">${m.status !== 'approved' ? html`<button class="btn sm mint ms" data-id="${m.id}" data-s="approved">Approve</button>` : ''}${m.status !== 'suspended' ? html`<button class="btn sm ghost ms" data-id="${m.id}" data-s="suspended">Suspend</button>` : ''}</td></tr>`)}
  </tbody></table></div>`);
  $$('.ms').forEach((b) => b.addEventListener('click', async () => {
    const why = b.dataset.s === 'suspended' ? await reason('Suspend venue') : 'approved';
    if (why === null) return;
    try { await api('POST', `/admin/merchants/${b.dataset.id}/status`, { status: b.dataset.s, reason: why }); route(); } catch (e) { toast(e.message, 'error'); }
  }));
}

async function users(params) {
  const q = params.get('q') ?? '';
  const { users: list } = await api('GET', `/admin/users?q=${encodeURIComponent(q)}`);
  shell('users', html`<h1>Players</h1><form id="s" class="row gap"><input class="grow field" name="q" value="${q}" placeholder="Email, name or id" style="min-height:44px;padding:0 12px;border-radius:12px;border:1px solid var(--line)"><button class="btn dark sm">Search</button></form>
    <div class="card table-wrap"><table class="data"><thead><tr><th>Player</th><th>Available</th><th>Reserved</th><th>Flags</th><th>Status</th></tr></thead><tbody>
    ${list.map((u) => html`<tr><td><a href="#/users/${u.id}"><b>${u.display_name ?? '(no name)'}</b></a><br><span class="small muted">${u.email}</span></td><td>${fmt.points(u.balance.available)}</td><td>${fmt.points(u.balance.held)}</td><td>${u.flags ? html`<span class="badge danger">${u.flags}</span>` : ''}</td><td>${u.status}</td></tr>`)}
    </tbody></table></div>`);
  $('#s').addEventListener('submit', (e) => { e.preventDefault(); location.hash = `#/users?q=${encodeURIComponent(e.target.q.value)}`; });
}

async function userDetail(id) {
  const d = await api('GET', `/admin/users/${id}/transactions`);
  shell('users', html`<a class="small" href="#/users">← Players</a><h1>${d.user.display_name ?? d.user.email}</h1><p class="muted">${d.user.email} · ${d.user.status} · <code>${d.user.id}</code></p>
    <div class="kpis"><div class="kpi"><b>${fmt.points(d.balance.available)}</b><span>Available</span></div><div class="kpi"><b>${fmt.points(d.balance.held)}</b><span>Reserved</span></div><div class="kpi"><b>${fmt.points(d.balance.earned)}</b><span>Earned</span></div><div class="kpi"><b>${fmt.points(d.balance.redeemed)}</b><span>Redeemed</span></div></div>
    <div class="row gap wrap"><button class="btn sm dark" id="adj">Adjust points</button><button class="btn sm ${d.user.status === 'active' ? 'danger' : 'mint'}" id="st">${d.user.status === 'active' ? 'Suspend account' : 'Reactivate account'}</button></div>
    <div class="card table-wrap"><h3>Ledger</h3><table class="data"><thead><tr><th>When</th><th>Type</th><th>Points</th><th>Available Δ</th><th>Held Δ</th><th>Note</th><th>Idempotency key</th></tr></thead><tbody>
      ${d.transactions.map((t) => html`<tr><td>${fmt.dateTime(t.created_at)}</td><td>${t.type}</td><td>${t.points}</td><td>${fmt.signed(t.amount)}</td><td>${fmt.signed(t.held_delta)}</td><td>${t.note ?? ''}</td><td class="small muted">${t.idempotency_key}</td></tr>`)}
    </tbody></table></div>`);
  $('#adj').addEventListener('click', async () => {
    const pts = await promptDialog({ title: 'Adjust points', label: 'Points (negative to remove)', type: 'number', confirm: 'Next' });
    if (pts === null) return;
    const why = await reason('Why?');
    if (why === null) return;
    try { await api('POST', '/admin/adjust', { user_id: id, points: Number(pts), reason: why, idempotency_key: uuid() }); toast('Adjusted', 'success'); route(); } catch (e) { toast(e.details || e.message, 'error'); }
  });
  $('#st').addEventListener('click', async () => {
    const why = await reason(d.user.status === 'active' ? 'Suspend account' : 'Reactivate account');
    if (why === null) return;
    try { await api('POST', `/admin/users/${id}/status`, { status: d.user.status === 'active' ? 'suspended' : 'active', reason: why }); route(); } catch (e) { toast(e.details || e.message, 'error'); }
  });
}

async function redemptions(params) {
  const status = params.get('status') ?? '';
  const { redemptions: list } = await api('GET', `/admin/redemptions${status ? `?status=${status}` : ''}`);
  shell('redemptions', html`<h1>Redemptions</h1><div class="chips">${['', 'reserved', 'redeemed', 'expired', 'cancelled', 'refunded'].map((s) => html`<a class="chip" href="#/redemptions${s ? `?status=${s}` : ''}" aria-pressed="${s === status}">${s || 'All'}</a>`)}</div>
    <div class="card table-wrap"><table class="data"><thead><tr><th>Reserved</th><th>Reward</th><th>Player</th><th>Status</th><th>Resolve</th></tr></thead><tbody>
    ${list.map((r) => html`<tr><td>${fmt.dateTime(r.reserved_at)}</td><td>${r.offer.title}<br><span class="small muted">${r.merchant.name}</span></td><td><a href="#/users/${r.user_id}">${r.player}</a></td><td>${r.status}${r.validated_at ? html`<br><span class="small muted">${fmt.dateTime(r.validated_at)}</span>` : ''}</td>
      <td class="row gap wrap">${r.status === 'reserved' ? html`<button class="btn sm ghost rs" data-id="${r.id}" data-a="release">Release points</button><button class="btn sm ghost rs" data-id="${r.id}" data-a="complete">Mark redeemed</button>` : ''}${r.status === 'redeemed' ? html`<button class="btn sm ghost rs" data-id="${r.id}" data-a="refund">Refund</button>` : ''}</td></tr>`)}
    </tbody></table></div>
    <p class="small muted">Release: give back the points for a reservation the venue couldn’t honour. Mark redeemed: the venue honoured it but couldn’t validate (e.g. offline). Refund: reverse a completed redemption.</p>`);
  $$('.rs').forEach((b) => b.addEventListener('click', async () => {
    const why = await reason(`${b.textContent}`);
    if (why === null) return;
    try { await api('POST', `/admin/redemptions/${b.dataset.id}/resolve`, { action: b.dataset.a, reason: why }); toast('Done', 'success'); route(); } catch (e) { toast(e.details || e.message, 'error'); }
  }));
}

async function offers() {
  const { offers: list } = await api('GET', '/admin/offers');
  shell('offers', html`<h1>Offers</h1><div class="card table-wrap"><table class="data"><thead><tr><th>Offer</th><th>WORDS</th><th>Stock</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map((o) => html`<tr><td><b>${o.title}</b><br><span class="small muted">${o.merchant?.name}</span></td><td>${fmt.points(o.points_price)}</td><td>${o.remaining} left · ${o.reserved} reserved · ${o.redeemed} redeemed</td><td>${o.suspended ? html`<span class="badge danger">suspended</span>` : o.status}</td>
      <td><button class="btn sm ghost sus" data-id="${o.id}" data-s="${o.suspended ? 'false' : 'true'}">${o.suspended ? 'Unsuspend' : 'Suspend'}</button></td></tr>`)}
  </tbody></table></div>`);
  $$('.sus').forEach((b) => b.addEventListener('click', async () => {
    const why = await reason(b.textContent);
    if (why === null) return;
    try { await api('POST', `/admin/offers/${b.dataset.id}/suspend`, { suspended: b.dataset.s === 'true', reason: why }); route(); } catch (e) { toast(e.details || e.message, 'error'); }
  }));
}

const RULE_HELP = {
  welcome_bonus: 'WORDS for a new player, once', complete_daily: 'Completing the daily challenge', target_score: 'Reaching the target score',
  personal_best: 'Beating your best daily score', sponsored_challenge: 'Completing a sponsored challenge', referral: 'Referrer, after the friend’s first game',
  daily_game_cap: 'Most WORDS from gameplay per day', referral_monthly_cap: 'Most referral rewards per player per month',
  reservation_minutes: 'Default minutes a reserved code is valid', expiry_inactive_days: 'Days without activity before a balance expires'
};

async function rules() {
  const { rules: r } = await api('GET', '/admin/rules');
  shell('rules', html`<h1>Earning rules</h1><form id="f" class="card stack">
    ${Object.entries(r).map(([k, v]) => html`<label class="field"><span>${RULE_HELP[k] ?? k}</span><input name="${k}" type="number" value="${v}" required><small>${k}</small></label>`)}
    <button class="btn primary">Save rules</button></form><p class="small muted">Changes apply to points issued from now on. Already-issued points never change.</p>`);
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const patch = Object.fromEntries([...new FormData(e.target)].map(([k, v]) => [k, Number(v)]));
    if (!(await confirmDialog({ title: 'Change earning rules?', body: 'This changes how many points every player earns from now on.', confirm: 'Save' }))) return;
    try { await api('POST', '/admin/rules', { rules: patch }); toast('Saved', 'success'); } catch (err) { toast(err.details || err.message, 'error'); }
  });
}

async function fraud() {
  const { signals } = await api('GET', '/admin/fraud');
  const label = { fast_play: 'Very fast play', implausible_coverage: 'Found an implausible share of words', referral_cap: 'Hit the referral cap', rate_limited: 'Rate limited' };
  shell('fraud', html`<h1>Fraud signals</h1><p class="muted small">Signals are prompts to look, not conclusions. Points are not withheld automatically.</p>
    <div class="card table-wrap"><table class="data"><thead><tr><th>When</th><th>Player</th><th>Signal</th><th>Details</th><th>Status</th></tr></thead><tbody>
    ${signals.map((f) => html`<tr><td>${fmt.dateTime(f.created_at)}</td><td><a href="#/users/${f.user_id}">${f.display_name ?? f.user_id}</a></td><td>${label[f.kind] ?? f.kind}</td><td class="small">${JSON.stringify(f.details)}</td>
      <td>${f.status === 'open' ? html`<button class="btn sm ghost fr" data-id="${f.id}" data-s="dismissed">Dismiss</button> <button class="btn sm danger fr" data-id="${f.id}" data-s="confirmed">Confirm</button>` : f.status}</td></tr>`)}
    </tbody></table>${signals.length ? '' : html`<p class="empty">Nothing flagged.</p>`}</div>`);
  $$('.fr').forEach((b) => b.addEventListener('click', async () => { await api('POST', `/admin/fraud/${b.dataset.id}/resolve`, { status: b.dataset.s }); route(); }));
}

async function challenges() {
  const c = await api('GET', '/admin/challenges');
  const tomorrow = new Date(Date.parse(`${c.today}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  shell('challenges', html`<h1>Challenges</h1>
    <form id="f" class="card stack"><h3>Prepare a challenge</h3>
      <div class="grid2"><label class="field"><span>Date</span><input name="date" type="date" value="${tomorrow}" min="${c.today}" required></label>
      <label class="field"><span>Word of the day (6–8 letters, optional)</span><input name="theme_word" maxlength="8" pattern="[A-Za-z]{6,8}"></label></div>
      <label class="field"><span>Theme hint (optional, shown after play)</span><input name="theme_hint" maxlength="80"></label>
      <div class="row gap wrap"><button type="button" class="btn ghost sm" id="suggest">Suggest themed words (AI)</button><button class="btn dark sm">Generate preview</button></div>
      <div id="sugg" class="row gap wrap"></div><div id="prev"></div></form>
    <div class="card table-wrap"><h3>Recent and upcoming</h3><table class="data"><thead><tr><th>Date</th><th>Word of the day</th><th>Words</th><th>Target</th><th>Players</th><th>Made by</th></tr></thead><tbody>
      ${c.challenges.map((g) => html`<tr><td>${g.date}</td><td>${g.theme_word}</td><td>${g.word_count}</td><td>${g.target_score}</td><td>${g.players}</td><td>${g.created_by === 'auto' ? 'auto' : 'admin'}</td></tr>`)}
    </tbody></table></div>`);
  const form = $('#f');
  let attempt = 0;
  $('#suggest').addEventListener('click', async () => {
    try {
      const s = await api('POST', '/admin/challenges/suggest', { theme: form.theme_hint.value || null });
      render($('#sugg'), html`${s.suggestions.map((x) => html`<button type="button" class="btn sm ghost pick" data-w="${x.word}" data-h="${x.hint ?? ''}">${x.word}</button>`)}<span class="small muted">${s.source === 'preview' ? 'Preview: from the built-in list' : 'Suggested by AI, checked against the dictionary'}</span>`);
      $$('.pick').forEach((b) => b.addEventListener('click', () => { form.theme_word.value = b.dataset.w; if (b.dataset.h) form.theme_hint.value = b.dataset.h; }));
    } catch (e) { toast(e.message, 'error'); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { date: form.date.value, theme_word: form.theme_word.value.toLowerCase() || null, theme_hint: form.theme_hint.value || null, attempt };
    try {
      const { challenge: ch } = await api('POST', '/admin/challenges/preview', body);
      render($('#prev'), html`<div class="card flat stack"><div class="row gap" style="align-items:flex-start">
        <div class="board" style="width:180px;gap:4px;padding:4px">${ch.tiles.map((t, i) => html`<div class="tile${i === ch.star ? ' star' : ''}" style="font-size:20px;border-radius:8px">${t === 'q' ? 'Qu' : t.toUpperCase()}</div>`)}</div>
        <div class="small"><b>${ch.word_count}</b> words · max ${ch.max_score} · target ${ch.target_score}<br>Word of the day: <b>${ch.theme_word}</b><br>Longest: ${ch.solutions.slice().sort((a, b) => b.word.length - a.word.length).slice(0, 5).map((s) => s.word).join(', ')}</div></div>
        <div class="row gap"><button type="button" class="btn ghost sm" id="again">Another grid</button><button type="button" class="btn primary sm" id="pub">Publish for ${ch.date}</button></div></div>`);
      $('#again').addEventListener('click', () => { attempt++; form.requestSubmit(); });
      $('#pub').addEventListener('click', async () => {
        try { await api('POST', '/admin/challenges/publish', body); toast('Published', 'success'); route(); } catch (err) { toast(err.details || err.message, 'error'); }
      });
    } catch (err) { toast(err.details || err.message, 'error'); }
  });
}

async function audit() {
  const { entries } = await api('GET', '/admin/audit');
  shell('audit', html`<h1>Audit log</h1><div class="card table-wrap"><table class="data"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th></tr></thead><tbody>
    ${entries.map((a) => html`<tr><td>${fmt.dateTime(a.at)}</td><td class="small">${a.actor}</td><td>${a.action}</td><td class="small">${a.target}</td><td class="small">${JSON.stringify(a.details)}</td></tr>`)}
  </tbody></table></div>`);
}

window.addEventListener('hashchange', route);
route();
