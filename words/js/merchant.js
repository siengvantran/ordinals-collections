// WORDS venue dashboard: validate codes, manage offers and inventory, see
// redemptions and performance, and use the yield engine.
import { api, auth, PREVIEW } from './api.js';
import { CONFIG } from './config.js';
import { $, $$, html, raw, render, toast, fmt, availabilityLabel, CATEGORY_LABELS, confirmDialog, promptDialog } from './ui.js';

const view = $('#view');
let ctx = null; // /merchant/me
let stopCamera = null;

const TABS = [['validate', 'Validate'], ['offers', 'Offers'], ['redemptions', 'Redemptions'], ['stats', 'Performance'], ['yield', 'Yield']];

function shell(active, body) {
  if (stopCamera) { stopCamera(); stopCamera = null; }
  const m = ctx?.merchant;
  render(view, html`<header class="topbar">
      <a class="logo" href="${CONFIG.basePath}" aria-label="WORDS"><span>W</span><span>O</span><span>R</span><span>D</span><span>S</span></a>
      <div class="row gap"><span class="small muted">${m?.name ?? 'Venues'}</span>${m ? html`<button class="btn sm ghost" id="out">Sign out</button>` : ''}</div>
    </header>
    ${PREVIEW ? html`<p class="preview-flag"><b>Preview</b> · venue view of the demo data in this browser</p>` : ''}
    ${m && m.status !== 'approved' ? html`<p class="banner">${m.status === 'pending' ? 'Your venue is waiting for approval by the WORDS team. You can prepare offers once approved.' : 'Your venue is suspended. Contact the WORDS team.'}</p>` : ''}
    ${m ? html`<nav class="tabs" aria-label="Venue">${TABS.map(([k, l]) => html`<a href="#/${k}" ${k === active ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>` : ''}
    <div class="stack">${body}</div>`);
  $('#out')?.addEventListener('click', async () => { await auth.signOut(); ctx = null; location.hash = '#/'; route(); });
}

async function load() {
  const a = await auth.current();
  if (!a) return (ctx = null);
  ctx = await api('GET', '/merchant/me');
  return ctx;
}

async function route() {
  const [path, query = ''] = (location.hash.replace(/^#/, '') || '/validate').split('?');
  const params = new URLSearchParams(query);
  try {
    if (!(await auth.current())) return signIn(params);
    await load();
    if (!ctx.merchant) return onboarding();
    const m = /^\/offers\/([\w-]+)$/.exec(path);
    if (m) return offerForm(m[1] === 'new' ? null : m[1]);
    const fn = { '/validate': validate, '/offers': offers, '/redemptions': redemptions, '/stats': stats, '/yield': yieldScreen }[path] ?? validate;
    await fn(params);
  } catch (e) {
    if (e.status === 401) { await auth.signOut(); return signIn(params); }
    shell('', html`<div class="card"><h2>Something went wrong</h2><p class="muted">${e.message}</p></div>`);
  }
}

// ---------------------------------------------------------------------------
// Sign-in and onboarding
// ---------------------------------------------------------------------------

function signIn() {
  shell('', html`<h1>Venue sign-in</h1>
    <p class="muted">${PREVIEW ? 'Preview: enter any email.' : 'We’ll email you a sign-in link.'}</p>
    <form id="f" class="stack"><label class="field"><span>Email</span><input name="email" type="email" required autocomplete="email"></label><button class="btn primary block">Continue</button></form>
    <p id="sent" class="card" hidden>Check your email for the sign-in link.</p>`);
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await auth.signIn(e.target.email.value.trim(), `${CONFIG.basePath}merchant/${location.hash}`);
      if (r.sent) { e.target.hidden = true; $('#sent').hidden = false; } else route();
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function onboarding() {
  let demo = '';
  if (PREVIEW) {
    const { offers } = await api('GET', '/offers');
    const venues = [...new Map(offers.map((o) => [o.merchant.id, o.merchant])).values()];
    demo = html`<div class="card stack"><h3>Try a demo venue</h3><p class="small muted">Preview only: act as the owner of a demo venue.</p>
      ${venues.map((v) => html`<button class="btn ghost block join" data-id="${v.id}">${v.name}</button>`)}</div>`;
  }
  shell('', html`<h1>Join WORDS as a venue</h1>${demo}
    <form id="reg" class="card stack"><h3>Register your venue</h3>
      <label class="field"><span>Venue name</span><input name="name" required minlength="2" maxlength="80"></label>
      <label class="field"><span>Type</span><select name="category">${Object.entries(CATEGORY_LABELS).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label>
      <label class="field"><span>Address</span><input name="address" required minlength="5" maxlength="200"></label>
      <label class="field"><span>Area</span><input name="area" value="Elephant & Castle" maxlength="60"></label>
      <label class="field"><span>About (optional)</span><textarea name="description" maxlength="400"></textarea></label>
      <button class="btn primary block">Register</button>
      <p class="small muted">The WORDS team checks every venue before its offers go live.</p></form>`);
  $$('.join').forEach((b) => b.addEventListener('click', async () => { await api('POST', '/preview/join-merchant', { merchant_id: b.dataset.id }); route(); }));
  $('#reg').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { await api('POST', '/merchant/register', f); toast('Registered. We’ll review your venue shortly.', 'success'); route(); } catch (err) { toast(err.details || err.message, 'error'); }
  });
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

async function validate(params) {
  shell('validate', html`<h1>Validate a reward</h1>
    <form id="f" class="card stack"><label class="field"><span>Code</span><input name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXXX-XXXXX" style="font:700 24px ui-monospace,monospace;letter-spacing:.1em;text-align:center" value="${params.get('code') ?? ''}"></label>
      <div class="row gap"><button class="btn dark grow">Check code</button><button type="button" class="btn ghost" id="scan">Scan QR</button></div></form>
    <video id="cam" playsinline muted hidden style="width:100%;border-radius:16px"></video>
    <div id="result"></div>
    <p class="small muted">Checking a code doesn’t use it. The points are only taken when you confirm.</p>`);
  const form = $('#f');
  const check = async (code) => {
    const box = $('#result');
    try {
      const r = await api('POST', '/merchant/validate', { code });
      const x = r.redemption;
      render(box, html`<div class="card stack" style="border:3px solid var(--mint)"><span class="badge mint">Valid</span>
        <div class="row gap"><div class="offer-img">${x.offer.image}</div><div class="grow"><h2>${x.offer.title}</h2><span class="muted">for ${x.player}</span></div></div>
        ${x.offer.terms ? html`<p class="small muted">${x.offer.terms}</p>` : ''}
        <p class="small">Expires ${fmt.time(x.expires_at)} · ${fmt.points(x.points)} WORDS</p>
        <button class="btn mint block" id="confirm">Confirm and redeem</button></div>`);
      $('#confirm').addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          await api('POST', '/merchant/validate', { code, confirm: true });
          render(box, html`<div class="card stack center"><div class="success-tick">✓</div><h2>Redeemed</h2><p>${x.offer.title} for ${x.player}</p>
            <button class="btn ghost" id="spend">Record what they spent (optional)</button></div>`);
          form.code.value = '';
          $('#spend').addEventListener('click', () => reportSpend(x.id));
        } catch (err) { showError(box, err); }
      });
    } catch (err) { showError(box, err); }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); check(form.code.value); });
  $('#scan').addEventListener('click', () => scan((code) => { form.code.value = code; check(code); }));
  if (params.get('code')) check(params.get('code'));
}

function showError(box, err) {
  const when = err.details?.validated_at ? ` (${fmt.dateTime(err.details.validated_at)})` : '';
  render(box, html`<div class="card stack" style="border:3px solid var(--danger)"><span class="badge danger">Not valid</span><h2>${err.message}${when}</h2><p class="small muted">Don’t hand over the reward. Ask the player to check their app.</p></div>`);
}

async function scan(onCode) {
  const video = $('#cam');
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
    return toast('Scanning isn’t supported in this browser. Use the phone camera app to open the QR, or type the code.', 'error');
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    video.srcObject = stream;
    video.hidden = false;
    await video.play();
    let live = true;
    stopCamera = () => { live = false; stream.getTracks().forEach((t) => t.stop()); video.hidden = true; };
    while (live) {
      const codes = await detector.detect(video).catch(() => []);
      if (codes[0]?.rawValue) { stopCamera(); stopCamera = null; onCode(codes[0].rawValue); return; }
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch { toast('Camera not available.', 'error'); }
}

async function reportSpend(id) {
  const v = await promptDialog({ title: 'Customer spend', label: 'Total the customer spent, in pounds (beyond the reward)', type: 'number', placeholder: '12.50', confirm: 'Save' });
  if (v === null) return;
  const pence = Math.round(Number(v) * 100);
  if (!Number.isFinite(pence) || pence < 0) return toast('Enter an amount in pounds.', 'error');
  try { await api('POST', `/merchant/redemptions/${id}/spend`, { spend_pence: pence }); toast('Saved. Thank you.', 'success'); } catch (e) { toast(e.message, 'error'); }
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

async function offers() {
  const owner = ctx.role === 'owner';
  shell('offers', html`<div class="row between"><h1>Offers</h1>${owner && ctx.merchant.status === 'approved' ? html`<a class="btn primary sm" href="#/offers/new">New offer</a>` : ''}</div>
    ${ctx.offers.length ? ctx.offers.map((o) => html`<div class="card stack"><div class="row gap"><div class="offer-img">${o.image}</div>
      <div class="grow"><h3>${o.title}</h3><span class="small muted">${fmt.points(o.points_price)} WORDS · ${availabilityLabel(o)}</span></div>
      <span class="badge ${o.suspended ? 'danger' : o.status === 'active' ? 'mint' : ''}">${o.suspended ? 'suspended' : o.status}</span></div>
      <div class="grid3 small"><div><span class="muted">Left</span><br><b>${o.remaining}/${o.quantity_total}</b></div><div><span class="muted">Reserved</span><br><b>${o.reserved}</b></div><div><span class="muted">Redeemed</span><br><b>${o.redeemed}</b></div></div>
      ${owner && !o.suspended && o.status !== 'ended' ? html`<div class="row gap wrap"><a class="btn sm ghost" href="#/offers/${o.id}">Edit</a>
        ${o.status === 'active' ? html`<button class="btn sm ghost st" data-id="${o.id}" data-s="paused">Pause</button>` : html`<button class="btn sm mint st" data-id="${o.id}" data-s="active">Publish</button>`}
        <button class="btn sm ghost st" data-id="${o.id}" data-s="ended">End</button></div>` : ''}</div>`)
    : html`<p class="empty">No offers yet.</p>`}
    <p class="small muted">Pausing or ending an offer never cancels rewards already reserved: those codes still work until they expire.</p>`);
  $$('.st').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.s === 'ended' && !(await confirmDialog({ title: 'End this offer?', body: 'It can’t be restarted. Reserved codes stay valid until they expire.', confirm: 'End offer', danger: true }))) return;
    try { await api('POST', `/merchant/offers/${b.dataset.id}/status`, { status: b.dataset.s }); route(); } catch (e) { toast(e.message, 'error'); }
  }));
}

function localInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function offerForm(id) {
  const o = id ? ctx.offers.find((x) => x.id === id) : null;
  if (id && !o) throw new Error('Offer not found');
  const v = (k, d = '') => o?.[k] ?? d;
  const pounds = (p) => (p === null || p === undefined ? '' : (p / 100).toFixed(2));
  shell('offers', html`<a class="small" href="#/offers">← Offers</a><h1>${o ? 'Edit offer' : 'New offer'}</h1>
    <form id="f" class="stack">
      <div class="card stack"><h3>The reward</h3>
        <label class="field"><span>Title</span><input name="title" required minlength="3" maxlength="80" value="${v('title')}"></label>
        <label class="field"><span>Description</span><textarea name="description" maxlength="500">${v('description')}</textarea></label>
        <div class="grid2"><label class="field"><span>Category</span><select name="category">${Object.entries(CATEGORY_LABELS).map(([k, l]) => html`<option value="${k}" ${v('category') === k ? raw('selected') : ''}>${l}</option>`)}</select></label>
        <label class="field"><span>Emoji or image URL</span><input name="image" value="${v('image', '🎁')}" maxlength="300"></label></div>
        <label class="field"><span>Terms and conditions</span><textarea name="terms" maxlength="1000">${v('terms')}</textarea></label></div>
      <div class="card stack"><h3>Price and economics</h3>
        <label class="field"><span>WORDS price</span><input name="points_price" type="number" min="50" max="100000" step="10" required value="${v('points_price', 300)}"></label>
        <div class="grid2"><label class="field"><span>Normal price (£)</span><input name="standard_price" type="number" min="0" step="0.01" value="${pounds(o?.standard_price_pence)}"></label>
        <label class="field"><span>Your cost to provide it (£)</span><input name="fulfilment_cost" type="number" min="0" step="0.01" value="${pounds(o?.fulfilment_cost_pence)}"><small>Estimated variable cost. Only you and the WORDS team see this.</small></label></div></div>
      <div class="card stack"><h3>Inventory and limits</h3>
        <div class="grid2"><label class="field"><span>Quantity available</span><input name="quantity_total" type="number" min="1" required value="${v('quantity_total', 20)}"></label>
        <label class="field"><span>Max per player</span><input name="max_per_customer" type="number" min="1" max="100" value="${v('max_per_customer', 1)}"></label></div>
        <label class="field"><span>Code valid for (minutes after reserving)</span><input name="hold_minutes" type="number" min="5" max="1440" value="${v('hold_minutes', 30)}"></label></div>
      <div class="card stack"><h3>When</h3>
        <div class="grid2"><label class="field"><span>From (optional)</span><input name="valid_from" type="datetime-local" value="${localInput(o?.valid_from)}"></label>
        <label class="field"><span>Until (optional)</span><input name="valid_until" type="datetime-local" value="${localInput(o?.valid_until)}"></label></div>
        <div class="grid2"><label class="field"><span>Daily start (optional)</span><input name="window_start" type="time" value="${v('window_start')}"></label>
        <label class="field"><span>Daily end</span><input name="window_end" type="time" value="${v('window_end')}"></label></div>
        <fieldset class="row wrap gap" style="border:0"><legend class="small" style="font-weight:700;margin-bottom:6px">Days (none = every day)</legend>
          ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => html`<label class="check"><input type="checkbox" name="days" value="${i + 1}" ${o?.days?.includes(i + 1) ? raw('checked') : ''}>${d}</label>`)}</fieldset></div>
      ${o ? '' : html`<label class="check"><input type="checkbox" name="publish" checked><span>Publish straight away</span></label>`}
      <button class="btn primary block">${o ? 'Save changes' : 'Create offer'}</button>
    </form>`);
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const num = (x) => (x.value === '' ? null : Number(x.value));
    const pence = (x) => (x.value === '' ? null : Math.round(Number(x.value) * 100));
    const iso = (x) => (x.value ? new Date(x.value).toISOString() : null);
    const body = {
      id: o?.id, title: f.title.value, description: f.description.value, category: f.category.value, image: f.image.value, terms: f.terms.value,
      points_price: num(f.points_price), standard_price_pence: pence(f.standard_price), fulfilment_cost_pence: pence(f.fulfilment_cost),
      quantity_total: num(f.quantity_total), max_per_customer: num(f.max_per_customer), hold_minutes: num(f.hold_minutes),
      valid_from: iso(f.valid_from), valid_until: iso(f.valid_until), window_start: f.window_start.value || null, window_end: f.window_end.value || null,
      days: $$('input[name=days]:checked', f).map((x) => Number(x.value)), status: f.publish?.checked ? 'active' : undefined
    };
    try { await api('POST', '/merchant/offers', body); toast('Saved', 'success'); location.hash = '#/offers'; } catch (err) { toast(err.details || err.message, 'error'); }
  });
}

// ---------------------------------------------------------------------------
// Redemptions and performance
// ---------------------------------------------------------------------------

async function redemptions() {
  const { redemptions: list } = await api('GET', '/merchant/redemptions');
  shell('redemptions', html`<h1>Redemptions</h1>
    ${list.length ? html`<div class="card table-wrap"><table class="data"><thead><tr><th>When</th><th>Reward</th><th>Player</th><th>Status</th><th>Spend</th></tr></thead><tbody>
      ${list.map((r) => html`<tr><td>${fmt.dateTime(r.validated_at ?? r.reserved_at)}</td><td>${r.offer.title}</td><td>${r.player}</td><td><span class="badge ${r.status === 'redeemed' ? 'mint' : ''}">${r.status}</span></td>
        <td>${r.status === 'redeemed' ? (r.reported_spend_pence !== null ? fmt.pounds(r.reported_spend_pence) : html`<button class="btn sm ghost sp" data-id="${r.id}">Add</button>`) : '—'}</td></tr>`)}
    </tbody></table></div>` : html`<p class="empty">No redemptions yet.</p>`}`);
  $$('.sp').forEach((b) => b.addEventListener('click', async () => { await reportSpend(b.dataset.id); route(); }));
}

async function stats() {
  const s = await api('GET', '/merchant/stats');
  const v = s.verified;
  shell('stats', html`<h1>Performance</h1>
    <h3>Verified by WORDS</h3>
    <div class="kpis"><div class="kpi"><b>${v.offers_live}</b><span>Live offers</span></div><div class="kpi"><b>${v.rewards_claimed}</b><span>Rewards claimed</span></div>
      <div class="kpi"><b>${v.rewards_redeemed}</b><span>Rewards redeemed</span></div><div class="kpi"><b>${fmt.pct(v.redemption_conversion)}</b><span>Claimed → redeemed</span></div>
      <div class="kpi"><b>${v.unique_customers}</b><span>Unique customers</span></div><div class="kpi"><b>${v.rewards_expired}</b><span>Expired unused</span></div></div>
    <h3>Reported by you</h3>
    <div class="kpis"><div class="kpi"><b>${s.reported.redemptions_with_spend}</b><span>Redemptions with spend</span></div><div class="kpi"><b>${fmt.pounds(s.reported.customer_spend_pence)}</b><span>Customer spend reported</span></div></div>
    <h3>Estimated</h3>
    <div class="kpis"><div class="kpi"><b>${fmt.pounds(s.estimated.incremental_revenue_pence)}</b><span>Incremental revenue (est.)</span></div><div class="kpi"><b>${fmt.pounds(s.estimated.fulfilment_cost_pence)}</b><span>Fulfilment cost (est.)</span></div></div>
    <p class="small muted">${s.estimated.basis}</p>`);
}

// ---------------------------------------------------------------------------
// Yield engine
// ---------------------------------------------------------------------------

async function yieldScreen() {
  const y = await api('GET', '/merchant/yield');
  const owner = ctx.role === 'owner';
  const live = ctx.offers.filter((o) => o.status !== 'ended' && !o.suspended);
  const ruleFor = (oid) => y.rules.find((r) => r.offer_id === oid);
  shell('yield', html`<h1>Yield</h1>
    <p class="muted">Release spare capacity when you’re quiet. Set price bands by how full you are; tell WORDS how full you are now and it suggests how many to release and at what price. Nothing changes until you apply it, unless you switch on auto-apply.</p>
    ${live.map((o) => {
      const r = ruleFor(o.id);
      const bands = r?.bands ?? y.default_bands;
      return html`<form class="card stack yr" data-offer="${o.id}" data-rule="${r?.id ?? ''}"><div class="row gap"><div class="offer-img">${o.image}</div><div class="grow"><h3>${o.title}</h3><span class="small muted">Now ${fmt.points(o.points_price)} WORDS · ${o.remaining} left</span></div></div>
        <div class="grid3"><label class="field"><span>Capacity</span><input name="capacity" type="number" min="1" value="${r?.capacity ?? 50}"></label>
          <label class="field"><span>Target % full</span><input name="target" type="number" min="1" max="100" value="${r?.target_utilisation ?? 70}"></label>
          <label class="field"><span>Max to release</span><input name="max_units" type="number" min="1" value="${r?.max_units ?? 10}"></label></div>
        <table class="data"><thead><tr><th>When fewer than … % full</th><th>WORDS price</th></tr></thead><tbody>
          ${bands.map((b) => html`<tr><td><input class="bb" type="number" min="1" max="100" value="${b.below}" style="width:80px"></td><td><input class="bp" type="number" min="1" value="${b.points}" style="width:100px"></td></tr>`)}
        </tbody></table>
        <label class="check"><input type="checkbox" name="auto" ${r?.auto_apply ? raw('checked') : ''}><span>Auto-apply: release automatically when I report utilisation (I authorise this in advance)</span></label>
        ${owner ? html`<button class="btn ghost sm">Save rule</button>` : ''}
        ${r ? html`<div class="row gap"><label class="field grow"><span>How full are you right now? (%)</span><input class="util" type="number" min="0" max="100" value="${r.last_recommendation?.utilisation ?? 30}"></label><button type="button" class="btn dark rec" style="align-self:flex-end">Recommend</button></div>
          <div class="out">${r.last_recommendation ? recView(r.last_recommendation, owner) : ''}</div>` : ''}
      </form>`;
    })}`);
  $$('.yr').forEach((f) => {
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const bands = $$('tbody tr', f).map((tr) => ({ below: Number($('.bb', tr).value), points: Number($('.bp', tr).value) }));
      try {
        await api('POST', '/merchant/yield/rules', { offer_id: f.dataset.offer, bands, capacity: Number(f.capacity.value), target_utilisation: Number(f.target.value), max_units: Number(f.max_units.value), auto_apply: f.auto.checked });
        toast('Rule saved', 'success');
        route();
      } catch (err) { toast(err.details || err.message, 'error'); }
    });
    $('.rec', f)?.addEventListener('click', async () => {
      try {
        const r = await api('POST', '/merchant/yield/recommend', { rule_id: f.dataset.rule, utilisation: Number($('.util', f).value) });
        render($('.out', f), recView(r.recommendation, owner));
        bindApply(f);
        if (r.recommendation.applied) { toast('Auto-applied', 'success'); await load(); }
      } catch (err) { toast(err.details || err.message, 'error'); }
    });
    bindApply(f);
  });
}

function recView(rec, owner) {
  if (rec.action !== 'release') return html`<p class="banner">Hold: ${rec.reason === 'at_target' ? 'you’re at or above your target already.' : 'you’re busy enough. No offer needed.'}</p>`;
  return html`<div class="card flat stack"><b>Release ${rec.quantity} at ${fmt.points(rec.points_price)} WORDS</b><span class="small muted">At ${rec.utilisation}% full, band “under ${rec.band.below}%”.</span>
    ${rec.applied ? html`<span class="badge mint">Applied ${fmt.time(rec.applied_at)}</span>` : owner ? html`<button type="button" class="btn mint apply">Apply: publish ${rec.quantity} now</button>` : ''}</div>`;
}

function bindApply(f) {
  $('.apply', f)?.addEventListener('click', async () => {
    try { await api('POST', '/merchant/yield/apply', { rule_id: f.dataset.rule }); toast('Released', 'success'); route(); } catch (err) { toast(err.message, 'error'); }
  });
}

window.addEventListener('hashchange', route);
route();
