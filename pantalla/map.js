// Mapa del estéreo estilo juego de carreras (Canvas 2D).
// Contrato de datos y mensajes: docs/PROTOCOLO.md (GPS, Navegación, Datos de mapa, Cluster).
//
//   const map = new MapView(canvas, hub, { base: '/datos/mapa/', compact: false, onPick: ({lat, lon}) => … });
//
// - Carga meta.json y los tiles visibles bajo demanda (caché LRU). Cada tile se convierte UNA vez a Path2D
//   en metros locales (proyección equirectangular alrededor de un origen fijo) y se agrupa por clase de vía.
// - Cada cuadro solo cambia la matriz (setTransform) y vuelve a trazar los Path2D ya hechos.
// - Rumbo arriba, auto al 70 % de la altura, zoom según la velocidad, posición interpolada a 30 fps.
// - Táctil: arrastrar = mover, pellizcar = zoom, mantener presionado = opts.onPick({lat, lon}).
//   A los 10 s sin tocar vuelve a seguir al auto (o con el botón "Recentrar").

const M_LAT = 110574;            // metros por grado de latitud
const M_LON = 111320;            // metros por grado de longitud en el ecuador
const RAD = Math.PI / 180;
const FRAME_MS = 1000 / 30;      // tope de 30 fps
const IDLE_MS = 100;             // 10 fps cuando no se mueve nada
const FREE_TIMEOUT = 10000;      // ms sin tocar para volver a centrar
const LONG_PRESS = 650;          // ms para "mantener presionado"
const TILE_CACHE = 72;           // tiles guardados (LRU)
const MAX_FETCH = 3;             // descargas simultáneas
const MAX_VISIBLE_TILES = 49;    // si la vista abarca más, no se piden más (zoom muy lejano)

// Clase OSM (0..8) → grupo de dibujo. 0 autopista/troncal, 1 primaria/secundaria, 2 terciaria/sin clasificar,
// 3 residencial/calle peatonal-vehicular, 4 servicio.
const GROUP_OF_CLASS = [0, 0, 1, 1, 2, 2, 3, 3, 4];
// w = ancho real en metros; min = ancho mínimo en píxeles; glow = halo para las vías grandes.
const GROUPS = [
  { w: 18, min: 3.4, color: '#4f86d6', glow: 'rgba(64,140,255,0.20)', glowK: 2.6, core: 'rgba(170,210,255,0.55)' },
  { w: 13, min: 2.6, color: '#3a66a3', glow: 'rgba(56,120,230,0.13)', glowK: 2.2 },
  { w: 10, min: 1.8, color: '#2c4a74' },
  { w: 7, min: 1.2, color: '#233752' },
  { w: 4, min: 0.8, color: '#1b2638' },
];
const BG = '#04060b';
const ROUTE = '#19e3ff';
const ROUTE_OFF = '#ffb020';
const CAR = '#ff2d55';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
/** Diferencia angular a−b en grados, en (−180, 180]. */
const angDiff = (a, b) => { let d = (a - b) % 360; if (d > 180) d -= 360; if (d <= -180) d += 360; return d; };

let cssDone = false;
function injectCss() {
  if (cssDone) return;
  cssDone = true;
  const st = document.createElement('style');
  st.textContent = `
  .mv-recenter { position:absolute; z-index:4; right:16px; bottom:96px; min-width:56px; height:56px; padding:0 18px;
    border-radius:28px; border:1px solid rgba(25,227,255,.55); background:rgba(6,14,24,.88); color:#dff9ff;
    font:600 17px system-ui, Roboto, sans-serif; letter-spacing:.3px; display:flex; align-items:center; gap:8px;
    box-shadow:0 0 16px rgba(25,227,255,.25); }
  .mv-recenter[hidden] { display:none; }
  .mv-recenter:active { transform:scale(.96); }
  .mv-recenter svg { width:22px; height:22px; }
  .mv-compact .mv-recenter { height:50px; min-width:50px; padding:0 14px; font-size:15px; bottom:84px; right:10px; }`;
  // Al principio del <head>: así los estilos de cada página pueden sobrescribir estos.
  document.head.insertBefore(st, document.head.firstChild);
}

export class MapView {
  constructor(canvas, hub, opts = {}) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.hub = hub;
    this.o = Object.assign({ base: '/datos/mapa/', compact: false, onPick: null, onMeta: null, onFree: null }, opts);
    if (!this.o.base.endsWith('/')) this.o.base += '/';
    this.compact = !!this.o.compact;
    this.dead = false;

    // Proyección (origen fijo para toda la sesión)
    this.origin = null;

    // Datos del mapa
    this.meta = null;
    this.metaState = 'loading';           // 'loading' | 'ok' | 'none'
    this.tiles = new Map();               // "tx_ty" → {state, groups:[Path2D|null], roads:[…]}
    this.fetching = 0;
    this.buildQueue = [];                 // tiles descargados en espera de convertirse (1 por cuadro)

    // Vehículo
    this.fix = null;                      // última posición GPS en metros locales
    this.est = null;                      // posición estimada {x, y, h}
    this.obd = { speed: null, t: -1e9 };
    this.trail = [];                      // estela [x, y, x, y, …]
    this.trailPath = null;
    this.trailDirty = false;

    // Vista: centro en el auto (punto ancla), rumbo hacia arriba, escala en px/m
    this.view = { x: 0, y: 0, h: 0, s: 1.5 };
    this.autoS = 1.5;
    this.free = null;                     // vista manual {x, y, h, s} mientras se arrastra/pellizca
    this.back = null;                     // animación de regreso al auto {from, t0}
    this.lastTouch = 0;
    this.pointers = new Map();
    this.press = null;
    this.pick = null;

    // Ruta
    this.route = null;
    this.nav = null;
    this.prog = 0;                        // metros recorridos sobre la ruta (proyección propia)
    this.progSeg = 0;

    // Rendimiento
    this.W = 0; this.H = 0;
    this.frames = 0;
    this.drawMs = 0;
    this._last = 0;
    this._lastT = 0;
    this._road = { name: '', limit: 0 };
    this._roadT = 0;

    injectCss();
    this._makeSprites();
    this._makeButton();
    this._resize();
    this._listen();
    this._touch();
    this._loadMeta();

    this._loop = this._loop.bind(this);
    this._onVis = () => { if (!document.hidden && !this.dead) { this._lastT = 0; this._raf = requestAnimationFrame(this._loop); } };
    document.addEventListener('visibilitychange', this._onVis);
    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    if (window.ResizeObserver) { this._ro = new ResizeObserver(this._onResize); this._ro.observe(canvas); }
    this._raf = requestAnimationFrame(this._loop);
  }

  // ======================================================================= API pública

  /** Calle más cercana a la posición estimada (de los tiles cargados). Se recalcula cada segundo. */
  nearestRoad() { return this._road; }

  /** Calle más cercana a un punto cualquiera (por ejemplo, el punto elegido con "mantener presionado"). */
  roadAt(lat, lon, maxDist = 60) {
    if (!this.origin) return { name: '', limit: 0 };
    const [x, y] = this.project(lat, lon);
    return this._nearest(x, y, null, maxDist) || { name: '', limit: 0 };
  }

  setRoute(r) {
    if (!r || !Array.isArray(r.pts) || r.pts.length < 2) { this.clearRoute(); return; }
    if (this.route && this.route.id === r.id && this.route.n === r.pts.length) { this.route.src = r; return; }
    if (!this.origin) this._setOrigin(r.pts[0][0], r.pts[0][1]);
    const n = r.pts.length;
    const xy = new Float32Array(n * 2);
    const cum = new Float32Array(n);
    const path = new Path2D();
    let len = 0;
    for (let i = 0; i < n; i++) {
      const [x, y] = this.project(r.pts[i][0], r.pts[i][1]);
      xy[i * 2] = x; xy[i * 2 + 1] = y;
      if (i) { len += Math.hypot(x - xy[i * 2 - 2], y - xy[i * 2 - 1]); path.lineTo(x, y); } else path.moveTo(x, y);
      cum[i] = len;
    }
    // La meta se marca al final de la geometría (sobre la calle); dest.lat/lon puede quedar fuera de la vía.
    const dest = [xy[n * 2 - 2], xy[n * 2 - 1]];
    this.route = { id: r.id, n, xy, cum, len, path, dest, src: r };
    this.prog = 0;
    this.progSeg = 0;
    this._updateProgress(true);
  }

  clearRoute() { this.route = null; this.nav = null; this.prog = 0; }

  /** Marca (o borra con null) el punto elegido. */
  setPick(p) {
    if (!p) { this.pick = null; return; }
    if (!this.origin) this._setOrigin(p.lat, p.lon);
    const [x, y] = this.project(p.lat, p.lon);
    this.pick = { x, y, t: performance.now() };
  }

  /** Velocidad que usa el mapa: OBD si es reciente (< 1.5 s), si no la del GPS. En km/h, o null. */
  speedKmh() {
    const now = performance.now();
    if (this.obd.speed != null && now - this.obd.t < 1500) return this.obd.speed;
    if (this.fix && this.fix.spd != null && now - this.fix.t < 4000) return this.fix.spd * 3.6;
    return null;
  }

  /** ms desde la última posición GPS (Infinity si nunca llegó). */
  gpsAge() { return this.fix ? performance.now() - this.fix.t : Infinity; }

  recenter() {
    if (!this.free) return;
    this.back = { from: { ...this.free }, t0: performance.now() };
    this.free = null;
    this._freeChanged();
  }

  get isFree() { return !!this.free; }

  destroy() {
    this.dead = true;
    cancelAnimationFrame(this._raf);
    clearTimeout(this._metaRetry);
    if (this.press) clearTimeout(this.press.timer);
    document.removeEventListener('visibilitychange', this._onVis);
    window.removeEventListener('resize', this._onResize);
    if (this._ro) this._ro.disconnect();
    for (const [ev, fn] of this._ptr || []) this.c.removeEventListener(ev, fn);
    if (this.btn) this.btn.remove();
    this.tiles.clear();
    this.buildQueue = [];
  }

  // ======================================================================= proyección

  _setOrigin(lat, lon) {
    this.origin = { lat, lon, kx: M_LON * Math.cos(lat * RAD), ky: M_LAT };
  }

  /** lat/lon → metros locales (x al este, y al SUR: igual que la pantalla). */
  project(lat, lon) {
    const o = this.origin;
    return [(lon - o.lon) * o.kx, -(lat - o.lat) * o.ky];
  }

  unproject(x, y) {
    const o = this.origin;
    return { lat: o.lat - y / o.ky, lon: o.lon + x / o.kx };
  }

  // ======================================================================= hub

  _listen() {
    const on = (t, fn) => this.hub.on(t, m => { if (!this.dead) fn(m); });
    on('gps', m => this._onGps(m));
    on('obd', m => { if (Number.isFinite(m.speed)) this.obd = { speed: m.speed, t: performance.now() }; });
    on('route', m => this.setRoute(m));
    on('nav', m => { this.nav = m; });
    on('navoff', () => this.clearRoute());
  }

  _onGps(m) {
    if (!Number.isFinite(m.lat) || !Number.isFinite(m.lon)) return;
    if (!this.origin) this._setOrigin(m.lat, m.lon);
    const [x, y] = this.project(m.lat, m.lon);
    const now = performance.now();
    const p = this.fix;
    let hdg = Number.isFinite(m.hdg) ? m.hdg : null;
    if (hdg == null && p) {
      const d = Math.hypot(x - p.x, y - p.y);
      hdg = d > 8 ? (Math.atan2(x - p.x, -(y - p.y)) / RAD + 360) % 360 : p.hdg;
    }
    this.fix = { x, y, lat: m.lat, lon: m.lon, hdg, spd: Number.isFinite(m.spd) ? m.spd : null, acc: m.acc, t: now };
    const jump = !this.est || Math.hypot(this.est.x - x, this.est.y - y) > 120;
    if (jump) {
      this.est = { x, y, h: hdg ?? (this.est ? this.est.h : 0) };
      this.view.x = x; this.view.y = y; this.view.h = this.est.h;
    }
    const tl = this.trail.length;
    if (jump && tl) this.trail.push(NaN, NaN);           // salto: la estela se corta, no se une con una recta
    if (!tl || jump || Math.hypot(x - this.trail[tl - 2], y - this.trail[tl - 1]) > 4) {
      this.trail.push(x, y);
      if (this.trail.length > 4000) this.trail.splice(0, 400);
      this.trailDirty = true;
    }
  }

  // ======================================================================= datos del mapa

  async _loadMeta() {
    try {
      const r = await fetch(this.o.base + 'meta.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const meta = await r.json();
      if (this.dead) return;
      if (!Array.isArray(meta.bbox) || meta.bbox.length !== 4) throw new Error('meta.json sin bbox');
      this.meta = meta;
      this.metaState = 'ok';
      if (!this.origin) {
        const [s, w, n, e] = meta.bbox;
        this._setOrigin((s + n) / 2, (w + e) / 2);
        this.view.x = 0; this.view.y = 0;
      }
    } catch (err) {
      if (this.dead) return;
      this.metaState = 'none';
      // Puede que el mapa se descargue más tarde: reintentar cada 30 s.
      this._metaRetry = setTimeout(() => this._loadMeta(), 30000);
    }
    if (this.o.onMeta) try { this.o.onMeta(this.metaState === 'ok', this.meta); } catch (e) { console.error(e); }
  }

  _tileWanted(tx, ty, key) {
    const t = this.tiles.get(key);
    if (t) { this.tiles.delete(key); this.tiles.set(key, t); return t; } // LRU: al final = más reciente
    if (this.fetching >= MAX_FETCH) return null;
    const ts = this.meta.tile || 0.01;
    const [s, w, n, e] = this.meta.bbox;
    if ((ty + 1) * ts < s || ty * ts > n || (tx + 1) * ts < w || tx * ts > e) {
      this.tiles.set(key, { state: 'none' });
      return null;
    }
    const entry = { state: 'loading' };
    this.tiles.set(key, entry);
    this.fetching++;
    fetch(`${this.o.base}tiles/${key}.json`)
      .then(r => (r.ok ? r.json() : null))
      .then(js => { if (js && !this.dead) this.buildQueue.push([entry, js]); else entry.state = 'none'; })
      .catch(() => { entry.state = 'none'; })
      .finally(() => { this.fetching--; });
    this._evict();
    return entry;
  }

  _evict() {
    if (this.tiles.size <= TILE_CACHE) return;
    for (const [k, t] of this.tiles) {
      if (this.tiles.size <= TILE_CACHE) break;
      if (t.state !== 'loading' && !t.visible) this.tiles.delete(k);
    }
  }

  /** Convierte un tile (formato del contrato) a Path2D por grupo + lista de vías para buscar calles. */
  _build(entry, js) {
    const names = js.names || [];
    const groups = [null, null, null, null, null];
    const roads = [];
    const o = this.origin;
    const kx = o.kx * 1e-5, ky = o.ky * 1e-5, ox = o.lon * 1e5, oy = o.lat * 1e5;
    for (const r of js.roads || []) {
      if (!Array.isArray(r) || r.length < 7) continue;
      const g = GROUP_OF_CLASS[r[0]] ?? 3;
      const path = groups[g] || (groups[g] = new Path2D());
      const n = (r.length - 3) >> 1;
      const xy = new Float32Array(n * 2);
      let lat = r[3], lon = r[4];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < n; i++) {
        if (i) { lat += r[3 + i * 2]; lon += r[4 + i * 2]; }
        const x = (lon - ox) * kx, y = -(lat - oy) * ky;
        xy[i * 2] = x; xy[i * 2 + 1] = y;
        if (i) path.lineTo(x, y); else path.moveTo(x, y);
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      roads.push({ cls: r[0], name: r[1] >= 0 ? names[r[1]] || '' : '', limit: r[2] || 0, xy, bb: [x0, y0, x1, y1] });
    }
    entry.groups = groups;
    entry.roads = roads;
    entry.state = 'ok';
  }

  /** Vía más cercana a (x, y). Si hay rumbo, castiga las vías que van en otra dirección. */
  _nearest(x, y, hdg, maxDist) {
    if (!this.meta) return null;
    const ts = this.meta.tile || 0.01;
    const { lat, lon } = this.unproject(x, y);
    const tx = Math.floor(lon / ts), ty = Math.floor(lat / ts);
    let best = null, bestScore = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const t = this.tiles.get(`${tx + dx}_${ty + dy}`);
      if (!t || t.state !== 'ok') continue;
      for (const r of t.roads) {
        const b = r.bb;
        if (x < b[0] - maxDist || x > b[2] + maxDist || y < b[1] - maxDist || y > b[3] + maxDist) continue;
        const p = r.xy;
        for (let i = 2; i < p.length; i += 2) {
          const ax = p[i - 2], ay = p[i - 1], vx = p[i] - ax, vy = p[i + 1] - ay;
          const L2 = vx * vx + vy * vy;
          const u = L2 > 0 ? clamp(((x - ax) * vx + (y - ay) * vy) / L2, 0, 1) : 0;
          const d = Math.hypot(ax + vx * u - x, ay + vy * u - y);
          if (d > maxDist) continue;
          let score = d;
          if (hdg != null && L2 > 1) {
            let a = Math.abs(angDiff(Math.atan2(vx, -vy) / RAD, hdg)) % 180;
            if (a > 90) a = 180 - a;          // las vías no tienen sentido aquí: 0..90°
            score += a * 0.25;
          }
          if (score < bestScore) { bestScore = score; best = r; }
        }
      }
    }
    return best ? { name: best.name, limit: best.limit, cls: best.cls } : null;
  }

  // ======================================================================= táctil

  _makeButton() {
    const parent = this.c.parentElement;
    if (!parent) return;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    if (this.compact) parent.classList.add('mv-compact');
    const b = document.createElement('button');
    b.className = 'mv-recenter';
    b.hidden = true;
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="7"/><path d="M12 1v5M12 18v5M1 12h5M18 12h5"/></svg>' +
      (this.compact ? '' : '<span>Recentrar</span>');
    b.addEventListener('click', e => { e.stopPropagation(); this.recenter(); });
    parent.appendChild(b);
    this.btn = b;
  }

  _freeChanged() {
    if (this.btn) this.btn.hidden = !this.free;
    if (this.o.onFree) try { this.o.onFree(!!this.free); } catch (e) { console.error(e); }
  }

  _touch() {
    const c = this.c;
    c.style.touchAction = 'none';
    const pos = e => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const startFree = () => {
      if (!this.free) { this.free = { x: this.view.x, y: this.view.y, h: this.view.h, s: this.view.s }; this.back = null; this._freeChanged(); }
    };
    const pinchStart = () => {
      const [a, b] = [...this.pointers.values()];
      startFree();
      this.pinch = { d: Math.max(20, Math.hypot(a.x - b.x, a.y - b.y)), s: this.free.s };
    };
    const down = e => {
      try { c.setPointerCapture(e.pointerId); } catch (err) { /* sin captura */ }
      const p = pos(e);
      this.pointers.set(e.pointerId, p);
      this.lastTouch = performance.now();
      if (this.pointers.size === 1) {
        this.press = { x: p.x, y: p.y, moved: false, fired: false, timer: setTimeout(() => this._longPress(p), LONG_PRESS) };
      } else {
        if (this.press) { clearTimeout(this.press.timer); this.press.moved = true; }
        if (this.pointers.size === 2) pinchStart();
      }
    };
    const move = e => {
      const old = this.pointers.get(e.pointerId);
      if (!old) return;
      const p = pos(e);
      this.lastTouch = performance.now();
      if (this.pointers.size === 1) {
        const pr = this.press;
        if (pr && !pr.moved) {
          if (Math.hypot(p.x - pr.x, p.y - pr.y) < 12) return;  // aún puede ser "mantener presionado"
          pr.moved = true;
          clearTimeout(pr.timer);
        }
        if (pr && pr.fired) return;
        startFree();
        const [wx, wy] = this._screenDelta(p.x - old.x, p.y - old.y, this.free);
        this.free.x -= wx; this.free.y -= wy;
        this.pointers.set(e.pointerId, p);
      } else if (this.pointers.size === 2 && this.pinch) {
        const ids = [...this.pointers.keys()];
        const other = this.pointers.get(ids[0] === e.pointerId ? ids[1] : ids[0]);
        const m0 = { x: (old.x + other.x) / 2, y: (old.y + other.y) / 2 };
        this.pointers.set(e.pointerId, p);
        const m1 = { x: (p.x + other.x) / 2, y: (p.y + other.y) / 2 };
        const f = this.free;
        const W0 = this._screenToWorld(m0.x, m0.y, f);
        f.s = clamp(this.pinch.s * Math.hypot(p.x - other.x, p.y - other.y) / this.pinch.d, 0.04, 8);
        const [dx, dy] = this._screenDelta(m1.x - this.W / 2, m1.y - this._anchorY(), f);
        f.x = W0[0] - dx; f.y = W0[1] - dy;
      }
    };
    const up = e => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      this.lastTouch = performance.now();
      if (this.press && this.pointers.size === 0) { clearTimeout(this.press.timer); this.press = null; }
      if (this.pointers.size === 2) pinchStart(); else this.pinch = null;
    };
    this._ptr = [['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', up],
      ['contextmenu', e => e.preventDefault()]];
    for (const [ev, fn] of this._ptr) c.addEventListener(ev, fn);
  }

  _longPress(p) {
    const pr = this.press;
    if (!pr || pr.moved || this.pointers.size !== 1 || !this.origin) return;
    pr.fired = true;
    const v = this.free || this.view;
    const [x, y] = this._screenToWorld(p.x, p.y, v);
    const ll = this.unproject(x, y);
    const pick = { lat: Math.round(ll.lat * 1e6) / 1e6, lon: Math.round(ll.lon * 1e6) / 1e6 };
    this.pick = { x, y, t: performance.now() };
    if (navigator.vibrate) try { navigator.vibrate(30); } catch (e) { /* sin vibración */ }
    if (this.o.onPick) try { this.o.onPick(pick); } catch (e) { console.error(e); }
  }

  _anchorY() { return Math.round(this.H * 0.7); }

  /** Desplazamiento en pantalla (px) → desplazamiento en el mundo (m) para la vista v. */
  _screenDelta(dx, dy, v) {
    const h = v.h * RAD, cs = Math.cos(h), sn = Math.sin(h);
    dx /= v.s; dy /= v.s;
    // inversa de la rotación por −h
    return [cs * dx - sn * dy, sn * dx + cs * dy];
  }

  _screenToWorld(sx, sy, v) {
    const [dx, dy] = this._screenDelta(sx - this.W / 2, sy - this._anchorY(), v);
    return [v.x + dx, v.y + dy];
  }

  // ======================================================================= ciclo

  _resize() {
    const w = Math.max(1, Math.round(this.c.clientWidth)), h = Math.max(1, Math.round(this.c.clientHeight));
    if (w === this.W && h === this.H) return;
    this.W = w; this.H = h;
    this.c.width = w; this.c.height = h;     // devicePixelRatio fijo en 1 (rendimiento)
    this._makeVignette();
  }

  _loop(now) {
    if (this.dead || document.hidden) return;   // se reanuda con visibilitychange
    this._raf = requestAnimationFrame(this._loop);
    const idle = !this.route && !this.free && !this.back && this.pointers.size === 0 && (this.speedKmh() ?? 0) < 1 &&
      now - this.lastTouch > 1500 && !this.pick;
    if (now - this._last < (idle ? IDLE_MS : FRAME_MS) - 4) return;
    this._last = now;
    const dt = this._lastT ? Math.min(0.25, (now - this._lastT) / 1000) : 0;
    this._lastT = now;
    const t0 = performance.now();
    try {
      this._update(now, dt);
      this._draw(now);
    } catch (e) { console.error(e); }
    this.drawMs += performance.now() - t0;
    this.frames++;
  }

  _update(now, dt) {
    // Convertir como máximo un tile por cuadro para no trabar la pantalla.
    if (this.buildQueue.length && this.origin) { const [entry, js] = this.buildQueue.shift(); this._build(entry, js); }

    const kmh = this.speedKmh() ?? 0;
    const v = kmh / 3.6;
    const est = this.est, fix = this.fix;
    if (est && fix) {
      // Estimación: avanzar con la velocidad (OBD) y el rumbo, y acercarse a la posición GPS proyectada.
      const fh = (fix.hdg ?? est.h) * RAD;
      const age = Math.min((now - fix.t) / 1000, 2.5);
      const tx = fix.x + Math.sin(fh) * v * age, ty = fix.y - Math.cos(fh) * v * age;
      const eh = est.h * RAD;
      est.x += Math.sin(eh) * v * dt; est.y -= Math.cos(eh) * v * dt;
      const k = 1 - Math.exp(-dt * 2.2);
      est.x += (tx - est.x) * k; est.y += (ty - est.y) * k;
      // El rumbo solo se sigue en movimiento: parado, el rumbo del GPS es puro ruido.
      if (fix.hdg != null && v > 0.7) est.h = (est.h + angDiff(fix.hdg, est.h) * (1 - Math.exp(-dt * 3.5)) + 360) % 360;
    }
    if (this.route) this._updateProgress(false);

    // Zoom automático: más rápido = más lejos. Cerca de una maniobra se acerca un poco.
    let ahead = clamp(170 + kmh * 7, 170, 1100) * (this.compact ? 0.9 : 1);
    const dn = this.nav && this.route ? this.nav.dnext : null;
    if (Number.isFinite(dn) && dn < 300) ahead = Math.min(ahead, Math.max(170, dn * 1.6 + 80));
    const target = (this.H * 0.7) / ahead;
    this.autoS = this.autoS * Math.exp(Math.log(target / this.autoS) * (1 - Math.exp(-dt * 1.2)));

    // Vista: sigue al auto, o la vista manual, o la animación de regreso.
    const follow = est ? { x: est.x, y: est.y, h: est.h, s: this.autoS } : { x: this.view.x, y: this.view.y, h: 0, s: this.autoS };
    if (this.free) {
      if (this.pointers.size === 0 && now - this.lastTouch > FREE_TIMEOUT) this.recenter();
    }
    if (this.free) {
      Object.assign(this.view, this.free);
    } else if (this.back) {
      const u = clamp((now - this.back.t0) / 700, 0, 1), e = u * u * (3 - 2 * u), f = this.back.from;
      this.view.x = f.x + (follow.x - f.x) * e;
      this.view.y = f.y + (follow.y - f.y) * e;
      this.view.h = (f.h + angDiff(follow.h, f.h) * e + 360) % 360;
      this.view.s = Math.exp(Math.log(f.s) + (Math.log(follow.s) - Math.log(f.s)) * e);
      if (u >= 1) this.back = null;
    } else {
      Object.assign(this.view, follow);
    }

    // Calle actual (cada segundo)
    if (now - this._roadT > 1000) {
      this._roadT = now;
      if (est && this.meta) this._road = this._nearest(est.x, est.y, v > 2 ? est.h : null, 35) || { name: '', limit: 0 };
    }
  }

  /** Avance sobre la ruta: proyecta la posición estimada sobre la geometría (ventana alrededor del último tramo). */
  _updateProgress(full) {
    const r = this.route, e = this.est;
    if (!r || !e) return;
    const scan = (i0, i1) => {
      let best = Infinity, bi = this.progSeg, bu = 0;
      for (let i = Math.max(1, i0); i < Math.min(r.n, i1); i++) {
        const ax = r.xy[i * 2 - 2], ay = r.xy[i * 2 - 1], vx = r.xy[i * 2] - ax, vy = r.xy[i * 2 + 1] - ay;
        const L2 = vx * vx + vy * vy;
        const u = L2 > 0 ? clamp(((e.x - ax) * vx + (e.y - ay) * vy) / L2, 0, 1) : 0;
        const d = Math.hypot(ax + vx * u - e.x, ay + vy * u - e.y);
        if (d < best) { best = d; bi = i; bu = u; }
      }
      return [best, bi, bu];
    };
    let [d, i, u] = full ? scan(1, r.n) : scan(this.progSeg - 3, this.progSeg + 40);
    if (d > 50 && !full) [d, i, u] = scan(1, r.n);
    if (d > 120) return;                      // muy fuera de la ruta: no mover el avance
    this.progSeg = i;
    this.prog = r.cum[i - 1] + (r.cum[i] - r.cum[i - 1]) * u;
  }

  /** Punto y dirección a la distancia s (m) sobre la ruta. */
  _routeAt(s) {
    const r = this.route, cum = r.cum;
    let lo = 1, hi = r.n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < s) lo = mid + 1; else hi = mid; }
    const i = lo, L = cum[i] - cum[i - 1] || 1, u = clamp((s - cum[i - 1]) / L, 0, 1);
    const ax = r.xy[i * 2 - 2], ay = r.xy[i * 2 - 1], bx = r.xy[i * 2], by = r.xy[i * 2 + 1];
    return [ax + (bx - ax) * u, ay + (by - ay) * u, (bx - ax) / L, (by - ay) / L];
  }

  // ======================================================================= dibujo

  _draw(now) {
    const ctx = this.ctx, W = this.W, H = this.H, v = this.view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    const ax = W / 2, ay = this._anchorY();
    const s = v.s, hr = -v.h * RAD, cs = Math.cos(hr), sn = Math.sin(hr);
    // pantalla = s · R(−h) · (mundo − centro) + ancla
    const a = s * cs, b = s * sn, c = -s * sn, d = s * cs;
    const e = ax - (a * v.x + c * v.y), f = ay - (b * v.x + d * v.y);
    const toScreen = (x, y) => [a * x + c * y + e, b * x + d * y + f];
    this._m = [a, b, c, d, e, f];

    // Caja visible en el mundo (esquinas de la pantalla)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [px, py] of [[0, 0], [W, 0], [0, H], [W, H]]) {
      const [wx, wy] = this._screenToWorld(px, py, v);
      if (wx < x0) x0 = wx; if (wx > x1) x1 = wx; if (wy < y0) y0 = wy; if (wy > y1) y1 = wy;
    }

    ctx.setTransform(a, b, c, d, e, f);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    this._drawGrid(ctx, x0, y0, x1, y1, s);
    if (this.origin) this._drawTiles(ctx, x0, y0, x1, y1, s);
    this._drawTrail(ctx, s);
    if (this.route) this._drawRoute(ctx, s);

    // ---- en coordenadas de pantalla
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.route) {
      this._drawChevrons(ctx, now, s, x0, y0, x1, y1);
      const [dx, dy] = toScreen(this.route.dest[0], this.route.dest[1]);
      this._drawDest(ctx, now, dx, dy);
    }
    if (this.pick) {
      const [px, py] = toScreen(this.pick.x, this.pick.y);
      const k = ((now - this.pick.t) % 1400) / 1400;
      ctx.strokeStyle = `rgba(255,214,10,${0.9 - k * 0.8})`;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(px, py, 10 + k * 26, 0, Math.PI * 2); ctx.stroke();
      ctx.drawImage(this.sprPin, px - 18, py - 44);
    }
    // Auto
    if (this.est) {
      const [cx, cy] = toScreen(this.est.x, this.est.y);
      const rot = (this.est.h - v.h) * RAD;
      ctx.setTransform(Math.cos(rot), Math.sin(rot), -Math.sin(rot), Math.cos(rot), cx, cy);
      const stale = this.gpsAge() > 5000;
      ctx.globalAlpha = stale ? 0.45 : 1;
      ctx.drawImage(this.sprCar, -this.sprCar.width / 2, -this.sprCar.height / 2);
      ctx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.drawImage(this.sprVig, 0, 0);
  }

  _drawGrid(ctx, x0, y0, x1, y1, s) {
    const G = s > 0.5 ? 100 : s > 0.12 ? 500 : 2000;
    if ((x1 - x0) / G > 80) return;
    const k = this.metaState === 'ok' ? 1 : 1.8;     // sin mapa, la rejilla es la referencia: más visible
    ctx.lineWidth = 1 / s;
    for (const major of [false, true]) {
      const step = major ? G * 5 : G;
      ctx.strokeStyle = major ? `rgba(70,110,170,${0.16 * k})` : `rgba(60,95,150,${0.09 * k})`;
      ctx.beginPath();
      for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
      for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
      ctx.stroke();
    }
  }

  _drawTiles(ctx, x0, y0, x1, y1, s) {
    if (!this.meta) return;
    const ts = this.meta.tile || 0.01;
    const sw = this.unproject(x0, y1), ne = this.unproject(x1, y0);
    const tx0 = Math.floor(sw.lon / ts), tx1 = Math.floor(ne.lon / ts);
    const ty0 = Math.floor(sw.lat / ts), ty1 = Math.floor(ne.lat / ts);
    for (const t of this.tiles.values()) t.visible = false;
    const vis = [];
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= MAX_VISIBLE_TILES) {
      // pedir primero los tiles cercanos al centro
      const cx = (tx0 + tx1) / 2, cy = (ty0 + ty1) / 2;
      const order = [];
      for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) order.push([Math.abs(tx - cx) + Math.abs(ty - cy), tx, ty]);
      order.sort((p, q) => p[0] - q[0]);
      for (const [, tx, ty] of order) {
        const t = this._tileWanted(tx, ty, `${tx}_${ty}`);
        if (t) { t.visible = true; if (t.state === 'ok') vis.push(t); }
      }
    } else {
      for (const t of this.tiles.values()) if (t.state === 'ok') vis.push(t); // sin pedir más
    }
    if (!vis.length) return;
    // Nivel de detalle: de lejos se omiten servicio y residenciales.
    const last = s < 0.16 ? 2 : s < 0.32 ? 3 : 4;
    for (let g = last; g >= 0; g--) {
      const st = GROUPS[g];
      const lw = Math.max(st.w, st.min / s);
      if (st.glow) {
        ctx.strokeStyle = st.glow;
        ctx.lineWidth = lw * st.glowK;
        for (const t of vis) if (t.groups[g]) ctx.stroke(t.groups[g]);
      }
      ctx.strokeStyle = st.color;
      ctx.lineWidth = lw;
      for (const t of vis) if (t.groups[g]) ctx.stroke(t.groups[g]);
      if (st.core && s > 0.25) {
        ctx.strokeStyle = st.core;
        ctx.lineWidth = Math.max(1.2 / s, lw * 0.12);
        for (const t of vis) if (t.groups[g]) ctx.stroke(t.groups[g]);
      }
    }
  }

  _drawTrail(ctx, s) {
    if (this.trail.length < 4) return;
    if (this.trailDirty || !this.trailPath) {
      const p = new Path2D(), t = this.trail;
      let pen = false;
      for (let i = 0; i < t.length; i += 2) {
        if (Number.isNaN(t[i])) { pen = false; continue; }
        if (pen) p.lineTo(t[i], t[i + 1]); else { p.moveTo(t[i], t[i + 1]); pen = true; }
      }
      this.trailPath = p;
      this.trailDirty = false;
    }
    ctx.strokeStyle = this.route ? 'rgba(255,45,85,0.22)' : 'rgba(255,45,85,0.55)';
    ctx.lineWidth = Math.max(4, 3 / s);
    ctx.setLineDash([]);
    ctx.stroke(this.trailPath);
  }

  _drawRoute(ctx, s) {
    const r = this.route, L = r.len + 10, done = clamp(this.prog, 0, r.len);
    const off = this.nav && this.nav.off;
    const col = off ? ROUTE_OFF : ROUTE;
    // Parte recorrida, apagada
    if (done > 1) {
      ctx.setLineDash([done, 2 * L]);
      ctx.lineDashOffset = 0;
      ctx.strokeStyle = 'rgba(70,95,125,0.55)';
      ctx.lineWidth = Math.max(8, 5 / s);
      ctx.stroke(r.path);
    }
    // Parte por recorrer: el patrón empieza "apagado" durante `done` metros (truco del lineDashOffset).
    ctx.setLineDash([L, L]);
    ctx.lineDashOffset = 2 * L - done;
    ctx.strokeStyle = off ? 'rgba(255,176,32,0.18)' : 'rgba(25,227,255,0.16)';
    ctx.lineWidth = Math.max(26, 22 / s);
    ctx.stroke(r.path);
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(11, 8 / s);
    ctx.stroke(r.path);
    ctx.strokeStyle = 'rgba(225,252,255,0.9)';
    ctx.lineWidth = Math.max(2.5, 2 / s);
    ctx.stroke(r.path);
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }

  _drawChevrons(ctx, now, s, x0, y0, x1, y1) {
    const r = this.route, [a, b, c, d, e, f] = this._m;
    const sp = 64 / s;                                // separación en metros (= 64 px)
    const anim = ((now / 1000) * 90 / s) % sp;        // avanzan a 90 px/s
    const start = this.prog + sp * 0.4;
    const end = Math.min(r.len - 4, this.prog + Math.hypot(x1 - x0, y1 - y0));
    let k = Math.ceil((start - anim) / sp);
    ctx.strokeStyle = '#04212b';
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let n = 0; n < 40; n++, k++) {
      const dist = k * sp + anim;
      if (dist > end) break;
      const [x, y, ux, uy] = this._routeAt(dist);
      const sx = a * x + c * y + e, sy = b * x + d * y + f;
      if (sx < -20 || sy < -20 || sx > this.W + 20 || sy > this.H + 20) continue;
      let fx = a * ux + c * uy, fy = b * ux + d * uy;
      const fl = Math.hypot(fx, fy) || 1; fx /= fl; fy /= fl;
      const fade = clamp((dist - this.prog) / (sp * 1.2), 0, 1);
      ctx.globalAlpha = 0.85 * fade;
      ctx.setTransform(-fy, fx, -fx, -fy, sx, sy);
      ctx.stroke(this.chev);
    }
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  _drawDest(ctx, now, x, y) {
    const k = (now % 1600) / 1600;
    ctx.strokeStyle = `rgba(255,45,85,${0.85 - k * 0.8})`;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, 12 + k * 30, 0, Math.PI * 2); ctx.stroke();
    ctx.drawImage(this.sprFlag, x - 6, y - 50);
  }

  // ======================================================================= sprites (se hacen una vez)

  _makeSprites() {
    const mk = (w, h) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; return cv; };
    // Flecha del auto con halo
    const car = mk(120, 120), g = car.getContext('2d');
    const halo = g.createRadialGradient(60, 60, 4, 60, 60, 58);
    halo.addColorStop(0, 'rgba(255,45,85,0.55)');
    halo.addColorStop(0.45, 'rgba(255,45,85,0.18)');
    halo.addColorStop(1, 'rgba(255,45,85,0)');
    g.fillStyle = halo;
    g.fillRect(0, 0, 120, 120);
    g.beginPath(); g.arc(60, 60, 22, 0, Math.PI * 2);
    g.fillStyle = 'rgba(20,4,10,0.65)'; g.fill();
    g.lineWidth = 2; g.strokeStyle = 'rgba(255,45,85,0.9)'; g.stroke();
    g.beginPath();
    g.moveTo(60, 36); g.lineTo(77, 76); g.lineTo(60, 67); g.lineTo(43, 76); g.closePath();
    g.shadowColor = CAR; g.shadowBlur = 12;
    g.fillStyle = '#ffffff'; g.fill();
    g.shadowBlur = 0;
    g.lineWidth = 2.5; g.strokeStyle = CAR; g.stroke();
    this.sprCar = car;

    // Bandera de meta (cuadros)
    const fl = mk(44, 54), q = fl.getContext('2d');
    q.fillStyle = '#e8eef7'; q.fillRect(4, 2, 3, 50);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
      q.fillStyle = (i + j) % 2 ? '#111' : '#fff';
      q.fillRect(7 + i * 8, 3 + j * 8, 8, 8);
    }
    q.strokeStyle = CAR; q.lineWidth = 2; q.strokeRect(7, 3, 32, 24);
    q.beginPath(); q.arc(5.5, 50, 4, 0, Math.PI * 2); q.fillStyle = CAR; q.fill();
    this.sprFlag = fl;

    // Pin del punto elegido
    const pin = mk(36, 46), pg = pin.getContext('2d');
    pg.beginPath(); pg.arc(18, 16, 13, Math.PI, 0); pg.quadraticCurveTo(31, 28, 18, 44); pg.quadraticCurveTo(5, 28, 5, 16);
    pg.fillStyle = '#ffd60a'; pg.fill();
    pg.beginPath(); pg.arc(18, 16, 5, 0, Math.PI * 2); pg.fillStyle = '#2a2100'; pg.fill();
    this.sprPin = pin;

    // Chevrón (apunta hacia −y)
    const ch = new Path2D();
    ch.moveTo(-6, 3.5); ch.lineTo(0, -3.5); ch.lineTo(6, 3.5);
    this.chev = ch;
  }

  _makeVignette() {
    const cv = document.createElement('canvas');
    cv.width = this.W; cv.height = this.H;
    const g = cv.getContext('2d'), W = this.W, H = this.H;
    const rg = g.createRadialGradient(W / 2, H * 0.62, Math.min(W, H) * 0.3, W / 2, H * 0.62, Math.hypot(W, H) * 0.62);
    rg.addColorStop(0, 'rgba(0,0,0,0)');
    rg.addColorStop(1, 'rgba(0,0,0,0.6)');
    g.fillStyle = rg; g.fillRect(0, 0, W, H);
    // horizonte: lo lejano se oscurece (sensación de profundidad)
    const lg = g.createLinearGradient(0, 0, 0, H * 0.35);
    lg.addColorStop(0, 'rgba(2,3,7,0.7)');
    lg.addColorStop(1, 'rgba(2,3,7,0)');
    g.fillStyle = lg; g.fillRect(0, 0, W, H * 0.35);
    this.sprVig = cv;
  }
}

// ========================================================================= utilidades para las páginas

/** Quita acentos y pasa a minúsculas (para buscar). */
export function sinAcentos(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Distancia legible: "80 m", "350 m", "1.2 km", "12 km". */
export function fmtDist(m) {
  if (!Number.isFinite(m)) return '—';
  if (m < 0) m = 0;
  if (m < 100) return `${Math.round(m / 5) * 5} m`;
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  if (m < 10000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

const DIR_TXT = { left: 'izquierda', right: 'derecha' };

/** Instrucción corta para una maniobra del contrato. */
export function manText(m) {
  if (!m) return '';
  const lado = DIR_TXT[m.dir] || '';
  switch (m.type) {
    case 'arrive': return 'Llegas a tu destino';
    case 'start': return 'Inicia el recorrido';
    case 'curve': return lado ? `Curva a la ${lado}` : 'Curva';
    default:
      if (m.dir === 'uturn') return 'Da vuelta en U';
      if (m.dir === 'straight' || !lado) return 'Sigue derecho';
      if (m.sev === 'slight') return `Ligeramente a la ${lado}`;
      if (m.sev === 'sharp') return `Vuelta cerrada a la ${lado}`;
      return `Gira a la ${lado}`;
  }
}

/** Nota de rally para curvas: {txt:"3 DER", cls:"g1".."g6", word:"horquilla"…}, o null. */
export function rallyNote(m) {
  if (!m || m.type !== 'curve' || !Number.isFinite(m.grade)) return null;
  const g = clamp(Math.round(m.grade), 1, 6);
  const lado = m.dir === 'left' ? 'IZQ' : m.dir === 'right' ? 'DER' : '';
  const words = ['', 'horquilla', 'muy cerrada', 'cerrada', 'media', 'abierta', 'casi recta'];
  return { txt: `${g} ${lado}`.trim(), grade: g, word: words[g] };
}

/** Flecha de la maniobra como SVG (viewBox 0 0 100 100). `color` = trazo principal. */
export function maneuverSVG(m, color = '#ffffff') {
  const dim = 'rgba(255,255,255,0.22)';
  const head = (x, y, ux, uy, w = 17, l = 19) => {
    // punta en (x + u·l), base en (x ± n·w)
    const nx = -uy, ny = ux;
    return `<path d="M${(x + nx * w).toFixed(1)},${(y + ny * w).toFixed(1)} L${(x + ux * l).toFixed(1)},${(y + uy * l).toFixed(1)} L${(x - nx * w).toFixed(1)},${(y - ny * w).toFixed(1)} Z" fill="${color}"/>`;
  };
  const wrap = body => `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" fill="none" stroke-linecap="butt" stroke-linejoin="round">${body}</svg>`;
  if (!m) return wrap('');
  const sgn = m.dir === 'left' ? -1 : 1;
  if (m.type === 'arrive') {
    let cells = '';
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) cells += `<rect x="${34 + i * 12}" y="${14 + j * 12}" width="12" height="12" fill="${(i + j) % 2 ? '#10141c' : color}"/>`;
    return wrap(`<path d="M30,10 V92" stroke="${color}" stroke-width="7"/>${cells}<rect x="34" y="14" width="48" height="36" stroke="${color}" stroke-width="3"/>`);
  }
  if (m.type === 'curve') {
    const ex = 50 + sgn * 30, ey = 18;
    // tangente final ~ desde el control (50 + sgn·6, 26)
    const cx = 50 + sgn * 4, cy = 30;
    let ux = ex - cx, uy = ey - cy; const l = Math.hypot(ux, uy); ux /= l; uy /= l;
    const bx = ex - ux * 2, by = ey - uy * 2;
    return wrap(`<path d="M50,94 C50,62 ${cx},${cy} ${bx.toFixed(1)},${by.toFixed(1)}" stroke="${color}" stroke-width="13"/>${head(bx, by, ux, uy)}`);
  }
  if (m.dir === 'uturn') {
    // vuelta en U por la izquierda (en México se circula por la derecha)
    return wrap(`<path d="M64,94 V40 A16,16 0 0 0 32,40 V56" stroke="${color}" stroke-width="13"/>${head(32, 56, 0, 1)}`);
  }
  if (m.dir === 'straight' || m.type === 'start' || !DIR_TXT[m.dir]) {
    return wrap(`<path d="M50,94 V36" stroke="${color}" stroke-width="13"/>${head(50, 36, 0, -1)}`);
  }
  // Vuelta: ángulo según la severidad (o el ángulo del contrato si viene)
  let ang = m.sev === 'slight' ? 40 : m.sev === 'sharp' ? 135 : 90;
  if (Number.isFinite(m.angle) && Math.abs(m.angle) >= 10 && Math.abs(m.angle) <= 180) ang = Math.abs(m.angle);
  const jx = 50, jy = ang > 100 ? 44 : 54;
  const ux = Math.sin(ang * RAD) * sgn, uy = -Math.cos(ang * RAD);
  const L = ang > 100 ? 24 : 26;
  const ex = jx + ux * L, ey = jy + uy * L;
  return wrap(`<path d="M50,${jy} V8" stroke="${dim}" stroke-width="9"/>` +
    `<path d="M50,94 V${jy} L${ex.toFixed(1)},${ey.toFixed(1)}" stroke="${color}" stroke-width="13"/>${head(ex, ey, ux, uy)}`);
}

/**
 * Estado de la navegación para los HUD (mapa.html y dividida.html): escucha route / nav / navoff / navstatus
 * y da la maniobra actual con la distancia interpolada entre mensajes (con la velocidad del mapa).
 */
export class NavState {
  constructor(hub, map) {
    this.map = map;
    this.route = null;
    this.nav = null;
    this.navT = 0;
    this.status = null;
    this.segLen = 1;
    this._next = -1;
    hub.on('route', m => {
      if (!m || !Array.isArray(m.pts) || m.pts.length < 2) return;
      if (!this.route || this.route.id !== m.id) { this.nav = null; this._next = -1; }
      this.route = m;
    });
    hub.on('nav', m => {
      if (!this.route) return;
      if (m.id !== undefined && this.route.id !== undefined && m.id !== this.route.id) return;
      this.nav = m;
      this.navT = performance.now();
      if (m.next !== this._next) { this._next = m.next; this.segLen = clamp(Number(m.dnext) || 0, 120, 1000); }
    });
    hub.on('navoff', () => { this.route = null; this.nav = null; this._next = -1; });
    hub.on('navstatus', m => { this.status = m; });
  }

  get active() { return !!this.route; }
  get mans() { return (this.route && Array.isArray(this.route.man)) ? this.route.man : []; }

  /** Índice de la maniobra siguiente. */
  get nextIdx() {
    if (!this.route) return -1;
    if (this.nav && Number.isInteger(this.nav.next)) return this.nav.next;
    return this.mans.findIndex(m => m.type !== 'start');
  }
  get next() { return this.mans[this.nextIdx] || null; }
  get after() { const i = this.nextIdx; return i >= 0 ? this.mans[i + 1] || null : null; }

  /** Metros a la maniobra, descontando lo avanzado desde el último mensaje "nav" (máx. 3 s). */
  dnext() {
    if (!this.route) return NaN;
    if (!this.nav || !Number.isFinite(this.nav.dnext)) { const m = this.next; return m ? m.d : NaN; }
    const v = (this.map && this.map.speedKmh()) || 0;
    const dt = Math.min(3, (performance.now() - this.navT) / 1000);
    return Math.max(0, this.nav.dnext - (v / 3.6) * dt);
  }

  /** 0..1: cuánto falta para la maniobra (1 = llegando). */
  frac() { const d = this.dnext(); return Number.isFinite(d) ? clamp(1 - d / this.segLen, 0, 1) : 0; }

  remain() {
    if (!this.route) return NaN;
    if (this.nav && Number.isFinite(this.nav.remain)) {
      const v = (this.map && this.map.speedKmh()) || 0;
      return Math.max(0, this.nav.remain - (v / 3.6) * Math.min(3, (performance.now() - this.navT) / 1000));
    }
    return this.route.len;
  }
  eta() { return this.nav && Number.isFinite(this.nav.eta) ? this.nav.eta : this.route ? this.route.time : NaN; }
}

/** Hora del reloj dentro de `s` segundos: "14:32". */
export function clockIn(s) {
  const d = new Date(Date.now() + (Number(s) || 0) * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Duración legible: "45 s", "18 min", "1 h 05". */
export function fmtDur(s) {
  if (!Number.isFinite(s)) return '—';
  if (s < 60) return `${Math.max(0, Math.round(s))} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
