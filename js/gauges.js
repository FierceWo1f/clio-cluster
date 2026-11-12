// Relojes analógicos en canvas con aguja suavizada.

const START = Math.PI * 0.75;  // 135°
const SWEEP = Math.PI * 1.5;   // 270°

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export class AnalogGauge {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{min:number,max:number,major:number,minor:number,label:string,unit:string,
   *          redFrom?:number,divisor?:number,decimals?:number}} opts
   */
  constructor(canvas, opts) {
    this.c = canvas;
    this.o = { divisor: 1, decimals: 0, ...opts };
    this.value = opts.min;
    this.shown = opts.min;
    this.hasData = false;
    this.bg = null;
    this.ro = new ResizeObserver(() => this._resize());
    this.ro.observe(canvas);
    this._resize();
  }

  setOptions(opts) {
    Object.assign(this.o, opts);
    this.bg = null;
  }

  set(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return;
    this.value = Math.max(this.o.min, Math.min(this.o.max, v));
    this.raw = v;
    this.hasData = true;
  }

  _resize() {
    const r = this.c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const size = Math.max(50, Math.min(r.width, r.height || r.width));
    this.size = size;
    this.c.width = Math.round(r.width * dpr);
    this.c.height = Math.round((r.height || r.width) * dpr);
    this.dpr = dpr;
    this.bg = null;
  }

  _angle(v) {
    const { min, max } = this.o;
    return START + ((v - min) / (max - min)) * SWEEP;
  }

  _drawBackground() {
    const off = document.createElement('canvas');
    off.width = this.c.width;
    off.height = this.c.height;
    const g = off.getContext('2d');
    const { min, max, major, minor, redFrom, divisor, label, unit } = this.o;
    const W = off.width / this.dpr, H = off.height / this.dpr;
    g.scale(this.dpr, this.dpr);
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 4;

    const face = g.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
    face.addColorStop(0, cssVar('--gauge-face-1', '#1a2029'));
    face.addColorStop(1, cssVar('--gauge-face-2', '#0b0e13'));
    g.fillStyle = face;
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
    g.strokeStyle = cssVar('--gauge-ring', '#2a3340');
    g.lineWidth = 2;
    g.stroke();

    // zona roja
    if (redFrom !== undefined && redFrom < max) {
      g.beginPath();
      g.arc(cx, cy, R * 0.88, this._angle(redFrom), this._angle(max));
      g.strokeStyle = cssVar('--danger', '#ff3b3b');
      g.lineWidth = R * 0.06;
      g.stroke();
    }

    const tickColor = cssVar('--gauge-tick', '#c9d3df');
    // marcas menores
    for (let v = min; v <= max + 1e-9; v += minor) {
      const a = this._angle(v);
      const isMajor = Math.abs(((v - min) / major) - Math.round((v - min) / major)) < 1e-6;
      const r1 = R * 0.92, r2 = R * (isMajor ? 0.78 : 0.85);
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      g.strokeStyle = redFrom !== undefined && v >= redFrom ? cssVar('--danger', '#ff3b3b') : tickColor;
      g.lineWidth = isMajor ? 2.5 : 1;
      g.stroke();
      if (isMajor) {
        const rt = R * 0.65;
        g.fillStyle = tickColor;
        g.font = `600 ${Math.round(R * 0.11)}px system-ui, "Segoe UI", sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(String(Math.round(v / divisor)), cx + Math.cos(a) * rt, cy + Math.sin(a) * rt);
      }
    }

    g.fillStyle = cssVar('--muted', '#7d8a99');
    g.font = `500 ${Math.round(R * 0.08)}px system-ui, "Segoe UI", sans-serif`;
    g.textAlign = 'center';
    g.fillText(label, cx, cy - R * 0.3);
    g.fillText(unit, cx, cy + R * 0.52);
    this.bg = off;
  }

  draw(dt) {
    if (!this.c.isConnected || this.c.offsetParent === null) return;
    if (this.c.width < 40 || this.c.height < 40) return; // aún sin tamaño (layout pendiente)
    if (!this.bg) this._drawBackground();
    // suavizado: la aguja se acerca al valor real
    const k = 1 - Math.exp(-dt * 10);
    this.shown += (this.value - this.shown) * k;

    const g = this.c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.c.width, this.c.height);
    g.drawImage(this.bg, 0, 0);
    g.scale(this.dpr, this.dpr);
    const W = this.c.width / this.dpr, H = this.c.height / this.dpr;
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 4;
    const a = this._angle(this.shown);
    const red = this.o.redFrom !== undefined && this.shown >= this.o.redFrom;
    const accent = red ? cssVar('--danger', '#ff3b3b') : cssVar('--accent', '#22d3ee');

    // arco de progreso
    g.beginPath();
    g.arc(cx, cy, R * 0.97, START, a);
    g.strokeStyle = accent;
    g.globalAlpha = 0.85;
    g.lineWidth = R * 0.035;
    g.stroke();
    g.globalAlpha = 1;

    // aguja
    g.save();
    g.translate(cx, cy);
    g.rotate(a);
    g.shadowColor = accent;
    g.shadowBlur = 12;
    g.beginPath();
    g.moveTo(-R * 0.12, -R * 0.025);
    g.lineTo(R * 0.86, -R * 0.006);
    g.lineTo(R * 0.86, R * 0.006);
    g.lineTo(-R * 0.12, R * 0.025);
    g.closePath();
    g.fillStyle = cssVar('--needle', '#ff7a1a');
    g.fill();
    g.restore();

    g.beginPath();
    g.arc(cx, cy, R * 0.07, 0, Math.PI * 2);
    g.fillStyle = cssVar('--gauge-ring', '#2a3340');
    g.fill();

    // lectura digital
    g.fillStyle = red ? cssVar('--danger', '#ff3b3b') : cssVar('--text', '#e8eef5');
    g.font = `700 ${Math.round(R * 0.24)}px "Segoe UI", system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const txt = this.hasData ? (this.raw ?? this.value).toFixed(this.o.decimals) : '—';
    g.fillText(txt, cx, cy + R * 0.32);
  }

  refreshTheme() {
    this.bg = null;
  }
}

/**
 * Reloj de estilo deportivo: bisel metálico, números en itálica, bandas segmentadas
 * (zona eco / rango óptimo / zona roja) y contenido central opcional.
 *
 * opts extra:
 *   bands:  [{from, to, color}]   bandas de color segmentadas sobre la escala
 *   center: 'tach' | 'value'      'tach' = velocidad digital + marcha; 'value' = lectura simple
 */
export class SportGauge extends AnalogGauge {
  constructor(canvas, opts) {
    super(canvas, { bands: [], center: 'value', ...opts });
    this.info = { speed: null, gear: '—', arrow: '', mode: '' };
  }

  setInfo(info) {
    Object.assign(this.info, info);
  }

  _geom() {
    const W = this.c.width / this.dpr, H = this.c.height / this.dpr;
    return { W, H, cx: W / 2, cy: H / 2, R: Math.min(W, H) / 2 - 6 };
  }

  _drawBackground() {
    const off = document.createElement('canvas');
    off.width = this.c.width;
    off.height = this.c.height;
    const g = off.getContext('2d');
    g.scale(this.dpr, this.dpr);
    const { cx, cy, R } = this._geom();
    const { min, max, major, minor, redFrom, divisor, label, bands, center } = this.o;
    const big = center === 'tach';
    const accent = cssVar('--accent', '#ff2d55');
    const danger = cssVar('--danger', '#ff3b3b');

    // bisel metálico
    const bezel = g.createLinearGradient(cx, cy - R, cx, cy + R);
    bezel.addColorStop(0, '#4a505c');
    bezel.addColorStop(0.5, '#1a1d23');
    bezel.addColorStop(1, '#3a3f49');
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fillStyle = bezel; g.fill();

    // anillo de color con brillo
    g.save();
    g.shadowColor = accent; g.shadowBlur = R * 0.08;
    g.beginPath(); g.arc(cx, cy, R * 0.955, 0, Math.PI * 2);
    g.strokeStyle = accent; g.lineWidth = Math.max(1.5, R * 0.012); g.stroke();
    g.restore();

    // carátula
    const face = g.createRadialGradient(cx, cy - R * 0.2, R * 0.05, cx, cy, R * 0.94);
    face.addColorStop(0, '#22262e');
    face.addColorStop(0.7, '#101216');
    face.addColorStop(1, '#060709');
    g.beginPath(); g.arc(cx, cy, R * 0.94, 0, Math.PI * 2);
    g.fillStyle = face; g.fill();

    // textura sutil de líneas (look fibra de carbono)
    g.save();
    g.beginPath(); g.arc(cx, cy, R * 0.94, 0, Math.PI * 2); g.clip();
    g.strokeStyle = 'rgba(255,255,255,0.025)'; g.lineWidth = 1;
    for (let x = -R; x < R * 2; x += 6) {
      g.beginPath(); g.moveTo(cx - R + x, cy - R); g.lineTo(cx - R + x - R, cy + R); g.stroke();
    }
    g.restore();

    // bandas segmentadas (eco / óptimo)
    const bandR = R * 0.84, bandW = R * (big ? 0.06 : 0.08);
    const drawSegments = (from, to, color, alpha = 1) => {
      const a0 = this._angle(Math.max(min, from)), a1 = this._angle(Math.min(max, to));
      const seg = (Math.PI / 180) * (big ? 4 : 7), gap = (Math.PI / 180) * 1.2;
      g.save();
      g.globalAlpha = alpha;
      g.strokeStyle = color; g.lineWidth = bandW;
      g.shadowColor = color; g.shadowBlur = R * 0.04;
      for (let a = a0; a < a1 - 0.001; a += seg + gap) {
        g.beginPath(); g.arc(cx, cy, bandR, a, Math.min(a + seg, a1)); g.stroke();
      }
      g.restore();
    };
    for (const b of bands) drawSegments(b.from, b.to, b.color, b.alpha ?? 1);
    if (redFrom !== undefined && redFrom < max) drawSegments(redFrom, max, danger);

    // marcas
    const tick = cssVar('--gauge-tick', '#e5e7eb');
    for (let v = min; v <= max + 1e-9; v += minor) {
      const a = this._angle(v);
      const isMajor = Math.abs((v - min) / major - Math.round((v - min) / major)) < 1e-6;
      const r1 = R * 0.79, r2 = R * (isMajor ? 0.67 : 0.74);
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      g.strokeStyle = redFrom !== undefined && v >= redFrom ? danger : isMajor ? tick : '#6b7280';
      g.lineWidth = isMajor ? Math.max(2, R * 0.022) : Math.max(1, R * 0.008);
      g.lineCap = 'round';
      g.stroke();
      if (isMajor) {
        const rt = R * (big ? 0.55 : 0.5);
        g.fillStyle = redFrom !== undefined && v >= redFrom ? danger : tick;
        g.font = `italic 800 ${Math.round(R * (this.o.numSize ?? (big ? 0.14 : 0.17)))}px "Segoe UI", system-ui, sans-serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(Math.round(v / divisor)), cx + Math.cos(a) * rt, cy + Math.sin(a) * rt);
      }
    }

    if (big && this.o.speedPanel !== false) {
      // panel inferior para la velocidad digital
      const pw = R * 0.66, ph = R * 0.4, px = cx - pw / 2, py = cy + R * 0.2;
      g.save();
      g.beginPath();
      g.moveTo(px + ph * 0.35, py);
      g.lineTo(px + pw, py);
      g.lineTo(px + pw - ph * 0.35, py + ph);
      g.lineTo(px, py + ph);
      g.closePath();
      g.fillStyle = 'rgba(0,0,0,0.75)'; g.fill();
      g.strokeStyle = accent; g.globalAlpha = 0.6; g.lineWidth = 1.5; g.stroke();
      g.restore();
    } else if (!big) {
      g.fillStyle = '#9ca3af';
      g.font = `700 ${Math.round(R * 0.1)}px "Segoe UI", system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(label, cx, cy + R * 0.2);
    }
    this.bg = off;
  }

  draw(dt) {
    if (!this.c.isConnected || this.c.offsetParent === null) return;
    if (this.c.width < 40 || this.c.height < 40) return;
    if (!this.bg) this._drawBackground();
    this.shown += (this.value - this.shown) * (1 - Math.exp(-dt * 12));

    const g = this.c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.c.width, this.c.height);
    g.drawImage(this.bg, 0, 0);
    g.scale(this.dpr, this.dpr);
    const { cx, cy, R } = this._geom();
    const big = this.o.center === 'tach';
    const accent = cssVar('--accent', '#ff2d55');
    const danger = cssVar('--danger', '#ff3b3b');
    const a = this._angle(this.shown);
    const inRed = this.o.redFrom !== undefined && this.shown >= this.o.redFrom;
    const col = inRed ? danger : accent;

    // arco de progreso
    g.save();
    g.beginPath();
    g.arc(cx, cy, R * 0.905, START, a);
    g.strokeStyle = col; g.lineWidth = R * (big ? 0.035 : 0.05);
    g.shadowColor = col; g.shadowBlur = R * 0.1;
    g.stroke();
    g.restore();

    const font = (w, s, it = true) => `${it ? 'italic ' : ''}${w} ${Math.round(R * s)}px "Segoe UI", system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';

    if (big) {
      const { speed, gear, arrow, mode, modeColor } = this.info;
      // marcha + flecha de cambio sugerido
      const arrowCh = arrow === 'up' ? '▲' : arrow === 'down' ? '▼' : '';
      g.fillStyle = arrow ? accent : '#e5e7eb';
      g.font = font(800, 0.2);
      const gearTxt = gear ?? '—';
      if (arrowCh) {
        g.save();
        g.shadowColor = accent; g.shadowBlur = R * 0.06;
        g.font = font(800, 0.11, false);
        g.fillText(arrowCh, cx - R * 0.14, cy - R * 0.25);
        g.restore();
        g.fillStyle = '#ffffff';
        g.font = font(800, 0.2);
        g.fillText(gearTxt, cx + R * 0.04, cy - R * 0.25);
      } else {
        g.fillStyle = '#ffffff';
        g.fillText(gearTxt, cx, cy - R * 0.25);
      }
      // modo (abajo, en el hueco sin escala)
      if (mode) {
        g.save();
        g.font = font(900, 0.08);
        g.fillStyle = modeColor || accent;
        g.shadowColor = modeColor || accent; g.shadowBlur = R * 0.05;
        g.fillText(mode, cx, cy + R * 0.83);
        g.restore();
      }
      if (this.o.speedPanel === false) {
        // diseño clásico: la velocidad va en otro reloj; aquí RPM digitales grandes
        g.save();
        g.fillStyle = inRed ? danger : '#ffffff';
        g.shadowColor = col; g.shadowBlur = R * 0.05;
        g.font = font(800, 0.17);
        g.fillText(this.hasData ? String(Math.round(this.raw ?? this.value)) : '—', cx, cy + R * 0.4);
        g.restore();
        g.fillStyle = '#9ca3af';
        g.font = font(700, 0.07);
        g.fillText('RPM', cx, cy + R * 0.58);
      } else {
      // velocidad digital
      g.save();
      g.fillStyle = '#ffffff';
      g.shadowColor = accent; g.shadowBlur = R * 0.05;
      g.font = font(800, 0.24);
      g.fillText(speed === null || speed === undefined ? '—' : String(Math.round(speed)), cx + R * 0.02, cy + R * 0.37);
      g.restore();
      g.fillStyle = '#d1d5db';
      g.font = font(700, 0.065);
      g.fillText('KM/H', cx + R * 0.02, cy + R * 0.54);
      // rpm digitales pequeñas
      g.fillStyle = inRed ? danger : '#9ca3af';
      g.font = font(700, 0.07, false);
      g.fillText(this.hasData ? `${Math.round(this.raw ?? this.value)} RPM` : '— RPM', cx, cy + R * 0.7);
      }
    } else {
      g.fillStyle = inRed ? danger : '#ffffff';
      g.font = font(800, 0.2);
      const txt = this.hasData ? (this.raw ?? this.value).toFixed(this.o.decimals) : '—';
      g.fillText(txt, cx, cy + R * 0.45);
      g.fillStyle = '#9ca3af';
      g.font = font(600, 0.085, false);
      g.fillText(this.o.unit, cx, cy + R * 0.66);
    }

    // aguja
    g.save();
    g.translate(cx, cy);
    g.rotate(a);
    g.shadowColor = col; g.shadowBlur = R * 0.06;
    const len = R * 0.82, base = R * (big ? 0.03 : 0.045);
    const grad = g.createLinearGradient(-R * 0.15, 0, len, 0);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.35, col);
    grad.addColorStop(1, col);
    g.beginPath();
    g.moveTo(-R * 0.15, -base * 0.7);
    g.lineTo(len, -R * 0.006);
    g.lineTo(len + R * 0.02, 0);
    g.lineTo(len, R * 0.006);
    g.lineTo(-R * 0.15, base * 0.7);
    g.closePath();
    g.fillStyle = grad; g.fill();
    g.restore();

    // centro
    const hub = g.createRadialGradient(cx - R * 0.02, cy - R * 0.02, 1, cx, cy, R * 0.09);
    hub.addColorStop(0, '#5b616d'); hub.addColorStop(1, '#14161b');
    g.beginPath(); g.arc(cx, cy, R * (big ? 0.075 : 0.1), 0, Math.PI * 2);
    g.fillStyle = hub; g.fill();
    g.strokeStyle = col; g.lineWidth = 1.5; g.stroke();
  }
}

/** Bucle de animación compartido por todos los relojes. */
export class GaugeAnimator {
  constructor() {
    this.items = new Set();
    this.last = performance.now();
    const loop = t => {
      requestAnimationFrame(loop);
      const dt = Math.min(0.1, (t - this.last) / 1000);
      this.last = t;
      for (const it of this.items) {
        try { it.draw(dt); } catch (e) { console.warn('Error dibujando reloj', e); }
      }
    };
    requestAnimationFrame(loop);
  }
  add(g) { this.items.add(g); return g; }
}
