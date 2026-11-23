#!/usr/bin/env python3
"""
Instala un mapa ya preparado (zip) en datos/mapa, sin tener que descargarlo de OpenStreetMap.
Solo usa la librería estándar de Python, así corre en Termux.

  python tools/mapa/instalar.py hidalgo            paquete publicado en GitHub (releases, etiqueta mapa-hidalgo)
  python tools/mapa/instalar.py https://…/x.zip    cualquier URL
  python tools/mapa/instalar.py ~/descargas/x.zip  un zip que ya tengas en el teléfono

El mapa anterior se guarda en datos/mapa.anterior por si quieres regresar.
Los datos son © colaboradores de OpenStreetMap (licencia ODbL).
"""

import json
import os
import shutil
import sys
import tempfile
import time
import urllib.request
import zipfile

REPO = "FierceWo1f/clio-cluster"
ROOT = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
DESTINO = os.path.join(ROOT, "datos", "mapa")


def descargar(url, ruta):
    req = urllib.request.Request(url, headers={"User-Agent": "clio-cluster-mapa/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r, open(ruta, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        hecho, t0 = 0, time.time()
        while True:
            bloque = r.read(256 * 1024)
            if not bloque:
                break
            f.write(bloque)
            hecho += len(bloque)
            if total:
                print(f"\r  {hecho / 1e6:6.1f} / {total / 1e6:.1f} MB  ({hecho * 100 // total}%)", end="", flush=True)
        print(f"\r  {hecho / 1e6:.1f} MB descargados en {time.time() - t0:.0f} s" + " " * 20)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    except AttributeError:
        pass
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    arg = sys.argv[1]
    tmp = tempfile.mkdtemp(prefix="clio-mapa-")
    try:
        if os.path.isfile(os.path.expanduser(arg)):
            zip_path = os.path.expanduser(arg)
        else:
            url = arg if "://" in arg else f"https://github.com/{REPO}/releases/download/mapa-{arg}/mapa-{arg}.zip"
            print(f"Descargando {url}")
            zip_path = os.path.join(tmp, "mapa.zip")
            try:
                descargar(url, zip_path)
            except Exception as e:
                raise SystemExit(f"No se pudo descargar ({e}). ¿Hay internet? ¿Existe el paquete '{arg}'?")

        print("Revisando el paquete…")
        with zipfile.ZipFile(zip_path) as z:
            nombres = z.namelist()
            if "meta.json" not in nombres or "grafo.json" not in nombres:
                raise SystemExit("El zip no parece un mapa de Clio (falta meta.json o grafo.json).")
            nuevo = os.path.join(tmp, "mapa")
            z.extractall(nuevo)
        with open(os.path.join(nuevo, "meta.json"), encoding="utf-8") as f:
            meta = json.load(f)

        os.makedirs(os.path.dirname(DESTINO), exist_ok=True)
        anterior = DESTINO + ".anterior"
        if os.path.isdir(DESTINO):
            shutil.rmtree(anterior, ignore_errors=True)
            os.replace(DESTINO, anterior)
        shutil.move(nuevo, DESTINO)
        print(f"Listo → {DESTINO}")
        print(f"  {meta.get('ways', 0):,} vías, {meta.get('nodes', 0):,} nodos, {meta.get('places', 0):,} lugares"
              f" (datos del {str(meta.get('created', ''))[:10]})")
        print("Recarga la app del teléfono para que use el mapa nuevo.")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
