// Enlace con la pantalla del estéreo.
// Si la app se abrió desde el hub (Termux, http://localhost:8080), se conecta a su relay WebSocket
// como "motor" y publica el estado del auto. Abierta desde otro lado, no hace nada.

export class StereoLink {
  /**
   * @param {{onCommand?: (msg: object) => void, onStatus?: (s: {open: boolean, screens: number}) => void}} handlers
   */
  constructor({ onCommand = () => {}, onStatus = () => {} } = {}) {
    this.onCommand = onCommand;
    this.onStatus = onStatus;
    this.ws = null;
    this.open = false;
    this.screens = 0; // pantallas conectadas al hub
    this.onScreen = () => {}; // se llama cuando entra una pantalla nueva (para mandarle la configuración)
  }

  /** Comprueba si hay un hub en el mismo origen y, si lo hay, se conecta. */
  async start() {
    if (!/^https?:$/.test(location.protocol)) return false;
    try {
      const r = await fetch('/hub/status', { cache: 'no-store' });
      if (!r.ok || !('clients' in (await r.json()))) return false;
    } catch {
      return false;
    }
    this._connect();
    return true;
  }

  _connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws?role=motor`);
    this.ws = ws;
    ws.onopen = () => { this.open = true; this._status(); };
    ws.onmessage = e => {
      if (typeof e.data !== 'string') return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'hub') {
        const before = this.screens;
        this.screens = m.clients.filter(r => r.startsWith('pantalla')).length;
        if (this.screens > before) this.onScreen();
        this._status();
      } else if (m.t === 'cmd') {
        this.onCommand(m);
      }
    };
    ws.onclose = () => {
      this.open = false;
      this.screens = 0;
      this._status();
      setTimeout(() => this._connect(), 2000);
    };
  }

  _status() {
    this.onStatus({ open: this.open, screens: this.screens });
  }

  /** Envía un mensaje solo si hay alguna pantalla escuchando. */
  publish(msg) {
    if (!this.open || !this.screens || this.ws.readyState !== WebSocket.OPEN) return;
    // Si la red se atasca, no acumular: se descarta este cuadro y se manda el siguiente.
    if (this.ws.bufferedAmount > 64 * 1024) return;
    this.ws.send(JSON.stringify(msg));
  }
}
