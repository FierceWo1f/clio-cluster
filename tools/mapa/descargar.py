#!/usr/bin/env python3
"""
Descarga los datos de mapa de OpenStreetMap para usarlos SIN datos móviles en el auto.
Solo usa la librería estándar de Python, así corre en Termux.

Genera (formato en docs/PROTOCOLO.md, sección "Datos de mapa"):
  datos/mapa/meta.json      resumen del área
  datos/mapa/tiles/*.json   calles por cuadro de 0.01° (para dibujar el mapa)
  datos/mapa/grafo.json     red de calles para calcular rutas
  datos/mapa/lugares.json   lugares con nombre y calles (para el buscador)

Ejemplos:
  python tools/mapa/descargar.py --lugar "Querétaro, Querétaro" --radio 8
  python tools/mapa/descargar.py --bbox 20.55,-100.45,20.65,-100.33

Los datos vienen de © colaboradores de OpenStreetMap (licencia ODbL).
"""

import argparse
import json
import math
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

USER_AGENT = "clio-cluster-mapa/1.0"
OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",  # espejo de respaldo
]
NOMINATIM = "https://nominatim.openstreetmap.org/search"
TILE = 0.01
E5 = 1e5  # coordenadas en enteros de 1e-5 grados

# Clases de vía del contrato (los *_link usan la clase de su vía principal)
CLASES = ["motorway", "trunk", "primary", "secondary", "tertiary",
          "unclassified", "residential", "living_street", "service"]
CLASE = {nombre: i for i, nombre in enumerate(CLASES)}

AREA_GRANDE_KM2 = 1500   # a partir de aquí se avisa y se pide confirmar
AREA_ENORME_KM2 = 20000  # a partir de aquí no se descarga (Overpass lo rechazaría)

ROOT = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


# ---------------------------------------------------------------------------
# Red
# ---------------------------------------------------------------------------
def http(url, data=None, etiqueta="", timeout=300):
    """Hace una petición y devuelve los bytes, mostrando cuánto se ha descargado."""
    req = urllib.request.Request(url, data=data, headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        **({"Content-Type": "application/x-www-form-urlencoded"} if data else {}),
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        partes, total, ultimo = [], 0, 0.0
        while True:
            bloque = r.read(256 * 1024)
            if not bloque:
                break
            partes.append(bloque)
            total += len(bloque)
            ahora = time.time()
            if etiqueta and ahora - ultimo > 0.5:
                print(f"\r  {etiqueta}: {total / 1e6:.1f} MB", end="", flush=True)
                ultimo = ahora
        if etiqueta:
            print(f"\r  {etiqueta}: {total / 1e6:.1f} MB  listo")
        return b"".join(partes)


def overpass(consulta, etiqueta, espera_max=300):
    datos = urllib.parse.urlencode({"data": consulta}).encode()
    ultimo_error = None
    for intento in range(3):
        for url in OVERPASS:
            try:
                print(f"  Pidiendo a {urllib.parse.urlsplit(url).netloc} …")
                return json.loads(http(url, datos, etiqueta, timeout=espera_max))
            except urllib.error.HTTPError as e:
                ultimo_error = f"HTTP {e.code} en {url}"
                # 429 = demasiadas peticiones, 504 = servidor ocupado: esperar antes de reintentar
                espera = 30 if e.code in (429, 504) else 5
            except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
                ultimo_error = f"{e} en {url}"
                espera = 5
            print(f"\n  Falló: {ultimo_error}. Reintento en {espera} s…")
            time.sleep(espera)
    raise SystemExit(f"No se pudo descargar de Overpass ({ultimo_error}). ¿Hay internet? Intenta más tarde.")


def geocodificar(lugar):
    """Una sola petición a Nominatim (respeta su política de uso)."""
    url = NOMINATIM + "?" + urllib.parse.urlencode({"q": lugar, "format": "json", "limit": 1})
    try:
        res = json.loads(http(url, timeout=30))
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise SystemExit(f"No se pudo buscar \"{lugar}\" en Nominatim: {e}")
    if not res:
        raise SystemExit(f"No se encontró \"{lugar}\". Prueba con \"Ciudad, Estado\" o usa --bbox.")
    r = res[0]
    print(f"  Encontrado: {r.get('display_name', lugar)}")
    return float(r["lat"]), float(r["lon"])


def bbox_de_radio(lat, lon, km):
    dlat = km / 111.32
    dlon = km / (111.32 * max(0.05, math.cos(math.radians(lat))))
    return [lat - dlat, lon - dlon, lat + dlat, lon + dlon]


def area_km2(b):
    s, w, n, e = b
    return (n - s) * 111.32 * (e - w) * 111.32 * math.cos(math.radians((s + n) / 2))


# ---------------------------------------------------------------------------
# Interpretación de etiquetas
# ---------------------------------------------------------------------------
def clase_de(highway):
    base = highway[:-5] if highway.endswith("_link") else highway
    return CLASE.get(base)


def velocidad_de(valor):
    """maxspeed en km/h (0 si no hay o no se entiende: "MX:urban", "signals", …)."""
    if not valor:
        return 0
    v = valor.split(";")[0].strip().lower()
    num = "".join(ch for ch in v if ch.isdigit() or ch == ".")
    try:
        x = float(num)
    except ValueError:
        return 0
    if "mph" in v:
        x *= 1.609
    return int(round(x)) if 3 <= x <= 200 else 0


def sentido_de(tags):
    """0 = doble sentido, 1 = sentido de los nodos, -1 = contrario."""
    ow = tags.get("oneway", "").lower()
    if ow in ("yes", "true", "1"):
        return 1
    if ow in ("-1", "reverse"):
        return -1
    if ow in ("no", "false", "0", "reversible", "alternating"):
        return 0
    if tags.get("junction") in ("roundabout", "circular"):
        return 1
    if tags.get("highway") in ("motorway", "motorway_link"):
        return 1  # en OSM las autopistas son de un solo sentido salvo que digan lo contrario
    return 0


def nombre_de(tags):
    return (tags.get("name") or tags.get("ref") or "").strip()


def metros(lat1, lon1, lat2, lon2):
    k = math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot((lat2 - lat1) * 111320, (lon2 - lon1) * 111320 * k)


# ---------------------------------------------------------------------------
# Consulta
# ---------------------------------------------------------------------------
def consulta(b, con_lugares):
    s, w, n, e = b
    box = f"({s:.6f},{w:.6f},{n:.6f},{e:.6f})"
    vias = "|".join(CLASES)
    q = (f'[out:json][timeout:600][maxsize:1073741824];\n'
         f'way["highway"~"^({vias})(_link)?$"]["area"!="yes"]{box}->.todas;\n'
         # fuera: entradas a cocheras y vías de servicio privadas (no sirven para rutas)
         f'way.todas["highway"="service"]["service"~"^(driveway|emergency_access)$"]->.fuera1;\n'
         f'way.todas["highway"="service"]["access"~"^(private|no)$"]->.fuera2;\n'
         f'(.fuera1; .fuera2;)->.fuera;\n'
         f'(.todas; - .fuera;)->.vias;\n'
         f'.vias out body geom;\n')
    if con_lugares:
        q += (f'(nwr["amenity"]["name"]{box}; nwr["shop"]["name"]{box}; nwr["tourism"]["name"]{box};);\n'
              f'out tags center;\n')
    return q


# ---------------------------------------------------------------------------
# Construcción de los archivos
# ---------------------------------------------------------------------------
def tiles_de_via(coords):
    """Cuadros que toca una vía (muestreando los tramos largos para no saltarse ninguno)."""
    vistos = set()
    paso = TILE / 3
    for i, (la, lo) in enumerate(coords):
        vistos.add((math.floor(lo / TILE), math.floor(la / TILE)))
        if i:
            pla, plo = coords[i - 1]
            k = int(max(abs(la - pla), abs(lo - plo)) / paso)
            for j in range(1, k + 1):
                t = j / (k + 1)
                vistos.add((math.floor((plo + (lo - plo) * t) / TILE), math.floor((pla + (la - pla) * t) / TILE)))
    return vistos


def construir(elementos, b):
    # --- vías ---
    nodo_idx = {}          # id OSM -> índice en lat/lon
    lat_e5, lon_e5 = [], []
    nombres, nombre_idx = [], {}
    vias_grafo = []
    vias_tiles = []        # (cls, nombre, maxspeed, [(lat_e5, lon_e5)…])
    calle_mas_larga = {}   # nombre -> (largo_m, [(lat, lon)…])
    lugares = []

    def idx_nombre(nm):
        if not nm:
            return -1
        if nm not in nombre_idx:
            nombre_idx[nm] = len(nombres)
            nombres.append(nm)
        return nombre_idx[nm]

    for el in elementos:
        tags = el.get("tags", {})
        if el["type"] == "way" and "highway" in tags and "geometry" in el:
            cls = clase_de(tags["highway"])
            if cls is None:
                continue
            ids, geom = el.get("nodes", []), el["geometry"]
            if len(ids) != len(geom) or len(ids) < 2:
                continue
            nm = nombre_de(tags)
            vmax = velocidad_de(tags.get("maxspeed"))
            pts_e5, refs, coords = [], [], []
            for nid, g in zip(ids, geom):
                if not g:
                    continue
                la, lo = round(g["lat"] * E5), round(g["lon"] * E5)
                if nid not in nodo_idx:
                    nodo_idx[nid] = len(lat_e5)
                    lat_e5.append(la)
                    lon_e5.append(lo)
                refs.append(nodo_idx[nid])
                pts_e5.append((la, lo))
                coords.append((g["lat"], g["lon"]))
            if len(refs) < 2:
                continue
            vias_grafo.append([cls, idx_nombre(nm), vmax, sentido_de(tags), *refs])
            vias_tiles.append((cls, nm, vmax, pts_e5, coords))
            if nm:
                largo = sum(metros(*coords[i - 1], *coords[i]) for i in range(1, len(coords)))
                if largo > calle_mas_larga.get(nm, (0, None))[0]:
                    calle_mas_larga[nm] = (largo, coords)
        else:
            # lugar con nombre (nodo, o vía/relación con su centro)
            nm = tags.get("name", "").strip()
            if not nm:
                continue
            if "lat" in el:
                la, lo = el["lat"], el["lon"]
            elif "center" in el:
                la, lo = el["center"]["lat"], el["center"]["lon"]
            else:
                continue
            tipo = tags.get("amenity") or tags.get("shop") or tags.get("tourism") or "lugar"
            lugares.append([nm, round(la, 5), round(lo, 5), tipo])

    # --- calles para el buscador: punto medio (a lo largo) del tramo más largo de cada nombre ---
    for nm, (largo, coords) in calle_mas_larga.items():
        mitad, acum = largo / 2, 0.0
        punto = coords[len(coords) // 2]
        for i in range(1, len(coords)):
            d = metros(*coords[i - 1], *coords[i])
            if acum + d >= mitad and d > 0:
                t = (mitad - acum) / d
                punto = (coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t,
                         coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t)
                break
            acum += d
        lugares.append([nm, round(punto[0], 5), round(punto[1], 5), "calle"])

    # quitar lugares repetidos (mismo nombre y tipo a menos de ~100 m)
    unicos, vistos = [], set()
    for l in lugares:
        clave = (l[0].lower(), l[3], round(l[1], 3), round(l[2], 3))
        if clave not in vistos:
            vistos.add(clave)
            unicos.append(l)
    unicos.sort(key=lambda l: (l[3] == "calle", l[0].lower()))

    # --- tiles ---
    tiles = {}
    for cls, nm, vmax, pts_e5, coords in vias_tiles:
        for t in tiles_de_via(coords):
            tiles.setdefault(t, []).append((cls, nm, vmax, pts_e5))

    grafo = {"names": nombres, "lat": lat_e5, "lon": lon_e5, "ways": vias_grafo}
    return grafo, tiles, unicos


def tile_json(vias):
    nombres, idx = [], {}
    roads = []
    for cls, nm, vmax, pts in vias:
        if nm and nm not in idx:
            idx[nm] = len(nombres)
            nombres.append(nm)
        fila = [cls, idx[nm] if nm else -1, vmax, pts[0][0], pts[0][1]]
        for i in range(1, len(pts)):
            fila.append(pts[i][0] - pts[i - 1][0])
            fila.append(pts[i][1] - pts[i - 1][1])
        roads.append(fila)
    return {"names": nombres, "roads": roads}


def escribir_json(ruta, obj):
    tmp = ruta + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, ruta)
    return os.path.getsize(ruta)


def tam(n):
    return f"{n / 1e6:.2f} MB" if n >= 1e6 else f"{n / 1e3:.1f} KB"


# ---------------------------------------------------------------------------
def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    except AttributeError:
        pass
    ap = argparse.ArgumentParser(description="Descarga mapas de OpenStreetMap para usarlos sin internet.")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--bbox", help="área: sur,oeste,norte,este en grados (ej. 20.55,-100.45,20.65,-100.33)")
    g.add_argument("--lugar", help='ciudad a buscar, ej. "Querétaro, Querétaro"')
    ap.add_argument("--radio", type=float, default=8, help="radio en km alrededor de --lugar (por defecto 8)")
    ap.add_argument("--salida", default=os.path.join(ROOT, "datos", "mapa"), help="carpeta de salida (por defecto datos/mapa)")
    ap.add_argument("--sin-lugares", action="store_true", help="no descargar negocios ni lugares")
    ap.add_argument("--si", action="store_true", help="no preguntar si el área es grande")
    a = ap.parse_args()

    print("Mapas para Clio — datos © colaboradores de OpenStreetMap (ODbL)")
    if a.bbox:
        try:
            b = [float(x) for x in a.bbox.split(",")]
            assert len(b) == 4 and b[0] < b[2] and b[1] < b[3]
        except (ValueError, AssertionError):
            raise SystemExit("--bbox debe ser sur,oeste,norte,este (con sur < norte y oeste < este).")
    else:
        print(f"Buscando \"{a.lugar}\"…")
        lat, lon = geocodificar(a.lugar)
        b = bbox_de_radio(lat, lon, a.radio)

    km2 = area_km2(b)
    print(f"Área: {b[0]:.4f},{b[1]:.4f},{b[2]:.4f},{b[3]:.4f}  (~{km2:,.0f} km²)")
    if km2 > AREA_ENORME_KM2:
        raise SystemExit("El área es enorme. Usa un radio menor o descarga por partes (una ciudad a la vez).")
    if km2 > AREA_GRANDE_KM2:
        print(f"Aviso: el área es grande. Puede tardar varios minutos y ocupar ~{km2 * 0.012:.0f} MB "
              "(y el teléfono tardará en cargar el grafo).")
        if not a.si:
            if input("¿Continuar? [s/N] ").strip().lower() not in ("s", "si", "sí", "y", "yes"):
                raise SystemExit("Cancelado.")

    t0 = time.time()
    print("Descargando calles" + ("" if a.sin_lugares else " y lugares") + " de Overpass (puede tardar)…")
    # Overpass no manda nada hasta terminar la consulta: el tiempo de espera crece con el área
    res = overpass(consulta(b, not a.sin_lugares), "recibido", espera_max=min(620, 120 + km2 * 0.5))
    elementos = res.get("elements", [])
    if res.get("remark"):
        print("  Nota del servidor:", res["remark"])
        if "error" in res["remark"].lower():
            raise SystemExit("Overpass devolvió un error; prueba un área más chica o más tarde.")
    print(f"  {len(elementos):,} elementos recibidos")

    print("Procesando…")
    grafo, tiles, lugares = construir(elementos, b)
    if not grafo["ways"]:
        raise SystemExit("No se encontraron calles en el área. Revisa las coordenadas.")

    os.makedirs(a.salida, exist_ok=True)
    dir_tiles = os.path.join(a.salida, "tiles")
    if os.path.isdir(dir_tiles):
        shutil.rmtree(dir_tiles)  # los cuadros viejos de otra área ya no sirven
    os.makedirs(dir_tiles)

    total_tiles = 0
    for i, ((tx, ty), vias) in enumerate(sorted(tiles.items())):
        total_tiles += escribir_json(os.path.join(dir_tiles, f"{tx}_{ty}.json"), tile_json(vias))
        if i % 50 == 0:
            print(f"\r  cuadros: {i + 1}/{len(tiles)}", end="", flush=True)
    print(f"\r  cuadros: {len(tiles)}/{len(tiles)}  listo")

    t_grafo = escribir_json(os.path.join(a.salida, "grafo.json"), grafo)
    t_lug = escribir_json(os.path.join(a.salida, "lugares.json"), lugares)
    meta = {
        "version": 1, "bbox": [round(x, 5) for x in b], "tile": TILE,
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "ways": len(grafo["ways"]), "nodes": len(grafo["lat"]), "places": len(lugares),
    }
    escribir_json(os.path.join(a.salida, "meta.json"), meta)

    calles = sum(1 for l in lugares if l[3] == "calle")
    print()
    print(f"Listo en {time.time() - t0:.0f} s → {a.salida}")
    print(f"  vías: {meta['ways']:,}   nodos: {meta['nodes']:,}   lugares: {meta['places']:,} ({calles:,} calles)")
    print(f"  grafo.json    {tam(t_grafo)}")
    print(f"  lugares.json  {tam(t_lug)}")
    print(f"  tiles/        {tam(total_tiles)} en {len(tiles)} archivos")
    print(f"  total         {tam(t_grafo + t_lug + total_tiles)}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("\nCancelado.")
