// Gráfica en tiempo real (varias series, cada una con su propia escala).

export const SERIES_COLORS = ['#ff2d55', '#facc15', '#a855f7', '#22c55e', '#f97316', '#f472b6', '#e5e7eb', '#38bdf8'];

export class LiveChart {
  constructor(canvas, { windowSec = 60 } = {}) {
    this.c = canvas;
    this.windowSec = windowSec;
    this.series = new Map(); // key -> {label, unit, color, min, max, data:[[t,v]]}
    this.paused = false;
    const loop = () => {
      requestAnimationFrame(loop);
      try { this.draw(); } catch (e) { console.warn('Error dibujando gráfica', e); }
    };
    requestAnimationFrame(loop);
  }

  setSeries(list) {
    const next = new Map();
    list.forEach((s, i) => {
      const prev = this.series.get(s.key);
      next.set(s.key, { ...s, color: SERIES_COLORS[i % SERIES_COLORS.length], data: prev?.data || [] });
    });
    this.series = next;
  }

  push(key, value, t = performance.now()) {
    const s = this.series.get(key);
    if (!s || typeof value !== 'number' || Number.isNaN(value)) return;
    s.data.push([t, value]);
    const cutoff = t - this.windowSec * 1000 * 1.1;
    while (s.data.length && s.data[0][0] < cutoff) s.data.shift();
  }

  clear() {
    for (const s of this.series.values()) s.data = [];
  }

  draw() {
    const c = this.c;
    if (this.paused || c.offsetParent === null) return;
    const dpr = window.devicePixelRatio || 1;
    const r = c.getBoundingClientRect();
    if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) {
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = r.width, H = r.height;
    const css = getComputedStyle(document.documentElement);
    const grid = css.getPropertyValue('--chart-grid').trim() || '#1f2732';
    const muted = css.getPropertyValue('--muted').trim() || '#7d8a99';
    g.clearRect(0, 0, W, H);

    const pad = { l: 8, r: 8, t: 8, b: 22 };
    const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    g.strokeStyle = grid;
    g.lineWidth = 1;
    g.fillStyle = muted;
    g.font = '11px system-ui, "Segoe UI", sans-serif';
    g.textAlign = 'center';
    for (let i = 0; i <= 6; i++) {
      const x = pad.l + (pw * i) / 6;
      g.beginPath(); g.moveTo(x, pad.t); g.lineTo(x, pad.t + ph); g.stroke();
      g.fillText(`-${Math.round(this.windowSec - (this.windowSec * i) / 6)}s`, x, H - 6);
    }
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (ph * i) / 4;
      g.beginPath(); g.moveTo(pad.l, y); g.lineTo(pad.l + pw, y); g.stroke();
    }

    const now = performance.now();
    const t0 = now - this.windowSec * 1000;
    for (const s of this.series.values()) {
      if (s.data.length < 2) continue;
      // escala automática si los datos salen del rango configurado
      let lo = s.min, hi = s.max;
      for (const [, v] of s.data) { if (v < lo) lo = v; if (v > hi) hi = v; }
      const span = hi - lo || 1;
      g.beginPath();
      let first = true;
      for (const [t, v] of s.data) {
        if (t < t0) continue;
        const x = pad.l + ((t - t0) / (this.windowSec * 1000)) * pw;
        const y = pad.t + ph - ((v - lo) / span) * ph;
        if (first) { g.moveTo(x, y); first = false; } else g.lineTo(x, y);
      }
      g.strokeStyle = s.color;
      g.lineWidth = 2;
      g.lineJoin = 'round';
      g.stroke();
    }
  }
}
