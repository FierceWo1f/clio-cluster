// Cronómetro de aceleración (0–100, 0–60, 60–100, 400 m) con "fantasma" contra la mejor corrida.
// Usa los mensajes "obd" del hub (speed, rpm) y el reloj propio del estéreo al recibirlos.
// La lógica está en tiempos-core.js (se prueba en node).
import { Hub, $, esc, startClock } from './common.js';
import { DragTimer, MODES, recordRun } from './tiempos-core.js';

const KEY = 'clio.tiempos';
let db = { best: {}, hist: [], mode: '0-100' };
try { db = { ...db, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} };

const hub = new Hub('pantalla-tiempos');
startClock($('#clock'));

let mode = MODES[db.mode] ? db.mode : '0-100';
const timer = new DragTimer(mode, db.best[mode]?.profile || null);
let lastObd = 0, lastOn = false, speed = 0, rpm, hz = 0;
let lastResult = null, lastRecord = false;
let abortMsg = '', abortUntil = 0;

const fmtT = s => (Number.isFinite(s) ? s.toFixed(2) : '0.00');

function setMode(m) {
  mode = m;
  db.mode = m; save();
  timer.setMode(m, db.best[m]?.profile || null);
  lastResult = null; lastRecord = false;
  // si ya está detenido se arma de inmediato
  if (lastOn && Number.isFinite(speed)) timer.feed(performance.now(), speed);
  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('on', b.dataset.mode === m);
  renderBottom();
  render();
}

$('#modes').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.mode); });
$('#btnReset').addEventListener('click', () => setMode(mode));

// ---------- datos ----------
hub.on('obd', m => {
  const t = performance.now();
  lastObd = t; lastOn = !!m.on; hz = m.hz || 0;
  rpm = m.rpm;
  if (!m.on || !Number.isFinite(m.speed)) return;
  speed = m.speed;
  const ev = timer.feed(t, m.speed);
  if (ev === 'done') {
    lastResult = timer.result;
    lastRecord = recordRun(db, lastResult);
    save();
    if (lastRecord) timer.ghost = db.best[mode].profile;
    renderBottom();
  } else if (ev === 'abort') {
    abortMsg = timer.reason; abortUntil = t + 2500;
  } else if (ev === 'start') {
    lastResult = null; lastRecord = false;
  }
});

// ---------- dibujo (máx. ~30 cuadros/s) ----------
let lastFrame = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (now - lastFrame < 33) return;
  lastFrame = now;
  render(now);
}
requestAnimationFrame(frame);

function render(now = performance.now()) {
  const fresh = now - lastObd < 3000 && lastOn;
  // Si se pierden los datos a media corrida, se cancela (si no, el reloj seguiría corriendo solo).
  if (timer.state === 'run' && now - lastObd > 1500) {
    timer.reset();
    abortMsg = 'se perdió la señal del OBD'; abortUntil = now + 2500;
  }
  const md = MODES[mode];
  $('#speed').textContent = fresh ? Math.round(speed) : '—';

  // estado
  const st = $('#state'), tb = $('#timeBox');
  let cls, txt;
  const again = md.from > 0 ? `baja de ${md.from - 5} km/h para repetir` : 'detente para repetir';
  if (!fresh && timer.state !== 'run') { cls = 'nodata'; txt = 'Sin datos del auto'; }
  else if (timer.state === 'run') { cls = 'run'; txt = md.kind === 'dist' ? `¡Vamos! ${Math.round(timer.dist)} m` : '¡Vamos!'; }
  else if (now < abortUntil) { cls = 'wait'; txt = `Cancelado: ${abortMsg.toLowerCase()}`; }
  else if (timer.state === 'armed') { cls = 'armed'; txt = 'Listo'; }
  else if (lastResult) { cls = lastRecord ? 'record' : 'done'; txt = (lastRecord ? '¡Nuevo récord! · ' : 'Resultado · ') + again; }
  else { cls = 'wait'; txt = md.from > 0 ? `Baja de ${md.from - 5} km/h para armar` : 'Detente para armar'; }
  st.className = 'state ' + cls;
  st.textContent = txt;

  // tiempo
  const showRes = lastResult && timer.state !== 'run';
  const t = timer.state === 'run' ? timer.elapsed(now) : showRes ? lastResult.time : 0;
  $('#time').textContent = fmtT(t);
  tb.className = 'num time ' + (timer.state === 'run' ? 'run' : showRes ? (lastRecord ? 'record' : 'done') : '');

  // fantasma
  const d = $('#delta');
  const delta = timer.state === 'run' ? timer.delta : showRes ? lastResult.delta : null;
  if (delta !== null && delta !== undefined && Number.isFinite(delta) && (timer.ghost || showRes)) {
    d.className = 'delta ' + (delta <= 0 ? 'faster' : 'slower');
    d.textContent = `${delta <= 0 ? '−' : '+'}${Math.abs(delta).toFixed(2)} s vs mejor`;
  } else {
    d.className = 'delta none';
    d.textContent = db.best[mode] ? 'Fantasma: tu mejor corrida' : 'Sin mejor tiempo todavía';
  }

  // datos chicos bajo la velocidad
  const parts = [];
  parts.push(`<span><b>${rpm !== undefined ? Math.round(rpm) : '—'}</b> rpm</span>`);
  if (timer.state === 'run' || md.kind === 'dist') parts.push(`<span><b>${Math.round(timer.state === 'run' ? timer.dist : showRes ? lastResult.dist : 0)}</b> m</span>`);
  if (showRes && md.kind === 'dist') parts.push(`<span>final a <b>${lastResult.trap}</b> km/h</span>`);
  $('#subL').innerHTML = parts.join('');

  // aviso a pantalla completa si no hay teléfono o datos
  const w = $('#wait');
  w.hidden = fresh || timer.state === 'run';
  if (!w.hidden) {
    if (!hub.open) { $('#waitTitle').textContent = 'Sin conexión con el teléfono'; $('#waitText').innerHTML = 'Reconectando con el hub…'; }
    else if (!hub.motor) {
      $('#waitTitle').textContent = 'Esperando la app del teléfono…';
      $('#waitText').innerHTML = 'En el teléfono abre <b>http://localhost:8080</b> en Chrome (Clio Cluster servida por el hub).';
    } else {
      $('#waitTitle').textContent = 'Esperando datos del auto…';
      $('#waitText').innerHTML = 'En la app del teléfono toca <b>Conectar</b> y elige el ELM327. El cronómetro necesita la velocidad del OBD.';
    }
  }
}

function renderBottom() {
  const b = db.best[mode];
  $('#best').innerHTML = `Mejor ${esc(MODES[mode].label)} <b>${b ? fmtT(b.time) + ' s' : '—'}</b>`;
  const hist = (db.hist || []).filter(h => h.mode === mode).slice(0, 6);
  $('#hist').innerHTML = hist.map(h => {
    const d = new Date(h.date);
    return `<span class="${b && h.time === b.time && h.date === b.date ? 'rec' : ''}">${fmtT(h.time)}<small>${d.getDate()}/${d.getMonth() + 1}</small></span>`;
  }).join('');
  $('#disc').textContent = `Precisión aprox. ±0.2 s: depende de qué tan seguido responde el OBD${hz ? ` (${hz} lect/s)` : ''}.`;
}

setInterval(renderBottom, 5000);
setMode(mode);
