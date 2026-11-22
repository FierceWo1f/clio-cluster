// Cluster del estéreo: dibuja lo que publica el teléfono (js/link.js) a través del hub.
// Reusa los mismos relojes de la app del teléfono (js/gauges.js).
import { SportGauge, GaugeAnimator } from '../js/gauges.js';

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- relojes (valores iniciales = ajustes por defecto de la app; luego llegan con "cfg") ----------
const animator = new GaugeAnimator();
const tach = animator.add(new SportGauge($('#gTach'), {
  min: 0, max: 7000, major: 1000, minor: 250, divisor: 1000, redFrom: 6250,
  label: 'x1000 RPM', unit: 'rpm', center: 'tach',
}));
const temp = animator.add(new SportGauge($('#gTemp'), {
  min: 40, max: 130, major: 30, minor: 10, redFrom: 110, label: 'TEMP', unit: '°C',
  bands: [{ from: 80, to: 100, color: '#22c55e', alpha: 0.6 }],
}));
const aux = animator.add(new SportGauge($('#gAux'), { min: 10, max: 16, major: 2, minor: 0.5, label: 'BATERÍA', unit: 'V', decimals: 1 }));
const GAUGES = [tach, temp, aux];

const shiftEl = $('#shift');
for (let i = 0; i < 10; i++) shiftEl.appendChild(document.createElement('span'));

let cfg = { shift: { start: 4000, at: 6000 }, mode: 'normal' };
let lastObd = 0;
let lastOn = false;
let motorConnected = false;

// ---------- configuración (modo, bandas, límites) ----------
function applyCfg(c) {
  cfg = c;
  document.documentElement.dataset.accent = c.accent || '';
  tach.setOptions({ max: c.tachMax, redFrom: c.redline, bands: c.bands || [] });
  tach.setInfo({ mode: c.modeLabel, modeColor: c.modeColor });
  temp.setOptions({ redFrom: c.tempAlert });
  // redFrom puede no venir (undefined no viaja en JSON): hay que borrarlo explícitamente
  // para que no se quede el límite rojo del modo anterior.
  if (c.aux) { aux.setOptions({ redFrom: undefined, decimals: 0, ...c.aux }); aux.hasData = false; }
  for (const g of GAUGES) g.refreshTheme?.();
  markMode(c.mode);
}

function markMode(mode) {
  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('on', b.dataset.mode === mode);
}

// ---------- datos en vivo ----------
function render(m) {
  if (m.rpm !== undefined) tach.set(m.rpm);
  tach.setInfo({ speed: m.speed ?? null, gear: m.gear ?? '—', arrow: m.arrow || '' });
  if (m.cool !== undefined) temp.set(m.cool);
  if (m.aux !== undefined) aux.set(m.aux); else aux.hasData = false;

  const speed = m.speed ?? 0;
  if (m.lh !== undefined && speed > 3) {
    $('#fuelInst').textContent = m.l100.toFixed(1);
    $('#fuelInstUnit').textContent = 'L/100km';
  } else {
    $('#fuelInst').textContent = m.lh !== undefined ? m.lh.toFixed(2) : '—';
    $('#fuelInstUnit').textContent = 'L/h';
  }
  const trip = m.trip || { km: 0, ms: 0, fuel: 0 };
  $('#fuelAvg').textContent = trip.km > 0.2 ? ((trip.fuel / trip.km) * 100).toFixed(1) : '—';
  $('#tripKm').textContent = trip.km.toFixed(1);
  const mins = Math.floor(trip.ms / 60000);
  $('#tripTime').textContent = `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
  $('#volt').textContent = m.volt !== undefined ? m.volt.toFixed(1) : '—';
  $('#thr').textContent = m.thr !== undefined ? m.thr.toFixed(0) : '—';
  $('#src').textContent = m.on ? `${m.src} · ${m.hz} lect/s` : '';

  const tt = m.tt || {};
  $('#ttMil').className = 'tt ' + (tt.mil || '');
  $('#ttTemp').className = 'tt ' + (tt.temp || '');
  $('#ttBatt').className = 'tt ' + (tt.batt || '');
  $('#ttShift').className = 'tt ' + (tt.shift || '');
  $('#alerts').innerHTML = (m.alerts || []).map(a => `<div class="${a.lvl === 'warn' ? 'warn' : ''}">${esc(a.msg)}</div>`).join('');

  // luces de cambio
  const sh = cfg.shift || { start: 4000, at: 6000 };
  const span = Math.max(1, sh.at - sh.start);
  const rpm = m.rpm;
  const lit = rpm === undefined ? 0 : Math.max(0, Math.min(10, Math.ceil(((rpm - sh.start) / span) * 10)));
  shiftEl.classList.toggle('flash', rpm !== undefined && rpm >= sh.at);
  const leds = shiftEl.children;
  for (let i = 0; i < 10; i++) leds[i].className = i < lit ? (i < 4 ? 'g' : i < 7 ? 'y' : 'r') : '';
}

// ---------- aviso de "sin datos" ----------
function updateWait() {
  const fresh = performance.now() - lastObd < 3000;
  const ok = fresh && lastOn;
  $('#wait').hidden = ok;
  if (ok) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    $('#waitTitle').textContent = 'Sin conexión con el teléfono';
    $('#waitText').innerHTML = 'Reconectando con el hub…';
  } else if (!motorConnected) {
    $('#waitTitle').textContent = 'Esperando la app del teléfono…';
    $('#waitText').innerHTML = 'En el teléfono abre <b>http://localhost:8080</b> en Chrome (Clio Cluster servida por el hub).';
  } else {
    $('#waitTitle').textContent = 'Esperando datos del auto…';
    $('#waitText').innerHTML = 'En la app del teléfono toca <b>Conectar</b> y elige el ELM327, o el <b>Simulador</b> para probar.';
  }
}
setInterval(updateWait, 500);

// ---------- conexión con el hub ----------
let ws = null;
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws?role=pantalla-cluster`);
  ws.onmessage = e => {
    if (typeof e.data !== 'string') return;
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'obd') { lastObd = performance.now(); lastOn = !!m.on; render(m); }
    else if (m.t === 'cfg') applyCfg(m);
    else if (m.t === 'hub') motorConnected = m.clients.some(r => r.startsWith('motor'));
  };
  ws.onclose = () => { motorConnected = false; setTimeout(connect, 2000); };
}
connect();

// Cambiar de modo desde el estéreo: lo aplica el teléfono y regresa en el siguiente "cfg".
$('#modes').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || !ws || ws.readyState !== WebSocket.OPEN) return;
  markMode(b.dataset.mode);
  ws.send(JSON.stringify({ t: 'cmd', a: 'mode', v: b.dataset.mode }));
});

// Reloj
function tick() {
  const d = new Date();
  $('#clock').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
tick();
setInterval(tick, 1000);
