// Cálculo de rutas sin internet sobre datos/mapa/grafo.json (formato en docs/PROTOCOLO.md).
// Lógica pura, sin DOM: la usa js/router.worker.js y se puede probar en node.

/** Velocidad típica (km/h) por clase de vía cuando no hay maxspeed: motorway … service. */
export const CLASS_SPEED = [95, 80, 55, 45, 40, 30, 25, 15, 12];

const R = 6371000;
const RAD = Math.PI / 180;
const GRID = 0.0025; // celda del índice de nodos (~275 m)

// ---------------------------------------------------------------------------
// Grafo
// ---------------------------------------------------------------------------

/**
 * Convierte el objeto de grafo.json en estructuras compactas (CSR).
 * @param {{names:string[], lat:number[], lon:number[], ways:number[][]}} g
 */
export function loadGraph(g) {
  const n = g.lat.length;
  const lat = new Float64Array(n), lon = new Float64Array(n);
  for (let i = 0; i < n; i++) { lat[i] = g.lat[i] / 1e5; lon[i] = g.lon[i] / 1e5; }

  let la0 = 0; for (let i = 0; i < n; i++) la0 += lat[i];
  la0 = n ? la0 / n : 0;
  const kx = Math.cos(la0 * RAD) * R * RAD, ky = R * RAD; // metros por grado (plano local)

  const W = g.ways.length;
  const wCls = new Uint8Array(W), wName = new Int32Array(W), wMax = new Uint16Array(W);
  // 1) contar aristas por nodo
  const outCount = new Int32Array(n + 1);
  const deg = new Uint8Array(n);       // grado sin dirección (para saber si es intersección)
  const usable = new Uint8Array(n);    // 1 = el nodo pertenece a alguna vía
  const bestCls = new Uint8Array(n).fill(255);
  let m = 0;
  for (let w = 0; w < W; w++) {
    const way = g.ways[w];
    wCls[w] = way[0]; wName[w] = way[1]; wMax[w] = way[2];
    const ow = way[3];
    for (let k = 4; k < way.length; k++) {
      const a = way[k];
      usable[a] = 1;
      if (way[0] < bestCls[a]) bestCls[a] = way[0];
      if (k === 4) continue;
      const p = way[k - 1];
      if (p === a) continue;
      if (deg[p] < 255) deg[p]++;
      if (deg[a] < 255) deg[a]++;
      if (ow >= 0) { outCount[p]++; m++; }
      if (ow <= 0) { outCount[a]++; m++; }
    }
  }
  // 2) CSR
  const off = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) off[i + 1] = off[i] + outCount[i];
  const fill = off.slice(0, n);
  const to = new Int32Array(m), len = new Float32Array(m), cost = new Float32Array(m), eWay = new Int32Array(m);
  let vmaxAll = 1;
  for (let w = 0; w < W; w++) {
    const way = g.ways[w];
    const ow = way[3];
    const v = speedOf(way[0], way[2]);
    if (v > vmaxAll) vmaxAll = v;
    for (let k = 5; k < way.length; k++) {
      const p = way[k - 1], a = way[k];
      if (p === a) continue;
      const d = Math.hypot((lat[a] - lat[p]) * ky, (lon[a] - lon[p]) * kx);
      const t = d / v;
      if (ow >= 0) { const e = fill[p]++; to[e] = a; len[e] = d; cost[e] = t; eWay[e] = w; }
      if (ow <= 0) { const e = fill[a]++; to[e] = p; len[e] = d; cost[e] = t; eWay[e] = w; }
    }
  }
  // 3) índice de rejilla con los nodos que tienen vías
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (!usable[i]) continue;
    const cx = Math.floor(lon[i] / GRID), cy = Math.floor(lat[i] / GRID);
    if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
  }
  if (minX > maxX) { minX = maxX = minY = maxY = 0; }
  const gw = maxX - minX + 1, gh = maxY - minY + 1;
  const cellCount = new Int32Array(gw * gh + 1);
  const cellOf = i => (Math.floor(lat[i] / GRID) - minY) * gw + (Math.floor(lon[i] / GRID) - minX);
  for (let i = 0; i < n; i++) if (usable[i]) cellCount[cellOf(i) + 1]++;
  for (let c = 0; c < gw * gh; c++) cellCount[c + 1] += cellCount[c];
  const cellNodes = new Int32Array(cellCount[gw * gh]);
  const cf = cellCount.slice(0, gw * gh);
  for (let i = 0; i < n; i++) if (usable[i]) cellNodes[cf[cellOf(i)]++] = i;

  const main = mainComponent(n, m, off, to);

  return {
    n, m, lat, lon, kx, ky, off, to, len, cost, eWay, deg, bestCls, main,
    wCls, wName, wMax, names: g.names, vmax: vmaxAll,
    grid: { minX, minY, gw, gh, start: cellCount, nodes: cellNodes },
    // memoria de trabajo de A* (se reutiliza entre rutas)
    work: null,
  };
}

/**
 * Marca los nodos de la componente fuertemente conexa más grande (Kosaraju iterativo).
 * Así no se elige como origen o destino un tramo sin salida (por ejemplo, un sentido único que sale del área).
 */
function mainComponent(n, m, off, to) {
  // grafo inverso
  const roff = new Int32Array(n + 1);
  for (let e = 0; e < m; e++) roff[to[e] + 1]++;
  for (let i = 0; i < n; i++) roff[i + 1] += roff[i];
  const rfill = roff.slice(0, n), rto = new Int32Array(m);
  for (let u = 0; u < n; u++) for (let e = off[u]; e < off[u + 1]; e++) rto[rfill[to[e]]++] = u;
  // 1) orden de salida con DFS iterativo
  const seen = new Uint8Array(n), order = new Int32Array(n), stack = new Int32Array(n), it = new Int32Array(n);
  let no = 0;
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    let sp = 0; stack[sp++] = s; seen[s] = 1; it[s] = off[s];
    while (sp) {
      const u = stack[sp - 1];
      if (it[u] < off[u + 1]) {
        const v = to[it[u]++];
        if (!seen[v]) { seen[v] = 1; it[v] = off[v]; stack[sp++] = v; }
      } else { order[no++] = u; sp--; }
    }
  }
  // 2) componentes sobre el grafo inverso en orden inverso
  const comp = new Int32Array(n).fill(-1);
  const sizes = [];
  for (let k = n - 1; k >= 0; k--) {
    const s = order[k];
    if (comp[s] >= 0) continue;
    const c = sizes.length;
    let sp = 0, size = 0; stack[sp++] = s; comp[s] = c;
    while (sp) {
      const u = stack[--sp]; size++;
      for (let e = roff[u]; e < roff[u + 1]; e++) {
        const v = rto[e];
        if (comp[v] < 0) { comp[v] = c; stack[sp++] = v; }
      }
    }
    sizes.push(size);
  }
  let big = 0;
  for (let c = 1; c < sizes.length; c++) if (sizes[c] > sizes[big]) big = c;
  const main = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (comp[i] === big) main[i] = 1;
  return main;
}

/** Velocidad en m/s de una vía según maxspeed o su clase. */
export function speedOf(cls, maxspeed) {
  const kmh = maxspeed > 0 ? Math.min(maxspeed, CLASS_SPEED[cls] * 1.6 + 10) : CLASS_SPEED[cls] ?? 20;
  return kmh / 3.6;
}

// ---------------------------------------------------------------------------
// Utilidades geométricas
// ---------------------------------------------------------------------------
export function distM(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Rumbo en grados (0 = norte, 90 = este). */
export function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
  const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Diferencia de rumbos en (-180, 180]: positivo = a la derecha. */
export function turnAngle(h1, h2) {
  let d = h2 - h1;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

// ---------------------------------------------------------------------------
// Nodo más cercano
// ---------------------------------------------------------------------------

/**
 * Nodo transitable más cercano. Las vías de servicio y calles peatonales cuentan como 40 m más lejos,
 * para preferir una calle normal si hay una casi igual de cerca.
 * @returns {{node:number, dist:number}|null}
 */
export function nearestNode(G, lat, lon, maxDist = 3000, onlyMain = true) {
  const { minX, minY, gw, gh, start, nodes } = G.grid;
  const cx = Math.floor(lon / GRID) - minX, cy = Math.floor(lat / GRID) - minY;
  const cell = GRID * Math.min(G.kx, G.ky);
  let best = -1, bestScore = Infinity, bestDist = Infinity;
  const maxRing = Math.ceil(maxDist / cell) + 1;
  for (let r = 0; r <= maxRing; r++) {
    // todo lo que quede en anillos posteriores está a más de (r-1)*cell
    if (best >= 0 && (r - 1) * cell > bestScore) break;
    for (let y = cy - r; y <= cy + r; y++) {
      if (y < 0 || y >= gh) continue;
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || x >= gw) continue;
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue;
        const c = y * gw + x;
        for (let k = start[c]; k < start[c + 1]; k++) {
          const i = nodes[k];
          if (G.off[i + 1] === G.off[i]) continue; // sin aristas de salida
          if (onlyMain && !G.main[i]) continue;     // tramo aislado o sin salida
          const d = Math.hypot((G.lat[i] - lat) * G.ky, (G.lon[i] - lon) * G.kx);
          const score = d + (G.bestCls[i] >= 7 ? 40 : 0);
          if (score < bestScore) { bestScore = score; best = i; bestDist = d; }
        }
      }
    }
  }
  if (best < 0 && onlyMain) return nearestNode(G, lat, lon, maxDist, false);
  return best >= 0 && bestDist <= maxDist ? { node: best, dist: bestDist } : null;
}

// ---------------------------------------------------------------------------
// A*
// ---------------------------------------------------------------------------
function workspace(G) {
  if (!G.work) {
    G.work = {
      g: new Float64Array(G.n), prevE: new Int32Array(G.n), stamp: new Uint32Array(G.n), closed: new Uint32Array(G.n), run: 0,
      heapN: new Int32Array(1024), heapF: new Float64Array(1024),
    };
  }
  return G.work;
}

/**
 * A* con costo en segundos y heurística distancia / velocidad máxima del grafo (admisible).
 * @returns {{nodes:number[], edges:number[], cost:number, visited:number}|null}
 */
export function astar(G, s, t) {
  const W = workspace(G);
  const run = ++W.run;
  const { g, prevE, stamp, closed } = W;
  const tl = G.lat[t], to_ = G.lon[t], ky = G.ky, kx = G.kx, inv = 1 / G.vmax;
  const h = i => Math.hypot((G.lat[i] - tl) * ky, (G.lon[i] - to_) * kx) * inv;
  let size = 0;
  let hn = W.heapN, hf = W.heapF;
  const push = (node, f) => {
    if (size === hn.length) {
      const n2 = new Int32Array(size * 2); n2.set(hn); hn = W.heapN = n2;
      const f2 = new Float64Array(size * 2); f2.set(hf); hf = W.heapF = f2;
    }
    let i = size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hf[p] <= f) break;
      hn[i] = hn[p]; hf[i] = hf[p]; i = p;
    }
    hn[i] = node; hf[i] = f;
  };
  const pop = () => {
    const top = hn[0];
    const ln = hn[--size], lf = hf[size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= size) break;
      if (c + 1 < size && hf[c + 1] < hf[c]) c++;
      if (hf[c] >= lf) break;
      hn[i] = hn[c]; hf[i] = hf[c]; i = c;
    }
    hn[i] = ln; hf[i] = lf;
    return top;
  };

  stamp[s] = run; g[s] = 0; prevE[s] = -1;
  push(s, h(s));
  let visited = 0;
  while (size) {
    const u = pop();
    if (closed[u] === run) continue;
    closed[u] = run;
    visited++;
    if (u === t) break;
    const gu = g[u];
    for (let e = G.off[u]; e < G.off[u + 1]; e++) {
      const v = G.to[e];
      if (closed[v] === run) continue;
      const nv = gu + G.cost[e];
      if (stamp[v] !== run || nv < g[v]) {
        stamp[v] = run; g[v] = nv; prevE[v] = e;
        push(v, nv + h(v));
      }
    }
  }
  if (closed[t] !== run) return null;
  const nodes = [t], edges = [];
  let v = t;
  while (v !== s) {
    const e = prevE[v];
    edges.push(e);
    // el origen de la arista e es el nodo u tal que off[u] <= e < off[u+1]
    v = edgeSource(G, e);
    nodes.push(v);
  }
  nodes.reverse(); edges.reverse();
  return { nodes, edges, cost: g[t], visited };
}

function edgeSource(G, e) {
  let lo = 0, hi = G.n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (G.off[mid] <= e) lo = mid; else hi = mid - 1;
  }
  // nodos sin aristas comparten el mismo off: avanzar hasta el que realmente tiene la arista
  while (G.off[lo + 1] <= e) lo++;
  return lo;
}

// ---------------------------------------------------------------------------
// Ruta completa con maniobras
// ---------------------------------------------------------------------------
const r5 = x => Math.round(x * 1e5) / 1e5;

/**
 * Calcula la ruta entre dos coordenadas.
 * @returns {{pts:number[][], man:object[], len:number, time:number, cum:number[], street:string[], limit:number[],
 *            snap:{from:number,to:number}, ms:number, visited:number} | {error:string}}
 */
export function route(G, from, to) {
  const t0 = now();
  const a = nearestNode(G, from[0], from[1]);
  const b = nearestNode(G, to[0], to[1]);
  if (!a) return { error: 'El origen está fuera del mapa descargado.' };
  if (!b) return { error: 'El destino está fuera del mapa descargado.' };
  let res = a.node === b.node ? { nodes: [a.node], edges: [], cost: 0, visited: 1 } : astar(G, a.node, b.node);
  if (!res) return { error: 'No hay camino entre esos puntos (calles desconectadas o de un solo sentido).' };

  const nodes = res.nodes;
  const pts = nodes.map(i => [r5(G.lat[i]), r5(G.lon[i])]);
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + distM(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]));
  // calle y límite de cada punto = los de la arista que sale de él (el último repite el anterior)
  const street = [], limit = [];
  for (let k = 0; k < pts.length; k++) {
    const e = res.edges[Math.min(k, res.edges.length - 1)];
    if (e === undefined) { street.push(''); limit.push(0); continue; }
    const w = G.eWay[e];
    street.push(G.wName[w] >= 0 ? G.names[G.wName[w]] : '');
    limit.push(G.wMax[w] || 0);
  }
  const len = cum[cum.length - 1];
  const man = maneuvers(G, nodes, pts, cum, street);
  return {
    pts, man, len: Math.round(len), time: Math.round(res.cost), cum, street, limit,
    snap: { from: Math.round(a.dist), to: Math.round(b.dist) }, ms: Math.round(now() - t0), visited: res.visited,
  };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Punto a `dist` metros antes (dist<0) o después (dist>0) del punto k, interpolado sobre la polilínea. */
function pointAlong(pts, cum, k, dist) {
  const target = Math.max(0, Math.min(cum[cum.length - 1], cum[k] + dist));
  let j = k;
  if (dist > 0) { while (j < pts.length - 1 && cum[j + 1] < target) j++; }
  else { while (j > 0 && cum[j] > target) j--; }
  if (j >= pts.length - 1) return pts[pts.length - 1];
  const segLen = cum[j + 1] - cum[j];
  const t = segLen > 0 ? (target - cum[j]) / segLen : 0;
  return [pts[j][0] + (pts[j + 1][0] - pts[j][0]) * t, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * t];
}

function headingAround(pts, cum, k, span) {
  const p0 = pointAlong(pts, cum, k, -span), p1 = pointAlong(pts, cum, k, span);
  const hin = bearing(p0[0], p0[1], pts[k][0], pts[k][1]);
  const hout = bearing(pts[k][0], pts[k][1], p1[0], p1[1]);
  return turnAngle(hin, hout);
}

function sevOf(absAngle) { return absAngle < 45 ? 'slight' : absAngle < 120 ? 'normal' : 'sharp'; }

/** Nota de giro en cruce según el ángulo (1 = muy cerrado … 6 = casi recto). */
function gradeFromAngle(abs) { return abs > 150 ? 1 : abs > 110 ? 2 : abs > 80 ? 3 : abs > 55 ? 4 : abs > 35 ? 5 : 6; }

/** Nota de curva según el radio aproximado en metros. */
function gradeFromRadius(r, abs) {
  if (abs >= 150 && r < 30) return 1;           // horquilla
  return r < 15 ? 1 : r < 30 ? 2 : r < 50 ? 3 : r < 85 ? 4 : r < 140 ? 5 : 6;
}

function maneuvers(G, nodes, pts, cum, street) {
  const N = pts.length;
  const man = [];
  const mk = (i, type, dir, sev, angle, name, grade) => {
    const o = { i, d: Math.round(cum[i]), type, dir, sev, angle: Math.round(angle), name: name || '' };
    if (grade) o.grade = grade;
    return o;
  };
  man.push(mk(0, 'start', 'straight', 'normal', 0, street[0]));
  if (N < 2) { man.push(mk(N - 1, 'arrive', 'straight', 'normal', 0, street[N - 1])); return man; }

  // --- giros en intersecciones ---
  const isTurn = new Uint8Array(N);
  const turns = [];
  for (let k = 1; k < N - 1; k++) {
    if (G.deg[nodes[k]] <= 2) continue;
    const ang = headingAround(pts, cum, k, 15);
    const abs = Math.abs(ang);
    const nameChange = street[k] !== street[k - 1] && street[k] !== '';
    if (abs > 30 || (nameChange && abs >= 15)) {
      const prev = turns[turns.length - 1];
      // dos cruces seguidos (camellón, avenida doble): una sola maniobra
      if (prev && cum[k] - cum[prev.k] < 22 && Math.sign(prev.ang) === Math.sign(ang)) {
        prev.ang += ang; prev.k2 = k; prev.name = street[k];
      } else {
        turns.push({ k, k2: k, ang, name: street[k] });
      }
      isTurn[k] = 1;
    }
  }

  // --- curvas (tramos sin giro de cruce): ángulo acumulado en ~60 m ≥ 35° ---
  const ang = new Float64Array(N);
  for (let k = 1; k < N - 1; k++) {
    if (isTurn[k]) continue;
    const a = turnAngle(bearing(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]),
                        bearing(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]));
    ang[k] = Math.abs(a) > 175 ? 0 : a; // un pico de 180° es ruido del mapa, no una curva
  }
  const curves = [];
  const nearTurn = k => turns.some(t => cum[k] > cum[t.k] - 25 && cum[k] < cum[t.k2] + 25);
  let k = 1;
  while (k < N - 1) {
    if (Math.abs(ang[k]) <= 2 || isTurn[k]) { k++; continue; }
    const sign = Math.sign(ang[k]);
    // suma en la ventana de 60 m (mismo sentido)
    let sum = 0, j = k;
    while (j < N - 1 && cum[j] - cum[k] <= 60 && !isTurn[j]) { if (Math.sign(ang[j]) === sign) sum += ang[j]; j++; }
    if (Math.abs(sum) < 35) { k++; continue; }
    // extender mientras siga girando hacia el mismo lado (huecos rectos de hasta 25 m)
    let end = k;
    for (j = k; j < N - 1 && !isTurn[j]; j++) {
      if (cum[j] - cum[end] > 25) break;
      if (Math.sign(ang[j]) === sign && Math.abs(ang[j]) > 2) end = j;
      else if (Math.sign(ang[j]) === -sign && Math.abs(ang[j]) > 20) break; // contracurva (el ruido chico se tolera)
    }
    // ángulo total = suma con signo (el ruido de redondeo se compensa solo)
    let total = 0;
    for (j = k; j <= end; j++) total += ang[j];
    if (Math.abs(total) >= 35 && !nearTurn(k)) {
      const abs = Math.abs(total);
      const arc = Math.max(8, cum[end] - cum[k] + 10);
      const radius = arc / (abs * RAD);
      const grade = gradeFromRadius(radius, abs);
      curves.push(mk(k, 'curve', sign > 0 ? 'right' : 'left', grade <= 2 ? 'sharp' : grade <= 4 ? 'normal' : 'slight',
        abs, street[k], grade));
    }
    k = end + 1;
  }

  for (const t of turns) {
    const abs = Math.abs(t.ang);
    const dir = abs > 160 ? 'uturn' : abs < 15 ? 'straight' : t.ang > 0 ? 'right' : 'left';
    man.push(mk(t.k, 'turn', dir, sevOf(abs), abs, t.name, gradeFromAngle(abs)));
  }
  man.push(...curves);
  man.push(mk(N - 1, 'arrive', 'straight', 'normal', 0, street[N - 2] || street[N - 1]));
  man.sort((x, y) => x.i - y.i || (x.type === 'start' ? -1 : 1));
  return man;
}

// ---------------------------------------------------------------------------
// Avance sobre la ruta
// ---------------------------------------------------------------------------

/**
 * Proyecta la posición sobre la polilínea de la ruta, buscando cerca del índice anterior.
 * @param {{pts:number[][], cum:number[]}} route
 * @param {number} hint índice del tramo de la última proyección (o 0)
 * @returns {{done:number, offDist:number, idx:number}}
 */
export function progress(route, lat, lon, hint = 0) {
  const { pts, cum } = route;
  const N = pts.length;
  if (N < 2) return { done: 0, offDist: distM(lat, lon, pts[0][0], pts[0][1]), idx: 0 };
  const kx = Math.cos(lat * RAD) * R * RAD, ky = R * RAD;
  const search = (lo, hi) => {
    let best = { d: Infinity, idx: lo, t: 0 };
    for (let i = lo; i < hi; i++) {
      const ax = (pts[i][1] - lon) * kx, ay = (pts[i][0] - lat) * ky;
      const bx = (pts[i + 1][1] - lon) * kx, by = (pts[i + 1][0] - lat) * ky;
      const dx = bx - ax, dy = by - ay;
      const L2 = dx * dx + dy * dy;
      let t = L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(ax + dx * t, ay + dy * t);
      if (d < best.d) best = { d, idx: i, t };
    }
    return best;
  };
  const h = Math.max(0, Math.min(N - 2, hint | 0));
  // ventana: un poco hacia atrás y hasta ~600 m hacia adelante
  let lo = h, hi = h;
  while (lo > 0 && cum[h] - cum[lo] < 50) lo--;
  while (hi < N - 1 && cum[hi] - cum[h] < 600) hi++;
  let best = search(lo, Math.max(lo + 1, hi));
  if (best.d > 60) {
    const all = search(0, N - 1); // se perdió: buscar en toda la ruta
    if (all.d < best.d - 20) best = all;
  }
  const segLen = cum[best.idx + 1] - cum[best.idx];
  return { done: cum[best.idx] + segLen * best.t, offDist: best.d, idx: best.idx };
}
