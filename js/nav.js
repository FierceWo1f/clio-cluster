// Navegación sin internet (contrato en docs/PROTOCOLO.md, sección Navegación).
// Calcula rutas con js/router.worker.js sobre datos/mapa/grafo.json, sigue el avance con el GPS,
// publica route / nav / navoff / navstatus al estéreo y da las indicaciones por voz.

import { progress, distM } from './router-core.js';

const MAP_URL = new URL('../datos/mapa/', import.meta.url);
const VOICE_KEY = 'clio.nav.voice';
const OFF_DIST = 45;      // m fuera de la ruta…
const OFF_COUNT = 3;      // …en tantas posiciones seguidas = recalcular
const ARRIVE_DIST = 30;   // m al destino = llegaste
const REROUTE_GAP = 8000; // ms mínimos entre recálculos

const TIPOS = {
  calle: 'Calle', fuel: 'Gasolinera', restaurant: 'Restaurante', fast_food: 'Comida rápida', cafe: 'Café',
  bank: 'Banco', atm: 'Cajero', pharmacy: 'Farmacia', hospital: 'Hospital', clinic: 'Clínica', doctors: 'Consultorio',
  school: 'Escuela', university: 'Universidad', college: 'Escuela', parking: 'Estacionamiento', place_of_worship: 'Templo',
  supermarket: 'Supermercado', convenience: 'Tienda', mall: 'Plaza comercial', department_store: 'Tienda departamental',
  hotel: 'Hotel', motel: 'Motel', hostel: 'Hostal', museum: 'Museo', attraction: 'Atracción', viewpoint: 'Mirador',
  car_repair: 'Taller', car_wash: 'Autolavado', tyres: 'Llantera', car_parts: 'Refaccionaria', police: 'Policía',
  bar: 'Bar', pub: 'Bar', theatre: 'Teatro', cinema: 'Cine', marketplace: 'Mercado', bus_station: 'Central de autobuses',
  townhall: 'Presidencia', post_office: 'Correos', library: 'Biblioteca', dentist: 'Dentista', bakery: 'Panadería',
  clothes: 'Ropa', hardware: 'Ferretería', ice_cream: 'Nevería', fountain: 'Fuente', bench: 'Banca', toilets: 'Baños',
};

const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r5 = x => Math.round(x * 1e5) / 1e5;

function fmtDist(m) {
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km`;
  return `${Math.max(0, Math.round(m / 10) * 10)} m`;
}
function fmtTime(s) {
  const min = Math.round(s / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}
/** Distancia para decir en voz alta: "200 metros", "1.5 kilómetros". */
function sayDist(m) {
  if (m >= 950) {
    const km = Math.round(m / 100) / 10;
    return km === 1 ? 'un kilómetro' : `${String(km).replace('.', ' punto ')} kilómetros`;
  }
  const r = m >= 100 ? Math.round(m / 50) * 50 : Math.max(10, Math.round(m / 10) * 10);
  return `${r} metros`;
}
/** Distancia corta del copiloto: "100", "50". */
function callDist(m) { return String(m >= 100 ? Math.round(m / 50) * 50 : Math.max(10, Math.round(m / 10) * 10)); }

const CSS = `
.nav-wrap { display: grid; gap: 14px; margin-bottom: 14px; }
.nav-card h3 { display: flex; align-items: center; gap: 8px; }
.nav-status { display: flex; flex-wrap: wrap; gap: 6px 16px; color: var(--muted); font-size: 13px; margin-bottom: 10px; }
.nav-status span { display: inline-flex; align-items: center; gap: 6px; }
.nav-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); display: inline-block; }
.nav-dot.ok { background: var(--ok); } .nav-dot.warn { background: var(--warn); } .nav-dot.err { background: var(--danger); }
.nav-help { background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; font-size: 13px; margin-bottom: 10px; }
.nav-help code { background: #0b0f15; padding: 2px 6px; border-radius: 6px; font-size: 12px; word-break: break-all; }
.nav-search { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--panel-2); font-size: 15px; }
.nav-search:focus { outline: none; border-color: var(--accent); }
.nav-results { list-style: none; margin: 6px 0 0; padding: 0; max-height: 320px; overflow-y: auto; }
.nav-results li { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-bottom: 1px solid var(--border); cursor: pointer; }
.nav-results li:hover, .nav-results li:active { background: var(--panel-2); }
.nav-results .nav-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-results .nav-type, .nav-results .nav-far { color: var(--muted); font-size: 12px; white-space: nowrap; }
.nav-empty { color: var(--muted); font-size: 13px; padding: 8px 2px; }
.nav-active { border: 1px solid var(--accent); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; background: rgba(var(--accent-rgb), .07); }
.nav-active .nav-dest { font-weight: 600; font-size: 15px; }
.nav-active .nav-next { font-size: 18px; margin: 6px 0; }
.nav-active .nav-next b { color: var(--accent); }
.nav-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; color: var(--muted); font-size: 13px; }
.nav-row .btn { margin-left: auto; }
.nav-off { color: var(--warn); }
.nav-voice { display: flex; align-items: center; gap: 8px; margin-top: 12px; flex-wrap: wrap; font-size: 13px; color: var(--muted); }
.nav-voice button { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border); background: transparent; cursor: pointer; }
.nav-voice button.on { border-color: var(--accent); background: rgba(var(--accent-rgb), .15); color: var(--text); }
`;

export class Nav {
  constructor(ctx) {
    this.ctx = ctx;
    this.status = { map: false, graph: false, msg: 'Revisando datos de mapa…' };
    this.meta = null;
    this.places = null;          // lugares.json (se carga al buscar)
    this.route = null;           // ruta activa (con cum/street/limit para seguirla)
    this.routeId = 0;
    this.dest = null;
    this.lastNav = null;
    this.spoken = [];            // últimas frases dichas (para la interfaz y pruebas)
    this.voiceMode = 'normal';
    try { this.voiceMode = localStorage.getItem(VOICE_KEY) || 'normal'; } catch {}
    if (!['normal', 'copiloto', 'off'].includes(this.voiceMode)) this.voiceMode = 'normal';
    this._said = new Set();
    this._speaking = 0;
    this._voice = null;
    this._reqId = 0;
    this._pending = new Map();
    this._el = null;
    this._resetTrack();

    this.worker = new Worker(new URL('./router.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = e => {
      const p = this._pending.get(e.data.id);
      if (p) { this._pending.delete(e.data.id); p(e.data); }
    };
    this.worker.onerror = e => {
      console.error('router.worker', e);
      this._setStatus({ graph: false, msg: 'No se pudo iniciar el calculador de rutas.' });
    };

    if ('speechSynthesis' in window) {
      this._pickVoice();
      speechSynthesis.addEventListener?.('voiceschanged', () => this._pickVoice());
    }
    this._unsub = null;
    this._hookGps();
    this.checkData();
  }

  // ------------------------------------------------------------------ datos
  async checkData() {
    this._setStatus({ map: false, graph: false, msg: 'Revisando datos de mapa…' });
    try {
      const r = await fetch(new URL('meta.json', MAP_URL), { cache: 'no-cache' });
      if (!r.ok) throw new Error('sin meta');
      this.meta = await r.json();
    } catch {
      this.meta = null;
      this._setStatus({ map: false, graph: false, msg: 'No hay mapas descargados.' });
      return;
    }
    this._setStatus({ map: true, graph: false, msg: 'Cargando calles para las rutas…' });
    const res = await this._call({ load: new URL('grafo.json', MAP_URL).href });
    if (res.error) {
      this._setStatus({ map: true, graph: false, msg: 'Error al cargar el grafo: ' + res.error });
      return;
    }
    const fecha = (this.meta.created || '').slice(0, 10);
    this._setStatus({ map: true, graph: true, msg: `Mapa listo: ${res.nodes.toLocaleString('es-MX')} nodos${fecha ? ', del ' + fecha : ''}.` });
  }

  _call(msg) {
    return new Promise(resolve => {
      const id = ++this._reqId;
      this._pending.set(id, resolve);
      this.worker.postMessage({ id, ...msg });
    });
  }

  _setStatus(s) {
    Object.assign(this.status, s);
    this._publishStatus();
    this._render();
  }

  _publishStatus() {
    const { map, graph, msg } = this.status;
    this.ctx.publish({ t: 'navstatus', map, graph, msg, voice: this.voiceMode });
  }

  _hookGps() {
    const gps = this.ctx.modules?.gps;
    if (gps?.onFix && !this._unsub) this._unsub = gps.onFix(f => this._onFix(f));
  }

  // ------------------------------------------------------------------ comandos
  command(m) {
    if (m.a === 'nav.go') this.go(m.v);
    else if (m.a === 'nav.stop') this.stop();
    else if (m.a === 'nav.voice') this.setVoice(m.v);
  }

  resend() {
    this._publishStatus();
    if (this.route) {
      this._publishRoute();
      if (this.lastNav) this.ctx.publish(this.lastNav);
    }
  }

  setVoice(mode) {
    if (!['normal', 'copiloto', 'off'].includes(mode)) return;
    this.voiceMode = mode;
    try { localStorage.setItem(VOICE_KEY, mode); } catch {}
    if (mode === 'off' && 'speechSynthesis' in window) speechSynthesis.cancel();
    this._publishStatus();
    this._render();
  }

  /** Navegar a {lat, lon, name}. */
  async go(v) {
    this._hookGps();
    const lat = +v?.lat, lon = +v?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { this.ctx.toast('Destino inválido.', true); return; }
    if (!this.status.graph) {
      this.ctx.toast(this.status.map ? 'El mapa todavía se está cargando.' : 'No hay mapas descargados. Revisa la pestaña Viaje.', true);
      this._publishStatus();
      return;
    }
    const fix = this.ctx.modules?.gps?.last;
    if (!fix) {
      this.ctx.toast('Todavía no hay posición GPS; espera la señal e inténtalo de nuevo.', true);
      this.ctx.publish({ t: 'navstatus', ...this.status, msg: 'Sin GPS: espera la señal e inténtalo de nuevo.', voice: this.voiceMode });
      return;
    }
    this.dest = { name: String(v.name || 'Destino'), lat: r5(lat), lon: r5(lon) };
    const ok = await this._calc(fix, false);
    if (ok) {
      const r = this.route;
      this.ctx.toast(`Ruta a ${this.dest.name}: ${fmtDist(r.len)}, ${fmtTime(r.time)}.`);
      if (this.voiceMode === 'normal') this._say(`Ruta calculada. ${sayDist(r.len)}, unos ${Math.max(1, Math.round(r.time / 60))} minutos.`);
      else if (this.voiceMode === 'copiloto') this._say('Ruta lista. Vamos.');
      this._onFix(fix);
    }
  }

  async _calc(fix, isReroute) {
    this._busy = true;
    const res = await this._call({ route: { from: [fix.lat, fix.lon], to: [this.dest.lat, this.dest.lon] } });
    this._busy = false;
    if (!this.dest) return false; // se canceló mientras calculaba
    if (res.error) {
      this.ctx.toast('No se pudo calcular la ruta: ' + res.error, true);
      this.ctx.publish({ t: 'navstatus', ...this.status, msg: res.error, voice: this.voiceMode });
      if (!isReroute) this.dest = null;
      return false;
    }
    this.route = { ...res.route, id: ++this.routeId };
    this._resetTrack();
    this._publishRoute();
    this._render();
    return true;
  }

  _publishRoute() {
    const r = this.route;
    this.ctx.publish({ t: 'route', id: r.id, dest: this.dest, pts: r.pts, man: r.man, len: r.len, time: r.time });
  }

  _resetTrack() {
    this.hint = 0;
    this.offCount = 0;
    this.speedEma = null;
    this._said = new Set();
    this.lastNav = null;
  }

  stop(silent = false) {
    const had = !!this.route || !!this.dest;
    this.route = null;
    this.dest = null;
    this._resetTrack();
    if (had || !silent) this.ctx.publish({ t: 'navoff' });
    this._render();
  }

  // ------------------------------------------------------------------ seguimiento
  _onFix(fix) {
    this._renderGps();
    const r = this.route;
    if (!r || this._busy) return;
    const p = progress(r, fix.lat, fix.lon, this.hint);
    this.hint = p.idx;
    // Al inicio la posición puede estar algo lejos del primer nodo: eso no es salirse.
    const tol = p.done < 60 ? Math.max(OFF_DIST, (r.snap?.from || 0) + 20) : OFF_DIST;
    const off = p.offDist > tol && (fix.acc || 0) < 80;
    this.offCount = off ? this.offCount + 1 : 0;

    const dDest = Math.min(distM(fix.lat, fix.lon, this.dest.lat, this.dest.lon),
      distM(fix.lat, fix.lon, r.pts.at(-1)[0], r.pts.at(-1)[1]));
    if (dDest < ARRIVE_DIST || (!off && r.len - p.done < ARRIVE_DIST * 0.6)) { this._arrive(); return; }

    if (this.offCount >= OFF_COUNT && Date.now() - (this._lastReroute || 0) > REROUTE_GAP) {
      this._lastReroute = Date.now();
      if (this.voiceMode !== 'off') this._say(this.voiceMode === 'copiloto' ? 'Recalculando.' : 'Recalculando la ruta.', true);
      this._calc(fix, true).then(ok => { if (ok) this._onFix(fix); });
      return;
    }

    const spd = Number.isFinite(fix.spd) ? fix.spd : (this.ctx.obd?.().speed ?? 0) / 3.6;
    this.speedEma = this.speedEma === null ? spd : this.speedEma * 0.85 + spd * 0.15;
    const done = p.done, remain = Math.max(0, r.len - done);
    let next = r.man.findIndex(m => m.type !== 'start' && m.d > done + 3);
    if (next < 0) next = r.man.length - 1;
    const dnext = Math.max(0, r.man[next].d - done);
    // ETA: tiempo de la ruta para lo que falta, mezclado con lo que tardaríamos a la velocidad real
    const planned = r.len ? r.time * remain / r.len : 0;
    const v = this.speedEma;
    const eta = v > 2 ? Math.min(planned * 3, Math.max(planned * 0.5, 0.5 * planned + 0.5 * remain / v)) : planned;
    const k = Math.min(p.idx, r.street.length - 1);
    this.lastNav = {
      t: 'nav', id: r.id, next, dnext: Math.round(dnext), done: Math.round(done), remain: Math.round(remain),
      eta: Math.round(eta), off, street: r.street[k] || '', limit: r.limit[k] || 0,
    };
    this.ctx.publish(this.lastNav);
    if (!off) this._voiceFor(done, spd);
    this._renderActive();
  }

  _arrive() {
    const name = this.dest?.name;
    if (this.voiceMode === 'normal') this._say('Has llegado a tu destino.', true);
    else if (this.voiceMode === 'copiloto') this._say('Meta. Llegamos.', true);
    this.ctx.toast(`Llegaste a ${name || 'tu destino'}.`);
    this.stop();
  }

  // ------------------------------------------------------------------ voz
  _voiceFor(done, spd) {
    if (this.voiceMode === 'off' || !this.route) return;
    const r = this.route;
    const id = r.id;
    if (this.voiceMode === 'normal') {
      const idx = r.man.findIndex(m => (m.type === 'turn' || m.type === 'arrive') && m.d > done + 2);
      if (idx < 0) return;
      const m = r.man[idx];
      const dist = m.d - done;
      const nowDist = Math.max(35, spd * 5);
      let stage = null;
      if (dist <= nowDist) stage = 'now';
      else if (dist <= 220) stage = 'near';
      else if (dist <= 550 && dist > 300 && spd > 60 / 3.6) stage = 'far';
      if (!stage) return;
      const key = `${id}:${m.i}:${stage}`;
      if (this._said.has(key)) return;
      // una etapa posterior anula las anteriores
      for (const s of ['far', 'near', 'now']) { this._said.add(`${id}:${m.i}:${s}`); if (s === stage) break; }
      if (m.type === 'arrive') {
        if (stage !== 'now') this._say(`En ${sayDist(dist)}, llegarás a tu destino.`);
        return;
      }
      let text = stage === 'now' ? `Ahora, ${this._turnPhrase(m)}` : `En ${sayDist(dist)}, ${this._turnPhrase(m)}`;
      // giro inmediato después
      const after = r.man.slice(idx + 1).find(x => x.type === 'turn' || x.type === 'arrive');
      if (stage === 'now' && after && after.d - m.d < 80) {
        text += after.type === 'arrive' ? ', y llegarás a tu destino' : `, y luego ${this._turnPhrase(after, false)}`;
        if (after.type === 'turn') {
          // ya se dijo junto con este giro: no repetir sus avisos (ni el "ahora" si está muy pegado)
          for (const s of after.d - m.d < 40 ? ['far', 'near', 'now'] : ['far', 'near']) this._said.add(`${id}:${after.i}:${s}`);
        }
      }
      this._say(text + '.');
      return;
    }
    // copiloto: una llamada por maniobra (giros y curvas), con anticipación según la velocidad
    const look = Math.min(250, Math.max(80, spd * 7));
    const idx = r.man.findIndex(m => m.type !== 'start' && m.d > done + 2 && !this._said.has(`${id}:${m.i}:${m.type}`));
    if (idx < 0) return;
    const m = r.man[idx];
    const dist = m.d - done;
    if (dist > look) return;
    this._said.add(`${id}:${m.i}:${m.type}`);
    let text = this._callPhrase(m, dist);
    const after = r.man[idx + 1];
    if (after && after.type !== 'start' && after.d - m.d < 50) {
      text += `, y ${this._callPhrase(after, 0).replace(/^Cuidado[,.] /, '').toLowerCase()}`;
      this._said.add(`${id}:${after.i}:${after.type}`);
    }
    this._say(text + '.');
  }

  _turnPhrase(m, withName = true) {
    const lado = m.dir === 'right' ? 'a la derecha' : 'a la izquierda';
    let t;
    if (m.dir === 'uturn') t = 'da vuelta en U';
    else if (m.dir === 'straight') t = 'continúa derecho';
    else if (m.sev === 'slight') t = `toma ligeramente ${lado}`;
    else if (m.sev === 'sharp') t = `gira cerrado ${lado}`;
    else t = `gira ${lado}`;
    return withName && m.name ? `${t} hacia ${m.name}` : t;
  }

  _callPhrase(m, dist) {
    const en = dist >= 30 ? ` en ${callDist(dist)}` : '';
    const Lado = m.dir === 'right' ? 'Derecha' : 'Izquierda';
    if (m.type === 'arrive') return `Meta${en}`;
    if (m.dir === 'uturn') return `Cuidado, vuelta en U${en}`;
    if (m.dir === 'straight') return `Derecho${en}${m.name ? ' hacia ' + m.name : ''}`;
    const g = m.grade || 3;
    const nota = g === 1 ? `${Lado} horquilla` : `${Lado} ${g}`;
    const base = (g <= 2 ? 'Cuidado, ' : '') + nota + en;
    if (m.type === 'turn') return `${g <= 2 ? 'Cuidado. ' : ''}Cruce, ${nota.toLowerCase()}${en}`;
    return base;
  }

  _pickVoice() {
    const vs = speechSynthesis.getVoices() || [];
    const lang = v => (v.lang || '').replace('_', '-').toLowerCase();
    this._voice = vs.find(v => lang(v) === 'es-mx') || vs.find(v => lang(v) === 'es-us' || lang(v) === 'es-419')
      || vs.find(v => lang(v).startsWith('es')) || null;
  }

  _say(text, urgent = false) {
    this.spoken.push(text);
    if (this.spoken.length > 30) this.spoken.shift();
    this._renderActive();
    if (this.voiceMode === 'off' || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    if (this._voice) u.voice = this._voice;
    u.lang = this._voice?.lang || 'es-MX';
    u.rate = this.voiceMode === 'copiloto' ? 1.15 : 1;
    const music = this.ctx.modules?.music;
    this._speaking++;
    if (this._speaking === 1) { try { music?.duck?.(true); } catch {} }
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      this._speaking = Math.max(0, this._speaking - 1);
      if (!this._speaking) { try { music?.duck?.(false); } catch {} }
    };
    // por si el navegador no avisa al terminar (pasa al cancelar o sin voces instaladas)
    const timer = setTimeout(done, 2000 + text.length * 90);
    u.onend = done;
    u.onerror = done;
    if (urgent) speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  // ------------------------------------------------------------------ interfaz del teléfono
  mount(el) {
    if (!document.getElementById('nav-style')) {
      const st = document.createElement('style');
      st.id = 'nav-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    el.innerHTML = `
      <div class="nav-wrap">
        <div class="card nav-card">
          <h3>Navegación</h3>
          <div class="nav-status">
            <span><i class="nav-dot" data-r="gpsDot"></i><span data-r="gps">GPS…</span></span>
            <span><i class="nav-dot" data-r="mapDot"></i><span data-r="map">Mapa…</span></span>
          </div>
          <div class="nav-help" data-r="help" hidden>
            <b>Descarga los mapas en casa, con WiFi</b> (una vez por ciudad). En Termux:<br>
            <code>cd clio-cluster &amp;&amp; python tools/mapa/descargar.py --lugar "Querétaro, Querétaro"</code><br>
            Tarda unos minutos y ocupa pocos MB. Después toca <b>Revisar de nuevo</b>.
            Más detalles en <code>tools/mapa/LEEME.md</code>.
            <div style="margin-top:8px"><button class="btn tiny" data-r="recheck">Revisar de nuevo</button></div>
          </div>
          <div class="nav-active" data-r="active" hidden></div>
          <input class="nav-search" data-r="q" type="search" autocomplete="off" placeholder="Buscar destino: calle, gasolinera, lugar…">
          <ul class="nav-results" data-r="results"></ul>
          <div class="nav-voice" data-r="voice">Voz:
            <button data-v="normal">Normal</button>
            <button data-v="copiloto">Copiloto (rally)</button>
            <button data-v="off">Sin voz</button>
          </div>
        </div>
      </div>`;
    const $ = k => el.querySelector(`[data-r="${k}"]`);
    this._el = { root: el, gps: $('gps'), gpsDot: $('gpsDot'), map: $('map'), mapDot: $('mapDot'), help: $('help'),
      active: $('active'), q: $('q'), results: $('results'), voice: $('voice') };
    $('recheck').addEventListener('click', () => this.checkData());
    this._el.voice.addEventListener('click', e => {
      const b = e.target.closest('button[data-v]');
      if (b) this.setVoice(b.dataset.v);
    });
    let timer;
    this._el.q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => this._search(), 150); });
    this._el.q.addEventListener('focus', () => this._loadPlaces());
    this._el.results.addEventListener('click', e => {
      const li = e.target.closest('li[data-k]');
      if (!li || !this._shown) return;
      const p = this._shown[+li.dataset.k];
      this._el.results.innerHTML = '';
      this._el.q.value = '';
      this.go({ lat: p[1], lon: p[2], name: p[0] });
    });
    this._el.active.addEventListener('click', e => { if (e.target.closest('[data-r="cancel"]')) this.stop(); });
    clearInterval(this._uiTimer);
    this._uiTimer = setInterval(() => this._renderGps(), 1000);
    this._render();
  }

  async _loadPlaces() {
    if (this.places || this._placesLoading || !this.status.map) return this.places;
    this._placesLoading = (async () => {
      try {
        const r = await fetch(new URL('lugares.json', MAP_URL), { cache: 'no-cache' });
        if (!r.ok) throw new Error();
        const list = await r.json();
        this.places = list.map(p => ({ p, n: norm(p[0]) }));
      } catch {
        this.places = null;
      }
      this._placesLoading = null;
      return this.places;
    })();
    return this._placesLoading;
  }

  async _search() {
    const el = this._el;
    if (!el) return;
    const q = norm(el.q.value);
    if (!q) { el.results.innerHTML = ''; return; }
    if (!this.status.map) { el.results.innerHTML = '<li class="nav-empty">No hay mapas descargados.</li>'; return; }
    await (this._placesLoading || this._loadPlaces());
    if (!this.places) { el.results.innerHTML = '<li class="nav-empty">No se pudo leer lugares.json.</li>'; return; }
    if (norm(el.q.value) !== q) return; // el texto cambió mientras cargaba
    const words = q.split(' ');
    const here = this.ctx.modules?.gps?.last;
    const found = [];
    for (const it of this.places) {
      if (!words.every(w => it.n.includes(w))) continue;
      let score = it.n.startsWith(q) ? 0 : (' ' + it.n).includes(' ' + words[0]) ? 1 : 2;
      const d = here ? distM(here.lat, here.lon, it.p[1], it.p[2]) : 0;
      found.push({ it, score, d });
    }
    found.sort((a, b) => a.score - b.score || a.d - b.d);
    const top = found.slice(0, 30);
    this._shown = top.map(f => f.it.p);
    el.results.innerHTML = top.length
      ? top.map((f, k) => `<li data-k="${k}"><span class="nav-name">${esc(f.it.p[0])}</span>
          <span class="nav-type">${esc(TIPOS[f.it.p[3]] || f.it.p[3])}</span>${here ? `<span class="nav-far">${fmtDist(f.d)}</span>` : ''}</li>`).join('')
      : '<li class="nav-empty">Sin resultados.</li>';
  }

  _render() {
    if (!this._el) return;
    const { map, graph, msg } = this.status;
    this._el.map.textContent = msg;
    this._el.mapDot.className = 'nav-dot ' + (graph ? 'ok' : map ? 'warn' : 'err');
    this._el.help.hidden = map;
    for (const b of this._el.voice.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === this.voiceMode);
    this._renderGps();
    this._renderActive();
  }

  _renderGps() {
    if (!this._el) return;
    const gps = this.ctx.modules?.gps;
    const last = gps?.last;
    const stale = last && Date.now() - last.ts > 15000;
    let txt = gps ? gps.msg || 'GPS…' : 'Sin módulo GPS';
    if (last && gps.state === 'ok') txt = stale ? `GPS sin señal reciente (±${last.acc} m)` : `GPS ±${last.acc} m`;
    this._el.gps.textContent = txt;
    this._el.gpsDot.className = 'nav-dot ' + (gps?.state === 'ok' && !stale ? (last.acc <= 25 ? 'ok' : 'warn')
      : gps?.state === 'denied' || gps?.state === 'error' ? 'err' : 'warn');
  }

  _renderActive() {
    const el = this._el?.active;
    if (!el) return;
    const r = this.route;
    if (!r || !this.dest) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const n = this.lastNav;
    const m = n ? r.man[n.next] : r.man[1];
    let next = '';
    if (m) {
      const what = m.type === 'arrive' ? 'Llegada' : m.type === 'curve'
        ? `Curva ${m.dir === 'right' ? 'derecha' : 'izquierda'} ${m.grade}`
        : this._turnPhrase(m, false).replace(/^./, c => c.toUpperCase());
      next = `<b>${n ? fmtDist(n.dnext) : ''}</b> ${esc(what)}${m.name && m.type === 'turn' ? ' · ' + esc(m.name) : ''}`;
    }
    const lastSaid = this.spoken.at(-1);
    el.innerHTML = `
      <div class="nav-dest">→ ${esc(this.dest.name)}</div>
      <div class="nav-next">${next}</div>
      <div class="nav-row">
        <span>${n ? fmtDist(n.remain) : fmtDist(r.len)} · ${fmtTime(n ? n.eta : r.time)}</span>
        ${n?.street ? `<span>${esc(n.street)}${n.limit ? ` · ${n.limit} km/h` : ''}</span>` : ''}
        ${n?.off ? '<span class="nav-off">Fuera de la ruta</span>' : ''}
        <button class="btn tiny danger" data-r="cancel">Cancelar</button>
      </div>
      ${lastSaid && this.voiceMode !== 'off' ? `<div class="nav-row" style="margin-top:6px">Voz: ${esc(lastSaid)}</div>` : ''}`;
  }
}
