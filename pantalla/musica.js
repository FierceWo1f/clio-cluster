// Reproductor del estéreo: muestra lo que suena en el teléfono y lo controla. Contrato: docs/PROTOCOLO.md (Música).
// El audio sale del teléfono por Bluetooth y llega ~200 ms tarde a las bocinas; la visualización y la letra se
// retrasan lo mismo (ajuste "Retraso del audio Bluetooth", guardado en localStorage).
import { Hub, $, esc, startClock, fmtTime } from './common.js';
import { Visualizer } from './viz.js';

// Claves de localStorage. La del retraso es la misma que usa el mini reproductor (player-compact.js).
const LS_DELAY = 'clio.btDelayMs', LS_VIZ = 'clio.musica.viz', LS_LYR = 'clio.musica.letra';
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, String(v)); } catch { /* sin almacenamiento */ } };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const hub = new Hub('pantalla-musica');

// ---------- estado ----------
const st = {
  track: null,            // último {t:"track"}
  play: { playing: false, shuffle: false, repeat: 'off', vol: 1 },
  base: { pos: 0, at: 0, playing: false },  // para interpolar la posición con el reloj propio
  dur: 0,
  queue: null, qCur: -1,
  holdUntil: 0,           // tras un seek se ignora la posición vieja que aún viene en camino
};
let delayMs = clamp(+lsGet(LS_DELAY, 200) || 0, 0, 600);
if (!Number.isFinite(delayMs)) delayMs = 200;

function curPos() {
  const b = st.base;
  const p = b.pos + (b.playing ? (performance.now() - b.at) / 1000 : 0);
  return st.dur > 0 ? clamp(p, 0, st.dur) : Math.max(0, p);
}
function rebase(pos, playing) { st.base = { pos, at: performance.now(), playing }; }

// ---------- visualizador ----------
const viz = new Visualizer($('#viz'), {
  scale: 0.5, fpsCap: 30, delayMs,
  mode: +lsGet(LS_VIZ, 0) || 0,
  onmode: (i, name) => { $('#vName').textContent = name; lsSet(LS_VIZ, i); },
});
$('#vName').textContent = viz.modeName;
viz.start();
hub.onBinary(buf => viz.feed(buf));
$('#vPrev').onclick = () => viz.prev();
$('#vNext').onclick = () => viz.next();
$('#viz').addEventListener('click', () => viz.next());

// ---------- ecualizador decorativo (sigue a las bandas ya retrasadas del visualizador) ----------
const EQ = [['60', 1], ['170', 4], ['310', 7], ['600', 10], ['1K', 13], ['3K', 16], ['6K', 19], ['12K', 23], ['14K', 26], ['16K', 29]];
$('#eq').innerHTML = EQ.map(([l]) => `<div><i><b></b></i><small>${l}</small></div>`).join('');
const eqKnobs = [...document.querySelectorAll('#eq i b')];
let eqH = 0;
function updateEq() {
  if (document.body.classList.contains('ly-full')) return;
  if (!eqH) eqH = Math.max(0, (document.querySelector('#eq i')?.clientHeight || 0) - 8);
  for (let k = 0; k < EQ.length; k++) {
    const v = clamp(viz.bands[EQ[k][1]] * 1.15, 0, 1);
    eqKnobs[k].style.transform = `translateY(${-Math.round(v * eqH)}px)`;
  }
}
window.addEventListener('resize', () => { eqH = 0; });

// ---------- deslizadores táctiles (avance, volumen, retraso) ----------
function slider(el, { onInput, onCommit }) {
  const fill = el.querySelector('.fill'), knob = el.querySelector('.knob');
  let drag = false, last = 0;
  const frac = e => { const r = el.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
  const draw = f => { fill.style.width = (f * 100).toFixed(2) + '%'; knob.style.left = (f * 100).toFixed(2) + '%'; };
  el.addEventListener('pointerdown', e => {
    drag = true; el.classList.add('drag');
    try { el.setPointerCapture(e.pointerId); } catch { /* nada */ }
    last = frac(e); draw(last); onInput?.(last);
  });
  el.addEventListener('pointermove', e => { if (!drag) return; last = frac(e); draw(last); onInput?.(last); });
  const end = e => {
    if (!drag) return;
    drag = false; el.classList.remove('drag');
    if (e.type === 'pointerup') last = frac(e);
    draw(last); onCommit?.(last);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  return { set(f) { if (!drag) draw(clamp(f, 0, 1)); }, get dragging() { return drag; } };
}

// avance
const seek = slider($('#seek'), {
  onInput: f => { $('#tCur').textContent = fmtTime(f * st.dur); },
  onCommit: f => {
    if (!(st.dur > 0)) return;
    const s = Math.round(f * st.dur * 10) / 10;
    hub.cmd('music.seek', s);
    rebase(s, st.base.playing);
    st.holdUntil = performance.now() + 900;
    lyrics.resync();
  },
});

// volumen (se manda como mucho cada 150 ms mientras se arrastra)
let volSentAt = 0, volHoldUntil = 0;
function sendVol(v, force) {
  v = Math.round(clamp(v, 0, 1) * 100) / 100;
  st.play.vol = v; volHoldUntil = performance.now() + 900;
  const now = performance.now();
  if (force || now - volSentAt > 150) { volSentAt = now; hub.cmd('music.vol', v); }
}
const vol = slider($('#vol'), { onInput: f => sendVol(f, false), onCommit: f => sendVol(f, true) });
$('#volDown').onclick = () => { sendVol((st.play.vol ?? 1) - 0.05, true); vol.set(st.play.vol); };
$('#volUp').onclick = () => { sendVol((st.play.vol ?? 1) + 0.05, true); vol.set(st.play.vol); };

// ---------- controles ----------
$('#btnPlay').onclick = () => {
  hub.cmd('music.toggle');
  st.play.playing = !st.base.playing;          // optimista; lo confirma el siguiente "play"
  rebase(curPos(), st.play.playing);
  renderPlay(); lyrics.resync();
};
$('#btnNext').onclick = () => hub.cmd('music.next');
$('#btnPrev').onclick = () => hub.cmd('music.prev');
$('#btnShuf').onclick = () => { st.play.shuffle = !st.play.shuffle; hub.cmd('music.shuffle', st.play.shuffle); renderPlay(); };
$('#btnRep').onclick = () => {
  const order = ['off', 'all', 'one'];
  st.play.repeat = order[(order.indexOf(st.play.repeat) + 1) % 3];
  hub.cmd('music.repeat', st.play.repeat); renderPlay();
};
// Teclas multimedia (si los botones del volante llegan como teclas estándar)
window.addEventListener('keydown', e => {
  if (e.key === 'MediaTrackNext') hub.cmd('music.next');
  else if (e.key === 'MediaTrackPrevious') hub.cmd('music.prev');
  else if (e.key === 'MediaPlayPause') $('#btnPlay').click();
});

const PLAY_D = 'M7 4v16l14-8z', PAUSE_D = 'M6 4h4v16H6zm8 0h4v16h-4z';
function renderPlay() {
  const p = st.play;
  $('#icoPlay').firstElementChild.setAttribute('d', st.base.playing ? PAUSE_D : PLAY_D);
  $('#btnShuf').classList.toggle('on', !!p.shuffle);
  $('#btnRep').classList.toggle('on', p.repeat === 'all' || p.repeat === 'one');
  $('#repOne').style.display = p.repeat === 'one' ? '' : 'none';
  $('#tagPlay').textContent = st.base.playing ? 'REPRODUCIENDO' : 'EN PAUSA';
  $('#tagPlay').classList.toggle('on', !!st.track);
  $('#tagShuf').classList.toggle('on', !!p.shuffle);
  $('#tagRep').textContent = p.repeat === 'one' ? 'REPETIR 1' : 'REPETIR';
  $('#tagRep').classList.toggle('on', p.repeat === 'all' || p.repeat === 'one');
  $('#lcdTime').classList.toggle('paused', !!st.track && !st.base.playing);
  if (performance.now() > volHoldUntil) vol.set(p.vol ?? 1);
}

// ---------- pista ----------
function renderTrack() {
  const t = st.track;
  $('#title').textContent = t?.title || '—';
  $('#artist').textContent = [t?.artist, t?.album].filter(Boolean).join(' · ');
  const img = $('#cover');
  if (t?.cover) { if (img.getAttribute('src') !== t.cover) img.src = t.cover; img.hidden = false; }
  else { img.hidden = true; img.removeAttribute('src'); }
  setMarquee(t ? [t.title || 'Sin título', t.artist, t.album].filter(Boolean).join(' — ') : 'CLIO · MÚSICA');
  $('#tDur').textContent = fmtTime(st.dur);
}

let mqLast = null;
function setMarquee(text) {
  if (text === mqLast) return;
  mqLast = text;
  const box = $('#mq');
  box.classList.remove('run');
  box.innerHTML = `<span>${esc(text)}</span>`;
  const w = box.firstElementChild.offsetWidth;
  if (w > box.clientWidth) {
    box.innerHTML = `<span>${esc(text)}</span><span>${esc(text)}</span>`;
    box.style.setProperty('--mqd', Math.max(6, w / 45).toFixed(1) + 's');
    box.classList.add('run');
  }
}

hub.on('track', m => {
  const isNew = !st.track || st.track.id !== m.id;
  st.track = m;
  if (Number.isFinite(m.dur)) st.dur = m.dur;
  if (isNew) {
    rebase(0, st.base.playing);
    if (Number.isFinite(m.idx)) st.qCur = m.idx; else guessQueueIndex();
    renderQueueCur();
  }
  lyrics.load(m);
  renderTrack(); renderPlay(); updateMsg();
});

hub.on('play', m => {
  const now = performance.now();
  Object.assign(st.play, {
    playing: !!m.playing,
    shuffle: m.shuffle ?? st.play.shuffle,
    repeat: m.repeat ?? st.play.repeat,
  });
  if (m.vol !== undefined && now > volHoldUntil) st.play.vol = m.vol;
  if (Number.isFinite(m.dur) && m.dur > 0) st.dur = m.dur;
  const was = st.base.playing;
  const pos = Number.isFinite(m.pos) ? m.pos : curPos();
  if (now < st.holdUntil) rebase(curPos(), !!m.playing);
  else {
    // corrige solo si el reloj propio se desvió (evita saltitos por la latencia del WiFi)
    const drift = Math.abs(pos - curPos());
    if (drift > 0.25 || was !== !!m.playing || !st.base.at) rebase(pos, !!m.playing);
  }
  if (Number.isFinite(m.idx) && m.idx !== st.qCur) { st.qCur = m.idx; renderQueueCur(); }
  if (was !== st.base.playing) lyrics.resync();
  $('#tDur').textContent = fmtTime(st.dur);
  renderPlay();
});

// ---------- cola ----------
hub.on('queue', m => {
  st.queue = Array.isArray(m.items) ? m.items : [];
  if (Number.isFinite(m.cur)) st.qCur = m.cur;
  renderQueue();
});

/** La cola trae índices, no ids: si cambió la canción y no llegó cola nueva, se busca por título y artista. */
function guessQueueIndex() {
  const q = st.queue, t = st.track;
  if (!q?.length || !t) return;
  const n = q.length, from = st.qCur >= 0 ? st.qCur : -1;
  for (let k = 1; k <= n; k++) {
    const it = q[(from + k + n) % n];
    if (it.title === t.title && (it.artist || '') === (t.artist || '')) { st.qCur = it.i ?? (from + k + n) % n; return; }
  }
}

function renderQueue() {
  const q = st.queue || [];
  $('#qCount').textContent = q.length ? `${q.length} canciones` : '';
  $('#qList').innerHTML = q.length
    ? q.map((it, k) => `<div class="qi" data-i="${it.i ?? k}"><em>${(it.i ?? k) + 1}</em><div><b>${esc(it.title || 'Sin título')}</b><span>${esc(it.artist || '')}</span></div></div>`).join('')
    : '<div class="qempty">La cola está vacía.<br>Elige música en la app del teléfono, pestaña Música.</div>';
  renderQueueCur();
}

function renderQueueCur() {
  const list = $('#qList');
  list.querySelector('.qi.cur')?.classList.remove('cur');
  const el = list.querySelector(`.qi[data-i="${st.qCur}"]`);
  if (el) el.classList.add('cur');
  return el;
}

$('#qList').addEventListener('click', e => {
  const el = e.target.closest('.qi');
  if (!el) return;
  const i = +el.dataset.i;
  hub.cmd('music.playIdx', i);
  st.qCur = i; renderQueueCur();
  setTimeout(closeDrawer, 250);
});

function openDrawer() {
  $('#drawer').classList.add('on'); $('#scrim').classList.add('on');
  const el = renderQueueCur();
  if (el) { const l = $('#qList'); l.scrollTop = el.offsetTop - l.clientHeight / 2 + el.offsetHeight / 2; }
}
function closeDrawer() { $('#drawer').classList.remove('on'); $('#scrim').classList.remove('on'); $('#cfg').classList.remove('on'); }
$('#btnQueue').onclick = openDrawer;
$('#qClose').onclick = closeDrawer;
$('#scrim').onclick = closeDrawer;

// ---------- ajuste: retraso del audio Bluetooth ----------
function setDelay(ms) {
  delayMs = clamp(Math.round(ms / 10) * 10, 0, 600);
  viz.delayMs = delayMs;
  lsSet(LS_DELAY, delayMs);
  $('#dlyVal').textContent = `${delayMs} ms`;
  dly.set(delayMs / 600);
  lyrics.resync();
}
const dly = slider($('#dly'), { onInput: f => setDelay(f * 600), onCommit: f => setDelay(f * 600) });
$('#dlyDown').onclick = () => setDelay(delayMs - 10);
$('#dlyUp').onclick = () => setDelay(delayMs + 10);
$('#dlyReset').onclick = () => setDelay(200);
$('#btnCfg').onclick = () => { $('#cfg').classList.add('on'); $('#scrim').classList.add('on'); setDelay(delayMs); };
$('#cfgClose').onclick = closeDrawer;

// ---------- letra ----------
const LYR_MODES = ['off', 'over', 'full'], LYR_LABEL = { off: 'Letra: apagada', over: 'Letra: encima', full: 'Letra: completa' };

const lyrics = {
  mode: LYR_MODES.includes(lsGet(LS_LYR, 'off')) ? lsGet(LS_LYR, 'off') : 'off',
  kind: 'none',   // 'sync' | 'plain' | 'none'
  lines: [],      // [[ms, texto]]
  key: '',        // para no reconstruir si llega la misma letra
  shownOver: -2, shownFull: -2,

  load(t) {
    const sync = Array.isArray(t.lyrics) && t.lyrics.length ? t.lyrics.filter(l => Array.isArray(l) && Number.isFinite(l[0])) : null;
    const key = `${t.id}|${sync ? sync.length + ':' + (sync[0]?.[1] || '') : ''}|${t.plain ? t.plain.length : 0}`;
    if (key === this.key) return;
    this.key = key;
    if (sync?.length) {
      this.kind = 'sync';
      this.lines = sync.slice().sort((a, b) => a[0] - b[0]).map(([ms, s]) => [ms, String(s ?? '')]);
    } else if (t.plain) { this.kind = 'plain'; this.lines = []; }
    else { this.kind = 'none'; this.lines = []; }
    $('#lyrList').innerHTML = this.lines.map(([, s]) => `<p>${s.trim() ? esc(s) : '♪'}</p>`).join('');
    $('#lyrPlain').innerHTML = t.plain ? `<span class="hint">LETRA SIN TIEMPOS · DESLIZA PARA LEER</span>${esc(t.plain)}` : '';
    $('#lyrPlain').scrollTop = 0;
    this.shownOver = this.shownFull = -2;
    this.applyClasses();
    this.tick();
  },

  setMode(m) {
    this.mode = m; lsSet(LS_LYR, m);
    this.shownOver = this.shownFull = -2;
    this.applyClasses();
    this.tick();
  },

  applyClasses() {
    const b = document.body.classList;
    for (const m of LYR_MODES) b.toggle('ly-' + m, this.mode === m);
    b.toggle('ly-sync', this.kind === 'sync');
    b.toggle('ly-plain', this.kind === 'plain');
    b.toggle('ly-nolyr', this.kind !== 'sync' && !(this.kind === 'plain' && this.mode === 'full'));
    document.querySelector('.lyr-none').textContent = this.kind === 'plain'
      ? 'Letra sin tiempos: tócala en «Letra: completa» para leerla' : 'Sin letra para esta canción';
    $('#lyrLabel').textContent = LYR_LABEL[this.mode];
    $('#btnLyr').classList.toggle('on', this.mode !== 'off');
    $('#tagLyr').classList.toggle('on', this.kind !== 'none');
  },

  /** Índice de la línea que suena (búsqueda binaria), con el retraso del Bluetooth aplicado. */
  index() {
    const ms = (curPos() - delayMs / 1000) * 1000, L = this.lines;
    let lo = 0, hi = L.length - 1, r = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (L[m][0] <= ms) { r = m; lo = m + 1; } else hi = m - 1; }
    return r;
  },

  resync() { this.shownFull = -2; this.tick(); },

  tick() {
    if (this.kind !== 'sync' || this.mode === 'off') return;
    const i = this.index();
    if (this.mode === 'over' && i !== this.shownOver) {
      this.shownOver = i;
      const txt = k => (k >= 0 && k < this.lines.length ? (this.lines[k][1].trim() || '♪') : '');
      $('#loP').textContent = txt(i - 1);
      $('#loN').textContent = txt(i + 1);
      const c = $('#loC');
      c.textContent = i < 0 ? '♪' : txt(i);
      c.classList.remove('in'); void c.offsetWidth; c.classList.add('in');
    }
    if (this.mode === 'full' && i !== this.shownFull) {
      this.shownFull = i;
      const list = $('#lyrList'), ps = list.children;
      for (let k = 0; k < ps.length; k++) {
        ps[k].className = k === i ? 'on' : k < i ? 'past' : '';
        if (k !== i) ps[k].style.animation = '';
      }
      const box = $('#lyrFull');
      const el = ps[Math.max(0, i)];
      if (el) {
        const y = el.offsetTop + el.offsetHeight / 2;
        list.style.transform = `translateY(${Math.round(box.clientHeight / 2 - y)}px)`;
      }
      if (i >= 0 && ps[i]) {
        // barrido tipo karaoke de la línea actual, hecho con una animación CSS (sin trabajo por cuadro)
        const start = this.lines[i][0], end = i + 1 < this.lines.length ? this.lines[i + 1][0] : start + 4000;
        const dur = clamp(end - start, 300, 15000);
        const el2 = ps[i], played = clamp((curPos() - delayMs / 1000) * 1000 - start, 0, dur);
        el2.style.animation = 'none'; void el2.offsetWidth;
        el2.style.animation = `wipe ${dur}ms linear ${-played}ms forwards`;
        el2.style.animationPlayState = st.base.playing ? 'running' : 'paused';
      }
    }
  },
};
$('#btnLyr').onclick = () => lyrics.setMode(LYR_MODES[(LYR_MODES.indexOf(lyrics.mode) + 1) % LYR_MODES.length]);
lyrics.applyClasses();

// ---------- avisos ----------
function updateMsg() {
  let title = '', text = '';
  if (!hub.open) { title = 'Sin conexión con el hub'; text = 'Reconectando…'; }
  else if (!hub.motor) {
    title = 'Esperando el teléfono';
    text = 'En el teléfono abre la app Clio en Chrome (<b>http://localhost:8080</b>).<br>Luego elige música en la pestaña <b>Música</b>.';
  } else if (!st.track) { title = 'No hay música sonando'; text = 'Elige música en la app del teléfono, pestaña <b>Música</b>.'; }
  $('#msg').hidden = !title;
  if (title) { $('#msgTitle').textContent = title; $('#msgText').innerHTML = text; }
  $('#tagBt').classList.toggle('on', hub.motor);
}
hub.on('open', updateMsg).on('close', updateMsg).on('motor', updateMsg).on('hub', updateMsg);

// ---------- ciclo de la interfaz (10 Hz; la visualización tiene su propio ciclo) ----------
setInterval(() => {
  const p = curPos();
  if (!seek.dragging) {
    $('#tCur').textContent = fmtTime(p);
    seek.set(st.dur > 0 ? p / st.dur : 0);
  }
  $('#lcdTime').textContent = fmtTime(p);
  lyrics.tick();
  updateEq();
}, 100);

startClock($('#clock'));
renderTrack(); renderPlay(); updateMsg(); setDelay(delayMs);

// Para pruebas desde la consola / CDP
window.clioMusica = { hub, viz, st, lyrics };
