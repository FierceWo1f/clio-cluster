// Mini reproductor para la vista dividida (Música + Mapa). Panel vertical de unos 384×560.
// Contrato de mensajes: docs/PROTOCOLO.md (Música).
//
//   import { mountCompactPlayer } from './player-compact.js';
//   const hub = new Hub('pantalla-dividida');
//   const pc = mountCompactPlayer(document.querySelector('#musica'), hub, { fpsCap: 20 });
//   …  pc.destroy();
//
// opts (todas opcionales):
//   fpsCap   cuadros por segundo de la mini visualización (20)
//   scale    resolución interna de la visualización (0.5)
//   vizMode  visualización inicial (índice; por defecto la última elegida aquí)
//   delayMs  retraso del audio Bluetooth; por defecto el guardado en el reproductor grande (localStorage)
//
// Importante: el teléfono reenvía la pista solo cuando entra una pantalla nueva, así que hay que montar el
// reproductor en el mismo turno en que se crea el Hub (antes de que conecte) o los primeros mensajes se pierden.
// El estado se guarda por Hub: si se destruye y se vuelve a montar con el mismo Hub, aparece con la pista actual.
import { fmtTime } from './common.js';
import { Visualizer } from './viz.js';

const LS_DELAY = 'clio.btDelayMs', LS_VIZ = 'clio.compacto.viz';
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, String(v)); } catch { /* sin almacenamiento */ } };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- estado compartido por Hub (Hub no tiene off(): se registra una sola vez por Hub) ----------
const stores = new WeakMap();
function storeFor(hub) {
  let s = stores.get(hub);
  if (s) return s;
  s = {
    track: null, playing: false, shuffle: false, repeat: 'off', dur: 0,
    base: { pos: 0, at: 0 }, holdUntil: 0,
    subs: new Set(), bins: new Set(),
    pos() {
      const p = this.base.pos + (this.playing ? (performance.now() - this.base.at) / 1000 : 0);
      return this.dur > 0 ? clamp(p, 0, this.dur) : Math.max(0, p);
    },
    rebase(pos) { this.base = { pos, at: performance.now() }; },
    emit(what) { for (const f of this.subs) { try { f(what); } catch (e) { console.error(e); } } },
  };
  hub.on('track', m => {
    const isNew = !s.track || s.track.id !== m.id;
    s.track = m;
    if (Number.isFinite(m.dur)) s.dur = m.dur;
    if (isNew) s.rebase(0);
    s.emit('track');
  });
  hub.on('play', m => {
    const now = performance.now(), was = s.playing;
    const pos = Number.isFinite(m.pos) ? m.pos : s.pos();
    if (now < s.holdUntil) s.rebase(s.pos());
    else if (Math.abs(pos - s.pos()) > 0.25 || was !== !!m.playing || !s.base.at) { s.playing = !!m.playing; s.rebase(pos); }
    s.playing = !!m.playing;
    if (m.shuffle !== undefined) s.shuffle = !!m.shuffle;
    if (m.repeat) s.repeat = m.repeat;
    if (Number.isFinite(m.dur) && m.dur > 0) s.dur = m.dur;
    s.emit('play');
  });
  hub.onBinary(buf => { for (const f of s.bins) f(buf); });
  for (const t of ['open', 'close', 'motor']) hub.on(t, () => s.emit('conn'));
  stores.set(hub, s);
  return s;
}

// ---------- CSS (una sola vez, todo con prefijo pc-) ----------
const CSS = `
.pc-root { position:relative; width:100%; height:100%; min-height:0; display:flex; flex-direction:column; padding:12px; box-sizing:border-box;
  border-radius:18px; color:#eef2f7; font-family:system-ui, Roboto, sans-serif; overflow:hidden; -webkit-user-select:none; user-select:none;
  background:linear-gradient(180deg,#5d6676 0%,#343b48 7%,#1f242e 50%,#171b23 52%,#222833 100%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.4), inset 0 -1px 0 rgba(0,0,0,.6), 0 4px 14px rgba(0,0,0,.6); }
.pc-root * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
.pc-root button { font:inherit; color:inherit; }
.pc-head { display:flex; align-items:center; flex:0 0 auto; }
.pc-cover { flex:0 0 108px; width:108px; height:108px; border-radius:10px; overflow:hidden; position:relative; border:1px solid #000;
  box-shadow:0 1px 0 rgba(255,255,255,.18), 0 2px 6px rgba(0,0,0,.7);
  background:radial-gradient(circle, #2a3140 0 8%, #0b0d11 9% 12%, #1a1e26 13% 34%, #111318 35% 36%, #1a1e26 37% 58%, #101217 59% 60%, #1b1f27 61%); }
.pc-cover img { position:absolute; left:0; top:0; width:100%; height:100%; object-fit:cover; }
.pc-cover img[hidden] { display:none; }
.pc-cover::after { content:''; position:absolute; left:0; top:0; right:0; bottom:0; background:linear-gradient(140deg, rgba(255,255,255,.16), rgba(255,255,255,0) 42%); }
.pc-meta { flex:1; min-width:0; margin-left:12px; }
.pc-meta b, .pc-meta span { display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.pc-meta b { font-size:19px; font-weight:700; text-shadow:0 1px 0 #000; }
.pc-meta span { font-size:15px; color:#a9b4c4; margin-top:3px; }
.pc-meta .pc-state { font:700 11px "Roboto Mono", Consolas, monospace; letter-spacing:1.2px; color:#2f6f78; margin-top:8px; }
.pc-meta .pc-state.pc-on { color:#8ff7ff; text-shadow:0 0 5px rgba(143,247,255,.6); }
.pc-viz { flex:1 1 auto; min-height:90px; margin-top:10px; position:relative; border-radius:12px; overflow:hidden; background:#04060a; border:1px solid #000;
  box-shadow:inset 0 0 0 2px #0d1118, 0 1px 0 rgba(255,255,255,.16); }
.pc-viz canvas { position:absolute; left:0; top:0; width:100%; height:100%; display:block; }
.pc-vname { position:absolute; right:6px; top:6px; height:48px; padding:0 14px; border-radius:999px; border:1px solid rgba(255,255,255,.08);
  background:rgba(8,11,16,.62); font-size:13px !important; font-weight:600; color:#dbe7f0 !important; }
.pc-lyr { flex:0 0 auto; height:92px; margin-top:8px; text-align:center; display:flex; flex-direction:column; justify-content:center; overflow:hidden; }
.pc-lyr div { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.pc-lyr .pc-l0, .pc-lyr .pc-l2 { font-size:14px; line-height:22px; color:rgba(200,214,230,.45); }
.pc-lyr .pc-l1 { font-size:20px; line-height:30px; font-weight:700; color:#fff; text-shadow:0 0 10px rgba(63,208,255,.35); }
.pc-lyr .pc-l1.pc-in { animation:pc-rise .35s ease-out; }
.pc-lyr .pc-dim { font-size:14px; color:#7d899b; font-weight:400; text-shadow:none; }
@keyframes pc-rise { from { transform:translateY(8px); opacity:.2; } }
.pc-seek { flex:0 0 auto; display:flex; align-items:center; height:44px; }
.pc-seek span { font-size:13px; color:#c4cfdc; min-width:40px; font-variant-numeric:tabular-nums; }
.pc-seek span:last-child { text-align:right; }
.pc-slider { position:relative; flex:1; height:48px; margin:0 8px; touch-action:none; }
.pc-rail { position:absolute; left:0; right:0; top:50%; height:8px; margin-top:-4px; border-radius:5px; background:#05070a; overflow:hidden;
  box-shadow:inset 0 1px 3px rgba(0,0,0,.9), 0 1px 0 rgba(255,255,255,.14); }
.pc-fill { position:absolute; left:0; top:0; bottom:0; width:0; background:linear-gradient(180deg,#a7ecff,#3fd0ff 50%,#1479b8); }
.pc-knob { position:absolute; top:50%; left:0; width:22px; height:22px; margin:-11px 0 0 -11px; border-radius:50%;
  background:radial-gradient(circle at 40% 30%, #fff, #b7c0cc 40%, #5b6474 75%, #3a414f); box-shadow:0 2px 4px rgba(0,0,0,.8); }
.pc-ctrls { flex:0 0 auto; display:flex; align-items:center; justify-content:space-between; height:68px; }
.pc-btn { width:52px; height:48px; border-radius:999px; border:1px solid #07090d; display:flex; align-items:center; justify-content:center; padding:0;
  background:linear-gradient(180deg,#465063 0%,#2a313e 46%,#1a1f28 54%,#232a35 100%); color:#d8e0ea !important;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.28), 0 2px 3px rgba(0,0,0,.55); position:relative; }
.pc-btn:active, .pc-btn.pc-on { background:linear-gradient(180deg,#14181f,#1c222c 50%,#262d3a); box-shadow:inset 0 2px 4px rgba(0,0,0,.7); }
.pc-btn.pc-on { color:#3fd0ff !important; }
.pc-btn svg { width:22px; height:22px; fill:currentColor; }
.pc-btn small { position:absolute; right:9px; bottom:6px; font-size:10px; font-weight:700; }
.pc-play { width:64px; height:64px; border-radius:50%; border:1px solid #062033; display:flex; align-items:center; justify-content:center; padding:0; color:#04263b !important;
  background:radial-gradient(circle at 50% 28%, #e3f8ff 0%, #8fe2ff 22%, #1ea7e8 58%, #0b4d78 100%);
  box-shadow:inset 0 2px 1px rgba(255,255,255,.6), inset 0 -3px 6px rgba(0,30,60,.6), 0 0 14px rgba(63,208,255,.4), 0 3px 5px rgba(0,0,0,.7); }
.pc-play:active { transform:scale(.95); }
.pc-play svg { width:28px; height:28px; fill:currentColor; }
.pc-msg { position:absolute; left:0; top:0; right:0; bottom:0; z-index:3; display:flex; align-items:center; justify-content:center; text-align:center;
  padding:24px; background:rgba(8,10,14,.86); border-radius:18px; }
.pc-msg[hidden] { display:none; }
.pc-msg b { display:block; font-size:21px; margin-bottom:8px; }
.pc-msg span { font-size:15px; line-height:1.5; color:#aab6c6; }
.pc-msg i { display:block; font-style:normal; font-size:34px; color:#3fd0ff; margin-bottom:6px; text-shadow:0 0 12px rgba(63,208,255,.6); }
`;
function injectCss() {
  if (document.getElementById('pc-css')) return;
  const el = document.createElement('style');
  el.id = 'pc-css';
  el.textContent = CSS;
  document.head.appendChild(el);
}

const ICON = {
  shuf: 'M14.8 4H20v5.2l-1.9-1.9-3.6 3.6-1.4-1.4 3.6-3.6zM4 5.4 5.4 4 20 18.6 18.6 20zM20 14.8V20h-5.2l1.9-1.9-2.9-2.9 1.4-1.4 2.9 2.9z',
  prev: 'M6 5h2v14H6zm3 7 10-7v14z',
  play: 'M7 4v16l14-8z',
  pause: 'M6 4h4v16H6zm8 0h4v16h-4z',
  next: 'M16 5h2v14h-2zM5 5l10 7-10 7z',
  rep: 'M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z',
};
const svg = d => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;

/**
 * Monta el mini reproductor dentro de container.
 * @returns {{destroy():void}}
 */
export function mountCompactPlayer(container, hub, opts = {}) {
  injectCss();
  const s = storeFor(hub);
  let delayMs = opts.delayMs ?? clamp(+lsGet(LS_DELAY, 200) || 0, 0, 600);

  const root = document.createElement('div');
  root.className = 'pc-root';
  root.innerHTML = `
    <div class="pc-head">
      <div class="pc-cover"><img alt="" hidden></div>
      <div class="pc-meta"><b class="pc-title">—</b><span class="pc-artist"></span><span class="pc-state">EN PAUSA</span></div>
    </div>
    <div class="pc-viz"><canvas></canvas><button class="pc-vname" aria-label="Cambiar visualización"></button></div>
    <div class="pc-lyr"><div class="pc-l0"></div><div class="pc-l1"></div><div class="pc-l2"></div></div>
    <div class="pc-seek"><span class="pc-cur">0:00</span><div class="pc-slider"><div class="pc-rail"><div class="pc-fill"></div></div><div class="pc-knob"></div></div><span class="pc-dur">0:00</span></div>
    <div class="pc-ctrls">
      <button class="pc-btn" data-a="shuf" aria-label="Aleatorio">${svg(ICON.shuf)}</button>
      <button class="pc-btn" data-a="prev" aria-label="Anterior">${svg(ICON.prev)}</button>
      <button class="pc-play" data-a="toggle" aria-label="Reproducir o pausar">${svg(ICON.play)}</button>
      <button class="pc-btn" data-a="next" aria-label="Siguiente">${svg(ICON.next)}</button>
      <button class="pc-btn" data-a="rep" aria-label="Repetir">${svg(ICON.rep)}<small></small></button>
    </div>
    <div class="pc-msg" hidden><div><i>♫</i><b></b><span></span></div></div>`;
  container.appendChild(root);
  const q = sel => root.querySelector(sel);

  // visualización
  const viz = new Visualizer(q('.pc-viz canvas'), {
    scale: opts.scale ?? 0.5, fpsCap: opts.fpsCap ?? 20, delayMs,
    mode: opts.vizMode ?? (+lsGet(LS_VIZ, 0) || 0),
    onmode: (i, name) => { q('.pc-vname').textContent = name + '  ▶'; lsSet(LS_VIZ, i); },
  });
  q('.pc-vname').textContent = viz.modeName + '  ▶';
  q('.pc-vname').onclick = () => viz.next();
  const onBin = buf => viz.feed(buf);
  s.bins.add(onBin);
  viz.start();

  // controles
  q('.pc-ctrls').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    switch (b.dataset.a) {
      case 'toggle':
        hub.cmd('music.toggle');
        s.rebase(s.pos()); s.playing = !s.playing; renderPlay(); lastLine = -2;
        break;
      case 'prev': hub.cmd('music.prev'); break;
      case 'next': hub.cmd('music.next'); break;
      case 'shuf': s.shuffle = !s.shuffle; hub.cmd('music.shuffle', s.shuffle); renderPlay(); break;
      case 'rep': {
        const order = ['off', 'all', 'one'];
        s.repeat = order[(order.indexOf(s.repeat) + 1) % 3];
        hub.cmd('music.repeat', s.repeat); renderPlay(); break;
      }
    }
  });

  // barra de avance arrastrable
  const sl = q('.pc-slider'), fill = q('.pc-fill'), knob = q('.pc-knob');
  let drag = false, dragF = 0;
  const frac = e => { const r = sl.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
  const drawSeek = f => { fill.style.width = (f * 100).toFixed(2) + '%'; knob.style.left = (f * 100).toFixed(2) + '%'; };
  sl.addEventListener('pointerdown', e => {
    drag = true; try { sl.setPointerCapture(e.pointerId); } catch { /* nada */ }
    dragF = frac(e); drawSeek(dragF); q('.pc-cur').textContent = fmtTime(dragF * s.dur);
  });
  sl.addEventListener('pointermove', e => { if (!drag) return; dragF = frac(e); drawSeek(dragF); q('.pc-cur').textContent = fmtTime(dragF * s.dur); });
  const endDrag = e => {
    if (!drag) return;
    drag = false;
    if (e.type === 'pointerup') dragF = frac(e);
    if (s.dur > 0) {
      const v = Math.round(dragF * s.dur * 10) / 10;
      hub.cmd('music.seek', v);
      s.rebase(v); s.holdUntil = performance.now() + 900; lastLine = -2;
    }
  };
  sl.addEventListener('pointerup', endDrag);
  sl.addEventListener('pointercancel', endDrag);

  // render
  let lines = [], kind = 'none', lastLine = -2;
  function renderTrack() {
    const t = s.track;
    q('.pc-title').textContent = t?.title || '—';
    q('.pc-artist').textContent = t?.artist || '';
    const img = q('.pc-cover img');
    if (t?.cover) { if (img.getAttribute('src') !== t.cover) img.src = t.cover; img.hidden = false; }
    else { img.hidden = true; img.removeAttribute('src'); }
    const sync = Array.isArray(t?.lyrics) ? t.lyrics.filter(l => Array.isArray(l) && Number.isFinite(l[0])) : [];
    lines = sync.slice().sort((a, b) => a[0] - b[0]).map(([ms, x]) => [ms, String(x ?? '')]);
    kind = lines.length ? 'sync' : t?.plain ? 'plain' : 'none';
    lastLine = -2;
    q('.pc-dur').textContent = fmtTime(s.dur);
    renderLyrics();
  }
  function renderPlay() {
    q('.pc-play').innerHTML = svg(s.playing ? ICON.pause : ICON.play);
    const st = q('.pc-state');
    st.textContent = s.track ? (s.playing ? 'REPRODUCIENDO' : 'EN PAUSA') : 'SIN MÚSICA';
    st.classList.toggle('pc-on', !!s.track && s.playing);
    q('[data-a=shuf]').classList.toggle('pc-on', s.shuffle);
    q('[data-a=rep]').classList.toggle('pc-on', s.repeat !== 'off');
    q('[data-a=rep] small').textContent = s.repeat === 'one' ? '1' : '';
    q('.pc-dur').textContent = fmtTime(s.dur);
  }
  function renderLyrics() {
    const l0 = q('.pc-l0'), l1 = q('.pc-l1'), l2 = q('.pc-l2');
    if (kind !== 'sync') {
      if (lastLine === -3) return;
      lastLine = -3;
      l0.textContent = l2.textContent = '';
      l1.textContent = kind === 'plain' ? 'Letra sin tiempos (ábrela en Música)' : s.track ? 'Sin letra' : '';
      l1.className = 'pc-l1 pc-dim';
      return;
    }
    const ms = (s.pos() - delayMs / 1000) * 1000;
    let lo = 0, hi = lines.length - 1, i = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (lines[m][0] <= ms) { i = m; lo = m + 1; } else hi = m - 1; }
    if (i === lastLine) return;
    lastLine = i;
    const txt = k => (k >= 0 && k < lines.length ? (lines[k][1].trim() || '♪') : '');
    l0.textContent = txt(i - 1);
    l1.textContent = i < 0 ? '♪' : txt(i);
    l2.textContent = txt(i + 1);
    l1.className = 'pc-l1';
    void l1.offsetWidth;
    l1.className = 'pc-l1 pc-in';
  }
  function renderMsg() {
    const m = q('.pc-msg');
    let t = '', x = '';
    if (!hub.open) { t = 'Sin conexión con el hub'; x = 'Reconectando…'; }
    else if (!hub.motor) { t = 'Esperando el teléfono'; x = 'Abre la app Clio en el teléfono.'; }
    else if (!s.track) { t = 'No hay música sonando'; x = 'Elige música en la app del teléfono, pestaña Música.'; }
    m.hidden = !t;
    if (t) { q('.pc-msg b').textContent = t; q('.pc-msg span').textContent = x; }
  }
  const onState = what => {
    if (what === 'track') { renderTrack(); renderPlay(); renderMsg(); }
    else if (what === 'play') { renderPlay(); }
    else renderMsg();
  };
  s.subs.add(onState);
  renderTrack(); renderPlay(); renderMsg();

  const timer = setInterval(() => {
    const p = s.pos();
    if (!drag) { q('.pc-cur').textContent = fmtTime(p); drawSeek(s.dur > 0 ? p / s.dur : 0); }
    renderLyrics();
  }, 125);

  // si el reproductor grande cambia el retraso en otra pestaña, se toma aquí
  const onStorage = e => {
    if (e.key === LS_DELAY && opts.delayMs === undefined) { delayMs = clamp(+e.newValue || 0, 0, 600); viz.delayMs = delayMs; lastLine = -2; }
  };
  window.addEventListener('storage', onStorage);

  return {
    destroy() {
      clearInterval(timer);
      window.removeEventListener('storage', onStorage);
      s.subs.delete(onState);
      s.bins.delete(onBin);
      viz.destroy();
      root.remove();
    },
  };
}
