// Viajes y mantenimiento en el estéreo. Los datos viven en el teléfono (js/trips.js); aquí solo se muestran
// y se mandan comandos: trips.list, trips.get, maint.done, maint.setOdo. Contrato en docs/PROTOCOLO.md
import { Hub, $, esc, startClock } from './common.js';

const hub = new Hub('pantalla-viajes');
startClock($('#clock'));

const CACHE = 'clio.pantalla.viajes';
let odo = null;          // último mensaje "odo"
let trips = [];          // resúmenes
let selId = null;        // viaje seleccionado
let cur = null;          // viaje mostrado {id, summary, pts}
let gotData = false;
let cachedAt = 0;

// Datos guardados en el estéreo para mostrar algo si el teléfono no está
try {
  const c = JSON.parse(localStorage.getItem(CACHE) || 'null');
  if (c) { odo = c.odo || null; trips = c.trips || []; cachedAt = c.at || 0; }
} catch {}
function saveCache() {
  try { localStorage.setItem(CACHE, JSON.stringify({ odo, trips, at: Date.now() })); } catch {}
}

// ---------- formato ----------
const nf0 = n => Math.round(n).toLocaleString('es-MX');
const nf1 = n => n.toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
function fmtDay(ms) {
  const d = new Date(ms);
  try {
    const s = d.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '');
    return s.charAt(0).toUpperCase() + s.slice(1);
  } catch { return d.toDateString(); }
}
const hhmm = ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

function leftText(it) {
  if (it.pct === null || it.pct === undefined) return 'Sin registro todavía';
  const p = [];
  if (it.leftKm !== null && it.leftKm !== undefined) p.push(`${nf0(Math.abs(it.leftKm))} km`);
  if (it.leftDays !== null && it.leftDays !== undefined) p.push(`${nf0(Math.abs(it.leftDays))} días`);
  const over = (it.leftKm !== null && it.leftKm !== undefined && it.leftKm < 0) || (it.leftDays !== null && it.leftDays !== undefined && it.leftDays < 0);
  return (over ? 'Vencido: ' : 'Faltan ') + p.join(' · ');
}
const level = it => (it.pct === null || it.pct === undefined ? 'none' : it.pct >= 1 ? 'red' : it.pct >= 0.8 ? 'amber' : 'ok');

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}
const canSend = () => hub.open && hub.motor;
function needPhone() { toast('Sin conexión con el teléfono: no se puede guardar el cambio'); }

// ---------- pestañas ----------
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  for (const x of document.querySelectorAll('#tabs button')) x.classList.toggle('on', x === b);
  $('#view-maint').classList.toggle('on', b.dataset.tab === 'maint');
  $('#view-trips').classList.toggle('on', b.dataset.tab === 'trips');
  if (b.dataset.tab === 'trips') { if (canSend()) hub.cmd('trips.list'); requestAnimationFrame(drawRoute); }
});

// ---------- mantenimiento ----------
function renderOdo() {
  $('#odoKm').textContent = odo ? nf1(odo.km) : '—';
  const items = (odo && odo.items) || [];
  const red = items.filter(i => level(i) === 'red').length, amber = items.filter(i => level(i) === 'amber').length;
  const none = items.filter(i => level(i) === 'none').length;
  $('#sum').innerHTML = items.length ? `
    <div><i style="background:var(--red)"></i>${red} vencido${red === 1 ? '' : 's'}</div>
    <div><i style="background:var(--amber)"></i>${amber} por vencer</div>
    <div><i style="background:var(--ok)"></i>${items.length - red - amber - none} al día</div>
    ${none ? `<div><i style="background:#3a4452"></i>${none} sin registro</div>` : ''}` : '<div class="note">Sin datos de mantenimiento.</div>';
  // vencidos primero
  const order = { red: 0, amber: 1, ok: 2, none: 3 };
  const sorted = items.slice().sort((a, b) => order[level(a)] - order[level(b)] || (b.pct || 0) - (a.pct || 0));
  $('#cards').innerHTML = sorted.map(it => {
    const lv = level(it);
    const w = it.pct === null || it.pct === undefined ? 0 : Math.min(100, it.pct * 100);
    const every = [it.everyKm ? `${nf0(it.everyKm)} km` : null, it.everyMonths ? `${it.everyMonths} meses` : null].filter(Boolean).join(' / ');
    return `<div class="card ${lv}${it.critical ? ' crit' : ''}">
      <div class="card-name">${esc(it.name)}${it.critical ? '<span class="tag crit">crítico</span>' : ''}${it.sug ? '<span class="tag">sugerido</span>' : ''}</div>
      <div class="bar"><i style="width:${w}%"></i></div>
      <div class="card-bottom">
        <div class="card-txt"><div class="left">${esc(leftText(it))}</div>
          <div class="every">Cada ${esc(every || '—')}</div></div>
        <button class="big-btn" data-done="${esc(it.id)}">Hecho hoy</button>
      </div>
    </div>`;
  }).join('') || '<div class="empty" style="grid-column:1/-1">Esperando datos del teléfono…</div>';
}

// Confirmación de "hecho hoy"
let confirmId = null;
$('#cards').addEventListener('click', e => {
  const b = e.target.closest('[data-done]');
  if (!b || !odo) return;
  if (!canSend()) return needPhone();
  const it = odo.items.find(x => x.id === b.dataset.done);
  if (!it) return;
  confirmId = it.id;
  $('#cfTitle').textContent = it.name;
  $('#cfText').textContent = `¿Marcarlo como hecho hoy a ${nf0(odo.km)} km? El contador de este servicio vuelve a empezar.`;
  $('#mConfirm').hidden = false;
});
$('#cfNo').onclick = () => { $('#mConfirm').hidden = true; };
$('#cfYes').onclick = () => {
  $('#mConfirm').hidden = true;
  if (!canSend()) return needPhone();
  hub.cmd('maint.done', confirmId);
  toast('Listo: guardado en el teléfono');
};

// Teclado numérico para calibrar
let padStr = '';
function padShow() {
  $('#padVal').textContent = padStr ? Number(padStr).toLocaleString('es-MX') : '0';
  $('#padOk').disabled = !padStr;
}
$('#btnCal').onclick = () => {
  if (!canSend()) return needPhone();
  padStr = '';
  padShow();
  $('#mPad').hidden = false;
};
$('#keys').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.k === 'clr') padStr = '';
  else if (b.dataset.k === 'bk') padStr = padStr.slice(0, -1);
  else if (padStr.length < 7) padStr = (padStr + b.textContent).replace(/^0+(?=\d)/, '');
  padShow();
});
$('#padNo').onclick = () => { $('#mPad').hidden = true; };
$('#padOk').onclick = () => {
  if (!padStr) return;
  if (!canSend()) return needPhone();
  hub.cmd('maint.setOdo', Number(padStr));
  $('#mPad').hidden = true;
  toast(`Odómetro calibrado a ${Number(padStr).toLocaleString('es-MX')} km`);
};

// ---------- viajes ----------
function renderList() {
  const el = $('#list');
  if (!trips.length) {
    el.innerHTML = '<div class="empty">Todavía no hay viajes.<br>Se graban solos en el teléfono al pasar de 5 km/h.</div>';
    return;
  }
  el.innerHTML = trips.map(s => `
    <div class="trip${s.id === selId ? ' sel' : ''}" data-id="${s.id}">
      <div class="trip-top"><b>${s.live ? '<span class="live">● En curso</span>' : esc(fmtDay(s.start))}</b><span>${nf1(s.km || 0)}<small>km</small></span></div>
      <div class="trip-sub"><span>${hhmm(s.start)} · ${fmtDur(s.end - s.start)}${s.npts ? ' · GPS' : ''}</span><span>${Math.round(s.avgSpeed || 0)} prom · ${Math.round(s.maxSpeed || 0)} máx</span></div>
    </div>`).join('');
}

// Tocar un viaje (se distingue del arrastre para desplazar la lista)
let downY = 0, moved = false;
$('#list').addEventListener('pointerdown', e => { downY = e.clientY; moved = false; });
$('#list').addEventListener('pointermove', e => { if (Math.abs(e.clientY - downY) > 12) moved = true; });
$('#list').addEventListener('click', e => {
  const t = e.target.closest('.trip');
  if (!t || moved) return;
  selectTrip(Number(t.dataset.id));
});

function selectTrip(id) {
  selId = id;
  renderList();
  const s = trips.find(x => x.id === id);
  cur = { id, summary: s, pts: null };
  renderStats();
  if (!canSend()) { $('#mapMsg').textContent = 'Sin conexión con el teléfono: solo el resumen'; $('#mapMsg').hidden = false; drawRoute(); return; }
  $('#mapMsg').textContent = 'Cargando recorrido…';
  $('#mapMsg').hidden = false;
  drawRoute();
  hub.cmd('trips.get', id);
}

function renderStats() {
  const s = cur && cur.summary;
  const det = $('#detail');
  if (!s) { $('#stats').innerHTML = ''; det.classList.remove('nogps'); return; }
  const noGps = cur.pts ? cur.pts.length < 2 : !s.npts;
  det.classList.toggle('nogps', noGps);
  const dur = s.end - s.start;
  const l100 = s.fuel !== null && s.fuel !== undefined && s.km > 0.5 ? (s.fuel / s.km) * 100 : null;
  $('#stats').innerHTML = `
    <div><small>Distancia</small><b>${nf1(s.km || 0)}<i>km</i></b></div>
    <div><small>Duración</small><b>${fmtDur(dur)}</b></div>
    <div><small>Inicio · ${esc(fmtDay(s.start))}</small><b>${hhmm(s.start)}</b></div>
    <div><small>Vel. máxima</small><b>${Math.round(s.maxSpeed || 0)}<i>km/h</i></b></div>
    <div><small>Promedio en mov.</small><b>${Math.round(s.avgSpeed || 0)}<i>km/h</i></b></div>
    <div><small>Gasolina</small><b>${s.fuel !== null && s.fuel !== undefined ? nf1(s.fuel) + '<i>L</i>' : '—'}${l100 !== null ? `<i>${nf1(l100)} L/100</i>` : ''}</b></div>`;
  if (noGps && cur.pts) { $('#mapMsg').textContent = 'Este viaje no tiene recorrido GPS: solo estadísticas'; $('#mapMsg').hidden = false; }
}

// Color por velocidad: azul (lento) → verde → amarillo → naranja → rojo (120+)
const STOPS = [[0, [59, 130, 246]], [30, [34, 197, 94]], [60, [250, 204, 21]], [90, [249, 115, 22]], [120, [239, 68, 68]]];
function speedColor(v) {
  if (v >= 120) return 'rgb(239,68,68)';
  for (let i = 1; i < STOPS.length; i++) {
    if (v <= STOPS[i][0]) {
      const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i], f = (v - a) / (b - a);
      return `rgb(${ca.map((c, k) => Math.round(c + (cb[k] - c) * f)).join(',')})`;
    }
  }
  return 'rgb(59,130,246)';
}

function drawRoute() {
  const cv = $('#cv');
  const box = cv.parentElement.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.max(1, Math.round(box.width)), H = Math.max(1, Math.round(box.height));
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const pts = cur && cur.pts;
  $('#legend').hidden = !(pts && pts.length >= 2);
  if (!pts || pts.length < 2) return;

  // proyección equirectangular en metros, ajustada al tamaño con margen
  const lat0 = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const kx = Math.cos((lat0 * Math.PI) / 180);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) {
    const x = p[1] * kx, y = p[0];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const pad = 34;
  const sx = (W - 2 * pad) / Math.max(1e-6, x1 - x0), sy = (H - 2 * pad) / Math.max(1e-6, y1 - y0);
  const s = Math.min(sx, sy);
  const ox = (W - (x1 - x0) * s) / 2, oy = (H - (y1 - y0) * s) / 2;
  const X = p => ox + (p[1] * kx - x0) * s, Y = p => H - (oy + (p[0] - y0) * s);

  // cuadrícula tenue
  g.strokeStyle = 'rgba(255,255,255,.04)'; g.lineWidth = 1;
  for (let x = 0; x < W; x += 40) { g.beginPath(); g.moveTo(x + .5, 0); g.lineTo(x + .5, H); g.stroke(); }
  for (let y = 0; y < H; y += 40) { g.beginPath(); g.moveTo(0, y + .5); g.lineTo(W, y + .5); g.stroke(); }

  g.lineCap = 'round'; g.lineJoin = 'round';
  // sombra del trazo
  g.strokeStyle = 'rgba(0,0,0,.65)'; g.lineWidth = 9;
  g.beginPath(); g.moveTo(X(pts[0]), Y(pts[0]));
  for (let i = 1; i < pts.length; i++) g.lineTo(X(pts[i]), Y(pts[i]));
  g.stroke();
  // tramos agrupados por color (pocas llamadas a stroke: la CPU del estéreo es débil)
  g.lineWidth = 5;
  let col = null;
  for (let i = 1; i < pts.length; i++) {
    const v = (pts[i - 1][2] + pts[i][2]) / 2;
    const c = speedColor(Math.round(v / 6) * 6);
    if (c !== col) {
      if (col) g.stroke();
      col = c; g.strokeStyle = c;
      g.beginPath(); g.moveTo(X(pts[i - 1]), Y(pts[i - 1]));
    }
    g.lineTo(X(pts[i]), Y(pts[i]));
  }
  g.stroke();
  // inicio y fin
  const dot = (p, fill, label, right) => {
    g.beginPath(); g.arc(X(p), Y(p), 9, 0, Math.PI * 2);
    g.fillStyle = fill; g.fill(); g.lineWidth = 3; g.strokeStyle = '#07090d'; g.stroke();
    g.fillStyle = '#eef2f7'; g.font = '600 13px system-ui, sans-serif';
    g.textAlign = right ? 'left' : 'right';
    g.fillText(label, X(p) + (right ? 14 : -14), Y(p) + (right ? -8 : 16));
  };
  dot(pts[pts.length - 1], '#eef2f7', 'Fin', false);
  dot(pts[0], '#22c55e', 'Inicio', true);
  g.textAlign = 'left';
}
window.addEventListener('resize', drawRoute);

// ---------- conexión ----------
hub.on('odo', m => { odo = m; gotData = true; renderOdo(); saveCache(); updateStatus(); });
hub.on('trips', m => {
  trips = m.items || []; gotData = true;
  renderList(); saveCache(); updateStatus();
  if (cur && !cur.pts) { const s = trips.find(x => x.id === cur.id); if (s) { cur.summary = s; renderStats(); } }
});
hub.on('trip', m => {
  if (!cur || m.id !== cur.id) return;
  if (!m.summary) { $('#mapMsg').textContent = 'No se encontró el viaje en el teléfono'; return; }
  cur = { id: m.id, summary: m.summary, pts: m.pts || [] };
  $('#mapMsg').hidden = cur.pts.length >= 2;
  renderStats();
  requestAnimationFrame(drawRoute);
});
const ask = () => { if (canSend()) hub.cmd('trips.list'); };
hub.on('open', () => { updateStatus(); setTimeout(ask, 300); });
hub.on('motor', on => { updateStatus(); if (on) setTimeout(ask, 800); });
hub.on('close', updateStatus);

function updateStatus() {
  const st = $('#status');
  if (!hub.open) { st.textContent = 'Sin conexión con el hub'; st.className = 'warn'; }
  else if (!hub.motor) { st.textContent = gotData || cachedAt ? 'Sin teléfono · datos guardados' : 'Sin teléfono'; st.className = 'warn'; }
  else { st.textContent = 'Teléfono conectado'; st.className = 'ok'; }
  // aviso a pantalla completa solo si no hay nada que mostrar
  const nothing = !odo && !trips.length;
  $('#wait').hidden = !(nothing && (!hub.open || !hub.motor));
  $('#waitTitle').textContent = !hub.open ? 'Sin conexión con el teléfono' : 'Esperando la app del teléfono…';
  $('#waitText').innerHTML = !hub.open ? 'Reconectando con el hub…'
    : 'En el teléfono abre <b>http://localhost:8080</b> en Chrome (Clio Cluster servida por el hub). El odómetro, el mantenimiento y los viajes se guardan en el teléfono.';
}
setInterval(updateStatus, 1000);

renderOdo();
renderList();
updateStatus();
