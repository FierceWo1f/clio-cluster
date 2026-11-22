// Web Worker (módulo) que calcula rutas sin bloquear la interfaz del teléfono.
//
// Mensajes de entrada:
//   {id, load: url}                          carga grafo.json
//   {id, route: {from:[lat,lon], to:[lat,lon]}}
// Respuestas:
//   {id, loaded: true, nodes, edges, ways, ms}   o   {id, error: "texto"}
//   {id, route: {pts, man, len, time, cum, street, limit, snap, ms}}   o   {id, error: "texto"}

import { loadGraph, route } from './router-core.js';

let G = null;

self.onmessage = async e => {
  const m = e.data || {};
  try {
    if (m.load) {
      const t0 = performance.now();
      const r = await fetch(m.load, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`No se encontró el grafo (${r.status}).`);
      const g = await r.json();
      G = loadGraph(g);
      self.postMessage({ id: m.id, loaded: true, nodes: G.n, edges: G.m, ways: G.wCls.length, ms: Math.round(performance.now() - t0) });
    } else if (m.route) {
      if (!G) throw new Error('El grafo todavía no está cargado.');
      const res = route(G, m.route.from, m.route.to);
      if (res.error) self.postMessage({ id: m.id, error: res.error });
      else self.postMessage({ id: m.id, route: res });
    }
  } catch (err) {
    self.postMessage({ id: m.id, error: err.message || String(err) });
  }
};
