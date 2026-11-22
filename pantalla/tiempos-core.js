// Lógica pura del cronómetro de aceleración (sin DOM): se prueba en node con perfiles sintéticos.
//
// Entrada: muestras (t en ms con el reloj propio del estéreo al recibir, v en km/h enteros del OBD).
// El OBD por línea K actualiza la velocidad unas 5–9 veces por segundo aunque el snapshot llegue a 10 Hz,
// así que los valores repetidos se toman como "dato viejo": para los cruces de velocidad se usa la
// PRIMERA llegada de cada valor nuevo. La distancia se integra con todas las llegadas (trapecios).

export const MODES = {
  '0-100': { id: '0-100', label: '0–100', kind: 'speed', from: 0, to: 100 },
  '0-60': { id: '0-60', label: '0–60', kind: 'speed', from: 0, to: 60 },
  '60-100': { id: '60-100', label: '60–100', kind: 'speed', from: 60, to: 100 },
  '400m': { id: '400m', label: '400 m', kind: 'dist', from: 0, dist: 400 },
};

const ARM_MARGIN = 5;      // en modos lanzados (60–100) hay que bajar 5 km/h del inicio para armar
const DROP_ABORT = 8;      // si la velocidad cae 8 km/h bajo el máximo de la corrida, se cancela
const MAX_RUN_MS = 60000;  // ninguna corrida dura más de esto
const FIT_MAX_V = 25;      // el arranque se estima con una recta por las primeras muestras hasta 25 km/h
const FIT_N = 6;

/** Recta por mínimos cuadrados v = a·t + b. Devuelve {a, b} o null. */
export function fitLine(pts) {
  const n = pts.length;
  if (n < 2) return null;
  let st = 0, sv = 0;
  for (const [t, v] of pts) { st += t; sv += v; }
  const mt = st / n, mv = sv / n;
  let num = 0, den = 0;
  for (const [t, v] of pts) { num += (t - mt) * (v - mv); den += (t - mt) ** 2; }
  if (den <= 0) return null;
  const a = num / den;
  return { a, b: mv - a * mt };
}

/** Tiempo en que una recta entre (t0,v0) y (t1,v1) cruza el valor x. */
export function crossTime(t0, v0, t1, v1, x) {
  if (v1 === v0) return t1;
  return t0 + ((x - v0) / (v1 - v0)) * (t1 - t0);
}

/**
 * Dentro de un tramo con velocidad lineal de v0 a v1 (km/h) en dt segundos, ¿en cuántos segundos se
 * recorren `need` metros? (resuelve v0·τ + ½·a·τ² = need)
 */
export function timeForDist(v0, v1, dt, need) {
  const u = v0 / 3.6, a = (v1 - v0) / 3.6 / dt;
  if (Math.abs(a) < 1e-9) return u > 0 ? need / u : dt;
  const disc = u * u + 2 * a * need;
  if (disc < 0) return dt;
  return (-u + Math.sqrt(disc)) / a;
}

/** Tiempo (s) en que un perfil [[t_s, v, d_m], …] alcanza por primera vez la velocidad o distancia x. */
export function profileAt(profile, x, key = 'speed') {
  if (!profile || profile.length < 2) return null;
  const k = key === 'dist' ? 2 : 1;
  if (x <= profile[0][k]) return profile[0][0];
  for (let i = 1; i < profile.length; i++) {
    const p = profile[i - 1], q = profile[i];
    if (q[k] >= x) return q[k] === p[k] ? q[0] : p[0] + ((x - p[k]) / (q[k] - p[k])) * (q[0] - p[0]);
  }
  return null;
}

/**
 * Máquina de estados: 'wait' (hay que detenerse / bajar de velocidad) → 'armed' (LISTO) → 'run' → 'done'.
 * feed() devuelve un evento cuando cambia algo importante: 'armed', 'start', 'done', 'abort' o null.
 */
export class DragTimer {
  constructor(modeId = '0-100', ghost = null) {
    this.setMode(modeId, ghost);
  }

  setMode(modeId, ghost = null) {
    this.mode = MODES[modeId] || MODES['0-100'];
    this.ghost = ghost;  // perfil de la mejor corrida de este modo
    this.reset();
  }

  reset() {
    this.state = 'wait';
    this.lastV = null; this.lastT = null;   // última llegada (cualquiera)
    this.newV = null; this.newT = null;     // primera llegada del último valor distinto
    this.zeroT = null;                      // última llegada con v = 0
    this.result = null;
    this.reason = '';
    this._run = null;
  }

  get standing() { return this.mode.from === 0; }

  /** Tiempo transcurrido de la corrida (s) al instante t (ms), o del resultado. */
  elapsed(t) {
    if (this.state === 'done' && this.result) return this.result.time;
    if (this.state !== 'run') return 0;
    return Math.max(0, (t - this._run.start) / 1000);
  }

  /** Distancia recorrida en la corrida (m). */
  get dist() { return this._run ? this._run.dist : 0; }

  /** Delta contra el fantasma en el último dato: + = más lento que el mejor. null si no hay. */
  get delta() { return this._run ? this._run.delta : null; }

  feed(t, v) {
    if (!Number.isFinite(v) || !Number.isFinite(t)) return null;
    const isNew = v !== this.newV;
    const prevNewV = this.newV, prevNewT = this.newT;
    if (isNew) { this.newV = v; this.newT = t; }
    const prevT = this.lastT;
    this.lastT = t; this.lastV = v;
    if (v === 0) this.zeroT = t;

    const m = this.mode;
    switch (this.state) {
      case 'wait':
      case 'done': {
        const armOk = this.standing ? v === 0 : v < m.from - ARM_MARGIN;
        if (armOk) { this.state = 'armed'; return 'armed'; }
        return null;
      }
      case 'armed': {
        if (this.standing) {
          if (v > 0) {
            this._begin(t, this.zeroT ?? prevT ?? t, v);
            return this._step(t, v, isNew, prevNewT, prevNewV) || 'start';
          }
        } else if (v >= m.from) {
          if (prevNewV === null || prevNewV >= m.from) { this.state = 'wait'; return null; }
          // cruce lanzado: interpolar entre la llegada del valor anterior y la de este
          const ts = crossTime(prevNewT, prevNewV, t, v, m.from);
          this._begin(t, ts, v, ts);
          this._run.dist = 0;
          return this._step(t, v, isNew, prevNewT, prevNewV) || 'start';
        }
        return null;
      }
      case 'run':
        return this._step(t, v, isNew, prevNewT, prevNewV);
    }
    return null;
  }

  _begin(t, zeroT, v, fixedStart) {
    this.state = 'run';
    this.result = null;
    this.reason = '';
    const r = this._run = {
      zeroT, fixed: fixedStart !== undefined, start: fixedStart ?? t,
      moving: [], prof: [], dist: 0, lastT: null, lastV: null, maxV: v, delta: null,
    };
    if (!r.fixed) r.start = this._estimateStart([[t, v]], t);
  }

  /** Inicio por extrapolación (recta por las primeras muestras en movimiento hasta v = 0). */
  _estimateStart(pts, t1) {
    const z = this._run.zeroT;
    const lo = Math.max(z - 200, t1 - 1500), hi = pts[0][0];
    const f = fitLine(pts);
    let ts;
    if (f && f.a > 0) ts = -f.b / f.a;
    else ts = pts[0][0] - 120; // una sola muestra: medio intervalo típico antes
    return Math.min(hi, Math.max(lo, ts));
  }

  _step(t, v, isNew, prevNewT, prevNewV) {
    const r = this._run, m = this.mode;
    // muestras en movimiento para estimar el inicio (solo modos desde parado)
    if (!r.fixed && isNew && v > 0 && v <= FIT_MAX_V && r.moving.length < FIT_N) {
      r.moving.push([t, v]);
      const old = r.start;
      r.start = this._estimateStart(r.moving, r.moving[0][0]);
      // el inicio se movió: se recalcula la distancia desde el nuevo inicio de forma aproximada
      if (r.prof.length) {
        const shift = (old - r.start) / 1000;
        for (const p of r.prof) p[0] += shift;
      }
    }
    // distancia (todas las llegadas). El primer tramo (del inicio estimado a la primera muestra)
    // se recalcula cada vez que se corrige el inicio.
    if (r.lastT === null) { r.firstT = t; r.firstV = v; r.rest = 0; }
    const seg0 = (((r.fixed ? m.from : 0) + r.firstV) / 2 / 3.6) * Math.max(0, (r.firstT - r.start) / 1000);
    if (r.lastT !== null) {
      const dt = (t - r.lastT) / 1000;
      const add = ((r.lastV + v) / 2 / 3.6) * dt;
      if (m.kind === 'dist' && seg0 + r.rest + add >= m.dist) {
        const tau = timeForDist(r.lastV, v, dt, m.dist - seg0 - r.rest);
        const tf = r.lastT + tau * 1000;
        const trap = r.lastV + (v - r.lastV) * (tau / dt);
        r.dist = m.dist;
        return this._finish(tf, trap);
      }
      r.rest += add;
    }
    r.dist = seg0 + r.rest;
    r.lastT = t; r.lastV = v;
    if (isNew) r.prof.push([Math.round(((t - r.start) / 1000) * 1000) / 1000, v, Math.round(r.dist * 10) / 10]);

    // cruce de la velocidad final
    if (m.kind === 'speed' && v >= m.to) {
      let tf;
      if (prevNewV !== null && prevNewV < m.to && isNew) tf = crossTime(prevNewT, prevNewV, t, v, m.to);
      else tf = t;
      return this._finish(tf, m.to);
    }
    // cancelaciones
    r.maxV = Math.max(r.maxV, v);
    if (v === 0 || v < r.maxV - DROP_ABORT || (!this.standing && v < m.from - ARM_MARGIN) || t - r.start > MAX_RUN_MS) {
      this.state = 'wait';
      this.reason = v === 0 ? 'Se detuvo' : t - r.start > MAX_RUN_MS ? 'Tardó demasiado' : 'Bajó la velocidad';
      this._run = null;
      return 'abort';
    }
    // fantasma
    if (this.ghost && isNew) {
      const gt = m.kind === 'dist' ? profileAt(this.ghost, r.dist, 'dist') : profileAt(this.ghost, v, 'speed');
      r.delta = gt === null ? null : (t - r.start) / 1000 - gt;
    }
    return null;
  }

  _finish(tf, trap) {
    const r = this._run;
    const time = Math.max(0, (tf - r.start) / 1000);
    r.prof.push([Math.round(time * 1000) / 1000, Math.round(trap), Math.round(r.dist * 10) / 10]);
    if (this.ghost) {
      const gt = this.mode.kind === 'dist' ? profileAt(this.ghost, this.mode.dist, 'dist') : profileAt(this.ghost, this.mode.to, 'speed');
      r.delta = gt === null ? null : time - gt;
    }
    this.result = {
      mode: this.mode.id, time: Math.round(time * 100) / 100, trap: Math.round(trap),
      dist: Math.round(r.dist), delta: r.delta === null ? null : Math.round(r.delta * 100) / 100,
      profile: simplifyProfile(r.prof),
    };
    this.state = 'done';
    return 'done';
  }
}

/** Limita el perfil a ~200 puntos para guardarlo en localStorage. */
export function simplifyProfile(p, max = 200) {
  if (p.length <= max) return p;
  const out = [], step = (p.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(p[Math.round(i * step)]);
  return out;
}

/** Guarda una corrida en el registro {best:{modo:resultado}, hist:[…]}; devuelve true si es récord. */
export function recordRun(db, res, date = Date.now()) {
  db.best = db.best || {};
  db.hist = db.hist || [];
  const entry = { mode: res.mode, time: res.time, trap: res.trap, date };
  db.hist.unshift(entry);
  if (db.hist.length > 50) db.hist.length = 50;
  const b = db.best[res.mode];
  if (!b || res.time < b.time) { db.best[res.mode] = { ...entry, profile: res.profile }; return true; }
  return false;
}
