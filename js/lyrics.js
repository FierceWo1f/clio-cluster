// Letras de canciones: archivo .lrc local, caché en localStorage y LRCLIB (https://lrclib.net).
// findLyrics() nunca lanza error: si no encuentra nada regresa {lyrics:null, plain:null}.

const CACHE_KEY = 'clio.lyrics';
const CACHE_MAX = 150;            // canciones guardadas como máximo
const CACHE_ENTRY_MAX = 40000;    // caracteres por canción (letras más largas no se guardan)
const MISS_TTL = 3 * 24 * 3600e3; // "no hay letra" se recuerda 3 días y luego se vuelve a buscar
const API = 'https://lrclib.net/api';

const TIME_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/**
 * Convierte texto LRC en [[ms, "línea"], ...] ordenado por tiempo.
 * Soporta varias marcas por línea ("[00:12.00][01:30.50]Coro") y el tag [offset:±ms].
 */
export function parseLrc(text) {
  if (!text) return [];
  let offset = 0;
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const off = /^\[offset:\s*([+-]?\d+)\s*\]$/i.exec(line);
    if (off) { offset = parseInt(off[1], 10) || 0; continue; }
    const times = [];
    TIME_RE.lastIndex = 0;
    let m, last = 0;
    // Las marcas van al principio de la línea, una tras otra.
    while ((m = TIME_RE.exec(line)) && m.index === last) {
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0;
      times.push(parseInt(m[1], 10) * 60000 + parseInt(m[2], 10) * 1000 + frac);
      last = TIME_RE.lastIndex;
    }
    if (!times.length) continue;
    // Quita marcas por palabra del LRC "mejorado": <00:12.34>
    const words = line.slice(last).replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim();
    for (const t of times) out.push([t, words]);
  }
  // Un offset positivo adelanta la letra (aparece antes).
  for (const e of out) e[0] = Math.max(0, e[0] - offset);
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/** Texto plano a partir de un LRC (sin marcas ni tags). */
function lrcToPlain(text) {
  return String(text).split(/\r?\n/)
    .map(l => l.replace(/^(\[[^\]]*\])+/, '').replace(/<[^>]*>/g, '').trim())
    .filter((l, i, a) => l || (i > 0 && a[i - 1]))
    .join('\n').trim() || null;
}

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// ---------- caché ----------
function cacheLoad() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch { return {}; }
}
function cacheSave(c) {
  const keys = Object.keys(c).sort((a, b) => c[a].at - c[b].at);
  while (keys.length > CACHE_MAX) delete c[keys.shift()];
  for (let tries = 0; tries < 6; tries++) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); return; }
    catch { // sin espacio: tira la mitad más vieja y reintenta
      const ks = Object.keys(c).sort((a, b) => c[a].at - c[b].at);
      if (!ks.length) return;
      ks.slice(0, Math.ceil(ks.length / 2)).forEach(k => delete c[k]);
    }
  }
}
function cacheGet(key) {
  const c = cacheLoad();
  const e = c[key];
  if (!e) return undefined;
  if (e.miss && Date.now() - e.at > MISS_TTL) return undefined;
  return e;
}
function cachePut(key, synced, plain) {
  try {
    const c = cacheLoad();
    const e = { at: Date.now() };
    if (synced || plain) {
      if ((synced || '').length + (plain || '').length > CACHE_ENTRY_MAX) return;
      if (synced) e.s = synced; else if (plain) e.p = plain;
    } else {
      e.miss = 1;
    }
    c[key] = e;
    cacheSave(c);
  } catch { /* sin localStorage */ }
}

// ---------- red ----------
async function fetchText(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return { status: r.status, text: null };
    return { status: r.status, text: await r.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, ms) {
  const { status, text } = await fetchText(url, ms);
  if (!text) return { status, data: null };
  try { return { status, data: JSON.parse(text) }; } catch { return { status, data: null }; }
}

function result(synced, plain) {
  const lyrics = synced ? parseLrc(synced) : [];
  return {
    lyrics: lyrics.length ? lyrics : null,
    plain: (plain && String(plain).trim()) || (synced ? lrcToPlain(synced) : null),
  };
}

/** Elige el mejor resultado de /api/search: con letra sincronizada y duración parecida. */
function pickBest(list, { title, artist, dur }) {
  let best = null, bestScore = -Infinity;
  for (const it of list || []) {
    if (!it || it.instrumental || (!it.syncedLyrics && !it.plainLyrics)) continue;
    let s = 0;
    if (it.syncedLyrics) s += 10;
    if (dur && it.duration) {
      const d = Math.abs(it.duration - dur);
      if (d > 15) continue; // seguramente otra versión
      s += 8 - Math.min(8, d);
    }
    if (norm(it.trackName) === norm(title)) s += 5;
    if (artist && norm(it.artistName) === norm(artist)) s += 5;
    if (s > bestScore) { best = it; bestScore = s; }
  }
  return best;
}

/**
 * Busca la letra de una canción. Orden: .lrc local → caché → LRCLIB get → LRCLIB search.
 * @param {{title?:string, artist?:string, album?:string, dur?:number, lrcUrl?:string|null, timeout?:number}} q
 * @returns {Promise<{lyrics: Array<[number,string]>|null, plain: string|null}>}
 */
export async function findLyrics({ title, artist, album, dur, lrcUrl, timeout = 7000 } = {}) {
  const empty = { lyrics: null, plain: null };
  try {
    // 1. Archivo .lrc junto a la canción
    if (lrcUrl) {
      try {
        const { text } = await fetchText(lrcUrl, 4000);
        if (text && text.trim()) {
          const r = parseLrc(text).length ? result(text, null) : result(null, text);
          if (r.lyrics || r.plain) return r;
        }
      } catch { /* sin .lrc: seguimos */ }
    }
    if (!title) return empty;
    const key = norm(artist) + '|' + norm(title);

    // 2. Caché
    const hit = cacheGet(key);
    if (hit) return hit.miss ? empty : result(hit.s || null, hit.p || null);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return empty;

    // 3. LRCLIB: búsqueda exacta y, si no hay, búsqueda general
    let found = null;
    let reached = false; // si nunca hubo respuesta del servidor, no se guarda "sin letra"
    if (artist) {
      const p = new URLSearchParams({ track_name: title, artist_name: artist });
      if (album) p.set('album_name', album);
      if (dur) p.set('duration', String(Math.round(dur)));
      try {
        const { status, data } = await fetchJson(`${API}/get?${p}`, timeout);
        reached = status > 0;
        if (data && !data.instrumental && (data.syncedLyrics || data.plainLyrics)) found = data;
      } catch { /* sin red o tiempo agotado */ }
    }
    if (!found) {
      const p = artist ? new URLSearchParams({ track_name: title, artist_name: artist })
        : new URLSearchParams({ q: title });
      try {
        const { status, data } = await fetchJson(`${API}/search?${p}`, timeout);
        reached = reached || status > 0;
        if (Array.isArray(data)) found = pickBest(data, { title, artist, dur });
      } catch { /* nada */ }
    }
    if (found) {
      cachePut(key, found.syncedLyrics || null, found.plainLyrics || null);
      return result(found.syncedLyrics || null, found.plainLyrics || null);
    }
    if (reached) cachePut(key, null, null);
    return empty;
  } catch {
    return empty;
  }
}
