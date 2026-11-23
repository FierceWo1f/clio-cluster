#!/usr/bin/env python3
"""
Lector mínimo de archivos .osm.pbf (OpenStreetMap) que solo usa la librería estándar.

Sirve para sacar un estado completo de un extracto grande (por ejemplo mexico-latest.osm.pbf de
download.geofabrik.de) sin depender de Overpass. Lo usa `descargar.py --pbf`.

El resultado tiene la misma forma que una respuesta de Overpass ("out body geom" / "out tags center"),
así la construcción del mapa es la misma.

Recorre el archivo dos veces con varios procesos:
  1. nodos dentro del rectángulo de la región (más los lugares con nombre)
  2. vías que tocan esos nodos (calles, lugares en área y la frontera de la región)
Con la frontera (relación con ISO3166-2=<código>) recorta a la forma real del estado.
"""

import bisect
import os
import struct
import sys
import time
import zlib
from array import array
from multiprocessing import Pool

# ---------------------------------------------------------------------------
# Protobuf mínimo
# ---------------------------------------------------------------------------


def _varint(b, i):
    r = s = 0
    while True:
        x = b[i]
        i += 1
        r |= (x & 0x7F) << s
        if x < 0x80:
            return r, i
        s += 7


def campos(b, i=0, fin=None):
    """Itera (campo, tipo, valor). Para tipo 2 el valor es (inicio, fin) dentro de b."""
    fin = len(b) if fin is None else fin
    while i < fin:
        k, i = _varint(b, i)
        f, t = k >> 3, k & 7
        if t == 0:
            v, i = _varint(b, i)
        elif t == 2:
            n, i = _varint(b, i)
            v = (i, i + n)
            i += n
        elif t == 1:
            v = b[i:i + 8]
            i += 8
        elif t == 5:
            v = b[i:i + 4]
            i += 4
        else:
            raise ValueError(f"tipo protobuf {t} no soportado")
        yield f, t, v


def empacados(b, ini, fin):
    out = []
    ap = out.append
    i = ini
    while i < fin:
        x = b[i]
        i += 1
        if x < 0x80:
            ap(x)
            continue
        r, s = x & 0x7F, 7
        while True:
            x = b[i]
            i += 1
            r |= (x & 0x7F) << s
            if x < 0x80:
                break
            s += 7
        ap(r)
    return out


def zz(v):
    return (v >> 1) ^ -(v & 1)


def delta_zz(vals):
    out, acc = [], 0
    ap = out.append
    for v in vals:
        acc += (v >> 1) ^ -(v & 1)
        ap(acc)
    return out


# ---------------------------------------------------------------------------
# Bloques del archivo
# ---------------------------------------------------------------------------


def bloques(ruta):
    """Posición y tamaño de cada bloque OSMData (sin descomprimir)."""
    out = []
    with open(ruta, "rb") as f:
        while True:
            h = f.read(4)
            if len(h) < 4:
                break
            n = struct.unpack(">I", h)[0]
            cab = f.read(n)
            tipo, tam = b"", 0
            for fl, t, v in campos(cab):
                if fl == 1:
                    tipo = cab[v[0]:v[1]]
                elif fl == 3:
                    tam = v
            pos = f.tell()
            f.seek(tam, 1)
            if tipo == b"OSMData":
                out.append((pos, tam))
    return out


def leer_bloque(ruta, pos, tam):
    with open(ruta, "rb") as f:
        f.seek(pos)
        blob = f.read(tam)
    for fl, t, v in campos(blob):
        if fl == 1:
            return blob[v[0]:v[1]]
        if fl == 3:
            return zlib.decompress(blob[v[0]:v[1]])
    raise ValueError("bloque sin datos (lzma no soportado)")


def primitivo(b):
    tabla, grupos, gran, lato, lono = [], [], 100, 0, 0
    for fl, t, v in campos(b):
        if fl == 1:
            tabla = [b[s:e].decode("utf-8", "replace") for f2, t2, (s, e) in campos(b, *v) if f2 == 1]
        elif fl == 2:
            grupos.append(v)
        elif fl == 17:
            gran = v
        elif fl == 19:
            lato = _signed(v)
        elif fl == 20:
            lono = _signed(v)
    return tabla, grupos, gran, lato, lono


def _signed(v):
    return v - (1 << 64) if v >= 1 << 63 else v


# ---------------------------------------------------------------------------
# Trabajo en paralelo
# ---------------------------------------------------------------------------
_W = {}

LUGAR_KEYS = ("amenity", "shop", "tourism")


def _init(ruta, bbox, ids_bytes, clases, buscar=()):
    _W["ruta"] = ruta
    _W["buscar"] = set(buscar)
    _W["bbox"] = bbox  # en nanogrados (1e-9), la unidad de lat_offset y granularity
    ids = array("q")
    if ids_bytes:
        ids.frombytes(ids_bytes)
    _W["ids"] = ids
    _W["clases"] = clases


def _en_bbox_e7(la, lo):
    s, w, n, e = _W["bbox"]
    return s <= la <= n and w <= lo <= e


def trabajo_nodos(bloque):
    """Paso 1: nodos dentro del rectángulo. Devuelve (ids, lat_e7, lon_e7, lugares)."""
    b = leer_bloque(_W["ruta"], *bloque)
    tabla, grupos, gran, lato, lono = primitivo(b)
    s, w, n, e = _W["bbox"]
    ids, las, los, lugares = array("q"), array("i"), array("i"), []
    for gi, gf in grupos:
        for fl, t, v in campos(b, gi, gf):
            if fl != 2:  # solo DenseNodes (Geofabrik siempre usa nodos densos)
                if fl in (3, 4):
                    return ids.tobytes(), las.tobytes(), los.tobytes(), lugares, True
                continue
            d_ids = d_lat = d_lon = kv = None
            for f2, t2, v2 in campos(b, *v):
                if f2 == 1:
                    d_ids = delta_zz(empacados(b, *v2))
                elif f2 == 8:
                    d_lat = delta_zz(empacados(b, *v2))
                elif f2 == 9:
                    d_lon = delta_zz(empacados(b, *v2))
                elif f2 == 10:
                    kv = empacados(b, *v2)
            if not d_ids:
                continue
            k = 0  # posición en keys_vals
            for j, nid in enumerate(d_ids):
                la = lato + gran * d_lat[j]
                lo = lono + gran * d_lon[j]
                dentro = s <= la <= n and w <= lo <= e
                if dentro:
                    ids.append(nid)
                    las.append((la + 5000) // 10000)  # nanogrados -> 1e-5 grados
                    los.append((lo + 5000) // 10000)
                if kv is None:
                    continue
                if kv[k] == 0:
                    k += 1
                    continue
                if not dentro:
                    while kv[k] != 0:
                        k += 2
                    k += 1
                    continue
                tags = {}
                while kv[k] != 0:
                    tags[tabla[kv[k]]] = tabla[kv[k + 1]]
                    k += 2
                k += 1
                if "name" in tags and any(x in tags for x in LUGAR_KEYS):
                    lugares.append({"type": "node", "id": nid, "lat": la / 1e9, "lon": lo / 1e9,
                                    "tags": {x: tags[x] for x in ("name", *LUGAR_KEYS) if x in tags}})
    return ids.tobytes(), las.tobytes(), los.tobytes(), lugares, False


def _tiene(ids, x):
    i = bisect.bisect_left(ids, x)
    return i < len(ids) and ids[i] == x


def trabajo_vias(bloque):
    """Paso 2: vías que tocan nodos del rectángulo y relaciones de frontera."""
    b = leer_bloque(_W["ruta"], *bloque)
    tabla, grupos, gran, lato, lono = primitivo(b)
    ids, clases = _W["ids"], _W["clases"]
    vias, rels = [], []
    for gi, gf in grupos:
        for fl, t, v in campos(b, gi, gf):
            if fl == 3:
                wid, keys, vals, refs = 0, [], [], None
                for f2, t2, v2 in campos(b, *v):
                    if f2 == 1:
                        wid = v2
                    elif f2 == 2:
                        keys = empacados(b, *v2)
                    elif f2 == 3:
                        vals = empacados(b, *v2)
                    elif f2 == 8:
                        refs = v2
                if not keys:
                    continue
                tags = {tabla[a]: tabla[c] for a, c in zip(keys, vals)}
                hw = tags.get("highway", "")
                calle = hw and (hw in clases or (hw.endswith("_link") and hw[:-5] in clases)) and tags.get("area") != "yes"
                if calle and hw == "service" and (tags.get("service") in ("driveway", "emergency_access")
                                                  or tags.get("access") in ("private", "no")):
                    calle = False
                lugar = "name" in tags and any(x in tags for x in LUGAR_KEYS)
                frontera = tags.get("boundary") == "administrative"
                if not (calle or lugar or frontera) or refs is None:
                    continue
                r = delta_zz(empacados(b, *refs))
                if not any(_tiene(ids, x) for x in r):
                    continue
                vias.append((wid, r, tags, "calle" if calle else ("lugar" if lugar else "frontera")))
            elif fl == 4:
                rid, keys, vals, memids, tipos, roles = 0, [], [], [], [], []
                for f2, t2, v2 in campos(b, *v):
                    if f2 == 1:
                        rid = v2
                    elif f2 == 2:
                        keys = empacados(b, *v2)
                    elif f2 == 3:
                        vals = empacados(b, *v2)
                    elif f2 == 8:
                        roles = empacados(b, *v2)
                    elif f2 == 9:
                        memids = delta_zz(empacados(b, *v2))
                    elif f2 == 10:
                        tipos = empacados(b, *v2)
                tags = {tabla[a]: tabla[c] for a, c in zip(keys, vals)}
                if "ISO3166-2" in tags:
                    rels.append((rid, tags["ISO3166-2"],
                                 [(m, tabla[ro]) for m, ty, ro in zip(memids, tipos, roles) if ty == 1]))
    return vias, rels


def trabajo_miembros(bloque):
    """Paso 3: nodos de las vías de la frontera que faltan (no todas tienen la etiqueta boundary)."""
    b = leer_bloque(_W["ruta"], *bloque)
    tabla, grupos, gran, lato, lono = primitivo(b)
    buscar, out = _W["buscar"], []
    for gi, gf in grupos:
        for fl, t, v in campos(b, gi, gf):
            if fl != 3:
                continue
            wid, refs = 0, None
            for f2, t2, v2 in campos(b, *v):
                if f2 == 1:
                    wid = v2
                elif f2 == 8:
                    refs = v2
            if wid in buscar and refs is not None:
                out.append((wid, delta_zz(empacados(b, *refs))))
    return out


# ---------------------------------------------------------------------------
# Punto en polígono (frontera de la región), con rejilla para que sea rápido
# ---------------------------------------------------------------------------


def _dentro(px, py, segs):
    c = False
    for x1, y1, x2, y2 in segs:
        if (y1 > py) != (y2 > py) and px < x1 + (py - y1) * (x2 - x1) / (y2 - y1):
            c = not c
    return c


def rejilla_region(segs, bbox_e5, paso=1000):
    """Celdas de paso*1e-5 grados (~1 km) cuyo centro cae dentro de la región."""
    s, w, n, e = bbox_e5
    dentro = set()
    for i in range((n - s) // paso + 1):
        cy = s + i * paso + paso // 2
        # solo los segmentos que cruzan esta fila
        fila = [g for g in segs if (g[1] > cy) != (g[3] > cy)]
        for j in range((e - w) // paso + 1):
            cx = w + j * paso + paso // 2
            if _dentro(cx, cy, fila):
                dentro.add((i, j))
    return dentro


# ---------------------------------------------------------------------------
# Entrada principal
# ---------------------------------------------------------------------------


def leer_region(ruta, bbox, codigo=None, clases=(), con_lugares=True, procesos=None):
    """bbox = [s, w, n, e] en grados. Devuelve elementos con forma de Overpass."""
    t0 = time.time()
    procesos = procesos or max(1, (os.cpu_count() or 2) - 1)
    print(f"Leyendo {os.path.basename(ruta)} ({os.path.getsize(ruta) / 1e6:.0f} MB) con {procesos} procesos…")
    bl = bloques(ruta)
    # margen de ~2 km para no cortar calles justo en el borde del rectángulo
    m = 0.02
    b7 = [round((bbox[0] - m) * 1e9 / 100), round((bbox[1] - m) * 1e9 / 100),
          round((bbox[2] + m) * 1e9 / 100), round((bbox[3] + m) * 1e9 / 100)]
    b7 = [x * 100 for x in b7]  # en nanogrados (1e-9), la unidad de lat_offset/granularidad

    # --- paso 1: nodos ---
    ids, las, los, lugares = array("q"), array("i"), array("i"), []
    primera_via = len(bl)
    with Pool(procesos, initializer=_init, initargs=(ruta, b7, b"", tuple(clases))) as pool:
        for k, (i_b, la_b, lo_b, lug, fin_nodos) in enumerate(pool.imap(trabajo_nodos, bl, chunksize=4)):
            ids.frombytes(i_b)
            las.frombytes(la_b)
            los.frombytes(lo_b)
            lugares.extend(lug)
            if fin_nodos:
                primera_via = min(primera_via, k)
            if k % 200 == 0:
                print(f"\r  nodos: bloque {k + 1}/{len(bl)}, {len(ids):,} en la región", end="", flush=True)
    print(f"\r  nodos: {len(ids):,} en el rectángulo, {len(lugares):,} lugares  ({time.time() - t0:.0f} s)" + " " * 10)

    # Geofabrik ordena por id; por si acaso, ordenar
    if any(ids[i] > ids[i + 1] for i in range(len(ids) - 1)):
        orden = sorted(range(len(ids)), key=ids.__getitem__)
        ids = array("q", (ids[i] for i in orden))
        las = array("i", (las[i] for i in orden))
        los = array("i", (los[i] for i in orden))

    # --- paso 2: vías y relaciones ---
    resto = bl[max(0, primera_via - 1):]
    vias, rels = [], []
    with Pool(procesos, initializer=_init, initargs=(ruta, b7, ids.tobytes(), tuple(clases))) as pool:
        for k, (vs, rs) in enumerate(pool.imap(trabajo_vias, resto, chunksize=4)):
            vias.extend(vs)
            rels.extend(rs)
            if k % 200 == 0:
                print(f"\r  vías: bloque {k + 1}/{len(resto)}, {len(vias):,} encontradas", end="", flush=True)
    print(f"\r  vías: {len(vias):,} que tocan el rectángulo  ({time.time() - t0:.0f} s)" + " " * 20)

    def coord(nid):
        i = bisect.bisect_left(ids, nid)
        if i < len(ids) and ids[i] == nid:
            return las[i], los[i]  # 1e-5 grados
        return None

    # --- forma real de la región ---
    celdas = None
    if codigo:
        rel = next((r for r in rels if r[1] == codigo), None)
        if rel is None:
            print(f"  Aviso: no se encontró la frontera {codigo}; se usa el rectángulo.")
        else:
            miembros = {m for m, rol in rel[2] if rol in ("outer", "")}
            refs_frontera = {wid: refs for wid, refs, tags, tipo in vias if wid in miembros}
            faltan = miembros - refs_frontera.keys()
            if faltan:
                with Pool(procesos, initializer=_init,
                          initargs=(ruta, b7, b"", tuple(clases), tuple(faltan))) as pool:
                    for res in pool.imap(trabajo_miembros, resto, chunksize=4):
                        refs_frontera.update(res)
            if len(refs_frontera) < len(miembros):
                print(f"  Aviso: faltan {len(miembros) - len(refs_frontera)} tramos de la frontera.")
            segs = []
            for wid, refs in refs_frontera.items():
                if True:
                    pts = [coord(x) for x in refs]
                    pts = [p for p in pts if p]
                    segs += [(pts[i][1], pts[i][0], pts[i + 1][1], pts[i + 1][0]) for i in range(len(pts) - 1)]
            if segs:
                be5 = [round(x * 1e5) for x in bbox]
                celdas = (be5, rejilla_region(segs, be5))
                print(f"  frontera de {codigo}: {len(segs):,} tramos, {len(celdas[1]):,} km² aprox. dentro")

    def en_region(p):
        if celdas is None:
            return True
        (s, w, n, e), dentro = celdas
        return ((p[0] - s) // 1000, (p[1] - w) // 1000) in dentro

    # --- armar elementos con forma de Overpass ---
    elementos = []
    for wid, refs, tags, tipo in vias:
        if tipo == "frontera":
            continue
        pts = [coord(x) for x in refs]
        if not any(p and en_region(p) for p in pts):
            continue
        if tipo == "lugar":
            if not con_lugares:
                continue
            ok = [p for p in pts if p]
            elementos.append({"type": "way", "id": wid, "center": {
                "lat": sum(p[0] for p in ok) / len(ok) / 1e5, "lon": sum(p[1] for p in ok) / len(ok) / 1e5},
                "tags": {x: tags[x] for x in ("name", *LUGAR_KEYS) if x in tags}})
            continue
        # tramos continuos de nodos conocidos (una vía que sale del rectángulo se corta)
        tramo_n, tramo_g = [], []
        for nid, p in zip(refs + [None], pts + [None]):
            if p is not None:
                tramo_n.append(nid)
                tramo_g.append({"lat": p[0] / 1e5, "lon": p[1] / 1e5})
                continue
            if len(tramo_n) >= 2:
                elementos.append({"type": "way", "id": wid, "nodes": tramo_n, "geometry": tramo_g, "tags": tags})
            tramo_n, tramo_g = [], []
    if con_lugares:
        elementos += [l for l in lugares if en_region((round(l["lat"] * 1e5), round(l["lon"] * 1e5)))]
    print(f"  {len(elementos):,} elementos dentro de la región  ({time.time() - t0:.0f} s)")
    return elementos


if __name__ == "__main__":
    # prueba rápida: python tools/mapa/pbf.py archivo.osm.pbf s,w,n,e [CODIGO]
    bb = [float(x) for x in sys.argv[2].split(",")]
    els = leer_region(sys.argv[1], bb, sys.argv[3] if len(sys.argv) > 3 else None,
                      clases=("motorway", "trunk", "primary", "secondary", "tertiary",
                              "unclassified", "residential", "living_street", "service"))
    print(len(els))
