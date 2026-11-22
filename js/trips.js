// Odómetro, mantenimiento y viajes (prefijos de comandos "trips." y "maint."). Contrato en docs/PROTOCOLO.md
//
// Por OBD estándar no se puede leer el odómetro del Clio: se acumulan los km de ctx.obd().trip.km
// (o del GPS si no hay OBD) y el usuario lo calibra con el valor del tablero.
// Los viajes se guardan en IndexedDB detrás de un adaptador pequeño (MemoryTripStore para pruebas en node).

const DAY = 86400000;
const MONTH_DAYS = 30.4375;
const MAX_TRIPS = 200;
const START_KMH = 5;          // empieza el viaje al pasar de esta velocidad
const MOVING_KMH = 3;         // por debajo de esto se considera detenido
const STOP_END_MS = 5 * 60000;  // termina tras 5 min detenido
const LOST_END_MS = 2 * 60000;  // o tras 2 min sin OBD ni GPS
const PT_MS = 5000, PT_M = 25;  // un punto cada 5 s o cada 25 m
const GPS_MAX_ACC = 50;       // se ignoran posiciones con precisión peor que esto (m)
const GPS_MAX_MS = 70;        // salto irreal: más de 252 km/h entre posiciones
const SEND_MAX_PTS = 3000;    // al mandar un viaje al estéreo se reduce a este número de puntos

/** Intervalos sugeridos para el Clio II 1.6 16V (K4M). El usuario los puede cambiar en el teléfono. */
export const MAINT_DEFAULTS = [
  { id: 'aceite', name: 'Aceite y filtro', everyKm: 10000, everyMonths: 12 },
  { id: 'aire', name: 'Filtro de aire', everyKm: 20000, everyMonths: 24 },
  { id: 'bujias', name: 'Bujías', everyKm: 30000, everyMonths: 36 },
  { id: 'distribucion', name: 'Banda de distribución y bomba de agua', everyKm: 60000, everyMonths: 48, critical: true },
  { id: 'frenos', name: 'Líquido de frenos', everyKm: null, everyMonths: 24 },
  { id: 'anticongelante', name: 'Anticongelante', everyKm: 40000, everyMonths: 24 },
  { id: 'llantas', name: 'Rotación de llantas', everyKm: 10000, everyMonths: null },
  { id: 'gasolina', name: 'Filtro de gasolina', everyKm: 40000, everyMonths: null },
];

// ---------------------------------------------------------------------------------------------
// Utilidades puras (se exportan para las pruebas)
// ---------------------------------------------------------------------------------------------

/** Distancia en metros entre dos puntos (haversine). */
export function distM(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Fecha local como "YYYY-MM-DD". */
export function isoDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

/**
 * Estado de un elemento de mantenimiento con el odómetro y la fecha actuales.
 * leftKm / leftDays son null si el elemento no tiene ese intervalo o no tiene registro.
 * pct es la fracción consumida del intervalo (la mayor entre km y tiempo); > 1 = vencido; null = sin registro.
 */
export function maintStatus(item, odoKm, nowMs) {
  let leftKm = null, leftDays = null, pct = null;
  if (item.everyKm > 0 && Number.isFinite(item.lastKm)) {
    const used = odoKm - item.lastKm;
    leftKm = Math.round(item.everyKm - used);
    pct = Math.max(0, used / item.everyKm);
  }
  const last = parseDate(item.lastDate);
  if (item.everyMonths > 0 && last) {
    const due = new Date(last.getFullYear(), last.getMonth() + item.everyMonths, last.getDate());
    const n = new Date(nowMs);
    const today = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    leftDays = Math.round((due - today) / DAY);
    const days = Math.round((today - last) / DAY);
    const f = Math.max(0, days / (item.everyMonths * MONTH_DAYS));
    pct = pct === null ? f : Math.max(pct, f);
  }
  return { leftKm, leftDays, pct: pct === null ? null : Math.round(pct * 1000) / 1000 };
}

/** Reduce una lista de puntos a como mucho n (conserva el primero y el último). */
export function decimate(pts, n) {
  if (pts.length <= n) return pts;
  const out = [], step = (pts.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(pts[Math.round(i * step)]);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Almacenes de viajes: {put(summary, pts), get(id) -> {summary, pts}|null, list() -> [summary], remove(id)}
// ---------------------------------------------------------------------------------------------

/** Almacén en memoria (pruebas y respaldo si no hay IndexedDB). */
export class MemoryTripStore {
  constructor() { this.s = new Map(); this.p = new Map(); }
  async put(summary, pts) { this.s.set(summary.id, { ...summary }); this.p.set(summary.id, pts.slice()); }
  async get(id) { return this.s.has(id) ? { summary: { ...this.s.get(id) }, pts: this.p.get(id).slice() } : null; }
  async list() { return [...this.s.values()].map(x => ({ ...x })).sort((a, b) => b.start - a.start); }
  async remove(id) { this.s.delete(id); this.p.delete(id); }
}

/** Almacén en IndexedDB: resúmenes y puntos en object stores separados para que listar sea ligero. */
export class IdbTripStore {
  constructor(name = 'clio-viajes') { this.name = name; this.db = null; }
  _open() {
    if (this.db) return this.db;
    this.db = new Promise((res, rej) => {
      const rq = indexedDB.open(this.name, 1);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains('summaries')) db.createObjectStore('summaries', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('points')) db.createObjectStore('points');
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    return this.db;
  }
  /** Corre fn(summaries, points) en una transacción; resuelve con lo que devuelva done() al completar. */
  async _tx(mode, fn) {
    const db = await this._open();
    return new Promise((res, rej) => {
      const tx = db.transaction(['summaries', 'points'], mode);
      const done = fn(tx.objectStore('summaries'), tx.objectStore('points'));
      tx.oncomplete = () => res(typeof done === 'function' ? done() : undefined);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  }
  put(summary, pts) { return this._tx('readwrite', (s, p) => { s.put(summary); p.put(pts, summary.id); }); }
  get(id) {
    return this._tx('readonly', (s, p) => {
      const a = s.get(id), b = p.get(id);
      return () => (a.result ? { summary: a.result, pts: b.result || [] } : null);
    });
  }
  remove(id) { return this._tx('readwrite', (s, p) => { s.delete(id); p.delete(id); }); }
  async list() {
    const r = await this._tx('readonly', s => { const q = s.getAll(); return () => q.result; });
    return (r || []).sort((a, b) => b.start - a.start);
  }
}

function defaultStorage() {
  try { if (typeof localStorage !== 'undefined') return localStorage; } catch {}
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}

// ---------------------------------------------------------------------------------------------
// Módulo
// ---------------------------------------------------------------------------------------------

export class Trips {
  /**
   * @param {object} ctx  contexto del teléfono (ver PROTOCOLO.md)
   * @param {object} [opts]  para pruebas: {now, store, storage, prefix, autoTick}
   */
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.now = opts.now || (() => Date.now());
    this.storage = opts.storage || defaultStorage();
    this.prefix = opts.prefix || 'clio.';
    this.store = opts.store || (typeof indexedDB !== 'undefined' ? new IdbTripStore(opts.dbName) : new MemoryTripStore());

    const saved = this._load('odo', {});
    this.odo = Number.isFinite(saved.km) ? saved.km : 0;
    this.maint = this._loadMaint();
    // Último ctx.obd().trip.km visto. El viaje de la app empieza en 0 al cargar la página (igual que este módulo).
    this.prevTripKm = 0;
    this.prevFuel = 0;        // último ctx.obd().trip.fuel visto
    this.gpsAnchor = null;    // última posición aceptada para medir distancia con GPS
    this.gpsDistM = 0;        // metros de GPS pendientes de sumar (se suman en tick)
    this.obdOn = false;
    this.lastTick = null;
    this.lastOdoPub = -Infinity;
    this.lastOdoSent = null;
    this.lastOdoSave = 0;

    this.trip = null;         // viaje en curso
    this.recent = [];         // resúmenes (más recientes primero)
    this.el = null;
    this.editId = null;
    this.calibrating = false;

    this.ready = this._init();
    this._hookGps();
    if (opts.autoTick !== false) this.timer = setInterval(() => this.tick(), 1000);
  }

  // ---------- persistencia ----------
  _load(key, def) {
    try { const v = JSON.parse(this.storage.getItem(this.prefix + key) || 'null'); return v ?? def; } catch { return def; }
  }
  _save(key, v) { try { this.storage.setItem(this.prefix + key, JSON.stringify(v)); } catch {} }
  _saveOdo() { this._save('odo', { km: this.odo }); this.lastOdoSave = this.now(); }

  _loadMaint() {
    const saved = this._load('maint', []);
    const byId = new Map((Array.isArray(saved) ? saved : []).map(x => [x.id, x]));
    return MAINT_DEFAULTS.map(d => {
      const s = byId.get(d.id) || {};
      return {
        ...d,
        everyKm: 'everyKm' in s ? s.everyKm : d.everyKm,
        everyMonths: 'everyMonths' in s ? s.everyMonths : d.everyMonths,
        lastKm: Number.isFinite(s.lastKm) ? s.lastKm : null,
        lastDate: s.lastDate || null,
      };
    });
  }
  _saveMaint() {
    this._save('maint', this.maint.map(({ id, everyKm, everyMonths, lastKm, lastDate }) => ({ id, everyKm, everyMonths, lastKm, lastDate })));
  }

  async _init() {
    try {
      const list = await this.store.list();
      const now = this.now();
      for (const s of list.filter(x => x.open)) {
        // Viaje que quedó abierto (se cerró la app): se reanuda si es reciente; si no, se cierra.
        if (!this.trip && now - s.end < STOP_END_MS) {
          const full = await this.store.get(s.id);
          this.trip = this._resume(full.summary, full.pts);
        } else {
          s.open = false;
          const full = await this.store.get(s.id);
          await this.store.put(s, full ? full.pts : []);
        }
      }
      this.recent = (await this.store.list()).filter(x => !x.open);
    } catch (e) {
      console.warn('Viajes: no se pudo abrir el almacén', e);
    }
    this._renderTrips();
  }

  _resume(s, pts) {
    return {
      id: s.id, start: s.start, end: s.end, km: s.km, maxSpeed: s.maxSpeed, movingMs: s.movingMs || 0,
      fuel: s.fuel, pts: pts || [], lastPtT: s.end, lastPt: pts && pts.length ? pts[pts.length - 1] : null,
      stoppedSince: null, lastAlive: s.end, lastCkpt: this.now(),
    };
  }

  // ---------- GPS ----------
  // ctx.modules puede llenarse después de crear este módulo: se intenta en cada vuelta hasta lograrlo.
  _hookGps() {
    const gps = this.ctx.modules?.gps;
    if (this._hooked || !gps || typeof gps.onFix !== 'function') return;
    gps.onFix(f => this._onFix(f));
    this._hooked = true;
  }

  _onFix(f) {
    if (!f || !Number.isFinite(f.lat) || !Number.isFinite(f.lon)) return;
    if (f.acc > GPS_MAX_ACC) return;
    const ts = f.ts || this.now();
    const a = this.gpsAnchor;
    if (!a) { this.gpsAnchor = { lat: f.lat, lon: f.lon, ts }; return; }
    if (ts <= a.ts) return;
    const d = distM(a.lat, a.lon, f.lat, f.lon);
    const v = d / ((ts - a.ts) / 1000);
    if (v > GPS_MAX_MS) return;  // salto irreal: se descarta esta posición y se conserva el ancla
    // Para no sumar el "temblor" del GPS estando parado, solo se avanza el ancla si se movió lo suficiente.
    const minMove = Math.max(8, Math.min(25, (f.acc || 10) * 0.6));
    if (d < minMove) return;
    if (!this.obdOn) this.gpsDistM += d;
    this.gpsAnchor = { lat: f.lat, lon: f.lon, ts };
  }

  _gpsFix() {
    const g = this.ctx.modules?.gps?.last;
    if (!g || !Number.isFinite(g.lat) || !(g.acc <= GPS_MAX_ACC)) return null;
    if (this.now() - (g.ts || 0) > 5000) return null;
    return g;
  }

  // ---------- bucle de 1 s ----------
  tick() {
    const now = this.now();
    const dt = this.lastTick === null ? 1 : Math.min(10, (now - this.lastTick) / 1000);
    this.lastTick = now;
    let o = null;
    try { o = this.ctx.obd ? this.ctx.obd() : null; } catch {}
    this.obdOn = !!(o && o.on);

    this._hookGps();
    // Si gps no tiene onFix, se consulta gps.last en cada vuelta.
    const fix = this._gpsFix();
    if (!this._hooked && fix && fix.ts !== this._lastFixTs) { this._lastFixTs = fix.ts; this._onFix(fix); }

    // --- distancia de esta vuelta ---
    let dKm = 0, dFuel = 0;
    const tk = o && o.trip;
    if (this.obdOn && tk && Number.isFinite(tk.km)) {
      if (this.prevTripKm !== null) {
        // Si trip.km bajó, el viaje de la app se reinició: lo recorrido desde entonces es el valor nuevo.
        const d = tk.km >= this.prevTripKm ? tk.km - this.prevTripKm : tk.km;
        if (d < 0.1 * dt + 0.05) dKm = d; // más de 360 km/h: dato raro, se ignora
      }
      this.prevTripKm = tk.km;
      if (Number.isFinite(tk.fuel)) {
        if (this.prevFuel !== null) dFuel = tk.fuel >= this.prevFuel ? tk.fuel - this.prevFuel : tk.fuel;
        this.prevFuel = tk.fuel;
      }
      this.gpsDistM = 0;
    } else {
      if (!this.obdOn) { /* se conserva prevTripKm: al volver el OBD se suma solo lo nuevo */ }
      dKm = this.gpsDistM / 1000;
      this.gpsDistM = 0;
    }
    if (dKm > 0) {
      this.odo += dKm;
      if (now - this.lastOdoSave > 15000) this._saveOdo();
    }

    // --- velocidad actual ---
    let speed;
    if (this.obdOn && Number.isFinite(o.speed)) speed = o.speed;
    else if (fix && Number.isFinite(fix.spd) && fix.spd !== null) speed = fix.spd * 3.6;
    else if (!this.obdOn && fix && this._prevFix && fix.ts > this._prevFix.ts) {
      speed = distM(this._prevFix.lat, this._prevFix.lon, fix.lat, fix.lon) / ((fix.ts - this._prevFix.ts) / 1000) * 3.6;
    }
    if (fix) this._prevFix = fix;
    const alive = this.obdOn || !!fix;

    this._tripTick(now, dt, speed, alive, dKm, dFuel, fix);

    // --- publicar odómetro: cada 10 s y al cambiar (en décimas de km) ---
    const shown = Math.round(this.odo * 10);
    if (now - this.lastOdoPub >= 10000 || shown !== this.lastOdoSent) this.publishOdo();
    this._renderLive();
  }

  _tripTick(now, dt, speed, alive, dKm, dFuel, fix) {
    let t = this.trip;
    if (!t) {
      if (!(speed > START_KMH)) return;
      t = this.trip = {
        id: now, start: now, end: now, km: 0, maxSpeed: 0, movingMs: 0, fuel: null,
        pts: [], lastPtT: -Infinity, lastPt: null, stoppedSince: null, lastAlive: now, lastCkpt: now,
      };
      this.publishTrips();
    }
    if (alive) t.lastAlive = now;
    t.km += dKm;
    if (this.obdOn && dFuel > 0) t.fuel = (t.fuel || 0) + dFuel;
    if (Number.isFinite(speed)) {
      t.maxSpeed = Math.max(t.maxSpeed, speed);
      if (speed >= MOVING_KMH) { t.movingMs += dt * 1000; t.stoppedSince = null; t.end = now; }
      else if (t.stoppedSince === null) t.stoppedSince = now;
    } else if (alive && t.stoppedSince === null) t.stoppedSince = now;

    if (fix) {
      const far = t.lastPt ? distM(t.lastPt[0], t.lastPt[1], fix.lat, fix.lon) >= PT_M : true;
      if (now - t.lastPtT >= PT_MS || far) {
        // Si está parado, no se repite el mismo punto cada 5 s
        if (far || (speed >= MOVING_KMH)) {
          const p = [Math.round(fix.lat * 1e5) / 1e5, Math.round(fix.lon * 1e5) / 1e5, Math.round(speed || 0)];
          t.pts.push(p); t.lastPt = p;
        }
        t.lastPtT = now;
      }
    }

    if (t.stoppedSince !== null && now - t.stoppedSince >= STOP_END_MS) return this._endTrip(t.stoppedSince);
    if (!alive && now - t.lastAlive >= LOST_END_MS) return this._endTrip(t.lastAlive);
    if (now - t.lastCkpt >= 30000) { t.lastCkpt = now; this._checkpoint(); }
  }

  _summary(t, open = false) {
    const h = t.movingMs / 3600000;
    const s = {
      id: t.id, start: t.start, end: t.end, km: Math.round(t.km * 100) / 100,
      maxSpeed: Math.round(t.maxSpeed), avgSpeed: h > 0 ? Math.round((t.km / h) * 10) / 10 : 0,
      fuel: t.fuel === null ? null : Math.round(t.fuel * 100) / 100,
      movingMs: Math.round(t.movingMs), npts: t.pts.length,
    };
    if (open) s.open = true;
    return s;
  }

  _checkpoint() {
    const t = this.trip;
    if (!t) return;
    this.store.put(this._summary(t, true), t.pts).catch(e => console.warn('Viajes: checkpoint', e));
  }

  async _endTrip(endMs) {
    const t = this.trip;
    if (!t) return;
    this.trip = null;
    t.end = Math.max(t.start, Math.min(t.end, endMs));
    this._saveOdo();
    if (t.km < 0.05) {  // arrancón de estacionamiento: no se guarda
      this.store.remove(t.id).catch(() => {});
      this.publishTrips();
      return;
    }
    const s = this._summary(t);
    try {
      await this.store.put(s, t.pts);
      const list = await this.store.list();
      for (const x of list.slice(MAX_TRIPS)) await this.store.remove(x.id);
      this.recent = list.slice(0, MAX_TRIPS).filter(x => !x.open);
    } catch (e) {
      console.warn('Viajes: no se pudo guardar', e);
      this.recent = [s, ...this.recent].slice(0, MAX_TRIPS);
    }
    this.publishTrips();
    this._renderTrips();
  }

  // ---------- mensajes al estéreo ----------
  odoMessage() {
    const now = this.now();
    return {
      t: 'odo', km: Math.round(this.odo * 10) / 10,
      items: this.maint.map(m => ({
        id: m.id, name: m.name, everyKm: m.everyKm, everyMonths: m.everyMonths,
        lastKm: m.lastKm, lastDate: m.lastDate, ...maintStatus(m, this.odo, now),
        critical: !!m.critical, sug: this._isSuggested(m),
      })),
    };
  }

  _isSuggested(m) {
    const d = MAINT_DEFAULTS.find(x => x.id === m.id);
    return !!d && d.everyKm === m.everyKm && d.everyMonths === m.everyMonths;
  }

  publishOdo() {
    this.lastOdoPub = this.now();
    this.lastOdoSent = Math.round(this.odo * 10);
    this.ctx.publish?.(this.odoMessage());
  }

  tripsList() {
    const items = this.recent.slice();
    if (this.trip) items.unshift({ ...this._summary(this.trip), live: true });
    return items;
  }

  publishTrips() { this.ctx.publish?.({ t: 'trips', items: this.tripsList() }); }

  async getTrip(id) {
    if (this.trip && this.trip.id === id) return { summary: { ...this._summary(this.trip), live: true }, pts: this.trip.pts.slice() };
    return this.store.get(id);
  }

  // ---------- interfaz del módulo ----------
  async command(m) {
    switch (m.a) {
      // También manda el odómetro: así una pantalla puede pedir todo con un solo comando.
      case 'trips.list': this.publishTrips(); this.publishOdo(); break;
      case 'trips.get': {
        const id = Number(m.v);
        const r = await this.getTrip(id).catch(() => null);
        if (r) this.ctx.publish?.({ t: 'trip', id, summary: r.summary, pts: decimate(r.pts || [], SEND_MAX_PTS) });
        else this.ctx.publish?.({ t: 'trip', id, summary: null, pts: [] });
        break;
      }
      case 'maint.done': this.markDone(m.v); break;
      case 'maint.setOdo': this.setOdo(m.v); break;
    }
  }

  resend() { this.publishOdo(); this.publishTrips(); }

  /** Marca un elemento como hecho hoy con el odómetro actual. */
  markDone(id) {
    const it = this.maint.find(x => x.id === id);
    if (!it) return false;
    it.lastKm = Math.round(this.odo);
    it.lastDate = isoDate(this.now());
    this._saveMaint();
    this.publishOdo();
    this._renderMaint();
    this.ctx.toast?.(`${it.name}: marcado como hecho a ${fmtKm(it.lastKm)} km`);
    return true;
  }

  /** Calibra el odómetro al valor real del tablero. */
  setOdo(km) {
    km = Number(km);
    if (!Number.isFinite(km) || km < 0 || km > 2e6) return false;
    this.odo = km;
    this._saveOdo();
    this.publishOdo();
    this._renderMaint();
    this.ctx.toast?.(`Odómetro calibrado a ${fmtKm(km)} km`);
    return true;
  }

  /** Cambia intervalos o el último servicio de un elemento: {everyKm, everyMonths, lastKm, lastDate}. */
  setItem(id, patch) {
    const it = this.maint.find(x => x.id === id);
    if (!it) return false;
    const num = v => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
    };
    for (const k of ['everyKm', 'everyMonths']) if (k in patch) it[k] = num(patch[k]) || null; // 0 = sin intervalo
    if ('lastKm' in patch) it.lastKm = num(patch.lastKm);
    if ('lastDate' in patch) it.lastDate = parseDate(patch.lastDate) ? patch.lastDate : null;
    this._saveMaint();
    this.publishOdo();
    return true;
  }

  resetItem(id) {
    const d = MAINT_DEFAULTS.find(x => x.id === id);
    if (d) this.setItem(id, { everyKm: d.everyKm, everyMonths: d.everyMonths });
  }

  destroy() { clearInterval(this.timer); }

  // ---------- interfaz del teléfono ----------
  mount(el) {
    injectCss();
    this.el = el;
    el.classList.add('trp');
    el.innerHTML = `
      <div class="trp-card">
        <div class="trp-odo">
          <div><span class="trp-cap">Odómetro (estimado)</span><b class="trp-odo-km">—</b> <i>km</i>
            <div class="trp-live"></div></div>
          <button class="btn trp-btn" data-act="cal">Calibrar</button>
        </div>
        <form class="trp-cal" hidden>
          <label>Km del tablero <input type="number" inputmode="numeric" min="0" step="1" name="km" required></label>
          <button class="btn primary trp-btn" type="submit">Guardar</button>
          <button class="btn ghost trp-btn" type="button" data-act="calx">Cancelar</button>
        </form>
        <p class="trp-note">Por OBD no se puede leer el odómetro del Clio: se suman los km recorridos (OBD, o GPS si no hay OBD).
          Calíbralo de vez en cuando con el valor del tablero.</p>
      </div>
      <div class="trp-card">
        <h3 class="trp-h">Mantenimiento</h3>
        <div class="trp-maint"></div>
        <p class="trp-note">Los intervalos marcados <span class="trp-tag">sugerido</span> son valores típicos para el motor K4M;
          revisa el manual o a tu mecánico y ajústalos con <b>Editar</b>.</p>
      </div>
      <div class="trp-card">
        <h3 class="trp-h">Viajes recientes</h3>
        <div class="trp-trips"></div>
      </div>`;
    el.addEventListener('click', e => this._onClick(e));
    el.addEventListener('submit', e => this._onSubmit(e));
    this._renderMaint();
    this._renderTrips();
    this._renderLive();
  }

  _onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act, id = b.dataset.id;
    const cal = this.el.querySelector('.trp-cal');
    if (act === 'cal') { cal.hidden = false; cal.km.value = Math.round(this.odo); cal.km.focus(); }
    else if (act === 'calx') cal.hidden = true;
    else if (act === 'done') {
      const it = this.maint.find(x => x.id === id);
      if (it && confirm(`¿Marcar "${it.name}" como hecho hoy a ${fmtKm(Math.round(this.odo))} km?`)) this.markDone(id);
    } else if (act === 'edit') { this.editId = this.editId === id ? null : id; this._renderMaint(); }
    else if (act === 'reset') { this.resetItem(id); this.editId = null; this._renderMaint(); }
    else if (act === 'editx') { this.editId = null; this._renderMaint(); }
  }

  _onSubmit(e) {
    e.preventDefault();
    const f = e.target;
    if (f.classList.contains('trp-cal')) {
      if (this.setOdo(f.km.value)) f.hidden = true;
      this._renderLive();
    } else if (f.classList.contains('trp-edit')) {
      this.setItem(f.dataset.id, { everyKm: f.everyKm.value, everyMonths: f.everyMonths.value, lastKm: f.lastKm.value, lastDate: f.lastDate.value });
      this.editId = null;
      this._renderMaint();
    }
  }

  _renderLive() {
    if (!this.el) return;
    this.el.querySelector('.trp-odo-km').textContent = fmtKm(this.odo, 1);
    const t = this.trip;
    this.el.querySelector('.trp-live').textContent = t
      ? `Viaje en curso: ${t.km.toFixed(1)} km · ${fmtDur(this.now() - t.start)}` : '';
    // Las barras se actualizan cada ~10 s (si no se está editando)
    if (!this.editId && this.now() - (this._lastMaintRender || 0) > 10000) this._renderMaint();
  }

  _renderMaint() {
    if (!this.el) return;
    this._lastMaintRender = this.now();
    const { items } = this.odoMessage();
    this.el.querySelector('.trp-maint').innerHTML = items.map(it => {
      const lvl = it.pct === null ? 'none' : it.pct >= 1 ? 'red' : it.pct >= 0.8 ? 'amber' : 'ok';
      const w = it.pct === null ? 0 : Math.min(100, it.pct * 100);
      const every = [it.everyKm ? `${fmtKm(it.everyKm)} km` : null, it.everyMonths ? `${it.everyMonths} meses` : null].filter(Boolean).join(' / ');
      const edit = this.editId === it.id ? `
        <form class="trp-edit" data-id="${it.id}">
          <label>Cada (km)<input type="number" name="everyKm" min="0" step="500" value="${it.everyKm ?? ''}" placeholder="—"></label>
          <label>Cada (meses)<input type="number" name="everyMonths" min="0" step="1" value="${it.everyMonths ?? ''}" placeholder="—"></label>
          <label>Último (km)<input type="number" name="lastKm" min="0" step="1" value="${it.lastKm ?? ''}" placeholder="sin registro"></label>
          <label>Última fecha<input type="date" name="lastDate" value="${it.lastDate ?? ''}"></label>
          <div class="trp-row">
            <button class="btn primary trp-btn" type="submit">Guardar</button>
            <button class="btn ghost trp-btn" type="button" data-act="reset" data-id="${it.id}">Restaurar sugerido</button>
            <button class="btn ghost trp-btn" type="button" data-act="editx">Cancelar</button>
          </div>
        </form>` : '';
      return `<div class="trp-item ${lvl}${it.critical ? ' crit' : ''}">
        <div class="trp-item-top">
          <div class="trp-name">${escHtml(it.name)}${it.critical ? ' <span class="trp-tag crit">crítico</span>' : ''}${it.sug ? ' <span class="trp-tag">sugerido</span>' : ''}
            <small>Cada ${every || '—'}</small></div>
          <button class="btn trp-btn" data-act="done" data-id="${it.id}">Hecho</button>
          <button class="btn ghost trp-btn" data-act="edit" data-id="${it.id}">Editar</button>
        </div>
        <div class="trp-bar"><i style="width:${w}%"></i></div>
        <div class="trp-left">${escHtml(leftText(it))}</div>
        ${edit}
      </div>`;
    }).join('');
  }

  _renderTrips() {
    if (!this.el) return;
    const list = this.recent.slice(0, 15);
    this.el.querySelector('.trp-trips').innerHTML = list.length ? list.map(s => `
      <div class="trp-trip">
        <div><b>${escHtml(fmtDate(s.start))}</b><small>${fmtDur(s.end - s.start)}${s.npts ? ' · con recorrido GPS' : ''}</small></div>
        <div class="trp-stats"><span><b>${s.km.toFixed(1)}</b> km</span><span><b>${Math.round(s.avgSpeed)}</b> prom.</span>
          <span><b>${Math.round(s.maxSpeed)}</b> máx.</span>${s.fuel !== null && s.fuel !== undefined ? `<span><b>${s.fuel.toFixed(1)}</b> L</span>` : ''}</div>
      </div>`).join('') : '<p class="trp-note">Todavía no hay viajes. Se graban solos al pasar de 5 km/h.</p>';
  }
}

// ---------------------------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------------------------
export function fmtKm(km, dec = 0) {
  if (!Number.isFinite(km)) return '—';
  return km.toLocaleString('es-MX', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
export function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}
function fmtDate(ms) {
  const d = new Date(ms);
  try { return d.toLocaleString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return d.toISOString().slice(0, 16).replace('T', ' '); }
}
/** Texto de "faltan / vencido" para un elemento de mantenimiento (lo usan teléfono y estéreo). */
export function leftText(it) {
  if (it.pct === null || it.pct === undefined) return 'Sin registro: toca "Hecho" cuando lo hagas o edita la fecha';
  const parts = [];
  if (it.leftKm !== null && it.leftKm !== undefined) parts.push(it.leftKm >= 0 ? `${fmtKm(it.leftKm)} km` : `${fmtKm(-it.leftKm)} km`);
  if (it.leftDays !== null && it.leftDays !== undefined) parts.push(it.leftDays >= 0 ? `${it.leftDays} días` : `${-it.leftDays} días`);
  const over = (it.leftKm !== null && it.leftKm < 0) || (it.leftDays !== null && it.leftDays < 0);
  return (over ? 'Vencido por ' : 'Faltan ') + parts.join(' · ');
}
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

let cssDone = false;
function injectCss() {
  if (cssDone || typeof document === 'undefined' || document.getElementById('trp-css')) return;
  cssDone = true;
  const st = document.createElement('style');
  st.id = 'trp-css';
  st.textContent = `
  .trp { display:flex; flex-direction:column; gap:12px; margin-top:12px; }
  .trp [hidden] { display:none !important; }
  .trp-card { background:var(--panel,#10151c); border:1px solid var(--border,#232c38); border-radius:var(--radius,12px); padding:14px; }
  .trp-h { margin:0 0 10px; font-size:16px; }
  .trp-cap { display:block; font-size:11px; letter-spacing:1.2px; text-transform:uppercase; color:var(--muted,#7d8a99); }
  .trp-odo { display:flex; align-items:center; justify-content:space-between; gap:12px; }
  .trp-odo-km { font-size:40px; font-weight:600; font-variant-numeric:tabular-nums; }
  .trp-odo i { font-style:normal; color:var(--muted,#7d8a99); }
  .trp-live { color:var(--ok,#34d399); font-size:13px; min-height:18px; }
  .trp-btn { min-height:44px; min-width:44px; }
  .trp-cal, .trp-row { display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end; margin-top:10px; }
  .trp input { background:var(--panel-2,#161c25); border:1px solid var(--border,#232c38); border-radius:8px; padding:9px 10px; min-height:44px; }
  .trp-cal label, .trp-edit label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--muted,#7d8a99); }
  .trp-note { color:var(--muted,#7d8a99); font-size:12px; margin:10px 0 0; }
  .trp-tag { font-size:10px; text-transform:uppercase; letter-spacing:.8px; border:1px solid var(--border,#232c38); color:var(--muted,#7d8a99); border-radius:5px; padding:1px 5px; vertical-align:middle; }
  .trp-tag.crit { color:var(--danger,#ff3b3b); border-color:var(--danger,#ff3b3b); }
  .trp-item { padding:10px 0; border-top:1px solid var(--border,#232c38); }
  .trp-item:first-child { border-top:0; }
  .trp-item-top { display:flex; align-items:center; gap:8px; }
  .trp-name { flex:1; font-weight:600; }
  .trp-name small { display:block; font-weight:400; color:var(--muted,#7d8a99); font-size:12px; }
  .trp-bar { height:8px; border-radius:4px; background:#1b222c; margin:8px 0 4px; overflow:hidden; }
  .trp-bar i { display:block; height:100%; background:var(--ok,#34d399); border-radius:4px; }
  .trp-item.amber .trp-bar i { background:#f59e0b; }
  .trp-item.red .trp-bar i { background:var(--danger,#ff3b3b); }
  .trp-left { font-size:13px; color:var(--muted,#7d8a99); }
  .trp-item.red .trp-left { color:#ff8a8a; }
  .trp-item.amber .trp-left { color:#fbbf24; }
  .trp-edit { display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:8px; margin-top:10px; }
  .trp-edit .trp-row { grid-column:1 / -1; }
  .trp-trip { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:9px 0; border-top:1px solid var(--border,#232c38); flex-wrap:wrap; }
  .trp-trip:first-child { border-top:0; }
  .trp-trip small { display:block; color:var(--muted,#7d8a99); font-size:12px; }
  .trp-stats { display:flex; gap:14px; color:var(--muted,#7d8a99); font-size:12px; }
  .trp-stats b { color:var(--text,#e8eef5); font-size:15px; }
  `;
  document.head.appendChild(st);
}
