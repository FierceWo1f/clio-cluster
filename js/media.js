// Reproductor de música del teléfono. La música suena aquí y sale por Bluetooth al estéreo;
// al estéreo le mandamos pista, estado, cola y el espectro de audio. Contrato: docs/PROTOCOLO.md
import { readTags } from './id3.js';
import { findLyrics } from './lyrics.js';

const PREFS_KEY = 'clio.music';
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|opus|flac|wav)$/i;
const ROW_H = 58;            // alto de cada fila de la lista (px), para la lista virtual
const QUEUE_MAX = 500;       // elementos de la cola que viajan al estéreo
const BANDS = 32, WAVE = 64; // binario del espectro: 1 + 32 + 64 = 97 bytes
const F_LO = 40, F_HI = 16000;
const DUCK_LEVEL = 0.25;

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const fmt = s => {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  s = Math.floor(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** "Artista - Título" en el nombre del archivo → {artist, title}. */
function splitName(name) {
  const clean = String(name).replace(/^\d{1,3}[\s._-]+(?=\D)/, '').replace(/_/g, ' ').trim();
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(clean);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { title: clean };
}

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zM9.5 12 18 18V6z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24"><path d="M10.6 9.2 5.4 4 4 5.4l5.2 5.2zM14.5 4l2 2L4 18.6 5.4 20 18 7.5l2 2V4zm.3 9.4-1.4 1.4 3.1 3.1-2 2H20v-5.5l-2 2z"/></svg>',
  repeat: '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z"/></svg>',
  vol: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M12 3v10.6A4 4 0 1 0 14 17V7h4V3z"/></svg>',
};

const CSS = `
.mus { display: grid; gap: 14px; max-width: 760px; margin: 0 auto; }
.mus svg { width: 26px; height: 26px; fill: currentColor; display: block; }
.mus-now { display: grid; grid-template-columns: 112px 1fr; gap: 14px; align-items: center; }
.mus-cover { width: 112px; height: 112px; border-radius: 10px; background: var(--panel-2, #161c25);
  display: grid; place-items: center; overflow: hidden; color: var(--muted, #7d8a99); }
.mus-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mus-cover svg { width: 48px; height: 48px; }
.mus-meta { min-width: 0; }
.mus-title { font-size: 19px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mus-artist { color: var(--muted, #7d8a99); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mus-extra { font-size: 12px; color: var(--muted, #7d8a99); margin-top: 4px; min-height: 1.2em; }
.mus-seek { grid-column: 1 / -1; display: grid; grid-template-columns: 46px 1fr 46px; gap: 8px; align-items: center;
  font-size: 13px; color: var(--muted, #7d8a99); }
.mus-seek span:last-child { text-align: right; }
.mus input[type=range] { width: 100%; height: 34px; accent-color: var(--accent, #ff2d55); margin: 0; }
.mus-ctrls { grid-column: 1 / -1; display: flex; justify-content: center; align-items: center; gap: 12px; }
.mus-ctrls .btn { width: 58px; height: 58px; padding: 0; display: grid; place-items: center; border-radius: 50%; position: relative; }
.mus-ctrls .mus-play { width: 74px; height: 74px; }
.mus-ctrls .mus-play svg { width: 36px; height: 36px; }
.mus-ctrls .btn.mus-on { color: var(--accent, #ff2d55); border-color: var(--accent, #ff2d55); }
.mus-ctrls .mus-one::after { content: '1'; position: absolute; right: 9px; bottom: 7px; font-size: 11px; font-weight: 700; }
.mus-vol { grid-column: 1 / -1; display: grid; grid-template-columns: 30px 1fr; gap: 8px; align-items: center; color: var(--muted, #7d8a99); }
.mus-src .mus-srcbtns { display: flex; gap: 10px; flex-wrap: wrap; }
.mus-src .btn { min-height: 48px; padding: 10px 16px; font-size: 15px; flex: 1 1 180px; text-align: center; }
.mus-src .btn.mus-on { border-color: var(--accent, #ff2d55); color: var(--text, #fff); box-shadow: inset 0 -3px 0 var(--accent, #ff2d55); }
.mus-msg { margin-top: 10px; color: var(--muted, #7d8a99); font-size: 13px; white-space: pre-line; }
.mus-msg:empty { display: none; }
.mus-msg code { background: var(--panel-2, #161c25); padding: 1px 6px; border-radius: 5px; color: var(--text, #fff); }
.mus-filter { width: 100%; min-height: 48px; font-size: 16px; padding: 10px 14px; border-radius: 10px;
  background: var(--panel, #10151c); border: 1px solid var(--border, #232c38); color: inherit; }
.mus-count { font-size: 12px; color: var(--muted, #7d8a99); margin: -6px 2px 0; }
.mus-list { position: relative; height: min(62vh, 640px); overflow-y: auto; border-radius: 12px;
  border: 1px solid var(--border, #232c38); background: var(--panel, #10151c); -webkit-overflow-scrolling: touch; }
.mus-list:empty::before { content: 'Sin canciones'; display: block; padding: 18px; color: var(--muted, #7d8a99); text-align: center; }
.mus-row { position: absolute; left: 0; right: 0; height: ${ROW_H}px; padding: 8px 14px; cursor: pointer;
  border-bottom: 1px solid var(--border, #232c38); display: flex; flex-direction: column; justify-content: center; }
.mus-row:active { background: var(--panel-2, #161c25); }
.mus-row b { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mus-row small { color: var(--muted, #7d8a99); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mus-row.mus-cur b { color: var(--accent, #ff2d55); font-weight: 700; }
@media (max-width: 420px) {
  .mus-now { grid-template-columns: 84px 1fr; }
  .mus-cover { width: 84px; height: 84px; }
  .mus-ctrls { gap: 8px; }
  .mus-ctrls .btn { width: 52px; height: 52px; }
  .mus-ctrls .mus-play { width: 68px; height: 68px; }
}`;

function injectCss() {
  if (document.getElementById('mus-css')) return;
  const st = document.createElement('style');
  st.id = 'mus-css';
  st.textContent = CSS;
  document.head.appendChild(st);
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Reduce una imagen (Blob) a ≤ max px y la regresa como data URL JPEG. */
async function coverDataUrl(blob, max = 256) {
  if (!blob || !blob.size) return null;
  let src, w, h, url;
  try {
    if (typeof createImageBitmap === 'function') {
      src = await createImageBitmap(blob);
      w = src.width; h = src.height;
    } else {
      url = URL.createObjectURL(blob);
      src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      w = src.naturalWidth; h = src.naturalHeight;
    }
    if (!w || !h) return null;
    const k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82);
  } catch {
    return null;
  } finally {
    if (src && src.close) src.close();
    if (url) URL.revokeObjectURL(url);
  }
}

export class MusicPlayer {
  constructor(ctx = {}) {
    this.ctx = ctx;
    this.el = null;
    this.ui = {};
    this.source = 'hub';       // 'hub' | 'files'
    this.lib = [];             // canciones de la fuente actual
    this.view = [];            // lib filtrada (lo que se ve en la lista)
    this.filter = '';
    this.queue = [];           // cola de reproducción (lista de canciones)
    this.order = [];           // orden de reproducción (índices de queue), aleatorio si shuffle
    this.opos = -1;            // posición actual dentro de order
    this.cur = -1;             // índice en queue de la canción actual
    this.trackId = 0;
    this.meta = null;          // {title, artist, album, cover, dur, lyrics, plain}
    this.errors = 0;
    this.duckOn = false;
    this.duckK = 1;            // factor actual de "duck" (1 = normal)
    this.hubMsg = '';
    this.objectUrls = [];

    const p = this._loadPrefs();
    this.vol = Number.isFinite(p.vol) ? Math.min(1, Math.max(0, p.vol)) : 0.9;
    this.shuffle = !!p.shuffle;
    this.repeat = ['off', 'all', 'one'].includes(p.repeat) ? p.repeat : 'off';
    this.last = p.last || null; // {url, pos} última canción de la fuente del hub

    // Audio
    const a = new Audio();
    a.preload = 'auto';
    this.audio = a;
    this.ac = null;            // AudioContext (se crea/reanuda con un gesto del usuario)
    this.graph = null;         // {src, an, gain}
    this._applyVol(true);
    a.addEventListener('play', () => this._onPlayState());
    a.addEventListener('pause', () => this._onPlayState());
    a.addEventListener('ended', () => this._onEnded());
    a.addEventListener('seeked', () => this._sendPlay());
    a.addEventListener('loadedmetadata', () => this._onMeta());
    a.addEventListener('durationchange', () => this._onMeta());
    a.addEventListener('timeupdate', () => this._renderTime());
    a.addEventListener('error', () => this._onError());

    // Un gesto en la página permite arrancar/reanudar el AudioContext (política de autoplay).
    const gesture = () => { if (this.queue.length) this._ensureGraph(); };
    if (typeof document !== 'undefined') {
      document.addEventListener('pointerdown', gesture, true);
      document.addEventListener('keydown', gesture, true);
    }

    this._setupMediaSession();
    this.specTimer = null;
    this.frame = new Uint8Array(1 + BANDS + WAVE);
    this.frame[0] = 0x46;
    this.playTimer = setInterval(() => { if (!this.audio.paused) this._sendPlay(); }, 500);
    this.saveTimer = setInterval(() => this._saveLast(), 5000);

    if (this._loadPrefs().source !== 'files') this.loadHub({ restore: true });
  }

  // =====================================================================
  // Interfaz del contrato
  // =====================================================================
  mount(el) {
    injectCss();
    this.el = el;
    el.innerHTML = `
      <div class="mus">
        <div class="card mus-now">
          <div class="mus-cover"></div>
          <div class="mus-meta">
            <div class="mus-title">Nada sonando</div>
            <div class="mus-artist">Elige una canción de la lista</div>
            <div class="mus-extra"></div>
          </div>
          <div class="mus-seek"><span class="mus-pos">0:00</span>
            <input type="range" class="mus-bar" min="0" max="1000" value="0" aria-label="Avance">
            <span class="mus-dur">0:00</span></div>
          <div class="mus-ctrls">
            <button class="btn mus-shuf" title="Aleatorio" aria-label="Aleatorio">${ICON.shuffle}</button>
            <button class="btn mus-prev" title="Anterior" aria-label="Anterior">${ICON.prev}</button>
            <button class="btn primary mus-play" title="Reproducir / pausa" aria-label="Reproducir o pausar">${ICON.play}</button>
            <button class="btn mus-next" title="Siguiente" aria-label="Siguiente">${ICON.next}</button>
            <button class="btn mus-rep" title="Repetir" aria-label="Repetir">${ICON.repeat}</button>
          </div>
          <label class="mus-vol">${ICON.vol}<input type="range" class="mus-volbar" min="0" max="100" aria-label="Volumen"></label>
        </div>
        <div class="card mus-src">
          <div class="mus-srcbtns">
            <button class="btn mus-src-hub">Música del teléfono</button>
            <label class="btn mus-src-files">Elegir archivos
              <input type="file" multiple accept="audio/*" hidden></label>
          </div>
          <div class="mus-msg"></div>
        </div>
        <input type="search" class="mus-filter" placeholder="Buscar canción, artista o carpeta" autocomplete="off">
        <div class="mus-count"></div>
        <div class="mus-list"></div>
      </div>`;
    const q = s => el.querySelector(s);
    const ui = this.ui = {
      cover: q('.mus-cover'), title: q('.mus-title'), artist: q('.mus-artist'), extra: q('.mus-extra'),
      pos: q('.mus-pos'), dur: q('.mus-dur'), bar: q('.mus-bar'), play: q('.mus-play'),
      shuf: q('.mus-shuf'), rep: q('.mus-rep'), vol: q('.mus-volbar'), msg: q('.mus-msg'),
      hub: q('.mus-src-hub'), files: q('.mus-src-files'), input: q('.mus-src-files input'),
      filter: q('.mus-filter'), count: q('.mus-count'), list: q('.mus-list'),
    };
    ui.play.onclick = () => this.toggle();
    q('.mus-prev').onclick = () => this.prev();
    q('.mus-next').onclick = () => this.next();
    ui.shuf.onclick = () => this.setShuffle(!this.shuffle);
    ui.rep.onclick = () => this.setRepeat({ off: 'all', all: 'one', one: 'off' }[this.repeat]);
    ui.vol.value = Math.round(this.vol * 100);
    ui.vol.oninput = () => this.setVol(ui.vol.value / 100);
    ui.bar.addEventListener('input', () => {
      this.seeking = true;
      const d = this._dur();
      ui.pos.textContent = fmt((ui.bar.value / 1000) * d);
    });
    ui.bar.addEventListener('change', () => {
      this.seeking = false;
      this.seek((ui.bar.value / 1000) * this._dur());
    });
    ui.hub.onclick = () => this.loadHub();
    ui.input.onchange = () => { this.loadFiles(ui.input.files); ui.input.value = ''; };
    let ft;
    ui.filter.oninput = () => {
      clearTimeout(ft);
      ft = setTimeout(() => this._applyFilter(ui.filter.value), 150);
    };
    let pending = false;
    ui.list.addEventListener('scroll', () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; this._renderRows(); });
    }, { passive: true });
    ui.list.addEventListener('click', e => {
      const row = e.target.closest('.mus-row');
      if (row) this.playFromView(+row.dataset.i);
    });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this._renderRows()).observe(ui.list);
    this._applyFilter(this.filter);
    this._renderNow();
    this._renderSrc();
    this._renderModes();
  }

  command(m) {
    const v = m && m.v;
    switch (m && m.a) {
      case 'music.toggle': this.toggle(); break;
      case 'music.play': this.play(); break;
      case 'music.pause': this.pause(); break;
      case 'music.next': this.next(); break;
      case 'music.prev': this.prev(); break;
      case 'music.seek': if (Number.isFinite(+v)) this.seek(+v); break;
      case 'music.playIdx': if (Number.isInteger(+v)) this.playIdx(+v); break;
      case 'music.shuffle': this.setShuffle(!!v); break;
      case 'music.repeat': if (['off', 'all', 'one'].includes(v)) this.setRepeat(v); break;
      case 'music.vol': if (Number.isFinite(+v)) this.setVol(+v); break;
    }
  }

  resend() {
    this._sendTrack(true);
    this._sendQueue();
    this._sendPlay();
  }

  /** Baja (true) o restaura (false) el volumen, con un fade corto. Lo usa nav al hablar. */
  duck(on) {
    this.duckOn = !!on;
    const target = on ? DUCK_LEVEL : 1;
    clearInterval(this.duckTimer);
    const from = this.duckK, t0 = performance.now(), ms = on ? 250 : 600;
    this.duckTimer = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      this.duckK = from + (target - from) * k;
      this._applyVol();
      if (k >= 1) clearInterval(this.duckTimer);
    }, 30);
  }

  // =====================================================================
  // Fuentes
  // =====================================================================
  async loadHub({ restore = false } = {}) {
    this.hubMsg = 'Buscando música en el teléfono…';
    if (!restore) { this.source = 'hub'; this._savePrefs(); }
    this._renderSrc();
    let data;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch('/hub/music', { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      data = await r.json();
    } catch {
      this.hubMsg = 'No se pudo leer la música del teléfono. Abre la app desde el hub (http://localhost:8080) '
        + 'o usa "Elegir archivos".';
      if (this.source === 'hub') { this.lib = []; this._applyFilter(this.filter); }
      this._renderSrc();
      return false;
    }
    if (restore && this.source !== 'hub') return false; // mientras tanto se eligieron archivos
    this.source = 'hub';
    const files = Array.isArray(data.files) ? data.files : [];
    this.lib = files.filter(f => f && f.url).map(f => this._item({
      url: f.url, name: f.name || decodeURIComponent(f.url.split('/').pop()), dir: f.dir || '', size: f.size, lrc: f.lrc || null,
    }));
    if (!this.lib.length) {
      this.hubMsg = 'No encontré canciones en el teléfono.\n'
        + 'En Termux ejecuta <code>termux-setup-storage</code>, acepta el permiso y reinicia el hub. '
        + 'Busco en Música y Descargas (o en la carpeta <code>musica/</code> del repo).';
    } else {
      const dirs = (data.dirs || []).join(', ');
      this.hubMsg = `${this.lib.length} canciones${dirs ? ' en ' + esc(dirs) : ''}.`;
    }
    this._applyFilter(this.filter);
    this._renderSrc();
    // Recuperar la última canción (en pausa, en el mismo punto)
    if (restore && this.last && this.cur < 0) {
      const i = this.lib.findIndex(t => t.url === this.last.url);
      if (i >= 0) this._setQueue(this.lib, i, { autoplay: false, pos: this.last.pos || 0 });
    }
    return true;
  }

  loadFiles(fileList) {
    const files = [...(fileList || [])].filter(f => (f.type || '').startsWith('audio/') || AUDIO_EXT.test(f.name));
    if (!files.length) return;
    for (const u of this.objectUrls) if (!this.queue.some(t => t.url === u)) URL.revokeObjectURL(u);
    this.objectUrls = this.objectUrls.filter(u => this.queue.some(t => t.url === u));
    files.sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
    this.lib = files.map(f => {
      const url = URL.createObjectURL(f);
      this.objectUrls.push(url);
      return this._item({ url, name: f.name.replace(/\.[^.]+$/, ''), dir: 'Archivos elegidos', size: f.size, file: f });
    });
    this.source = 'files';
    this._savePrefs();
    this.hubMsg = '';
    this._applyFilter('');
    if (this.ui.filter) this.ui.filter.value = '';
    this._renderSrc();
    this._setQueue(this.lib, 0, { autoplay: true });
  }

  _item(t) {
    const guess = splitName(t.name);
    return { ...t, gTitle: guess.title || t.name, gArtist: guess.artist || '', key: fold(t.name + ' ' + t.dir) };
  }

  // =====================================================================
  // Reproducción
  // =====================================================================
  playFromView(i) {
    if (i < 0 || i >= this.view.length) return;
    this._ensureGraph();
    this._setQueue(this.view, i, { autoplay: true });
  }

  _setQueue(list, start, { autoplay = true, pos = 0 } = {}) {
    this.queue = list.slice();
    this._buildOrder(start);
    this._load(start, { autoplay, pos });
  }

  _buildOrder(first) {
    const n = this.queue.length;
    const idx = [...Array(n).keys()];
    if (this.shuffle && n > 1) {
      const rest = shuffled(idx.filter(i => i !== first));
      this.order = first >= 0 ? [first, ...rest] : rest;
      this.opos = first >= 0 ? 0 : -1;
    } else {
      this.order = idx;
      this.opos = first;
    }
  }

  playIdx(i) {
    if (i < 0 || i >= this.queue.length) return;
    if (this.shuffle) this._buildOrder(i); else this.opos = i;
    this._load(i, { autoplay: true });
  }

  _load(i, { autoplay = true, pos = 0 } = {}) {
    const t = this.queue[i];
    if (!t) return;
    this.cur = i;
    const id = ++this.trackId;
    this.meta = { title: t.title || t.gTitle, artist: t.artist || t.gArtist || '', album: t.album || '', cover: t.cover || null,
      dur: 0, lyrics: null, plain: null, lyricsState: 'buscando' };
    const a = this.audio;
    a.src = t.url;
    this.pendingPos = pos > 0;
    if (pos > 0) {
      const seekOnce = () => {
        a.removeEventListener('loadedmetadata', seekOnce);
        try { a.currentTime = pos; } catch {}
        this.pendingPos = false;
      };
      a.addEventListener('loadedmetadata', seekOnce);
    }
    if (autoplay) this.play(); else a.load();
    this._sendTrack(true);
    this._sendQueue();
    this._sendPlay();
    this._renderNow();
    this._renderRows();
    this._updateSession();
    this._saveLast();
    this._enrich(t, id);
  }

  /** Lee etiquetas y portada, y busca la letra en segundo plano. Reenvía `track` con el mismo id. */
  async _enrich(t, id) {
    const alive = () => id === this.trackId;
    if (!t.tagged) {
      const tags = await readTags(t.file || t.url);
      t.tagged = true;
      if (tags.title) t.title = tags.title;
      if (tags.artist) t.artist = tags.artist;
      if (tags.album) t.album = tags.album;
      if (tags.dur) t.tagDur = tags.dur;
      if (tags.picture) t.cover = await coverDataUrl(tags.picture);
    }
    if (!alive()) return;
    Object.assign(this.meta, {
      title: t.title || t.gTitle, artist: t.artist || t.gArtist || '', album: t.album || '', cover: t.cover || null,
    });
    if (!this.meta.dur && t.tagDur) this.meta.dur = t.tagDur;
    this._sendTrack();
    this._renderNow();
    this._updateSession();
    const lr = await findLyrics({
      title: this.meta.title, artist: this.meta.artist, album: this.meta.album,
      dur: this._dur() || t.tagDur, lrcUrl: t.lrc,
    });
    if (!alive()) return;
    this.meta.lyrics = lr.lyrics;
    this.meta.plain = lr.plain;
    this.meta.lyricsState = lr.lyrics ? 'sincronizada' : lr.plain ? 'sin tiempos' : 'no encontrada';
    this._sendTrack();
    this._renderNow();
  }

  play() {
    if (this.cur < 0) {
      const list = this.view.length ? this.view : this.lib;
      if (list.length) this._setQueue(list, this.shuffle ? Math.floor(Math.random() * list.length) : 0, { autoplay: true });
      return;
    }
    this._ensureGraph();
    const p = this.audio.play();
    if (p && p.catch) {
      p.catch(e => {
        if (e && e.name === 'NotAllowedError') this._toast('Toca la pantalla del teléfono para empezar a reproducir.');
      });
    }
  }

  pause() { this.audio.pause(); }

  toggle() {
    if (this.cur < 0 || this.audio.paused) this.play(); else this.pause();
  }

  next(auto = false) {
    if (!this.queue.length) return;
    if (auto && this.repeat === 'one') { this.seek(0); this.play(); return; }
    let p = this.opos + 1;
    if (p >= this.order.length) {
      if (this.repeat === 'off' && auto) {
        // Se acabó la cola: se queda en pausa al final.
        this._sendPlay();
        return;
      }
      if (this.shuffle && this.order.length > 1) {
        const last = this.order[this.order.length - 1];
        this.order = shuffled(this.order);
        if (this.order[0] === last) this.order.push(this.order.shift()); // no repetir la misma
      }
      p = 0;
    }
    this.opos = p;
    this._load(this.order[p], { autoplay: true });
  }

  prev() {
    if (!this.queue.length) return;
    if (this.audio.currentTime > 3) { this.seek(0); return; }
    let p = this.opos - 1;
    if (p < 0) p = this.repeat === 'off' ? 0 : this.order.length - 1;
    this.opos = p;
    this._load(this.order[p], { autoplay: true });
  }

  seek(s) {
    const d = this._dur();
    if (!Number.isFinite(s)) return;
    try { this.audio.currentTime = Math.max(0, d ? Math.min(s, d - 0.25) : s); } catch {}
    this._renderTime();
  }

  setShuffle(on) {
    this.shuffle = !!on;
    this._buildOrder(this.cur);
    this._savePrefs();
    this._renderModes();
    this._sendPlay();
  }

  setRepeat(r) {
    this.repeat = r;
    this._savePrefs();
    this._renderModes();
    this._sendPlay();
  }

  setVol(v) {
    this.vol = Math.min(1, Math.max(0, v));
    this._applyVol();
    this._savePrefs();
    if (this.ui.vol && document.activeElement !== this.ui.vol) this.ui.vol.value = Math.round(this.vol * 100);
    clearTimeout(this.volTimer);
    this.volTimer = setTimeout(() => this._sendPlay(), 60);
  }

  _dur() {
    const d = this.audio.duration;
    return Number.isFinite(d) && d > 0 ? d : (this.meta && this.meta.dur) || 0;
  }

  /** Volumen real: curva cuadrática (se siente más natural) × factor de duck. */
  _applyVol() {
    const v = this.vol * this.vol * this.duckK;
    if (this.graph) {
      this.audio.volume = 1;
      this.graph.gain.gain.setTargetAtTime(v, this.ac.currentTime, 0.02);
    } else {
      this.audio.volume = Math.min(1, Math.max(0, v));
    }
  }

  // ---------- AudioContext + analizador ----------
  _ensureGraph() {
    if (this.graph) {
      if (this.ac.state !== 'running') this.ac.resume().catch(() => {});
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!this.ac) this.ac = new AC();
      // Solo se conecta cuando el contexto corre: si se conectara suspendido, el audio quedaría mudo.
      if (this.ac.state === 'running') this._connectGraph();
      else this.ac.resume().then(() => { if (this.ac.state === 'running') this._connectGraph(); }).catch(() => {});
    } catch { /* sin Web Audio: suena igual, solo sin espectro */ }
  }

  _connectGraph() {
    if (this.graph) return;
    try {
      const ac = this.ac;
      const src = ac.createMediaElementSource(this.audio);
      const an = ac.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0.72;
      an.minDecibels = -85;
      an.maxDecibels = -15;
      const gain = ac.createGain();
      src.connect(an);
      an.connect(gain);
      gain.connect(ac.destination);
      // Bandas logarítmicas de ~40 Hz a 16 kHz, como rangos de bins del FFT.
      const binHz = ac.sampleRate / an.fftSize;
      const nb = an.frequencyBinCount;
      const edges = [];
      for (let k = 0; k <= BANDS; k++) edges.push(F_LO * Math.pow(F_HI / F_LO, k / BANDS));
      const ranges = [];
      for (let k = 0; k < BANDS; k++) {
        const lo = Math.min(nb - 1, Math.floor(edges[k] / binHz));
        const hi = Math.min(nb - 1, Math.max(lo, Math.ceil(edges[k + 1] / binHz) - 1));
        ranges.push([lo, hi]);
      }
      this.graph = { src, an, gain, ranges, freq: new Uint8Array(nb), wave: new Uint8Array(an.fftSize) };
      gain.gain.value = this.vol * this.vol * this.duckK;
      this._applyVol();
      if (!this.audio.paused) this._startSpectrum();
    } catch (e) {
      console.warn('Sin analizador de audio:', e);
    }
  }

  _startSpectrum() {
    if (this.specTimer || !this.graph) return;
    this.specTimer = setInterval(() => this._spectrumFrame(), 33);
  }

  _stopSpectrum() {
    clearInterval(this.specTimer);
    this.specTimer = null;
    // Un cuadro en cero para que el estéreo baje las barras.
    const f = this.frame;
    f.fill(0, 1, 1 + BANDS);
    f.fill(128, 1 + BANDS);
    this._pubBin();
  }

  _spectrumFrame() {
    const g = this.graph;
    if (!g) return;
    g.an.getByteFrequencyData(g.freq);
    g.an.getByteTimeDomainData(g.wave);
    const f = this.frame;
    for (let k = 0; k < BANDS; k++) {
      const [lo, hi] = g.ranges[k];
      let m = 0;
      for (let i = lo; i <= hi; i++) if (g.freq[i] > m) m = g.freq[i];
      f[1 + k] = m;
    }
    const step = Math.floor(g.wave.length / 2 / WAVE); // ~21 ms de onda
    for (let i = 0; i < WAVE; i++) f[1 + BANDS + i] = g.wave[i * step];
    this._pubBin();
  }

  _pubBin() {
    try { this.ctx.publishBinary && this.ctx.publishBinary(this.frame.buffer); } catch {}
  }

  // ---------- eventos del <audio> ----------
  _onPlayState() {
    const playing = !this.audio.paused;
    if (playing) { this.errors = 0; this._startSpectrum(); } else this._stopSpectrum();
    if (this.ui.play) this.ui.play.innerHTML = playing ? ICON.pause : ICON.play;
    try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch {}
    this._sendPlay();
    this._saveLast();
  }

  _onMeta() {
    const d = this.audio.duration;
    if (this.meta && Number.isFinite(d) && d > 0 && Math.abs(d - (this.meta.dur || 0)) > 0.5) {
      this.meta.dur = d;
      this._sendTrack();
      this._sendPlay();
    }
    this._renderTime();
  }

  _onEnded() {
    this.next(true);
  }

  _onError() {
    if (!this.audio.getAttribute('src') || this.cur < 0) return;
    const t = this.queue[this.cur];
    this._toast(`No se pudo reproducir "${t ? t.name : ''}".`, true);
    this.errors++;
    if (this.errors < Math.min(5, this.queue.length)) setTimeout(() => this.next(), 800);
  }

  // =====================================================================
  // Mensajes al estéreo
  // =====================================================================
  _pub(msg) {
    try { this.ctx.publish && this.ctx.publish(msg); } catch {}
  }

  /** Manda `track`; sin `now` se agrupan los cambios de los próximos ~80 ms en un solo mensaje. */
  _sendTrack(now = false) {
    if (!this.meta) return;
    if (!now) {
      if (this.trackTimer) return;
      this.trackTimer = setTimeout(() => { this.trackTimer = null; this._sendTrack(true); }, 80);
      return;
    }
    clearTimeout(this.trackTimer);
    this.trackTimer = null;
    const m = this.meta;
    this._pub({
      t: 'track', id: this.trackId, title: m.title, artist: m.artist || undefined, album: m.album || undefined,
      cover: m.cover || null, dur: +(this._dur() || 0).toFixed(2), lyrics: m.lyrics || null, plain: m.plain || null,
    });
  }

  _sendPlay() {
    const a = this.audio;
    this._pub({
      t: 'play', id: this.trackId, idx: this.cur, playing: !a.paused && this.cur >= 0, pos: +(a.currentTime || 0).toFixed(2),
      dur: +(this._dur() || 0).toFixed(2), shuffle: this.shuffle, repeat: this.repeat, vol: +this.vol.toFixed(3),
    });
    this._updatePosition();
  }

  _sendQueue() {
    const n = this.queue.length;
    let from = 0;
    if (n > QUEUE_MAX) from = Math.max(0, Math.min(n - QUEUE_MAX, this.cur - Math.floor(QUEUE_MAX / 2)));
    const items = [];
    for (let i = from; i < Math.min(n, from + QUEUE_MAX); i++) {
      const t = this.queue[i];
      items.push({ i, title: t.title || t.gTitle, artist: t.artist || t.gArtist || undefined });
    }
    this._pub({ t: 'queue', cur: this.cur, items });
  }

  // =====================================================================
  // Media Session (botones del volante por AVRCP / notificación de Android)
  // =====================================================================
  _setupMediaSession() {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch {} };
    set('play', () => this.play());
    set('pause', () => this.pause());
    set('previoustrack', () => this.prev());
    set('nexttrack', () => this.next());
    set('seekto', d => { if (d && Number.isFinite(d.seekTime)) this.seek(d.seekTime); });
    set('seekbackward', d => this.seek(this.audio.currentTime - ((d && d.seekOffset) || 10)));
    set('seekforward', d => this.seek(this.audio.currentTime + ((d && d.seekOffset) || 10)));
  }

  _updateSession() {
    if (!('mediaSession' in navigator) || !this.meta || typeof MediaMetadata === 'undefined') return;
    try {
      const m = this.meta;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: m.title || '', artist: m.artist || '', album: m.album || '',
        artwork: m.cover ? [{ src: m.cover, sizes: '256x256', type: 'image/jpeg' }] : [],
      });
    } catch {}
  }

  _updatePosition() {
    try {
      const d = this.audio.duration;
      if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && Number.isFinite(d) && d > 0) {
        navigator.mediaSession.setPositionState({
          duration: d, position: Math.min(d, this.audio.currentTime || 0), playbackRate: this.audio.playbackRate || 1,
        });
      }
    } catch {}
  }

  // =====================================================================
  // Interfaz del teléfono
  // =====================================================================
  _renderSrc() {
    const ui = this.ui;
    if (!ui.msg) return;
    ui.hub.classList.toggle('mus-on', this.source === 'hub');
    ui.files.classList.toggle('mus-on', this.source === 'files');
    ui.msg.innerHTML = this.source === 'hub' ? this.hubMsg
      : `${this.lib.length} archivos elegidos. Se olvidan al cerrar la app.`;
  }

  _renderModes() {
    const ui = this.ui;
    if (!ui.shuf) return;
    ui.shuf.classList.toggle('mus-on', this.shuffle);
    ui.rep.classList.toggle('mus-on', this.repeat !== 'off');
    ui.rep.classList.toggle('mus-one', this.repeat === 'one');
    ui.rep.title = { off: 'Repetir: no', all: 'Repetir: todas', one: 'Repetir: una' }[this.repeat];
    ui.shuf.title = this.shuffle ? 'Aleatorio: sí' : 'Aleatorio: no';
  }

  _renderNow() {
    const ui = this.ui;
    if (!ui.title) return;
    const m = this.meta;
    if (!m) return;
    ui.title.textContent = m.title || 'Sin título';
    ui.artist.textContent = [m.artist, m.album].filter(Boolean).join(' · ') || '—';
    ui.extra.textContent = `Letra: ${m.lyricsState || '—'}`;
    if (ui.coverSrc !== m.cover) {
      ui.coverSrc = m.cover;
      ui.cover.innerHTML = m.cover ? `<img alt="" src="${m.cover}">` : ICON.note;
    }
    ui.play.innerHTML = this.audio.paused ? ICON.play : ICON.pause;
    this._renderTime();
  }

  _renderTime() {
    const ui = this.ui;
    if (!ui.bar) return;
    const d = this._dur(), p = this.audio.currentTime || 0;
    ui.dur.textContent = fmt(d);
    if (!this.seeking) {
      ui.pos.textContent = fmt(p);
      ui.bar.value = d ? Math.round((p / d) * 1000) : 0;
    }
  }

  _applyFilter(text) {
    this.filter = text || '';
    const words = fold(this.filter).split(/\s+/).filter(Boolean);
    this.view = words.length ? this.lib.filter(t => words.every(w => t.key.includes(w))) : this.lib;
    const ui = this.ui;
    if (!ui.list) return;
    ui.count.textContent = this.lib.length
      ? (words.length ? `${this.view.length} de ${this.lib.length} canciones` : `${this.lib.length} canciones`) : '';
    ui.list.scrollTop = 0;
    ui.list.innerHTML = this.view.length ? `<div class="mus-spacer" style="height:${this.view.length * ROW_H}px"></div>` : '';
    ui.rows = new Map();
    this._renderRows();
  }

  /** Lista virtual: solo existen en el DOM las filas visibles (más un margen). */
  _renderRows() {
    const ui = this.ui;
    if (!ui.list || !ui.rows) return;
    const top = ui.list.scrollTop, h = ui.list.clientHeight || 600;
    const a = Math.max(0, Math.floor(top / ROW_H) - 8);
    const b = Math.min(this.view.length, Math.ceil((top + h) / ROW_H) + 8);
    const curUrl = this.cur >= 0 && this.queue[this.cur] ? this.queue[this.cur].url : null;
    for (const [i, row] of ui.rows) {
      if (i < a || i >= b) { row.remove(); ui.rows.delete(i); }
    }
    for (let i = a; i < b; i++) {
      const t = this.view[i];
      let row = ui.rows.get(i);
      if (!row) {
        row = document.createElement('div');
        row.className = 'mus-row';
        row.dataset.i = i;
        row.style.top = i * ROW_H + 'px';
        ui.list.appendChild(row);
        ui.rows.set(i, row);
        row._sig = '';
      }
      const title = t.title || t.gTitle;
      const sub = [t.artist || t.gArtist, t.dir].filter(Boolean).join(' · ');
      const sig = title + '|' + sub;
      if (row._sig !== sig) { row.innerHTML = `<b>${esc(title)}</b><small>${esc(sub)}</small>`; row._sig = sig; }
      row.classList.toggle('mus-cur', t.url === curUrl);
    }
  }

  _toast(msg, err = false) {
    try { if (this.ctx.toast) this.ctx.toast(msg, err); else console.log(msg); } catch {}
  }

  // =====================================================================
  // Preferencias (localStorage)
  // =====================================================================
  _loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; }
  }

  _savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        vol: this.vol, shuffle: this.shuffle, repeat: this.repeat, source: this.source, last: this.last,
      }));
    } catch {}
  }

  _saveLast() {
    const t = this.queue[this.cur];
    if (!t || this.source !== 'hub' || t.file || this.pendingPos || this.audio.readyState < 1) return;
    const pos = Math.floor(this.audio.currentTime || 0);
    if (this.last && this.last.url === t.url && this.last.pos === pos) return;
    this.last = { url: t.url, pos };
    this._savePrefs();
  }
}
