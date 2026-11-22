// Visualizaciones de música del estéreo (pantalla/musica.html y el mini reproductor de la vista dividida).
// Recibe el binario del espectro descrito en docs/PROTOCOLO.md (sección Música):
//   97 bytes = [0x46 ('F'), 32 bandas 0..255 (graves→agudos, escala log), 64 muestras de onda 0..255 (128 = 0)]
//
// Pensado para un CPU débil (A7 a 1.3 GHz):
//   - dibuja a resolución interna reducida (opción scale) y el CSS lo estira;
//   - limita los cuadros por segundo (opción fpsCap);
//   - no usa shadowBlur ni filtros (el brillo se logra con trazos translúcidos en modo 'lighter');
//   - se pausa sola cuando la página queda oculta.
//
// Búfer de retardo: el audio por Bluetooth suena ~200 ms después de que el teléfono lo analiza, así que cada
// cuadro se guarda con su hora de llegada y se dibuja el que corresponde a (ahora - delayMs), interpolando entre
// los dos cuadros vecinos.

const NB = 32, NW = 64, TAU = Math.PI * 2;
const MODES = ['Columnas de cristal', 'Hilo de luz', 'Corona pulsante', 'Túnel espejo', 'Chispas', 'Cordillera'];
const BG = '#04060a';
const MAXP = 420;          // partículas como máximo
const MAX_FRAMES = 90;     // ~3 s de espectro guardado (alcanza para 600 ms de retardo con holgura)
const BUCKETS = 8;         // colores de partícula por cuadro (agrupar evita cambiar fillStyle 400 veces)

const hsl = (h, s, l, a = 1) => `hsla(${(((h % 360) + 360) % 360) | 0},${s}%,${l}%,${a})`;
const clampMode = i => ((Math.round(i) % MODES.length) + MODES.length) % MODES.length;

export class Visualizer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{scale?:number, fpsCap?:number, delayMs?:number, mode?:number, onmode?:(i:number,name:string)=>void}} opts
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.scale = opts.scale ?? 0.5;
    this.fpsCap = opts.fpsCap ?? 30;
    this.delayMs = opts.delayMs ?? 200;
    this.onmode = opts.onmode || null;
    this.modes = MODES.slice();
    this.mode = clampMode(opts.mode ?? 0);

    this.frames = [];                       // [{t, b:Uint8Array(32), w:Uint8Array(64)}] en orden de llegada
    this.raw = new Float32Array(NB);        // bandas del cuadro retrasado (interpoladas), 0..1
    this.rawWave = new Float32Array(NW);    // onda del cuadro retrasado, -1..1
    this.bands = new Float32Array(NB);      // bandas suavizadas que se dibujan (también las lee la página)
    this.wave = new Float32Array(NW);
    this.peaks = new Float32Array(NB);      // picos de las columnas (en px internos)
    this.peakV = new Float32Array(NB);
    this.idle = 1;                          // 1 = sin datos (animación de reposo), 0 = música
    this.bass = 0; this.bassAvg = 0.2; this.beat = 0; this.lastBeat = 0;
    this.hue = 200; this.spin = 0;
    this.hasData = false;
    this.stats = { frames: 0, drawMs: 0 };

    // búfer auxiliar para los modos con retroalimentación / desplazamiento
    this.buf = document.createElement('canvas');
    this.bctx = this.buf.getContext('2d', { alpha: false });

    // partículas
    this.px = new Float32Array(MAXP); this.py = new Float32Array(MAXP);
    this.vx = new Float32Array(MAXP); this.vy = new Float32Array(MAXP);
    this.life = new Float32Array(MAXP); this.maxLife = new Float32Array(MAXP);
    this.pcol = new Uint8Array(MAXP); this.pi = 0;
    this.shocks = [];                       // ondas expansivas de los golpes: [{r, a}]

    this.W = 0; this.H = 0;
    this._raf = 0; this._running = false; this._last = 0; this._next = 0; this._clear = true;
    this._loop = this._loop.bind(this);
    this._onVis = () => {
      if (document.hidden) { cancelAnimationFrame(this._raf); this._raf = 0; }
      else if (this._running && !this._raf) { this._last = 0; this._raf = requestAnimationFrame(this._loop); }
    };
    document.addEventListener('visibilitychange', this._onVis);
    this._onResize = () => this.resize();
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(this._onResize);
      this._ro.observe(canvas);
    } else window.addEventListener('resize', this._onResize);
    this.resize();
  }

  get modeName() { return this.modes[this.mode]; }

  setMode(i) {
    this.mode = clampMode(i);
    this._clear = true;
    if (this.onmode) this.onmode(this.mode, this.modeName);
  }
  next() { this.setMode(this.mode + 1); }
  prev() { this.setMode(this.mode - 1); }

  /** Recibe el binario de 97 bytes del teléfono. Devuelve false si no es un cuadro de espectro. */
  feed(data) {
    const u = data instanceof ArrayBuffer ? new Uint8Array(data)
      : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    if (!u || u.length < 1 + NB + NW || u[0] !== 0x46) return false;
    this.frames.push({ t: performance.now(), b: u.slice(1, 1 + NB), w: u.slice(1 + NB, 1 + NB + NW) });
    if (this.frames.length > MAX_FRAMES) this.frames.shift();
    return true;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.resize();
    if (!document.hidden) { this._last = 0; this._raf = requestAnimationFrame(this._loop); }
  }

  stop() {
    this._running = false;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  destroy() {
    this.stop();
    document.removeEventListener('visibilitychange', this._onVis);
    if (this._ro) this._ro.disconnect(); else window.removeEventListener('resize', this._onResize);
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(16, Math.round((r.width || this.canvas.clientWidth || 320) * this.scale));
    const h = Math.max(16, Math.round((r.height || this.canvas.clientHeight || 180) * this.scale));
    if (w === this.W && h === this.H) return;
    this.W = this.canvas.width = this.buf.width = w;
    this.H = this.canvas.height = this.buf.height = h;
    this._clear = true;
    this.peaks.fill(0);
  }

  // ---------------------------------------------------------------- ciclo

  _loop(now) {
    this._raf = requestAnimationFrame(this._loop);
    const minDt = 1000 / this.fpsCap;
    if (this._last && now - this._next < -2) return;
    const dt = this._last ? Math.min(120, now - this._last) : minDt;
    // el siguiente cuadro toca minDt después del que *debía* ser este (así el promedio se acerca al tope
    // aunque requestAnimationFrame no sea múltiplo exacto); si nos atrasamos mucho, se reinicia
    this._next = this._last && now - this._next < minDt ? this._next + minDt : now + minDt;
    this._last = now;
    const t0 = performance.now();
    this._update(now, dt);
    this._draw(now, dt);
    this.stats.frames++;
    this.stats.drawMs += performance.now() - t0;
  }

  _update(now, dt) {
    const f = this.frames, target = now - this.delayMs;
    // f[0] queda como el último cuadro con llegada <= ahora - retardo
    while (f.length > 1 && f[1].t <= target) f.shift();
    const raw = this.raw, rw = this.rawWave;
    let fresh = false;
    if (f.length && f[0].t <= target && target - f[0].t < 300) {
      fresh = true;
      const a = f[0], b = f[1];
      const k = b && b.t - a.t < 200 ? (target - a.t) / (b.t - a.t) : 0;
      for (let i = 0; i < NB; i++) raw[i] = (b ? a.b[i] + (b.b[i] - a.b[i]) * k : a.b[i]) / 255;
      for (let i = 0; i < NW; i++) rw[i] = ((b ? a.w[i] + (b.w[i] - a.w[i]) * k : a.w[i]) - 128) / 128;
    } else {
      const d = Math.exp(-dt / 120);
      for (let i = 0; i < NB; i++) raw[i] *= d;
      for (let i = 0; i < NW; i++) rw[i] *= d;
    }
    this.hasData = fresh;
    this.idle += ((fresh ? 0 : 1) - this.idle) * (1 - Math.exp(-dt / (fresh ? 250 : 900)));

    // mezcla con la animación de reposo y suavizado (sube rápido, baja lento)
    const t = now * 0.001, idle = this.idle;
    const att = 1 - Math.exp(-dt / 35), rel = 1 - Math.exp(-dt / 170), wk = 1 - Math.exp(-dt / 28);
    for (let i = 0; i < NB; i++) {
      const iv = (0.17 + 0.1 * Math.sin(t * 1.3 + i * 0.37) + 0.07 * Math.sin(t * 2.1 - i * 0.71)) * (1 - i / NB * 0.45);
      const v = raw[i] * (1 - idle) + iv * idle;
      const s = this.bands[i];
      this.bands[i] = s + (v - s) * (v > s ? att : rel);
    }
    for (let i = 0; i < NW; i++) {
      const x = i / NW * TAU;
      const iv = 0.3 * Math.sin(x * 2 + t * 2.2) * Math.sin(t * 0.7 + 1) + 0.1 * Math.sin(x * 5 - t * 3.1);
      const v = rw[i] * (1 - idle) + iv * idle;
      this.wave[i] += (v - this.wave[i]) * wk;
    }

    // graves y detección de golpes (energía de graves contra su promedio móvil)
    const rb = (raw[0] + raw[1] + raw[2] + raw[3]) / 4;
    const b4 = (this.bands[0] + this.bands[1] + this.bands[2] + this.bands[3]) / 4;
    this.bass += (b4 - this.bass) * (1 - Math.exp(-dt / 60));
    this.bassAvg += (rb - this.bassAvg) * (1 - Math.exp(-dt / 900));
    if (fresh && rb > this.bassAvg * 1.25 + 0.07 && now - this.lastBeat > 260) this._onBeat(now, Math.min(1, rb));
    else if (idle > 0.8 && now - this.lastBeat > 2600) this._onBeat(now, 0.3);   // latido suave en reposo
    this.beat *= Math.exp(-dt / 180);

    // paleta: da la vuelta completa en ~70 s; los golpes la empujan un poco
    this.hue = (this.hue + dt * 0.0052 + this.beat * dt * 0.01) % 360;
  }

  _onBeat(now, strength) {
    this.lastBeat = now;
    this.beat = Math.max(this.beat, strength);
    if (this.mode === 4) this._burst(strength);
    if (this.shocks.length < 6) this.shocks.push({ r: 0, a: 0.5 + strength * 0.5 });
  }

  // ---------------------------------------------------------------- dibujo

  _draw(now, dt) {
    const c = this.ctx;
    if (this._clear) {
      c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
      c.fillStyle = BG; c.fillRect(0, 0, this.W, this.H);
      this._clear = false;
    }
    switch (this.mode) {
      case 0: this._bars(c, dt); break;
      case 1: this._scope(c, dt); break;
      case 2: this._ring(c, dt); break;
      case 3: this._tunnel(c, dt); break;
      case 4: this._sparks(c, dt); break;
      default: this._ridge(c, dt); break;
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }

  /** Oscurece lo anterior para dejar estela. a = cuánto se borra por cuadro a 30 fps. */
  _fade(c, a, dt) {
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = Math.min(1, a * dt / 33);
    c.fillStyle = BG;
    c.fillRect(0, 0, this.W, this.H);
    c.globalAlpha = 1;
  }

  // 1) Columnas de cristal: barras segmentadas tipo LED, picos que caen y reflejo en el piso.
  _bars(c, dt) {
    const W = this.W, H = this.H, h = this.hue, b = this.bands;
    const base = Math.round(H * 0.74), top = H * 0.06;
    const g0 = c.createLinearGradient(0, 0, 0, H);
    g0.addColorStop(0, '#070a12'); g0.addColorStop(0.74, hsl(h + 200, 40, 9)); g0.addColorStop(1, '#030407');
    c.fillStyle = g0; c.fillRect(0, 0, W, H);

    const slot = W / NB, bw = Math.max(1, slot * 0.74), off = (slot - bw) / 2;
    const g = c.createLinearGradient(0, top, 0, base);
    g.addColorStop(0, hsl(h + 70, 100, 70)); g.addColorStop(0.45, hsl(h + 25, 95, 58)); g.addColorStop(1, hsl(h - 15, 90, 42));
    const gr = c.createLinearGradient(0, base, 0, H);
    gr.addColorStop(0, hsl(h - 10, 90, 45, 0.45)); gr.addColorStop(1, hsl(h - 10, 90, 45, 0));
    const span = base - top;
    const hs = [];
    for (let i = 0; i < NB; i++) hs.push(Math.max(1, Math.pow(b[i], 0.85) * span));

    c.fillStyle = g;
    for (let i = 0; i < NB; i++) c.fillRect(i * slot + off, base - hs[i], bw, hs[i]);
    c.fillStyle = gr;
    for (let i = 0; i < NB; i++) c.fillRect(i * slot + off, base + 2, bw, hs[i] * 0.42);
    // brillo de cristal en el borde izquierdo de cada barra
    c.fillStyle = 'rgba(255,255,255,0.16)';
    for (let i = 0; i < NB; i++) c.fillRect(i * slot + off, base - hs[i], Math.max(1, bw * 0.28), hs[i]);
    // segmentos: rayas horizontales del color del fondo
    const step = Math.max(3, Math.round(H / 55));
    c.fillStyle = 'rgba(4,6,10,0.72)';
    for (let y = base - step; y > top - step; y -= step) c.fillRect(0, y, W, 1);
    // picos que caen con gravedad
    const grav = H * 0.0000045;
    c.fillStyle = hsl(h + 90, 100, 88);
    for (let i = 0; i < NB; i++) {
      if (hs[i] >= this.peaks[i]) { this.peaks[i] = hs[i]; this.peakV[i] = 0; }
      else { this.peakV[i] += grav * dt; this.peaks[i] = Math.max(0, this.peaks[i] - this.peakV[i] * dt); }
      c.fillRect(i * slot + off, base - this.peaks[i] - step, bw, Math.max(1, step * 0.6));
    }
    c.fillStyle = hsl(h + 30, 100, 70, 0.55);
    c.fillRect(0, base, W, 1);
  }

  // 2) Hilo de luz: osciloscopio con estela que se desvanece y halo brillante.
  _scope(c, dt) {
    const W = this.W, H = this.H, h = this.hue, w = this.wave;
    this._fade(c, 0.24, dt);
    // retícula tenue (con la estela queda a brillo constante)
    c.fillStyle = 'rgba(80,200,255,0.035)';
    for (let i = 1; i < 8; i++) c.fillRect(Math.round(W * i / 8), 0, 1, H);
    for (let i = 1; i < 4; i++) c.fillRect(0, Math.round(H * i / 4), W, 1);

    const mid = H / 2, amp = H * 0.4 * (0.8 + this.bass * 0.5);
    c.globalCompositeOperation = 'lighter';
    const path = (k, ph) => {
      c.beginPath();
      let px = 0, py = mid + w[0] * amp * k;
      c.moveTo(px, py);
      for (let i = 1; i < NW; i++) {
        const x = i / (NW - 1) * W, y = mid + w[(i + ph) % NW] * amp * k;
        c.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
        px = x; py = y;
      }
      c.lineTo(px, py);
    };
    // eco en espejo, más tenue
    path(-0.55, 16);
    c.strokeStyle = hsl(h + 150, 90, 55, 0.35); c.lineWidth = Math.max(1, H / 140); c.stroke();
    // trazo principal: halo ancho + núcleo + filo blanco
    path(1, 0);
    c.lineJoin = 'round';
    c.strokeStyle = hsl(h, 100, 55, 0.16); c.lineWidth = Math.max(4, H / 22); c.stroke();
    c.strokeStyle = hsl(h + 20, 100, 60, 0.55); c.lineWidth = Math.max(2, H / 60); c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.7)'; c.lineWidth = Math.max(1, H / 200); c.stroke();
  }

  // 3) Corona pulsante: anillo de espectro en espejo que late con los graves y gira.
  _ring(c, dt) {
    const W = this.W, H = this.H, h = this.hue, b = this.bands, m = Math.min(W, H);
    this._fade(c, 0.3, dt);
    const cx = W / 2, cy = H / 2;
    const R = m * 0.24 * (1 + this.bass * 0.35 + this.beat * 0.1);
    this.spin += dt * (0.00022 + this.bass * 0.0016);
    const N = NB * 2;
    // halo del centro
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, R * 1.6);
    g.addColorStop(0, hsl(h + 180, 90, 60, 0.10 + this.beat * 0.25)); g.addColorStop(1, hsl(h + 180, 90, 50, 0));
    c.fillStyle = g; c.fillRect(cx - R * 1.6, cy - R * 1.6, R * 3.2, R * 3.2);

    c.globalCompositeOperation = 'lighter';
    c.beginPath();
    for (let j = 0; j <= N; j++) {
      const idx = j % N < NB ? j % N : N - 1 - (j % N);
      const r = R + Math.pow(b[idx], 0.9) * m * 0.3;
      const a = this.spin + j / N * TAU;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      j ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.closePath();
    c.fillStyle = hsl(h, 90, 50, 0.06); c.fill();
    c.strokeStyle = hsl(h + 25, 100, 62, 0.9); c.lineWidth = Math.max(1.5, m / 90); c.stroke();
    // rayos
    c.beginPath();
    for (let j = 0; j < N; j += 2) {
      const idx = j < NB ? j : N - 1 - j;
      const a = this.spin + j / N * TAU, r2 = R + Math.pow(b[idx], 0.9) * m * 0.3;
      c.moveTo(cx + Math.cos(a) * R * 0.9, cy + Math.sin(a) * R * 0.9);
      c.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
    }
    c.strokeStyle = hsl(h + 60, 100, 70, 0.35); c.lineWidth = Math.max(1, m / 160); c.stroke();
    // anillo interior con la onda, gira al revés
    c.beginPath();
    for (let j = 0; j <= NW; j++) {
      const a = -this.spin * 1.7 + j / NW * TAU, r = R * 0.62 + this.wave[j % NW] * R * 0.22;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      j ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.strokeStyle = hsl(h + 180, 100, 65, 0.8); c.lineWidth = Math.max(1, m / 130); c.stroke();
    // puntos orbitando
    c.fillStyle = hsl(h + 90, 100, 80, 0.8);
    const d = Math.max(1.5, m / 110), ro = R * 1.25 + m * 0.3 * this.bass;
    for (let j = 0; j < 24; j++) {
      const a = -this.spin * 0.6 + j / 24 * TAU;
      c.fillRect(cx + Math.cos(a) * ro - d / 2, cy + Math.sin(a) * ro - d / 2, d, d);
    }
    this._shockwaves(c, cx, cy, m, dt, h + 40);
  }

  // 4) Túnel espejo: retroalimentación (el cuadro anterior se redibuja ampliado y girado, desvaneciéndose)
  //    con una figura de caleidoscopio que nace en el centro.
  _tunnel(c, dt) {
    const W = this.W, H = this.H, h = this.hue, w = this.wave, m = Math.min(W, H);
    const cx = W / 2, cy = H / 2, k = dt / 33;
    this.bctx.globalCompositeOperation = 'copy';
    this.bctx.drawImage(this.canvas, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = BG; c.fillRect(0, 0, W, H);
    c.save();
    c.translate(cx, cy);
    c.rotate((0.012 + this.bass * 0.03) * k);
    const z = Math.pow(1.035 + this.bass * 0.035 + this.beat * 0.02, k);
    c.scale(z, z);
    c.translate(-cx, -cy);
    c.globalAlpha = Math.pow(0.9, k);
    c.drawImage(this.buf, 0, 0);
    c.restore();
    c.globalAlpha = 1;

    // caleidoscopio: 8 gajos en espejo hechos con la onda
    this.spin += dt * 0.0004;
    const n = 8, r0 = m * 0.03, r1 = m * (0.14 + this.bass * 0.22);
    c.globalCompositeOperation = 'lighter';
    c.beginPath();
    for (let s = 0; s < n; s++) {
      const base = this.spin + s / n * TAU;
      for (let mir = -1; mir <= 1; mir += 2) {
        for (let q = 0; q <= 15; q++) {
          const r = r0 + q / 15 * (r1 - r0);
          const a = base + mir * (0.1 + w[q * 4] * 0.35);
          const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
          q ? c.lineTo(x, y) : c.moveTo(x, y);
        }
      }
    }
    c.strokeStyle = hsl(h + Math.sin(this.spin * 3) * 40, 100, 62, 0.85);
    c.lineWidth = Math.max(1, m / 120); c.stroke();
    // pétalos de color en los agudos
    const tre = (this.bands[20] + this.bands[24] + this.bands[28]) / 3;
    c.fillStyle = hsl(h + 140, 100, 65, 0.25 + tre * 0.5);
    const d = Math.max(1.5, m / 70) * (0.6 + tre);
    for (let s = 0; s < n; s++) {
      const a = -this.spin * 2 + s / n * TAU, r = r1 * 1.1;
      c.fillRect(cx + Math.cos(a) * r - d / 2, cy + Math.sin(a) * r - d / 2, d, d);
    }
    this._shockwaves(c, cx, cy, m * 0.4, dt, h + 200);
  }

  // 5) Chispas: partículas que estallan con cada golpe de graves, con estela y onda expansiva.
  _sparks(c, dt) {
    const W = this.W, H = this.H, h = this.hue, m = Math.min(W, H), s = dt / 1000;
    this._fade(c, 0.28, dt);
    // emisión continua suave según los medios
    const mids = (this.bands[10] + this.bands[14] + this.bands[18]) / 3;
    if (Math.random() < mids * 1.4 * (dt / 33)) this._spawn(W * (0.2 + Math.random() * 0.6), H, 1, m * 0.25, -Math.PI / 2, 0.5);

    // brillo central que late
    const R = m * (0.08 + this.bass * 0.18 + this.beat * 0.1);
    const g = c.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, R * 2);
    g.addColorStop(0, hsl(h + 20, 100, 70, 0.22 + this.beat * 0.3)); g.addColorStop(1, hsl(h, 100, 50, 0));
    c.fillStyle = g; c.fillRect(W / 2 - R * 2, H / 2 - R * 2, R * 4, R * 4);

    // física
    const drag = Math.pow(0.12, s), grav = m * 0.35 * s;
    const { px, py, vx, vy, life } = this;
    for (let i = 0; i < MAXP; i++) {
      if (life[i] <= 0) continue;
      life[i] -= s;
      vx[i] *= drag; vy[i] = vy[i] * drag + grav;
      px[i] += vx[i] * s; py[i] += vy[i] * s;
    }
    // dibujo agrupado por color
    c.globalCompositeOperation = 'lighter';
    const sz = Math.max(1.2, m / 75);
    for (let k = 0; k < BUCKETS; k++) {
      c.fillStyle = hsl(h + k * 16 - 40, 100, 62 + k * 3);
      for (let i = 0; i < MAXP; i++) {
        if (life[i] <= 0 || this.pcol[i] !== k) continue;
        const q = sz * (0.4 + life[i] / this.maxLife[i]);
        c.fillRect(px[i] - q / 2, py[i] - q / 2, q, q);
      }
    }
    this._shockwaves(c, W / 2, H / 2, m, dt, h + 30);
    // línea de espectro en el piso
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = hsl(h + 60, 90, 60, 0.5);
    const slot = W / NB;
    for (let i = 0; i < NB; i++) { const bh = this.bands[i] * H * 0.08; c.fillRect(i * slot, H - bh, slot - 1, bh); }
  }

  _burst(strength) {
    const W = this.W, H = this.H, m = Math.min(W, H);
    const x = W * (0.3 + Math.random() * 0.4), y = H * (0.32 + Math.random() * 0.36);
    this._spawn(x, y, Math.round(40 + strength * 70), m * (0.9 + strength * 1.6), 0, TAU);
  }

  /** n partículas desde (x,y), con rapidez ~v (px/s) en el abanico ang ± spread/2. */
  _spawn(x, y, n, v, ang, spread) {
    const color = (Math.random() * BUCKETS) | 0;
    for (let j = 0; j < n; j++) {
      const i = this.pi; this.pi = (this.pi + 1) % MAXP;
      const a = ang + (Math.random() - 0.5) * spread, sp = v * (0.25 + Math.random() * 0.75);
      this.px[i] = x; this.py[i] = y;
      this.vx[i] = Math.cos(a) * sp; this.vy[i] = Math.sin(a) * sp;
      this.maxLife[i] = this.life[i] = 0.8 + Math.random() * 1.1;
      this.pcol[i] = (color + (Math.random() * 3 | 0)) % BUCKETS;
    }
  }

  _shockwaves(c, cx, cy, m, dt, hue) {
    if (!this.shocks.length) return;
    c.globalCompositeOperation = 'lighter';
    c.lineWidth = Math.max(1, m / 110);
    for (const s of this.shocks) {
      s.r += dt * m * 0.0012; s.a *= Math.exp(-dt / 260);
      c.strokeStyle = hsl(hue, 100, 70, s.a * 0.6);
      c.beginPath(); c.arc(cx, cy, m * 0.1 + s.r, 0, TAU); c.stroke();
    }
    this.shocks = this.shocks.filter(s => s.a > 0.03);
  }

  // 6) Cordillera: los últimos espectros en perspectiva, como montañas que se alejan hacia un horizonte con sol
  //    (graves al centro, agudos a los lados). Cada fila tapa a las de atrás.
  _ridge(c, dt) {
    const W = this.W, H = this.H, h = this.hue, ROWS = 22, STEP = 70;
    if (!this.hist) { this.hist = []; for (let r = 0; r < ROWS; r++) this.hist.push(new Float32Array(NB)); this.histAcc = 0; }
    const hist = this.hist;
    this.histAcc += dt;
    while (this.histAcc >= STEP) { this.histAcc -= STEP; const a = hist.pop(); a.set(this.bands); hist.unshift(a); }
    const frac = this.histAcc / STEP, hz = H * 0.3, cx = W / 2;

    const sky = c.createLinearGradient(0, 0, 0, hz);
    sky.addColorStop(0, '#020309'); sky.addColorStop(1, hsl(h + 210, 70, 14));
    c.fillStyle = sky; c.fillRect(0, 0, W, hz + 1);
    c.fillStyle = BG; c.fillRect(0, hz, W, H - hz);
    // sol que late con los graves
    const R = H * (0.17 + this.bass * 0.05);
    const sun = c.createLinearGradient(0, hz - R, 0, hz);
    sun.addColorStop(0, hsl(h + 50, 100, 70)); sun.addColorStop(1, hsl(h - 10, 100, 50));
    c.save();
    c.beginPath(); c.arc(cx, hz, R, Math.PI, 0); c.closePath();
    c.fillStyle = sun; c.fill();
    c.clip();
    c.fillStyle = hsl(h + 210, 60, 10);
    for (let k = 1; k < 5; k++) c.fillRect(cx - R, hz - k * R / 5, R * 2, Math.max(1, R / 22 * (5 - k)));
    c.restore();

    const lw = Math.max(1, H / 200);
    for (let r = ROWS - 1; r >= 0; r--) {
      const z = (r + frac) / ROWS, near = 1 - z;
      const y = hz + (H * 1.04 - hz) * Math.pow(near, 1.8);
      const half = W * (0.16 + 0.64 * near), amp = H * 0.5 * (0.2 + 0.8 * near);
      const row = hist[r];
      c.beginPath();
      c.moveTo(cx - half, y);
      for (let k = -(NB - 1); k < NB; k++) {
        const v = row[k < 0 ? -k : k];
        c.lineTo(cx + k / (NB - 1) * half, y - v * v * amp * 1.4);
      }
      c.lineTo(cx + half, y);
      c.closePath();
      c.fillStyle = BG; c.fill();
      c.strokeStyle = hsl(h + 180 + z * 80, 100, 62 - z * 28, 1 - z * 0.55);
      c.lineWidth = lw * (1 + near); c.stroke();
    }
  }
}
