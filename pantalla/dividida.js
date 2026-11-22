// Vista dividida Música + Mapa (1024×600): MapView compacto a la izquierda (640 px) y mini reproductor a la derecha (384 px).
// Contrato: docs/PROTOCOLO.md. Parámetro de prueba: dividida.html?base=/datos/prueba-mapa/
import { Hub, $, esc } from './common.js';
import { MapView, NavState, maneuverSVG, manText, rallyNote, fmtDist, fmtDur, clockIn } from './map.js';
import { mountCompactPlayer } from './player-compact.js';

const qs = new URLSearchParams(location.search);
const qBase = qs.get('base');
const BASE = qBase && qBase.startsWith('/') ? (qBase.endsWith('/') ? qBase : qBase + '/') : '/datos/mapa/';
const SWAP_KEY = 'clio.dividida.swap';
const NEAR = 300;                        // m: a partir de aquí la maniobra se agranda

if (location.search) $('#btnFull').href = 'mapa.html' + location.search;

const hub = new Hub('pantalla-dividida');
// El reproductor se monta en el mismo turno que el Hub para no perder la pista que reenvía el teléfono.
let player = null;
try { player = mountCompactPlayer($('#musica'), hub, { fpsCap: 20 }); }
catch (e) { console.error(e); $('#musica').innerHTML = '<div id="playerMsg">No se pudo cargar el reproductor.</div>'; }

let metaOk = null;
const map = new MapView($('#map'), hub, { base: BASE, compact: true, onMeta: ok => { metaOk = ok; } });
const nav = new NavState(hub, map);
window.mapView = map;
let lastNavStatus = null;
hub.on('navstatus', m => { lastNavStatus = m; });

// ---------------------------------------------------------------- intercambiar lados
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } }
document.body.classList.toggle('swap', lsGet(SWAP_KEY) === '1');
$('#btnSwap').addEventListener('click', () => {
  const on = !document.body.classList.contains('swap');
  document.body.classList.toggle('swap', on);
  lsSet(SWAP_KEY, on ? '1' : '0');
});

// ---------------------------------------------------------------- maniobra (pequeña y grande)
let key = '', dismissed = '';
$('#big').addEventListener('click', () => { dismissed = key; $('#big').classList.remove('show'); });

function distHtml(d) { const t = fmtDist(d).split(' '); return `${esc(t[0])}<small>${esc(t[1] || '')}</small>`; }
function rallyHtml(el, m) {
  const rn = rallyNote(m);
  el.hidden = !rn;
  if (rn) { el.className = 'g' + rn.grade; el.innerHTML = esc(rn.txt) + (el.id === 'bigRally' ? `<small>${esc(rn.word)}</small>` : ''); }
}

function renderMan() {
  const m = nav.next;
  const active = nav.active && !!m;
  $('#man').hidden = !active;
  $('#eta').hidden = !nav.active;
  if (!active) { $('#big').classList.remove('show'); key = ''; return; }
  const off = !!(nav.nav && nav.nav.off);
  const k = `${nav.route.id}:${nav.nextIdx}:${off}`;
  const name = off ? 'Recalculando…' : (m.type === 'arrive' ? (nav.route.dest?.name || 'Destino') : (m.name || manText(m)));
  if (k !== key) {
    key = k;
    const svg = maneuverSVG(m, off ? '#ffb020' : '#ffffff');
    $('#manArrow').innerHTML = svg;
    $('#bigArrow').innerHTML = svg;
    $('#manName').textContent = name;
    $('#bigName').textContent = name;
    $('#bigText').textContent = off ? 'Fuera de ruta' : manText(m);
    rallyHtml($('#manRally'), m);
    rallyHtml($('#bigRally'), m);
  }
  const d = nav.dnext();
  const html = distHtml(d);
  $('#manDist').innerHTML = html;
  const w = (nav.frac() * 100).toFixed(1) + '%';
  $('#manBar').style.width = w;
  const big = !off && d < NEAR && m.type !== 'start' && dismissed !== key;
  $('#big').classList.toggle('show', big);
  $('#man').style.visibility = big ? 'hidden' : '';   // la pequeña queda debajo de la grande
  if (big) { $('#bigDist').innerHTML = html; $('#bigBar').style.width = (Math.max(0, 1 - d / NEAR) * 100).toFixed(1) + '%'; }

  const eta = nav.eta();
  $('#etaTime').textContent = Number.isFinite(eta) ? clockIn(eta) : '--:--';
  $('#etaRemain').textContent = `${fmtDist(nav.remain())} · ${fmtDur(eta)}`;
}

function renderDrive() {
  const v = map.speedKmh();
  const road = map.nearestRoad();
  const n = nav.nav;
  const limit = (n && n.limit > 0) ? n.limit : (road.limit || 0);
  $('#speed').textContent = v == null ? '—' : Math.round(v);
  $('#speed').classList.toggle('over', limit > 0 && v != null && v > limit + 3);
  $('#limit').hidden = !limit;
  $('#limit').textContent = limit || '';
  const street = (n && n.street) || road.name || '';
  $('#street').hidden = !street;
  $('#street').textContent = street;
}

function renderStatus() {
  let t = '', p = '';
  if (!hub.open) { t = 'Sin conexión con el hub'; p = 'Reconectando…'; }
  else if (!hub.motor) { t = 'Sin teléfono'; p = 'Abre <b>http://localhost:8080</b> en Chrome del teléfono.'; }
  else if (map.gpsAge() > 6000) { t = 'Sin GPS'; p = 'Activa la ubicación del teléfono y permite el acceso en la app.'; }
  else if (metaOk === false || (lastNavStatus && lastNavStatus.map === false)) {
    t = 'Sin datos del mapa';
    p = "Descarga el mapa en Termux:<br><code>python tools/mapa/descargar.py --lugar 'Tu ciudad'</code>";
  }
  $('#status').hidden = !t;
  if (t) { $('#stTitle').textContent = t; $('#stText').innerHTML = p; }
}

setInterval(() => { try { renderMan(); renderDrive(); renderStatus(); } catch (e) { console.error(e); } }, 200);

window.addEventListener('pagehide', () => { map.destroy(); if (player) player.destroy(); });
