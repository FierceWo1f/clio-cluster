// GPS del teléfono (contrato en docs/PROTOCOLO.md, sección GPS).
// Publica {"t":"gps",lat,lon,acc,hdg,spd,ts} en cada posición nueva y la ofrece a otros módulos
// con gps.last y gps.onFix(fn).

const RAD = Math.PI / 180;

function distM(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
  const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

export class Gps {
  constructor(ctx) {
    this.ctx = ctx;
    /** @type {{lat:number, lon:number, acc:number, hdg:number|null, spd:number|null, ts:number}|null} */
    this.last = null;
    /** Estado para la interfaz: 'off' | 'wait' | 'ok' | 'denied' | 'error' */
    this.state = 'off';
    this.msg = '';
    this._fns = new Set();
    this._ref = null;     // posición de referencia para calcular el rumbo (>8 m)
    this._hdg = null;
    this._prev = null;    // posición anterior para calcular la velocidad
    this._watch = null;
    this._warned = false;
    this.start();
  }

  start() {
    if (this._watch !== null) return;
    if (!('geolocation' in navigator)) {
      this._setState('error', 'Este navegador no tiene GPS.');
      this.ctx.toast('Este navegador no tiene acceso al GPS.', true);
      return;
    }
    if (!window.isSecureContext) {
      this._setState('error', 'El GPS solo funciona abriendo la app desde http://localhost o https.');
      this.ctx.toast(this.msg, true);
      return;
    }
    this._setState('wait', 'Buscando señal GPS…');
    this._watch = navigator.geolocation.watchPosition(p => this._fix(p), e => this._error(e), {
      enableHighAccuracy: true, maximumAge: 0,
    });
  }

  stop() {
    if (this._watch !== null) navigator.geolocation.clearWatch(this._watch);
    this._watch = null;
    this._setState('off', 'GPS apagado.');
  }

  /** Registra un oyente de posiciones; devuelve una función para quitarlo. */
  onFix(fn) {
    this._fns.add(fn);
    return () => this._fns.delete(fn);
  }

  /** Entró una pantalla nueva: reenviar la última posición. */
  resend() {
    if (this.last) this.ctx.publish({ t: 'gps', ...this.last });
  }

  _fix(p) {
    const c = p.coords;
    const lat = c.latitude, lon = c.longitude, ts = p.timestamp || Date.now();
    // Rumbo: el del GPS si lo da (y nos movemos); si no, calculado con posiciones separadas por más de 8 m.
    if (!this._ref) this._ref = { lat, lon };
    const moved = distM(this._ref.lat, this._ref.lon, lat, lon);
    if (moved > 8) {
      this._hdg = bearing(this._ref.lat, this._ref.lon, lat, lon);
      this._ref = { lat, lon };
    }
    let hdg = Number.isFinite(c.heading) && (c.speed ?? 1) > 0.5 ? c.heading : this._hdg;
    // Velocidad: la del GPS, o calculada entre las dos últimas posiciones
    let spd = Number.isFinite(c.speed) ? c.speed : null;
    if (spd === null && this._prev) {
      const dt = (ts - this._prev.ts) / 1000;
      if (dt >= 0.5 && dt < 30) spd = distM(this._prev.lat, this._prev.lon, lat, lon) / dt;
    }
    this._prev = { lat, lon, ts };
    const fix = {
      lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, acc: Math.round(c.accuracy ?? 0),
      hdg: hdg === null || hdg === undefined ? null : Math.round(hdg), spd: spd === null ? null : Math.round(spd * 10) / 10, ts,
    };
    const first = !this.last;
    this.last = fix;
    this._setState('ok', `GPS ±${fix.acc} m`);
    if (first) this.ctx.toast(`GPS listo (±${fix.acc} m).`);
    this.ctx.publish({ t: 'gps', ...fix });
    for (const fn of this._fns) {
      try { fn(fix); } catch (e) { console.error(e); }
    }
  }

  _error(e) {
    if (e.code === 1) {
      this._setState('denied', 'Permiso de ubicación denegado.');
      this.ctx.toast('Permiso de ubicación denegado. En Chrome: candado de la barra › Permisos › Ubicación › Permitir, y recarga.', true);
      this._watch = null;
      return;
    }
    // 2 = sin señal, 3 = tiempo agotado: el watch sigue activo, solo avisamos una vez
    this._setState('wait', e.code === 2 ? 'Sin señal GPS (¿ubicación apagada?).' : 'Buscando señal GPS…');
    if (!this._warned) {
      this._warned = true;
      this.ctx.toast(e.code === 2 ? 'No hay señal GPS. Revisa que la ubicación del teléfono esté encendida.' : 'Buscando señal GPS…', e.code === 2);
    }
  }

  _setState(state, msg) {
    this.state = state;
    this.msg = msg;
  }
}
