// Página del mapa del estéreo (1024×600): mapa estilo juego de carreras + HUD de navegación.
// Contrato: docs/PROTOCOLO.md (GPS, Navegación, Datos de mapa, Cluster).
// Parámetro de prueba: mapa.html?base=/datos/prueba-mapa/  (carpeta de datos del mapa; por defecto /datos/mapa/)
import { Hub, $, esc, startClock } from './common.js';
import { MapView, NavState, maneuverSVG, manText, rallyNote, fmtDist, fmtDur, clockIn, sinAcentos } from './map.js';

const qs = new URLSearchParams(location.search);
const qBase = qs.get('base');
const BASE = qBase && qBase.startsWith('/') ? (qBase.endsWith('/') ? qBase : qBase + '/') : '/datos/mapa/';
const VOICE_KEY = 'clio.nav.voz';
const MAP_HELP = "Descarga el mapa en Termux: <code>python tools/mapa/descargar.py --lugar 'Tu ciudad'</code>";

// Conservar ?base= al ir a la vista dividida
if (location.search) $('#btnSplit').href = 'dividida.html' + location.search;

const hub = new Hub('pantalla-mapa');
let metaOk = null;                       // null = cargando
const map = new MapView($('#map'), hub, {
  base: BASE,
  onPick: p => showPick(p),
  onMeta: ok => { metaOk = ok; },
});
const nav = new NavState(hub, map);
window.mapView = map;                    // para depurar desde la consola

startClock($('#clock'));

// ---------------------------------------------------------------- estado del teléfono / ruta
let lastNavStatus = null;
let pending = null;                      // {t, name} mientras se espera la ruta de nav.go
hub.on('navstatus', m => { lastNavStatus = m; });
hub.on('route', () => { pending = null; hidePick(); });
hub.on('navoff', () => { pending = null; renderMan(true); });
hub.on('motor', on => {
  if (!on) return;
  const v = savedVoice();
  if (v) setTimeout(() => hub.cmd('nav.voice', v), 300);  // el teléfono recibe la preferencia guardada en el estéreo
});

function go(lat, lon, name) {
  hub.cmd('nav.go', { lat, lon, name });
  pending = { t: performance.now(), name };
  map.setPick({ lat, lon });
}

// ---------------------------------------------------------------- voz
function savedVoice() { try { return localStorage.getItem(VOICE_KEY); } catch (e) { return null; } }
function markVoice(v) { for (const b of document.querySelectorAll('#voice button')) b.classList.toggle('on', b.dataset.v === v); }
markVoice(savedVoice() || 'normal');
$('#voice').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  try { localStorage.setItem(VOICE_KEY, b.dataset.v); } catch (err) { /* sin almacenamiento */ }
  markVoice(b.dataset.v);
  hub.cmd('nav.voice', b.dataset.v);
});

$('#cancel').addEventListener('click', () => { hub.cmd('nav.stop'); pending = null; });

// ---------------------------------------------------------------- ¿Ir aquí? (mantener presionado el mapa)
let pickPt = null;
function showPick(p) {
  pickPt = p;
  const road = map.roadAt(p.lat, p.lon);
  pickPt.name = road.name || 'Punto en el mapa';
  $('#pickText').textContent = road.name ? road.name : `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
  $('#pick').hidden = false;
}
function hidePick() { $('#pick').hidden = true; pickPt = null; }
$('#pickGo').addEventListener('click', () => { if (pickPt) go(pickPt.lat, pickPt.lon, pickPt.name); $('#pick').hidden = true; });
$('#pickNo').addEventListener('click', () => { hidePick(); map.setPick(null); });

// ---------------------------------------------------------------- buscador
const TYPES = {
  calle: ['Calle', '⛙'], fuel: ['Gasolinera', '⛽'], cafe: ['Café', '☕'], restaurant: ['Restaurante', '🍴'], fast_food: ['Comida rápida', '🍔'],
  hospital: ['Hospital', '✚'], clinic: ['Clínica', '✚'], pharmacy: ['Farmacia', '℞'], marketplace: ['Mercado', '🛒'],
  supermarket: ['Supermercado', '🛒'], convenience: ['Tienda', '🛒'], museum: ['Museo', '🏛'], car_repair: ['Taller', '🔧'],
  place_of_worship: ['Templo', '⛪'], viewpoint: ['Mirador', '⛰'], parking: ['Estacionamiento', 'P'], school: ['Escuela', '✎'],
  bank: ['Banco', '$'], atm: ['Cajero', '$'], hotel: ['Hotel', '⌂'], police: ['Policía', '★'],
};
let places = null;                        // [{n, lat, lon, tp, k}]
let placesErr = null;

async function loadPlaces() {
  if (places || placesErr) return;
  try {
    const r = await fetch(BASE + 'lugares.json');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const arr = await r.json();
    places = arr.filter(p => Array.isArray(p) && p[0] && Number.isFinite(p[1]) && Number.isFinite(p[2]))
      .map(p => ({ n: String(p[0]), lat: p[1], lon: p[2], tp: p[3] || '', k: sinAcentos(p[0]) }));
  } catch (e) {
    placesErr = e;
  }
}

function distTo(p) {
  const f = map.fix;
  if (!f) return NaN;
  const kx = Math.cos(f.lat * Math.PI / 180) * 111320;
  return Math.hypot((p.lon - f.lon) * kx, (p.lat - f.lat) * 110574);
}

function search(q) {
  const toks = sinAcentos(q).split(/\s+/).filter(Boolean);
  let out;
  if (!toks.length) {
    out = places.filter(p => p.tp !== 'calle').map(p => ({ p, s: 0, d: distTo(p) }));
  } else {
    out = [];
    for (const p of places) {
      if (!toks.every(t => p.k.includes(t))) continue;
      const s = p.k.startsWith(toks[0]) ? 0 : (' ' + p.k).includes(' ' + toks[0]) ? 1 : 2;
      out.push({ p, s, d: distTo(p) });
    }
  }
  out.sort((a, b) => a.s - b.s || (Number.isFinite(a.d) && Number.isFinite(b.d) ? a.d - b.d : a.p.n.localeCompare(b.p.n)));
  return out.slice(0, 40);
}

function hl(name, toks) {
  // resaltar la primera coincidencia de cada palabra (sobre el texto sin acentos, misma longitud con NFC simple)
  const k = sinAcentos(name);
  if (k.length !== name.length || !toks.length) return esc(name);
  const marks = new Array(name.length).fill(false);
  for (const t of toks) { const i = k.indexOf(t); if (i >= 0) for (let j = i; j < i + t.length; j++) marks[j] = true; }
  let html = '', open = false;
  for (let i = 0; i < name.length; i++) {
    if (marks[i] !== open) { html += marks[i] ? '<mark>' : '</mark>'; open = marks[i]; }
    html += esc(name[i]);
  }
  return html + (open ? '</mark>' : '');
}

let shown = [];
function renderResults() {
  const res = $('#res');
  if (placesErr) {
    res.innerHTML = `<div class="msg">No se pudo cargar la lista de lugares (${esc(BASE)}lugares.json).<br>${MAP_HELP}</div>`;
    return;
  }
  if (!places) { res.innerHTML = '<div class="msg">Cargando lugares…</div>'; return; }
  const q = $('#q').value;
  shown = search(q);
  const toks = sinAcentos(q).split(/\s+/).filter(Boolean);
  if (!shown.length) { res.innerHTML = `<div class="msg">Sin resultados para “${esc(q)}”.</div>`; return; }
  res.innerHTML = (toks.length ? '' : '<div class="msg" style="padding:8px 14px">Lugares cercanos</div>') + shown.map((r, i) => {
    const [lbl, ico] = TYPES[r.p.tp] || [r.p.tp || 'Lugar', '•'];
    return `<div class="it" data-i="${i}"><span class="ico">${ico}</span><div><b>${hl(r.p.n, toks)}</b><small>${esc(lbl)}</small></div>` +
      `<span class="d num">${Number.isFinite(r.d) ? fmtDist(r.d) : ''}</span></div>`;
  }).join('');
}

let qTimer = 0;
$('#q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(renderResults, 120); });
$('#q').addEventListener('keydown', e => { if (e.key === 'Enter' && shown.length) choose(0); });
$('#res').addEventListener('click', e => { const it = e.target.closest('.it'); if (it) choose(+it.dataset.i); });

function choose(i) {
  const r = shown[i];
  if (!r) return;
  closeSearch();
  go(r.p.lat, r.p.lon, r.p.n);
}

async function openSearch() {
  hidePick();
  $('#search').hidden = false;
  $('#q').value = '';
  $('#q').focus();                        // el teclado de Android aparece solo
  renderResults();
  await loadPlaces();
  if (!$('#search').hidden) renderResults();
}
function closeSearch() { $('#search').hidden = true; $('#q').blur(); }
$('#btnSearch').addEventListener('click', openSearch);
$('#searchClose').addEventListener('click', closeSearch);

// ---------------------------------------------------------------- HUD
let manKey = '';
function renderMan(force) {
  const m = nav.next;
  const active = nav.active && !!m;
  $('#man').hidden = !active;
  $('#cancel').hidden = !nav.active;
  if (!active) { $('#then').hidden = true; manKey = ''; return; }
  const off = !!(nav.nav && nav.nav.off);
  const key = `${nav.route.id}:${nav.nextIdx}:${off}`;
  if (key !== manKey || force) {
    manKey = key;
    $('#manArrow').innerHTML = maneuverSVG(m, off ? '#ffb020' : '#ffffff');
    $('#manText').textContent = off ? 'Fuera de ruta' : manText(m);
    $('#manName').textContent = off ? 'Recalculando…' : (m.name || (m.type === 'arrive' ? (nav.route.dest?.name || 'Destino') : ''));
    $('#man').classList.toggle('off', off);
    const rn = rallyNote(m);
    $('#rally').hidden = !rn;
    if (rn) { $('#rally').className = 'g' + rn.grade; $('#rally').innerHTML = `${esc(rn.txt)}<small>${esc(rn.word)}</small>`; }
    const a = nav.after;
    $('#then').hidden = !a;
    if (a) {
      $('#thenArrow').innerHTML = maneuverSVG(a, '#cfe8ff');
      $('#thenName').textContent = a.type === 'arrive' ? (nav.route.dest?.name || 'Destino') : (a.name || manText(a));
      $('#thenDist').textContent = fmtDist(a.d - m.d);
    }
  }
  const d = nav.dnext();
  const txt = fmtDist(d).split(' ');
  $('#manDist').innerHTML = `${esc(txt[0])}<small>${esc(txt[1] || '')}</small>`;
  $('#manBar').style.width = (nav.frac() * 100).toFixed(1) + '%';
  $('#man').classList.toggle('near', d < 120 && !off);
  // "Luego" justo debajo de la tarjeta
  $('#then').style.top = ($('#man').offsetTop + $('#man').offsetHeight + 8) + 'px';
}

function renderDrive() {
  const v = map.speedKmh();
  const road = map.nearestRoad();
  const n = nav.nav;
  const limit = (n && n.limit > 0) ? n.limit : (road.limit || 0);
  $('#speed').textContent = v == null ? '—' : Math.round(v);
  const over = limit > 0 && v != null && v > limit + 3;
  $('#speed').classList.toggle('over', over);
  $('#limit').hidden = !limit;
  $('#limit').textContent = limit || '';
  $('#limit').classList.toggle('over', over);
  const street = (n && n.street) || road.name || '';
  $('#street').hidden = !street;
  $('#street').textContent = street;

  const act = nav.active;
  $('#tripEta').hidden = !act;
  $('#tripRemain').hidden = !act;
  if (act) {
    const eta = nav.eta();
    $('#eta').textContent = Number.isFinite(eta) ? clockIn(eta) : '--:--';
    $('#remain').textContent = fmtDist(nav.remain());
    $('#remainTime').textContent = Number.isFinite(eta) ? fmtDur(eta) : 'Restante';
  }
}

function renderStatus() {
  let title = '', text = '', warn = false;
  const noMap = metaOk === false || (lastNavStatus && lastNavStatus.map === false);
  if (!hub.open) { title = 'Sin conexión con el hub'; text = 'Reconectando… Revisa que el hub esté corriendo en Termux (<code>python hub/hub.py</code>).'; }
  else if (!hub.motor) { title = 'Sin teléfono'; text = 'En el teléfono abre <b>http://localhost:8080</b> en Chrome (la app Clio servida por el hub) y déjala abierta: de ahí salen el GPS y las rutas.'; }
  else if (map.gpsAge() > 6000) {
    title = 'Sin GPS';
    text = map.fix ? 'Se perdió la señal del GPS. Se muestra la última posición conocida.' : 'Activa la ubicación del teléfono y permite el acceso a la ubicación en la app (pestaña GPS). Busca cielo abierto.';
  } else if (noMap) {
    title = 'Sin datos del mapa'; warn = true;
    text = (lastNavStatus && lastNavStatus.map === false && lastNavStatus.msg ? esc(lastNavStatus.msg) + '<br>' : '') + MAP_HELP;
  } else if (lastNavStatus && lastNavStatus.graph === false && pending) {
    title = 'No se pueden calcular rutas'; warn = true;
    text = (lastNavStatus.msg ? esc(lastNavStatus.msg) + '<br>' : '') + MAP_HELP;
  }
  // Sin mapa pero con GPS: aviso arriba para que el mapa (rejilla + estela) siga visible.
  const st = $('#status');
  st.hidden = !title;
  st.classList.toggle('warn', warn);
  if (title) {
    $('#stTitle').textContent = title;
    $('#stText').innerHTML = text;
    st.style.top = title === 'Sin datos del mapa' && map.fix ? '44%' : '50%';
  }

  // calculando ruta
  if (pending && performance.now() - pending.t > 25000) {
    pending = null;
    flash('El teléfono no respondió. Intenta de nuevo.');
  }
  if (pending) { $('#busy').hidden = false; $('#busyText').textContent = `Calculando ruta a ${pending.name || 'destino'}…`; }
  else if (!flashT || performance.now() > flashT) $('#busy').hidden = true;
}
let flashT = 0;
function flash(msg) { $('#busy').hidden = false; $('#busyText').textContent = msg; flashT = performance.now() + 4000; }

function tick() {
  try { renderMan(false); renderDrive(); renderStatus(); } catch (e) { console.error(e); }
}
setInterval(tick, 200);
tick();
