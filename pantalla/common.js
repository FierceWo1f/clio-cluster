// Utilidades compartidas por las páginas del estéreo. Contrato en docs/PROTOCOLO.md

export const $ = s => document.querySelector(s);
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Conexión con el relay del hub (se reconecta sola). */
export class Hub {
  constructor(role) {
    this.role = role;
    this.handlers = new Map();
    this.binHandlers = [];
    this.motor = false;
    this.ws = null;
    this._connect();
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return this;
  }

  onBinary(fn) { this.binHandlers.push(fn); return this; }

  get open() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }

  _emit(type, m) {
    for (const fn of this.handlers.get(type) || []) {
      try { fn(m); } catch (e) { console.error(e); }
    }
  }

  _connect() {
    const ws = new WebSocket(`ws://${location.host}/ws?role=${encodeURIComponent(this.role)}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => this._emit('open');
    ws.onmessage = e => {
      if (typeof e.data !== 'string') {
        for (const fn of this.binHandlers) { try { fn(e.data); } catch (err) { console.error(err); } }
        return;
      }
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'hub') {
        const had = this.motor;
        this.motor = m.clients.some(r => r.startsWith('motor'));
        if (this.motor !== had) this._emit('motor', this.motor);
      }
      this._emit(m.t, m);
      this._emit('*', m);
    };
    ws.onclose = () => {
      this.motor = false;
      this._emit('close');
      setTimeout(() => this._connect(), 2000);
    };
  }

  send(msg) {
    if (this.open) this.ws.send(JSON.stringify(msg));
  }

  /** Comando para el teléfono: {t:"cmd", a, v} */
  cmd(a, v) {
    this.send(v === undefined ? { t: 'cmd', a } : { t: 'cmd', a, v });
  }
}

export function startClock(el) {
  const tick = () => {
    const d = new Date();
    el.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  tick();
  return setInterval(tick, 1000);
}

/** Formatea segundos como m:ss */
export function fmtTime(s) {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  s = Math.floor(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
