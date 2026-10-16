// The WORDS GRID game screen. Drag across touching tiles (or tap them one by
// one) to make a word; letting go submits it. Every word is checked by the
// server. If the connection drops, words wait in a queue on this device and
// are sent as soon as it comes back.
import { api } from './api.js';
import { isAdjacent, tileText, wordFromPath } from './core/grid.js';
import { letterValue, MIN_WORD } from './core/scoring.js';
import { $, html, render, toast, fmt, confirmDialog } from './ui.js';

const QUEUE_PREFIX = 'words_queue_';

function loadQueue(sessionId) {
  try { return JSON.parse(localStorage.getItem(QUEUE_PREFIX + sessionId) || '[]'); } catch { return []; }
}
function saveQueue(sessionId, q) {
  try {
    if (q.length) localStorage.setItem(QUEUE_PREFIX + sessionId, JSON.stringify(q));
    else localStorage.removeItem(QUEUE_PREFIX + sessionId);
  } catch { /* storage full or blocked */ }
}

/**
 * Mount the game. Returns a cleanup function.
 *   challenge: public challenge, session: session view from /game/start
 *   clockOffset: serverTime - localTime in ms
 *   onFinish(result): called once with the /game/finish response
 */
export function mountGame(root, { challenge, session, clockOffset = 0, onFinish }) {
  const tiles = challenge.tiles;
  const state = {
    path: [],
    dragging: false,
    moved: false,
    found: new Map(session.words.map((w) => [w.word, w])),
    pending: loadQueue(session.session_id),
    score: session.score,
    finished: false,
    sending: false,
    themeWord: null
  };
  const endsAt = new Date(session.ends_at).getTime();
  const serverNow = () => Date.now() + clockOffset;

  render(root, html`
    <div class="stack">
      <div class="game-head">
        <div><span class="eyebrow">Time</span><div class="timer" id="timer" aria-live="off">5:00</div></div>
        <div class="center small muted" id="progress"></div>
        <div class="score-box"><span class="eyebrow">Score</span><b id="score">0</b></div>
      </div>
      <div class="current-word" id="current" aria-live="polite"></div>
      <div class="board" id="board" role="grid" aria-label="Letter grid. Select touching letters to make a word.">
        <svg class="trail" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polyline id="trail" points=""/></svg>
        ${tiles.map((t, i) => html`<button type="button" class="tile${t === 'q' ? ' qu' : ''}${i === challenge.star ? ' star' : ''}" data-i="${i}"
          aria-label="${tileText(t).toUpperCase()}${i === challenge.star ? ', star tile, doubles the word' : ''}">${t === 'q' ? 'Qu' : t.toUpperCase()}<small>${letterValue(t)}</small></button>`)}
      </div>
      <div class="row gap">
        <button class="btn ghost grow" id="clear" type="button">Clear</button>
        <button class="btn dark grow" id="submit" type="button" disabled>Enter word</button>
      </div>
      <p class="small muted center">★ doubles a word · hidden ${challenge.theme_length ?? ''}-letter word of the day: +15 · ${challenge.word_count} words to find</p>
      <div class="found" id="found" aria-label="Words found"></div>
      <button class="btn ghost block sm" id="finish" type="button">Finish now</button>
    </div>`);

  const board = $('#board', root);
  const tileEls = [...board.querySelectorAll('.tile')];

  function centre(i) {
    const r = Math.floor(i / 4), c = i % 4;
    return [12.5 + c * 25, 12.5 + r * 25];
  }

  function drawPath() {
    tileEls.forEach((el, i) => {
      el.classList.toggle('on', state.path.includes(i));
      el.classList.toggle('last', state.path.at(-1) === i);
    });
    $('#trail', root).setAttribute('points', state.path.map((i) => centre(i).join(',')).join(' '));
    const cur = $('#current', root);
    cur.className = 'current-word';
    cur.textContent = wordFromPath(tiles, state.path);
    $('#submit', root).disabled = wordFromPath(tiles, state.path).length < MIN_WORD;
  }

  function drawFound() {
    const items = [...state.found.values()].reverse().map((w) => html`<span class="w${w.word === state.themeWord ? ' theme' : ''}">${w.word}<small>${w.score}</small></span>`);
    const pend = state.pending.map((p) => html`<span class="w pending" title="Waiting for connection">${wordFromPath(tiles, p.path)}</span>`);
    render($('#found', root), html`${pend}${items}`);
    $('#score', root).textContent = fmt.points(state.score);
    $('#progress', root).textContent = `${state.found.size} / ${challenge.word_count} words`;
  }

  function feedback(text, ok) {
    const cur = $('#current', root);
    cur.textContent = text;
    cur.className = `current-word ${ok ? 'ok' : 'bad'}`;
    if (navigator.vibrate) navigator.vibrate(ok ? 15 : [30, 40, 30]);
  }

  // ---- input ----
  function tileAt(x, y) {
    // Hit only near a tile's centre, so diagonal drags don't clip neighbours.
    for (const el of tileEls) {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (Math.abs(x - cx) < r.width * 0.4 && Math.abs(y - cy) < r.height * 0.4) return Number(el.dataset.i);
    }
    return null;
  }

  function step(i) {
    const p = state.path;
    if (p.at(-1) === i) return;
    if (p.length >= 2 && p.at(-2) === i) p.pop(); // backtrack
    else if (!p.includes(i) && (p.length === 0 || isAdjacent(p.at(-1), i))) p.push(i);
    else return;
    drawPath();
  }

  function onDown(e) {
    const i = tileAt(e.clientX, e.clientY);
    if (i === null || state.finished) return;
    e.preventDefault();
    board.setPointerCapture?.(e.pointerId);
    state.dragging = true;
    state.moved = false;
    const p = state.path;
    if (p.at(-1) === i) { p.pop(); drawPath(); state.dragging = false; return; } // tap last tile to undo it
    if (p.length && !p.includes(i) && isAdjacent(p.at(-1), i)) p.push(i); // tap-to-extend
    else state.path = [i];
    drawPath();
  }
  function onMove(e) {
    if (!state.dragging) return;
    const i = tileAt(e.clientX, e.clientY);
    if (i === null) return;
    if (i !== state.path.at(-1)) state.moved = true;
    step(i);
  }
  function onUp() {
    if (!state.dragging) return;
    state.dragging = false;
    if (state.moved && state.path.length >= MIN_WORD) submit();
  }
  board.addEventListener('pointerdown', onDown);
  board.addEventListener('pointermove', onMove);
  board.addEventListener('pointerup', onUp);
  board.addEventListener('pointercancel', onUp);
  // Keyboard: tiles are buttons; Enter/Space selects.
  board.addEventListener('click', (e) => {
    if (e.detail !== 0) return; // pointer clicks are handled above
    const el = e.target.closest('.tile');
    if (!el) return;
    const i = Number(el.dataset.i);
    if (state.path.at(-1) === i) state.path.pop();
    else if (!state.path.length || (isAdjacent(state.path.at(-1), i) && !state.path.includes(i))) state.path.push(i);
    else state.path = [i];
    drawPath();
  });
  $('#submit', root).addEventListener('click', () => submit());
  $('#clear', root).addEventListener('click', () => { state.path = []; drawPath(); });
  $('#finish', root).addEventListener('click', async () => {
    if (await confirmDialog({ title: 'Finish now?', body: 'You can’t play today’s challenge again after finishing.', confirm: 'Finish' })) finish();
  });
  const onKey = (e) => {
    if (e.key === 'Enter' && state.path.length >= MIN_WORD) submit();
    if (e.key === 'Escape') { state.path = []; drawPath(); }
  };
  document.addEventListener('keydown', onKey);

  // ---- submission ----
  async function submit() {
    const path = state.path.slice();
    state.path = [];
    drawPath();
    const word = wordFromPath(tiles, path);
    if (word.length < MIN_WORD) return feedback('Too short', false);
    if (state.found.has(word) || state.pending.some((p) => wordFromPath(tiles, p.path) === word)) return feedback('Already found', false);
    try {
      const res = await api('POST', '/game/word', { session_id: session.session_id, path });
      accept(res);
      feedback(res.theme_word ? `★ ${word} ★ +${res.score}` : `${word} +${res.score}`, true);
      if (res.theme_word) toast('You found the hidden word of the day! +15', 'success');
    } catch (e) {
      if (e.code === 'offline') {
        state.pending.push({ path, at: serverNow() });
        saveQueue(session.session_id, state.pending);
        feedback(`${word} · saved`, true);
        drawFound();
      } else if (e.code === 'session_closed') {
        finish();
      } else {
        feedback(e.code === 'not_a_word' ? 'Not in the list' : e.code === 'duplicate_word' ? 'Already found' : e.message, false);
      }
    }
  }

  function accept(res) {
    if (res.theme_word) state.themeWord = res.word;
    state.found = new Map(res.session.words.map((w) => [w.word, w]));
    state.score = res.session.score;
    drawFound();
  }

  async function flushQueue() {
    if (state.sending || !state.pending.length) return;
    state.sending = true;
    try {
      while (state.pending.length) {
        const item = state.pending[0];
        try {
          const res = await api('POST', '/game/word', { session_id: session.session_id, path: item.path });
          accept(res);
        } catch (e) {
          if (e.code === 'offline') break;
          // Rejected (not a word, duplicate, too late): drop it.
        }
        state.pending.shift();
        saveQueue(session.session_id, state.pending);
      }
    } finally {
      state.sending = false;
      drawFound();
    }
  }

  async function finish() {
    if (state.finished) return;
    state.finished = true;
    clearInterval(tick);
    await flushQueue();
    board.style.pointerEvents = 'none';
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await api('POST', '/game/finish', { session_id: session.session_id });
        onFinish(result);
        return;
      } catch (e) {
        if (e.code !== 'offline') { toast(e.message, 'error'); return; }
        $('#current', root).textContent = 'Saving your game… reconnect to see results';
        await new Promise((r) => setTimeout(r, Math.min(15000, 2000 * (attempt + 1))));
        await flushQueue();
      }
    }
  }

  // ---- clock ----
  const tick = setInterval(update, 250);
  function update() {
    const left = endsAt - serverNow();
    const t = $('#timer', root);
    if (!t) return;
    t.textContent = fmt.duration(left);
    t.classList.toggle('low', left < 30000);
    if (left <= 0) finish();
  }
  const onOnline = () => flushQueue();
  window.addEventListener('online', onOnline);
  const retry = setInterval(flushQueue, 5000);

  drawPath();
  drawFound();
  update();
  flushQueue();

  return () => {
    clearInterval(tick);
    clearInterval(retry);
    window.removeEventListener('online', onOnline);
    document.removeEventListener('keydown', onKey);
  };
}
