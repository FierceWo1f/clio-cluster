// Lector de etiquetas ID3v2 (2.2, 2.3 y 2.4) para MP3.
// Solo lee los primeros bytes del archivo (fetch con Range o blob.slice), nunca el archivo completo.
// Saca: título (TIT2), artista (TPE1), álbum (TALB), duración (TLEN) y portada (APIC) como Blob.

const MAX_TAG = 8 * 1024 * 1024; // etiquetas más grandes que esto se ignoran (portadas gigantes)
const FIRST_READ = 64 * 1024;    // primera lectura: suele alcanzar para todo menos la portada

const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];

/** Quita la "desincronización" (cada 0xFF 0x00 vuelve a ser 0xFF). */
function unsync(b) {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    out[n++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

function decodeUtf16(b, bigEndian) {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) {
    s += String.fromCharCode(bigEndian ? (b[i] << 8) | b[i + 1] : b[i] | (b[i + 1] << 8));
  }
  return s;
}

/** Decodifica texto según el byte de codificación de ID3: 0 latin1, 1 UTF-16 con BOM, 2 UTF-16BE, 3 UTF-8. */
function decodeText(enc, b) {
  if (enc === 1) {
    if (b[0] === 0xfe && b[1] === 0xff) return decodeUtf16(b.subarray(2), true);
    if (b[0] === 0xff && b[1] === 0xfe) return decodeUtf16(b.subarray(2), false);
    return decodeUtf16(b, false);
  }
  if (enc === 2) return decodeUtf16(b, true);
  if (enc === 3) return new TextDecoder('utf-8').decode(b);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

/** Posición del terminador (0x00, o 0x00 0x00 alineado en UTF-16) a partir de `from`. */
function findTerm(b, from, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = from; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
    return b.length;
  }
  for (let i = from; i < b.length; i++) if (b[i] === 0) return i;
  return b.length;
}

function textFrame(b) {
  if (!b.length) return '';
  const enc = b[0];
  // En 2.4 un frame puede traer varios valores separados por 0; nos quedamos con el primero.
  const body = b.subarray(1);
  const end = findTerm(body, 0, enc);
  return decodeText(enc, body.subarray(0, end)).replace(/\u0000/g, '').trim();
}

function pictureFrame(b, v22) {
  const enc = b[0];
  let p = 1;
  let mime;
  if (v22) {
    const fmt = decodeText(0, b.subarray(1, 4)).toLowerCase();
    mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
    p = 4;
  } else {
    const end = findTerm(b, 1, 0);
    mime = decodeText(0, b.subarray(1, end)).toLowerCase() || 'image/jpeg';
    if (!mime.includes('/')) mime = 'image/' + (mime === 'jpg' ? 'jpeg' : mime);
    p = end + 1;
  }
  const type = b[p];
  p++;
  const dEnd = findTerm(b, p, enc);
  p = dEnd + (enc === 1 || enc === 2 ? 2 : 1);
  if (p >= b.length) return null;
  return { type, mime, data: b.slice(p) };
}

/**
 * Interpreta una etiqueta ID3v2 completa (desde el byte 0 del archivo).
 * @param {ArrayBuffer|Uint8Array} buf
 * @returns {{version?:string, title?:string, artist?:string, album?:string, dur?:number, picture?:Blob|null, pictureMime?:string}}
 */
export function parseId3(buf) {
  const all = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (all.length < 10 || all[0] !== 0x49 || all[1] !== 0x44 || all[2] !== 0x33) return {};
  const major = all[3];
  const flags = all[5];
  const size = syncsafe(all, 6);
  if (major < 2 || major > 4) return {};
  let b = all.subarray(10, Math.min(all.length, 10 + size));
  // En 2.2 y 2.3 la desincronización se aplica a toda la etiqueta; en 2.4, frame por frame.
  if ((flags & 0x80) && major < 4) b = unsync(b);
  let p = 0;
  if (flags & 0x40 && major >= 3) {
    // Encabezado extendido: en 2.3 el tamaño no lo incluye y no es sincsafe; en 2.4 sí lo incluye.
    p = major === 3 ? u32(b, 0) + 4 : syncsafe(b, 0);
  }
  const out = { version: `2.${major}` };
  const v22 = major === 2;
  const head = v22 ? 6 : 10;
  let pic = null;
  while (p + head <= b.length) {
    if (b[p] === 0) break; // relleno
    const id = String.fromCharCode(...b.subarray(p, p + (v22 ? 3 : 4)));
    let fsize;
    if (v22) fsize = (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5];
    else if (major === 4) fsize = syncsafe(b, p + 4);
    else fsize = u32(b, p + 4);
    const fflags = v22 ? 0 : (b[p + 8] << 8) | b[p + 9];
    p += head;
    if (fsize <= 0 || p + fsize > b.length) break;
    let data = b.subarray(p, p + fsize);
    p += fsize;
    if (major === 4) {
      if (fflags & 0x0001) data = data.subarray(4); // indicador de longitud original
      if (fflags & 0x0002) data = unsync(data);
      if (fflags & 0x000c) continue; // comprimido o cifrado: no lo soportamos
    } else if (major === 3 && (fflags & 0x00c0)) {
      continue; // comprimido o cifrado en 2.3
    }
    try {
      switch (id) {
        case 'TIT2': case 'TT2': out.title = textFrame(data); break;
        case 'TPE1': case 'TP1': out.artist = textFrame(data); break;
        case 'TALB': case 'TAL': out.album = textFrame(data); break;
        case 'TLEN': case 'TLE': {
          const ms = parseInt(textFrame(data), 10);
          if (ms > 0) out.dur = ms / 1000;
          break;
        }
        case 'APIC': case 'PIC': {
          const f = pictureFrame(data, v22);
          // Preferimos la portada frontal (tipo 3); si no hay, la primera que aparezca.
          if (f && (!pic || (f.type === 3 && pic.type !== 3))) pic = f;
          break;
        }
      }
    } catch { /* frame dañado: se ignora */ }
  }
  for (const k of ['title', 'artist', 'album']) if (!out[k]) delete out[k];
  if (pic) {
    out.picture = new Blob([pic.data], { type: pic.mime });
    out.pictureMime = pic.mime;
  } else {
    out.picture = null;
  }
  return out;
}

/** Lee del inicio de un stream como máximo `max` bytes (sirve aunque el servidor ignore Range). */
async function readLimited(res, max) {
  if (!res.body || !res.body.getReader) return new Uint8Array(await res.arrayBuffer()).subarray(0, max);
  const reader = res.body.getReader();
  const parts = [];
  let n = 0;
  while (n < max) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.length;
  }
  reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(n, max));
  let o = 0;
  for (const v of parts) {
    const take = Math.min(v.length, out.length - o);
    out.set(v.subarray(0, take), o);
    o += take;
    if (o >= out.length) break;
  }
  return out;
}

async function readRange(src, start, end, signal) {
  if (typeof src !== 'string') {
    return new Uint8Array(await src.slice(start, end).arrayBuffer());
  }
  const res = await fetch(src, { headers: { Range: `bytes=${start}-${end - 1}` }, signal });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  if (res.status === 200 && start > 0) {
    // El servidor ignoró el Range: hay que leer desde el principio.
    const all = await readLimited(res, end);
    return all.subarray(start, end);
  }
  return readLimited(res, end - start);
}

/**
 * Lee las etiquetas de un MP3 desde una URL o un Blob/File.
 * Nunca lanza error: si no hay etiqueta o algo falla regresa {}.
 * @param {string|Blob} urlOrBlob
 */
export async function readTags(urlOrBlob, { timeout = 8000 } = {}) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
  try {
    const signal = ctrl?.signal;
    const first = await readRange(urlOrBlob, 0, FIRST_READ, signal);
    if (first.length < 10 || first[0] !== 0x49 || first[1] !== 0x44 || first[2] !== 0x33) return {};
    const total = 10 + syncsafe(first, 6) + (first[5] & 0x10 ? 10 : 0);
    if (total > MAX_TAG) {
      // Etiqueta enorme (por lo general una portada pesada): leemos lo que ya tenemos, sin portada.
      const t = parseId3(first);
      t.picture = null;
      return t;
    }
    let buf = first;
    if (total > first.length && first.length >= FIRST_READ) {
      const rest = await readRange(urlOrBlob, first.length, total, signal);
      buf = new Uint8Array(first.length + rest.length);
      buf.set(first, 0);
      buf.set(rest, first.length);
    }
    return parseId3(buf);
  } catch {
    return {};
  } finally {
    if (timer) clearTimeout(timer);
  }
}
