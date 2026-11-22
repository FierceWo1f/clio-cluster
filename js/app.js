import { SerialTransport, BleTransport, SimTransport, NetTransport } from './transport.js';
import { ELM327 } from './elm327.js';
import { PIDS, VIRTUAL, CATEGORIES, pidInfo, formatValue, decodeMonitorStatus } from './pids.js';
import { describeDtc, decodeDtc, SYSTEM_NAMES } from './dtc.js';
import { SportGauge, GaugeAnimator } from './gauges.js';
import { LiveChart, SERIES_COLORS } from './chart.js';
import { DEFAULT_GEAR_RATIOS } from './simulator.js';
import { StereoLink } from './link.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const delay = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// =====================================================================
// Ajustes
// =====================================================================
const DEFAULTS = {
  tachMax: 7000, redline: 6250, shiftRpm: 5800, speedMax: 220,
  tempAlert: 105, voltLow: 12.8, voltHigh: 15.2, sound: true,
  displacement: 1.598, ve: 0.85,
  gears: DEFAULT_GEAR_RATIOS.join(','),
  fastMode: false, sensorPeriod: 800,
  // Modos de manejo. Motor K4M 1.6 16V: par máx. ~3750 rpm, potencia máx. ~5750 rpm.
  mode: 'normal', ecoMaxRpm: 2500, ecoMinRpm: 1300, sportMin: 4000, sportMax: 6000,
  accent: 'rojo', layout: 'deportivo',
  chartKeys: ['0C', '0D', '11', '05'],
};

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('clio.settings') || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  try { localStorage.setItem('clio.settings', JSON.stringify(settings)); } catch {}
}
const settings = loadSettings();
const gearRatios = () => settings.gears.split(',').map(Number).filter(n => n > 0);

// =====================================================================
// Estado
// =====================================================================
const state = {
  connected: false,
  ecuOk: false,
  transport: null,
  elm: null,
  view: 'cluster',
  paused: false,
  supported: new Set(),
  values: {},
  stamps: {},   // momento de la última lectura de cada PID (performance.now)
  minmax: {},
  misses: {},
  errors: 0,
  hz: 0,
  minThrottle: 100,
  trip: { km: 0, fuel: 0, ms: 0 },
  rec: null,
  vin: null,
  wakeLock: null,
};

// Enlace con la pantalla del estéreo (solo si la app se abre desde el hub). Ver js/link.js
let stereo = null;

// PIDs que necesita el cluster y cada cuánto (ms) leerlos. 0 = lo más rápido posible.
const CLUSTER_PIDS = {
  '0C': 0, '0D': 0, '11': 120, '0B': 150, '10': 150, '04': 400, '0E': 600,
  '14': 500, '06': 1000, '07': 4000, '05': 2000, '0F': 3000, '03': 2000,
  '01': 10000, '1C': 600000, '2F': 10000, '42': 5000,
};

const CLUSTER_BARS = [
  { key: '11', label: 'Acelerador' },
  { key: '04', label: 'Carga motor' },
  { key: '0B', label: 'Presión múltiple (MAP)' },
  { key: '0E', label: 'Avance encendido' },
  { key: '0F', label: 'Temp. admisión' },
  { key: '06', label: 'Corrección corto (STFT)' },
  { key: '07', label: 'Corrección largo (LTFT)' },
  { key: '14', label: 'Sonda O2 B1S1' },
  { key: '10', label: 'Flujo aire (MAF)' },
  { key: '2F', label: 'Combustible' },
  { key: 'RV', label: 'Batería' },
];

// =====================================================================
// Relojes y gráfica
// =====================================================================
document.documentElement.dataset.accent = settings.accent;

const animator = new GaugeAnimator();
const tach = animator.add(new SportGauge($('#gTach'), {
  min: 0, max: settings.tachMax, major: 1000, minor: 250, divisor: 1000,
  redFrom: settings.redline, label: 'x1000 RPM', unit: 'rpm', center: 'tach',
}));
const tempG = animator.add(new SportGauge($('#gTemp'), {
  min: 40, max: 130, major: 30, minor: 10, redFrom: settings.tempAlert,
  label: 'TEMP', unit: '°C', bands: [{ from: 80, to: 100, color: '#22c55e', alpha: 0.6 }],
}));
const auxG = animator.add(new SportGauge($('#gAux'), { min: 0, max: 20, major: 5, minor: 1, label: '', unit: '' }));
// diseño clásico: tacómetro y velocímetro separados
const tachC = animator.add(new SportGauge($('#gTachC'), {
  min: 0, max: settings.tachMax, major: 1000, minor: 250, divisor: 1000,
  redFrom: settings.redline, label: 'x1000 RPM', unit: 'rpm', center: 'tach', speedPanel: false,
}));
const speedC = animator.add(new SportGauge($('#gSpeedC'), {
  min: 0, max: settings.speedMax, major: 20, minor: 10, label: '', unit: 'km/h', numSize: 0.095,
}));
const ALL_GAUGES = [tach, tempG, auxG, tachC, speedC];
const chart = new LiveChart($('#chart'));

// ---------- Modos de manejo ----------
// Cada modo define: bandas del tacómetro, luces de cambio, flechas de cambio sugerido
// y qué muestra el reloj pequeño de la derecha.
const MODES = {
  eco: {
    label: 'ECO', color: '#22c55e',
    bands: s => [
      { from: s.ecoMinRpm, to: s.ecoMaxRpm, color: '#22c55e' },
      { from: s.ecoMaxRpm, to: s.redline, color: '#f59e0b', alpha: 0.35 },
    ],
    shift: s => ({ start: s.ecoMaxRpm - 1000, at: s.ecoMaxRpm }),
    upAt: s => s.ecoMaxRpm,
    downAt: s => s.ecoMinRpm,
    aux: { key: 'FUEL', label: 'CONSUMO', unit: 'L/100km', min: 0, max: 20, major: 5, minor: 1, decimals: 1, redFrom: 12 },
    hint: s => `<b>ECO:</b> mantén la aguja en la zona verde (${s.ecoMinRpm}–${s.ecoMaxRpm} rpm). La flecha ▲ indica cuándo subir de marcha para ahorrar combustible.`,
  },
  normal: {
    label: '', color: '#e5e7eb',
    bands: () => [],
    shift: s => ({ start: s.shiftRpm - 2000, at: s.shiftRpm }),
    upAt: () => null,
    downAt: () => null,
    aux: { key: 'RV', label: 'BATERÍA', unit: 'V', min: 10, max: 16, major: 2, minor: 0.5, decimals: 1, redFrom: 15 },
    hint: () => '<b>NORMAL:</b> cluster estándar.',
  },
  sport: {
    label: 'SPORT', color: null,
    bands: s => [{ from: s.sportMin, to: s.sportMax, color: '#facc15' }],
    shift: s => ({ start: s.sportMin, at: s.sportMax }),
    upAt: s => s.sportMax,
    downAt: s => s.sportMin,
    aux: { key: '04', label: 'CARGA', unit: '%', min: 0, max: 100, major: 25, minor: 5, decimals: 0 },
    hint: s => `<b>SPORT:</b> la banda amarilla (${s.sportMin}–${s.sportMax} rpm) es donde el motor da su máxima fuerza. ▲ = sube de marcha, ▼ = baja para volver a la banda.`,
  },
};

function applyMode() {
  const m = MODES[settings.mode] || MODES.normal;
  for (const t of [tach, tachC]) {
    t.setOptions({ bands: m.bands(settings) });
    t.setInfo({ mode: m.label, modeColor: m.color });
  }
  auxG.setOptions({ ...m.aux, redFrom: m.aux.redFrom });
  auxG.hasData = false;
  document.body.dataset.mode = settings.mode;
  $$('#modeSwitch button').forEach(b => {
    const on = b.dataset.mode === settings.mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on);
  });
  $('#modeHint').innerHTML = m.hint(settings);
  publishStereoConfig();
}

function setMode(mode) {
  if (!MODES[mode]) return;
  settings.mode = mode;
  saveSettings();
  applyMode();
}

$('#modeSwitch').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) setMode(b.dataset.mode);
});
document.addEventListener('keydown', e => {
  if (e.target.matches('input, select, textarea') || e.ctrlKey || e.altKey || e.metaKey) return;
  const k = e.key.toLowerCase();
  if (k === 'e') setMode('eco');
  else if (k === 'n') setMode('normal');
  else if (k === 's') setMode('sport');
  else if (k === 'd') setLayout('deportivo');
  else if (k === 'c') setLayout('clasico');
});

// ---------- Diseño del cluster: deportivo / clásico ----------
function applyLayout() {
  document.body.dataset.layout = settings.layout;
  $$('#layoutSwitch button').forEach(b => {
    const on = b.dataset.layout === settings.layout;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on);
  });
}

function setLayout(layout) {
  settings.layout = layout === 'clasico' ? 'clasico' : 'deportivo';
  saveSettings();
  applyLayout();
  const sel = $('#set_layout');
  if (sel) sel.value = settings.layout;
}

$('#layoutSwitch').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) setLayout(b.dataset.layout);
});

function applyGaugeSettings() {
  for (const t of [tach, tachC]) t.setOptions({ max: settings.tachMax, redFrom: settings.redline });
  speedC.setOptions({ max: settings.speedMax });
  tempG.setOptions({ redFrom: settings.tempAlert });
  document.documentElement.dataset.accent = settings.accent;
  for (const g of ALL_GAUGES) g.refreshTheme();
  applyMode();
  applyLayout();
}

/** Flecha de cambio sugerido según el modo. */
function shiftArrow(rpm, gear) {
  const m = MODES[settings.mode];
  const g = parseInt(gear, 10);
  if (!m || rpm === undefined || !g) return '';
  const up = m.upAt(settings), down = m.downAt(settings);
  const nGears = gearRatios().length;
  if (up && rpm >= up && g < nGears) return 'up';
  if (down && rpm < down && g > 1) {
    // en SPORT solo sugerir bajar si se está acelerando
    if (settings.mode === 'sport' && (fresh('11') ?? 0) < 40) return '';
    return 'down';
  }
  return '';
}

// luces de cambio
const shiftEl = $('#shiftLights');
for (let i = 0; i < 10; i++) shiftEl.appendChild(document.createElement('span'));

// =====================================================================
// Valores
// =====================================================================
function setValue(key, v) {
  state.values[key] = v;
  state.stamps[key] = performance.now();
  if (typeof v === 'number' && Number.isFinite(v)) {
    const mm = state.minmax[key] || (state.minmax[key] = { min: v, max: v });
    if (v < mm.min) mm.min = v;
    if (v > mm.max) mm.max = v;
    if (settings.chartKeys.includes(key)) chart.push(key, v);
  }
}

function fresh(key, maxAge = 4000) {
  const t = state.stamps[key];
  return t && performance.now() - t < maxAge ? state.values[key] : undefined;
}

// =====================================================================
// Lectura continua (planificador por prioridad)
// =====================================================================
function wantedPids() {
  const w = new Map();
  const add = (k, p) => { if (!w.has(k) || w.get(k) > p) w.set(k, p); };
  for (const [k, p] of Object.entries(CLUSTER_PIDS)) add(k, p);
  if (state.view === 'sensores') for (const k of state.supported) add(k, settings.sensorPeriod);
  if (state.view === 'graficas') for (const k of settings.chartKeys) add(k, 0);
  add('RV', 2000);
  for (const k of [...w.keys()]) {
    if (k !== 'RV' && (!PIDS[k] || !state.supported.has(k))) w.delete(k);
  }
  return w;
}

async function pollLoop() {
  const elm = state.elm;
  let count = 0;
  let t0 = performance.now();
  while (state.connected && state.ecuOk && state.elm === elm) {
    if (state.paused) { await delay(200); continue; }
    const now = performance.now();
    let best = null, bestScore = -Infinity;
    for (const [k, period] of wantedPids()) {
      // Las lecturas "atrasadas" respecto a su periodo tienen prioridad.
      const last = Math.max(state.stamps[k] || 0, state.stamps['_' + k] || 0);
      const score = now - last - period;
      if (score > bestScore) { bestScore = score; best = k; }
    }
    if (!best) { await delay(250); continue; }

    try {
      if (best === 'RV') {
        const v = await elm.readVoltage(true);
        if (v !== null) setValue('RV', v); else state.stamps._RV = performance.now();
      } else {
        const bytes = await elm.queryRaw(best, true);
        const v = bytes && bytes.length ? PIDS[best].decode(bytes) : null;
        if (v !== null && v !== undefined && !(typeof v === 'number' && Number.isNaN(v))) {
          state.misses[best] = 0;
          setValue(best, v);
        } else {
          state.stamps['_' + best] = performance.now();
          state.misses[best] = (state.misses[best] || 0) + 1;
          if (state.misses[best] >= 4) {
            state.supported.delete(best);
            consoleSys(`El PID ${best} (${PIDS[best].name}) no responde; se deja de consultar.`);
          }
        }
      }
      state.errors = 0;
      count++;
    } catch (e) {
      state.stamps['_' + best] = performance.now();
      state.errors++;
      consoleSys(e.message, true);
      if (state.errors >= 6) {
        toast('El ELM327 dejó de responder. Revisa la conexión.', true);
        await disconnect();
        return;
      }
      await delay(200);
    }
    const t = performance.now();
    if (t - t0 >= 1000) { state.hz = (count * 1000) / (t - t0); count = 0; t0 = t; }
  }
}

// =====================================================================
// Valores derivados: marcha, consumo, viaje, alertas
// =====================================================================
let lastDerive = performance.now();
let lastAlertKey = '';

function fuelRateLh() {
  const rpm = fresh('0C');
  if (rpm === undefined) return undefined;
  if (rpm < 300) return 0;
  let maf = fresh('10');
  if (maf === undefined) {
    const map = fresh('0B', 6000);
    if (map === undefined) return undefined;
    const iat = state.values['0F'] ?? 25;
    // Speed-density: masa de aire (g/s) a partir de MAP, temperatura, rpm y cilindrada
    maf = ((rpm * map) / (iat + 273.15) / 120) * settings.ve * settings.displacement * (28.97 / 8.314);
  }
  // corte de inyección en desaceleración
  const fuelSys = state.values['03'];
  const thr = fresh('11');
  const speed = fresh('0D') ?? 0;
  if (fuelSys === 4) return 0;
  if (thr !== undefined && thr <= state.minThrottle + 1.5 && rpm > 1400 && speed > 15) return 0;
  const trims = 1 + ((state.values['06'] ?? 0) + (state.values['07'] ?? 0)) / 100;
  return (maf / 14.7 / 740) * 3600 * trims; // AFR 14.7, densidad gasolina 740 g/L
}

function estimateGear(speed, rpm) {
  if (speed === undefined || rpm === undefined) return '—';
  if (speed < 3) return 'N';
  if (rpm < 500) return '—';
  const ratio = speed / (rpm / 1000);
  let best = -1, bestErr = Infinity;
  gearRatios().forEach((r, i) => {
    const err = Math.abs(ratio - r) / r;
    if (err < bestErr) { bestErr = err; best = i; }
  });
  return bestErr < 0.12 ? String(best + 1) : '—';
}

function derive() {
  const now = performance.now();
  const dt = (now - lastDerive) / 1000;
  lastDerive = now;
  if (!state.connected || !state.ecuOk) return;

  const rpm = fresh('0C');
  const speed = fresh('0D');
  const thr = fresh('11');
  if (thr !== undefined && rpm > 500) state.minThrottle = Math.min(state.minThrottle, thr);

  if (speed !== undefined) state.trip.km += (speed * dt) / 3600;
  if (rpm > 300) state.trip.ms += dt * 1000;
  const lh = fuelRateLh();
  if (lh !== undefined) {
    state.trip.fuel += (lh * dt) / 3600;
    setValue('FUEL_LH', lh);
    if (speed > 3) setValue('FUEL_L100', (lh / speed) * 100);
  }
  setValue('GEAR', estimateGear(speed, rpm));

  if (state.rec) {
    const row = { t: new Date().toISOString() };
    for (const [k, v] of Object.entries(state.values)) {
      if (typeof v === 'number' && fresh(k, 5000) !== undefined) row[k] = v;
    }
    state.rec.rows.push(row);
    for (const k of Object.keys(row)) state.rec.keys.add(k);
  }
}

function computeAlerts() {
  const out = [];
  const tt = { mil: '', temp: '', batt: '', shift: '' };
  if (!state.connected || !state.ecuOk) return { out, tt };
  const rpm = fresh('0C') ?? 0;
  const cool = fresh('05', 8000);
  const volt = fresh('RV', 8000);
  const mon = state.values['01'];

  if (cool !== undefined) {
    if (cool >= settings.tempAlert) { out.push({ lvl: 'err', msg: `¡Motor sobrecalentado! ${cool.toFixed(0)} °C` }); tt.temp = 'red'; }
    else if (cool < 60 && rpm > 300) tt.temp = 'blue';
  }
  if (volt !== undefined) {
    if (volt > settings.voltHigh) { out.push({ lvl: 'err', msg: `Sobrevoltaje: ${volt.toFixed(1)} V (revisa el alternador/regulador)` }); tt.batt = 'red'; }
    else if (rpm > 500 && volt < settings.voltLow) { out.push({ lvl: 'err', msg: `El alternador no carga: ${volt.toFixed(1)} V` }); tt.batt = 'red'; }
    else if (rpm < 300 && volt < 11.9) { out.push({ lvl: 'warn', msg: `Batería baja: ${volt.toFixed(1)} V` }); tt.batt = 'amber'; }
  }
  if (mon && mon.mil) { out.push({ lvl: 'warn', msg: `Check engine encendido: ${mon.dtcCount} código(s). Ver Diagnóstico.` }); tt.mil = 'amber'; }
  else if (mon && mon.dtcCount > 0) tt.mil = 'amber';
  if (rpm >= MODES[settings.mode].shift(settings).at) tt.shift = 'accent';
  if (state.stamps['0C'] && performance.now() - state.stamps['0C'] > 5000 && !state.paused) {
    out.push({ lvl: 'warn', msg: 'La ECU no está enviando RPM (¿motor apagado?)' });
  }

  const key = out.filter(a => a.lvl === 'err').map(a => a.msg.split(':')[0]).join('|');
  if (key && key !== lastAlertKey) beep(660, 350);
  lastAlertKey = key;
  return { out, tt };
}

// =====================================================================
// Renderizado
// =====================================================================
function buildBars() {
  $('#clusterBars').innerHTML = CLUSTER_BARS.map(b => {
    const info = pidInfo(b.key);
    return `<div class="bar" data-key="${b.key}">
      <div class="top"><span class="cap">${esc(b.label)}</span><span><span class="val">—</span><span class="unit">${esc(info.unit || '')}</span></span></div>
      <div class="track"><div class="fill"></div></div></div>`;
  }).join('');
}

function renderCluster() {
  const rpm = fresh('0C');
  const speed = fresh('0D');
  const gear = state.values.GEAR ?? '—';
  const arrow = shiftArrow(rpm, gear);
  if (rpm !== undefined) { tach.set(rpm); tachC.set(rpm); }
  if (speed !== undefined) speedC.set(speed);
  tach.setInfo({ speed: speed ?? null, gear, arrow });
  tachC.setInfo({ gear: '', arrow: '' }); // en el clásico la marcha va en el panel central

  const cool = fresh('05', 8000);
  if (cool !== undefined) tempG.set(cool);

  // reloj pequeño derecho (y valor del centro en el clásico): depende del modo
  const aux = MODES[settings.mode].aux;
  const auxVal = aux.key === 'FUEL'
    ? (speed > 3 ? fresh('FUEL_L100') : undefined)
    : fresh(aux.key, 8000);
  if (auxVal !== undefined) auxG.set(auxVal);
  else auxG.hasData = false;

  if (settings.layout === 'clasico') {
    $('#cvGear').textContent = gear;
    $('#cvArrow').textContent = arrow === 'up' ? '▲' : arrow === 'down' ? '▼' : '';
    $('#cvCool').textContent = cool !== undefined ? cool.toFixed(0) : '—';
    $('#cvCool').classList.toggle('hot', cool !== undefined && cool >= settings.tempAlert);
    $('#cvAuxLabel').textContent = aux.label.charAt(0) + aux.label.slice(1).toLowerCase();
    $('#cvAuxUnit').textContent = aux.unit;
    $('#cvAux').textContent = auxVal !== undefined ? auxVal.toFixed(aux.decimals) : '—';
    const thr = fresh('11'), iat = fresh('0F', 8000);
    $('#cvThr').textContent = thr !== undefined ? thr.toFixed(0) : '—';
    $('#cvIat').textContent = iat !== undefined ? iat.toFixed(0) : '—';
  }

  $('#tripKm').textContent = state.trip.km.toFixed(1);
  const mins = Math.floor(state.trip.ms / 60000);
  $('#tripTime').textContent = `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
  const lh = fresh('FUEL_LH');
  if (lh !== undefined && speed > 3) {
    $('#fuelInst').textContent = ((lh / speed) * 100).toFixed(1);
    $('#fuelInstUnit').textContent = 'L/100km';
  } else {
    $('#fuelInst').textContent = lh !== undefined ? lh.toFixed(2) : '—';
    $('#fuelInstUnit').textContent = 'L/h';
  }
  $('#fuelAvg').textContent = state.trip.km > 0.2 ? ((state.trip.fuel / state.trip.km) * 100).toFixed(1) : '—';
  $('#fuelUsed').textContent = state.trip.fuel.toFixed(2);
  const volt = fresh('RV', 8000);
  $('#battText').textContent = volt !== undefined ? volt.toFixed(1) : '—';

  // luces de cambio
  const leds = shiftEl.children;
  const sh = MODES[settings.mode].shift(settings);
  const span = Math.max(1, sh.at - sh.start);
  const lit = rpm === undefined ? 0 : Math.max(0, Math.min(10, Math.ceil(((rpm - sh.start) / span) * 10)));
  shiftEl.classList.toggle('flash', rpm !== undefined && rpm >= sh.at);
  for (let i = 0; i < 10; i++) leds[i].className = i < lit ? (i < 4 ? 'g' : i < 7 ? 'y' : 'r') : '';

  // barras
  for (const el of $$('#clusterBars .bar')) {
    const key = el.dataset.key;
    const info = pidInfo(key);
    const v = fresh(key, 8000);
    const supported = key === 'RV' || state.supported.has(key);
    el.hidden = state.ecuOk && !supported; // ocultar sensores que la ECU no reporta
    el.querySelector('.val').textContent = v !== undefined ? formatValue(key, v) : '—';
    const p = v !== undefined ? ((v - info.min) / (info.max - info.min)) * 100 : 0;
    el.querySelector('.fill').style.width = `${Math.max(0, Math.min(100, p))}%`;
  }

  const { out, tt } = computeAlerts();
  $('#alerts').innerHTML = out.map(a => `<div class="${a.lvl === 'warn' ? 'warn' : ''}">${esc(a.msg)}</div>`).join('');
  $('#ttMil').className = 'tt ' + tt.mil;
  $('#ttTemp').className = 'tt ' + tt.temp;
  $('#ttBatt').className = 'tt ' + tt.batt;
  $('#ttShift').className = 'tt ' + tt.shift;
  $('#clusterHint').hidden = state.connected;
}

// ---------- Sensores ----------
let sensorSig = '';
function sensorKeys() {
  const showAll = $('#sensorAll').checked;
  const keys = Object.keys(PIDS).filter(k => showAll || state.supported.has(k));
  return [...keys, 'RV', 'FUEL_LH', 'FUEL_L100', 'GEAR'];
}

function buildSensors() {
  const filter = $('#sensorFilter').value.trim().toLowerCase();
  const keys = sensorKeys().filter(k => !filter || pidInfo(k).name.toLowerCase().includes(filter) || k.toLowerCase() === filter);
  const sig = keys.join(',') + '|' + settings.chartKeys.join(',');
  if (sig === sensorSig) return;
  sensorSig = sig;
  const byCat = {};
  for (const k of keys) (byCat[pidInfo(k).cat || 'estado'] ||= []).push(k);
  let html = '';
  if (!state.ecuOk && !$('#sensorAll').checked) {
    html += '<p class="hint">Conecta para ver los sensores que soporta tu ECU, o activa "Mostrar también los no soportados".</p>';
  }
  for (const [cat, title] of Object.entries(CATEGORIES)) {
    if (!byCat[cat]) continue;
    html += `<h3 class="cat-title">${esc(title)}</h3><div class="sgrid">`;
    for (const k of byCat[cat]) {
      const info = pidInfo(k);
      const isPid = !!PIDS[k];
      const cls = ['sensor'];
      if (settings.chartKeys.includes(k)) cls.push('charted');
      if (isPid && state.ecuOk && !state.supported.has(k)) cls.push('unsupported');
      html += `<div class="${cls.join(' ')}" data-key="${k}" title="${info.text ? '' : 'Clic para añadir/quitar de la gráfica'}">
        <span class="pid">${isPid ? '01 ' + k : k === 'RV' ? 'ELM' : 'calc'}</span>
        <div class="name">${esc(info.name)}</div>
        <div class="v${info.text ? ' text' : ''}"><span class="num">—</span><span class="u">${esc(info.unit || '')}</span></div>
        <div class="mm"></div></div>`;
    }
    html += '</div>';
  }
  $('#sensorGrid').innerHTML = html;
}

function renderSensors() {
  buildSensors();
  for (const el of $$('#sensorGrid .sensor')) {
    const k = el.dataset.key;
    const v = state.values[k];
    el.querySelector('.num').textContent = v !== undefined ? formatValue(k, v) : '—';
    const mm = state.minmax[k];
    const info = pidInfo(k);
    el.querySelector('.mm').textContent = mm && !info.text
      ? `mín ${mm.min.toFixed(info.decimals ?? 1)} · máx ${mm.max.toFixed(info.decimals ?? 1)}`
      : '';
  }
}

$('#sensorGrid').addEventListener('click', e => {
  const el = e.target.closest('.sensor');
  if (!el) return;
  const k = el.dataset.key;
  if (pidInfo(k).text) return;
  toggleChartKey(k);
});
$('#sensorFilter').addEventListener('input', () => renderSensors());
$('#sensorAll').addEventListener('change', () => renderSensors());
$('#btnResetMinMax').addEventListener('click', () => { state.minmax = {}; renderSensors(); });

// ---------- Gráficas ----------
function chartableKeys() {
  const keys = Object.keys(PIDS).filter(k => !PIDS[k].text && (state.supported.has(k) || !state.ecuOk));
  return [...keys, 'RV', 'FUEL_LH'];
}

function toggleChartKey(k) {
  const list = settings.chartKeys;
  const i = list.indexOf(k);
  if (i >= 0) list.splice(i, 1);
  else {
    if (list.length >= 8) { toast('Máximo 8 series en la gráfica.'); return; }
    list.push(k);
  }
  saveSettings();
  applyChartSeries();
  sensorSig = '';
}

function applyChartSeries() {
  chart.setSeries(settings.chartKeys.map(k => {
    const info = pidInfo(k);
    return { key: k, label: info.short || info.name, unit: info.unit, min: info.min ?? 0, max: info.max ?? 100 };
  }));
  buildPicker();
}

function buildPicker() {
  $('#chartPicker').innerHTML = chartableKeys().map(k => {
    const info = pidInfo(k);
    return `<label><input type="checkbox" value="${k}" ${settings.chartKeys.includes(k) ? 'checked' : ''}>${esc(info.short || info.name)}</label>`;
  }).join('');
}

$('#chartPicker').addEventListener('change', e => {
  if (e.target.matches('input')) toggleChartKey(e.target.value);
});
$('#chartWindow').addEventListener('change', e => { chart.windowSec = +e.target.value; });
$('#btnChartPause').addEventListener('click', e => {
  chart.paused = !chart.paused;
  e.target.textContent = chart.paused ? '▶ Continuar' : '⏸ Pausar';
});
$('#btnChartClear').addEventListener('click', () => chart.clear());

function renderLegend() {
  $('#chartLegend').innerHTML = settings.chartKeys.map((k, i) => {
    const info = pidInfo(k);
    const v = state.values[k];
    return `<span><i style="background:${SERIES_COLORS[i % SERIES_COLORS.length]}"></i>${esc(info.short || info.name)}: <b>${v !== undefined ? formatValue(k, v) : '—'}</b> ${esc(info.unit || '')}</span>`;
  }).join('');
}

// ---------- pantalla del estéreo ----------
// Configuración del cluster (cambia poco): se manda al conectar una pantalla y al cambiar de modo/ajustes.
function publishStereoConfig() {
  if (!stereo) return;
  const m = MODES[settings.mode] || MODES.normal;
  stereo.publish({
    t: 'cfg', mode: settings.mode, modeLabel: m.label, modeColor: m.color, accent: settings.accent,
    bands: m.bands(settings), shift: m.shift(settings), aux: m.aux,
    tachMax: settings.tachMax, redline: settings.redline, speedMax: settings.speedMax, tempAlert: settings.tempAlert,
  });
}

// Estado del auto (10 veces por segundo). Los valores sin dato se omiten (undefined no viaja en JSON).
function stereoSnapshot() {
  const rpm = fresh('0C');
  const speed = fresh('0D');
  const gear = state.values.GEAR ?? '—';
  const aux = (MODES[settings.mode] || MODES.normal).aux;
  const lh = fresh('FUEL_LH');
  const { out, tt } = computeAlerts();
  return {
    t: 'obd', on: state.connected && state.ecuOk, src: state.transport?.label || '', hz: +state.hz.toFixed(1),
    rpm, speed, gear, arrow: shiftArrow(rpm, gear),
    cool: fresh('05', 8000), volt: fresh('RV', 8000), thr: fresh('11'), load: fresh('04'), iat: fresh('0F', 8000),
    lh, l100: lh !== undefined && speed > 3 ? (lh / speed) * 100 : undefined,
    aux: aux.key === 'FUEL' ? (speed > 3 ? fresh('FUEL_L100') : undefined) : fresh(aux.key, 8000),
    trip: { km: state.trip.km, ms: state.trip.ms, fuel: state.trip.fuel },
    alerts: out, tt,
  };
}

// ---------- bucle de renderizado ----------
let stereoTick = 0;
setInterval(() => {
  derive();
  if (stereo) {
    stereo.publish(stereoSnapshot());
    if (++stereoTick % 30 === 0) publishStereoConfig(); // cada 3 s por si una pantalla se perdió algo
  }
  if (state.view === 'cluster') renderCluster();
  else if (state.view === 'sensores') renderSensors();
  else if (state.view === 'graficas') renderLegend();
  $('#hz').textContent = state.connected && state.ecuOk ? `${state.hz.toFixed(1)} lect/s` : '';
}, 100);

// =====================================================================
// Pestañas
// =====================================================================
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  state.view = b.dataset.view;
  $$('#tabs button').forEach(x => x.classList.toggle('active', x === b));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + state.view));
  if (state.view === 'sensores') { sensorSig = ''; renderSensors(); }
  if (state.view === 'graficas') buildPicker();
  if (state.view === 'cluster') for (const g of ALL_GAUGES) g.refreshTheme();
});

// =====================================================================
// Conexión
// =====================================================================
function setStatus(kind, text) {
  $('#connDot').className = 'dot ' + (kind || '');
  $('#connText').textContent = text;
}

function setConnectedUi(on) {
  $$('.needs-conn').forEach(b => { b.disabled = !on; });
  $('#btnRecord').disabled = !on;
  $('#btnConnect').textContent = on ? 'Desconectar' : 'Conectar';
  $('#btnConnect').classList.toggle('primary', !on);
}

const connectDialog = $('#connectDialog');
const progressDialog = $('#progressDialog');

$('#btnConnect').addEventListener('click', () => {
  if (state.connected) { disconnect(); return; }
  const serialOpt = connectDialog.querySelector('[value=serial]');
  const bleOpt = connectDialog.querySelector('[value=ble]');
  serialOpt.disabled = !SerialTransport.supported();
  bleOpt.disabled = !BleTransport.supported();
  connectDialog.returnValue = '';
  connectDialog.showModal();
});

connectDialog.addEventListener('close', () => {
  const v = connectDialog.returnValue;
  if (['serial', 'ble', 'net', 'sim'].includes(v)) connect(v);
});

function progress(msg, cls = '') {
  const li = document.createElement('li');
  li.textContent = msg;
  if (cls) li.className = cls;
  $('#progressLog').appendChild(li);
  li.scrollIntoView({ block: 'nearest' });
  consoleSys(msg, cls === 'err');
}
$('#btnProgressClose').addEventListener('click', () => progressDialog.close());

async function connect(kind) {
  const t = kind === 'serial' ? new SerialTransport(+$('#baudSel').value)
    : kind === 'ble' ? new BleTransport()
    : kind === 'net' ? new NetTransport($('#netHost').value.trim() || '127.0.0.1', +$('#netPort').value || 35000)
    : new SimTransport();
  if (kind === 'net') {
    settings.netHost = $('#netHost').value.trim();
    settings.netPort = +$('#netPort').value;
    saveSettings();
  }
  setStatus('busy', 'Conectando…');
  try {
    await t.connect();
  } catch (e) {
    setStatus('', 'Desconectado');
    if (e.name !== 'NotFoundError') toast(e.message || String(e), true);
    return;
  }

  $('#progressLog').innerHTML = '';
  progressDialog.showModal();
  progress(`Conectado a: ${t.label}`);

  const elm = new ELM327(t);
  elm.fastMode = settings.fastMode;
  elm.onTraffic = consoleTraffic;
  t.onDisconnect = () => {
    if (state.transport === t && state.connected) {
      toast('Se perdió la conexión con el ELM327.', true);
      disconnect();
    }
  };
  state.transport = t;
  state.elm = elm;
  state.connected = true;
  setConnectedUi(true);

  await initEcu();
}

async function initEcu() {
  const elm = state.elm;
  state.ecuOk = false;
  setStatus('busy', 'Inicializando…');
  try {
    await elm.init(m => progress(m), settings.elmStrategy);
  } catch (e) {
    if (!state.connected) return;
    progress(e.message, 'err');
    if (!elm.version) {
      progress('El adaptador no respondió. ¿Elegiste el puerto COM correcto? Prueba con el otro puerto COM del ELM.', 'err');
      await disconnect();
      return;
    }
    progress('El adaptador funciona, pero la ECU no contesta. Puedes usar la Consola o reintentar con el contacto en ON.', 'err');
    setStatus('busy', 'Adaptador conectado · ECU sin respuesta');
    addRetryButton();
    renderEcuInfo();
    return;
  }
  state.ecuOk = true;
  state.supported = new Set([...elm.supported].filter(k => PIDS[k]));
  if (elm.strategy) { settings.elmStrategy = elm.strategy.id; saveSettings(); }
  if (!state.supported.size) {
    progress('La ECU contestó, pero no entrega ningún sensor estándar. Ve a Diagnóstico → "Prueba de conexión completa" y envía el reporte.', 'err');
  }
  state.misses = {};
  state.errors = 0;
  state.stamps = {};
  state.minThrottle = 100;
  progress('¡Listo! Leyendo datos en vivo.', 'ok');
  setTimeout(() => progressDialog.open && progressDialog.close(), 900);
  setStatus('on', `${state.transport.label} · ${elm.protocolName}`);
  renderEcuInfo();
  renderSupported();
  sensorSig = '';
  buildPicker();
  requestWakeLock();
  pollLoop();
}

function addRetryButton() {
  const row = progressDialog.querySelector('.row');
  if (row.querySelector('.retry')) return;
  const b = document.createElement('button');
  b.className = 'btn primary retry';
  b.textContent = 'Reintentar';
  b.onclick = () => { b.remove(); initEcu(); };
  row.prepend(b);
}

async function disconnect() {
  const t = state.transport;
  state.connected = false;
  state.ecuOk = false;
  state.transport = null;
  state.elm = null;
  setConnectedUi(false);
  setStatus('', 'Desconectado');
  releaseWakeLock();
  try { await t?.close(); } catch {}
  renderEcuInfo();
}

// =====================================================================
// Diagnóstico
// =====================================================================
function renderEcuInfo() {
  const elm = state.elm;
  const rows = [];
  if (!state.connected || !elm) rows.push(['Estado', 'Sin conexión']);
  else {
    rows.push(['Conexión', state.transport.label]);
    rows.push(['Adaptador', elm.version || '—']);
    rows.push(['Protocolo', elm.protocolName || 'No detectado']);
    if (elm.strategy) rows.push(['Método', elm.strategy.name]);
    rows.push(['PIDs soportados', state.ecuOk ? String(state.supported.size) : '—']);
    if (state.values['1C'] !== undefined) rows.push(['Norma', formatValue('1C', state.values['1C'])]);
    if (state.vin) rows.push(['VIN', state.vin]);
  }
  $('#ecuInfo').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}

function renderSupported() {
  const keys = [...state.supported].sort();
  $('#supportedList').innerHTML = keys.length
    ? keys.map(k => `<span class="chip"><b>${k}</b>${esc(PIDS[k].name)}</span>`).join('')
    : '<span class="muted">Ninguno.</span>';
}

async function withButton(btn, fn) {
  if (!state.elm) return;
  const txt = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Leyendo…';
  try { await fn(); }
  catch (e) { toast(e.message || String(e), true); }
  finally { btn.textContent = txt; btn.disabled = !state.connected; }
}

function renderDtcs(codes, pending) {
  const title = pending ? 'pendientes' : 'almacenados';
  if (!codes.length) {
    $('#dtcList').innerHTML = `<p class="ok">✔ No hay códigos ${title}.</p>`;
    return;
  }
  $('#dtcList').innerHTML = `<p class="muted small">${codes.length} código(s) ${title}:</p>` + codes.map(c => `
    <div class="dtc${pending ? ' pending' : ''}">
      <span class="code">${c}</span>
      <div><div>${esc(describeDtc(c))}</div><div class="muted small">${esc(SYSTEM_NAMES[c[0]] || '')}${pending ? ' · pendiente (aún no enciende el testigo)' : ''}</div></div>
    </div>`).join('');
}

$('#btnReadDtc').addEventListener('click', e => withButton(e.target, async () => {
  renderDtcs(await state.elm.readDtcs('03'), false);
}));
$('#btnReadPending').addEventListener('click', e => withButton(e.target, async () => {
  renderDtcs(await state.elm.readDtcs('07'), true);
}));
$('#btnClearDtc').addEventListener('click', e => {
  const ok = confirm(
    '¿Borrar los códigos de falla?\n\n' +
    '• Se apagará el testigo "check engine" y se borrará el freeze frame.\n' +
    '• Los monitores de preparación se reinician (la verificación vehicular puede rechazar el auto hasta que se completen).\n' +
    '• Hazlo con el contacto en ON y el motor APAGADO.\n\n' +
    'Si la falla sigue presente, el código volverá a aparecer.');
  if (!ok) return;
  withButton(e.target, async () => {
    const done = await state.elm.clearDtcs();
    toast(done ? 'Códigos borrados.' : 'La ECU no confirmó el borrado.', !done);
    renderDtcs(await state.elm.readDtcs('03'), false);
  });
});

$('#btnMonitors').addEventListener('click', e => withButton(e.target, async () => {
  const bytes = await state.elm.queryRaw('01');
  if (!bytes || bytes.length < 4) { $('#monitors').innerHTML = '<p class="muted">La ECU no reporta monitores.</p>'; return; }
  const m = decodeMonitorStatus(bytes);
  setValue('01', m);
  const list = m.monitors.filter(x => x.available);
  $('#monitors').innerHTML = `
    <p>${m.mil ? '<b style="color:#ffb020">Testigo MIL ENCENDIDO</b>' : 'Testigo MIL apagado'} · ${m.dtcCount} código(s) · Motor de ${m.spark ? 'gasolina' : 'diésel'}</p>` +
    list.map(x => `<div class="mon"><span>${esc(x.name)}</span><span class="${x.complete ? 's-ok' : 's-no'}">${x.complete ? 'Completo' : 'Incompleto'}</span></div>`).join('');
}));

const FREEZE_PIDS = ['02', '04', '05', '06', '07', '0B', '0C', '0D', '0E', '0F', '11'];
$('#btnFreeze').addEventListener('click', e => withButton(e.target, async () => {
  const rows = [];
  for (const pid of FREEZE_PIDS) {
    const b = await state.elm.readFreezeFrame(pid);
    if (!b || !b.length) continue;
    if (pid === '02') {
      if (b.length >= 2 && (b[0] || b[1])) rows.push(['Código que lo provocó', decodeDtc(b[0], b[1])]);
      continue;
    }
    const v = PIDS[pid].decode(b);
    if (typeof v === 'number' && Number.isNaN(v)) continue;
    rows.push([PIDS[pid].name, `${formatValue(pid, v)} ${PIDS[pid].unit || ''}`]);
  }
  $('#freeze').innerHTML = rows.length
    ? `<table class="ff">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`
    : '<p class="muted">No hay freeze frame guardado.</p>';
}));

// ---------- Prueba de conexión completa ----------
let reportText = '';
$('#btnReport').addEventListener('click', async e => {
  const btn = e.target;
  if (!state.elm || !confirm('La prueba pausa la lectura y tarda 1–3 minutos. Deja el contacto en ON. ¿Continuar?')) return;
  const elm = state.elm;
  const wasOk = state.ecuOk;
  state.ecuOk = false;          // detiene el bucle de lectura
  await delay(400);
  btn.disabled = true;
  const out = $('#reportOut');
  out.hidden = false;
  out.textContent = 'Iniciando…\n';
  try {
    reportText = await elm.runReport(m => { out.textContent += m + '\n'; out.scrollTop = out.scrollHeight; });
    out.textContent = reportText;
    $('#btnReportCopy').hidden = false;
    $('#btnReportSave').hidden = false;
    toast('Prueba terminada. Copia o descarga el reporte.');
  } catch (err) {
    out.textContent += '\nError: ' + err.message;
  } finally {
    btn.disabled = !state.connected;
  }
  // Reconectar a la ECU con el método normal
  if (state.connected && state.elm === elm) {
    $('#progressLog').innerHTML = '';
    progressDialog.showModal();
    await initEcu();
  }
});

$('#btnReportCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(reportText); toast('Reporte copiado. Pégalo en el chat.'); }
  catch { toast('No se pudo copiar; usa "Descargar .txt".', true); }
});
$('#btnReportSave').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([reportText], { type: 'text/plain;charset=utf-8' }));
  a.download = `clio_prueba_conexion_${Date.now()}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$('#btnVin').addEventListener('click', e => withButton(e.target, async () => {
  const vin = await state.elm.readVin();
  if (vin) { state.vin = vin; renderEcuInfo(); }
  else toast('Tu ECU no reporta el VIN (normal en autos de 2002).');
}));

// =====================================================================
// Consola
// =====================================================================
const consoleEl = $('#consoleLog');
function consoleAppend(cls, text) {
  const atBottom = consoleEl.scrollTop + consoleEl.clientHeight >= consoleEl.scrollHeight - 30;
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = text + '\n';
  consoleEl.appendChild(span);
  while (consoleEl.childNodes.length > 1500) consoleEl.firstChild.remove();
  if (atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
}
function consoleTraffic(dir, text, polling) {
  if (polling && !$('#consolePolling').checked) return;
  consoleAppend(dir, (dir === 'tx' ? '> ' : '  ') + (text || '(vacío)').replace(/\n/g, '\n  '));
}
function consoleSys(text, err = false) {
  consoleAppend(err ? 'err' : 'sys', '# ' + text);
}

$('#consoleForm').addEventListener('submit', async e => {
  e.preventDefault();
  const cmd = $('#consoleInput').value.trim();
  if (!cmd || !state.elm) return;
  $('#consoleInput').value = '';
  try { await state.elm.send(cmd.toUpperCase(), { timeout: 8000 }); }
  catch (err) { consoleSys(err.message, true); }
});
$$('.quick [data-cmd]').forEach(b => b.addEventListener('click', async () => {
  try { await state.elm?.send(b.dataset.cmd, { timeout: 8000 }); }
  catch (err) { consoleSys(err.message, true); }
}));
$('#consolePause').addEventListener('change', e => {
  state.paused = e.target.checked;
  consoleSys(state.paused ? 'Lectura continua en pausa.' : 'Lectura continua reanudada.');
});
$('#btnConsoleClear').addEventListener('click', () => { consoleEl.innerHTML = ''; });

// =====================================================================
// Grabación CSV
// =====================================================================
$('#btnRecord').addEventListener('click', () => {
  const btn = $('#btnRecord');
  if (!state.rec) {
    state.rec = { rows: [], keys: new Set(['t']), start: new Date() };
    btn.textContent = '■ Detener y guardar';
    btn.classList.add('rec');
    toast('Grabando… los datos se guardarán en un archivo CSV.');
    return;
  }
  const rec = state.rec;
  state.rec = null;
  btn.textContent = '● Grabar';
  btn.classList.remove('rec');
  if (!rec.rows.length) { toast('No se grabaron datos.'); return; }
  const keys = [...rec.keys];
  const header = keys.map(k => (k === 't' ? 'hora' : `${pidInfo(k).short || k} (${pidInfo(k).unit || ''})`));
  const lines = [header.map(h => `"${h}"`).join(',')];
  for (const r of rec.rows) lines.push(keys.map(k => r[k] ?? '').join(','));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  const d = rec.start;
  const pad = n => String(n).padStart(2, '0');
  a.download = `clio_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.csv`;
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`Guardadas ${rec.rows.length} filas.`);
});

$('#btnTripReset').addEventListener('click', () => { state.trip = { km: 0, fuel: 0, ms: 0 }; });

// =====================================================================
// Ajustes
// =====================================================================
const SETTINGS_SCHEMA = [
  { group: 'Cluster', fields: [
    { k: 'accent', label: 'Color del cluster', type: 'select', options: [['rojo', 'Rojo'], ['morado', 'Morado']] },
    { k: 'tachMax', label: 'RPM máximas del tacómetro', step: 500 },
    { k: 'redline', label: 'Inicio de zona roja (rpm)', step: 50 },
    { k: 'layout', label: 'Diseño', type: 'select', options: [['deportivo', 'Deportivo'], ['clasico', 'Clásico']] },
    { k: 'shiftRpm', label: 'Luz de cambio en modo NORMAL (rpm)', step: 50 },
    { k: 'speedMax', label: 'Velocidad máx. del velocímetro (km/h)', step: 20,
      help: 'Solo se usa en el diseño clásico.' },
  ] },
  { group: 'Modos de manejo', fields: [
    { k: 'ecoMinRpm', label: 'ECO: rpm mínimas (debajo, sugiere bajar)', step: 100 },
    { k: 'ecoMaxRpm', label: 'ECO: rpm máximas para ahorrar', step: 100,
      help: 'En el K4M 1.6 16V, cambiar entre 2000 y 2500 rpm suele dar el menor consumo.' },
    { k: 'sportMin', label: 'SPORT: inicio del rango óptimo (rpm)', step: 100 },
    { k: 'sportMax', label: 'SPORT: fin del rango óptimo / cambio (rpm)', step: 100,
      help: 'El K4M entrega su par máximo cerca de 3750 rpm y su potencia máxima cerca de 5750 rpm.' },
  ] },
  { group: 'Alertas', fields: [
    { k: 'tempAlert', label: 'Alerta temperatura refrigerante (°C)', step: 1 },
    { k: 'voltLow', label: 'Voltaje mínimo con motor encendido (V)', step: 0.1 },
    { k: 'voltHigh', label: 'Voltaje máximo (V)', step: 0.1 },
    { k: 'sound', label: 'Sonido en alertas', type: 'checkbox' },
  ] },
  { group: 'Consumo (estimación)', fields: [
    { k: 'displacement', label: 'Cilindrada (litros)', step: 0.001 },
    { k: 've', label: 'Eficiencia volumétrica', step: 0.01,
      help: 'El Clio no tiene sensor MAF: el consumo se calcula con MAP, RPM y temperatura. Si la app marca menos litros de los que realmente cargas, sube este valor (y viceversa).' },
  ] },
  { group: 'Comunicación', fields: [
    { k: 'fastMode', label: 'Modo rápido (ATAT2 + respuesta única)', type: 'checkbox',
      help: 'Puede duplicar la velocidad de lectura. Algunos clones del ELM327 fallan con esto: si ves errores, desactívalo. Se aplica al reconectar.' },
    { k: 'sensorPeriod', label: 'Refresco de la pestaña Sensores (ms)', step: 100 },
  ] },
];

function buildSettings() {
  let html = '';
  for (const g of SETTINGS_SCHEMA) {
    html += `<fieldset><legend>${esc(g.group)}</legend>`;
    for (const f of g.fields) {
      const id = 'set_' + f.k;
      const input = f.type === 'checkbox'
        ? `<input type="checkbox" id="${id}" data-k="${f.k}" ${settings[f.k] ? 'checked' : ''}>`
        : f.type === 'select'
          ? `<select id="${id}" data-k="${f.k}">${f.options.map(([v, t]) => `<option value="${v}" ${settings[f.k] === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`
          : `<input type="number" id="${id}" data-k="${f.k}" step="${f.step}" value="${settings[f.k]}">`;
      html += `<div class="f"><label for="${id}">${esc(f.label)}</label>${input}${f.help ? `<small>${esc(f.help)}</small>` : ''}</div>`;
    }
    html += '</fieldset>';
  }
  // marchas
  const ratios = gearRatios();
  html += '<fieldset><legend>Marchas (km/h por cada 1000 rpm)</legend>';
  html += '<p class="muted small">Para calibrar: maneja estable en cada marcha y presiona "Usar actual".</p>';
  for (let i = 0; i < 5; i++) {
    html += `<div class="f g3"><label>Marcha ${i + 1}</label>
      <input type="number" step="0.1" data-gear="${i}" value="${ratios[i] ?? ''}">
      <button type="button" class="btn tiny ghost" data-calib="${i}">Usar actual</button></div>`;
  }
  html += '<div class="row end"><button type="button" class="btn ghost" id="btnResetSettings">Restaurar valores por defecto</button></div>';
  html += '</fieldset>';
  $('#settingsForm').innerHTML = html;
}

$('#settingsForm').addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.k) {
    settings[el.dataset.k] = el.type === 'checkbox' ? el.checked
      : el.tagName === 'SELECT' ? el.value
      : parseFloat(el.value);
  } else if (el.dataset.gear !== undefined) {
    const r = gearRatios();
    r[+el.dataset.gear] = parseFloat(el.value);
    settings.gears = r.join(',');
  }
  saveSettings();
  applyGaugeSettings();
});

$('#settingsForm').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'btnResetSettings') {
    if (!confirm('¿Restaurar todos los ajustes por defecto?')) return;
    Object.assign(settings, DEFAULTS, { chartKeys: [...DEFAULTS.chartKeys] });
    saveSettings();
    applyGaugeSettings();
    buildSettings();
    applyChartSeries();
    return;
  }
  if (b.dataset.calib !== undefined) {
    const speed = fresh('0D'), rpm = fresh('0C');
    if (!speed || !rpm || speed < 10) { toast('Necesitas ir a velocidad estable (más de 10 km/h) en esa marcha.'); return; }
    const r = gearRatios();
    r[+b.dataset.calib] = +(speed / (rpm / 1000)).toFixed(2);
    settings.gears = r.join(',');
    saveSettings();
    buildSettings();
    toast(`Marcha ${+b.dataset.calib + 1} calibrada: ${r[+b.dataset.calib]} km/h por 1000 rpm.`);
  }
});

// =====================================================================
// Utilidades: toast, sonido, pantalla encendida, instalación PWA
// =====================================================================
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 4000);
}

let audioCtx;
function beep(freq = 880, ms = 200) {
  if (!settings.sound) return;
  try {
    audioCtx ||= new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = freq;
    g.gain.value = 0.12;
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + ms / 1000);
  } catch {}
}

async function requestWakeLock() {
  try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
function releaseWakeLock() {
  try { state.wakeLock?.release(); } catch {}
  state.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.connected) requestWakeLock();
});

let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  $('#btnInstall').hidden = false;
});
$('#btnInstall').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('#btnInstall').hidden = true;
});
window.addEventListener('appinstalled', () => toast('¡App instalada! Ya puedes abrirla desde el menú Inicio.'));

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW no registrado', err));
}

{
  const link = new StereoLink({
    onCommand: m => { if (m.a === 'mode') setMode(m.v); },
    onStatus: ({ open, screens }) => {
      const el = $('#stereoState');
      if (el) {
        el.hidden = !open;
        el.textContent = screens ? 'Estéreo conectado' : 'Hub sin estéreo';
        el.classList.toggle('on', screens > 0);
      }
    },
  });
  link.onScreen = () => publishStereoConfig();
  link.start().then(ok => { if (ok) stereo = link; });
}

// =====================================================================
// Inicio
// =====================================================================
if (settings.netHost) $('#netHost').value = settings.netHost;
if (settings.netPort) $('#netPort').value = settings.netPort;
buildBars();
buildSettings();
applyMode();
applyLayout();
applyChartSeries();
renderEcuInfo();
setConnectedUi(false);
if (!SerialTransport.supported()) {
  toast('Para conectar el ELM327 usa Google Chrome o Microsoft Edge.', true);
}
