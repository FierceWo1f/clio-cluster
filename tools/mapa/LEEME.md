# Mapas sin internet (`descargar.py`)

La navegación del teléfono funciona **sin datos móviles**: las calles, el grafo para calcular rutas y los lugares
del buscador se descargan una vez, **en casa con WiFi**, y el hub los sirve desde `datos/mapa/`.

Los datos vienen de OpenStreetMap (© colaboradores de OpenStreetMap, licencia ODbL). El formato de los archivos está
en `docs/PROTOCOLO.md`, sección "Datos de mapa".

## En Termux (teléfono)

```sh
pkg install python          # una sola vez (no necesita nada más: solo usa la librería estándar)
cd clio-cluster

# Una ciudad: busca el nombre y descarga un radio de 8 km a su alrededor
python tools/mapa/descargar.py --lugar "Querétaro, Querétaro"

# Más chico o más grande
python tools/mapa/descargar.py --lugar "San Juan del Río, Querétaro" --radio 5

# Un rectángulo exacto: sur,oeste,norte,este (en grados)
python tools/mapa/descargar.py --bbox 20.55,-100.45,20.65,-100.33
```

No hace falta reiniciar el hub (lee los archivos en cada petición): en la app abre la pestaña **Viaje** y toca
"Revisar de nuevo", o recarga la app.

Opciones:

| Opción | Qué hace |
|---|---|
| `--lugar "Ciudad, Estado"` | busca el centro en Nominatim (1 sola petición) |
| `--radio KM` | radio alrededor de `--lugar` (por defecto 8) |
| `--bbox S,W,N,E` | rectángulo exacto, en lugar de `--lugar` |
| `--salida carpeta` | dónde escribir (por defecto `datos/mapa/`) |
| `--sin-lugares` | solo calles, sin negocios ni lugares para el buscador |
| `--si` | no preguntar aunque el área sea grande |

Cada descarga **reemplaza** la anterior (una sola área a la vez). Si viajas a otra ciudad, descárgala antes de salir.

## Cuánto pesa y cuánto tarda

Depende de qué tan densa sea la zona. Valores de referencia:

| Área | Calles + lugares | Tiempo |
|---|---|---|
| Centro de Querétaro, ~3 km² (`--bbox 20.585,-100.400,20.600,-100.380`) | ~180 KB (grafo 78 KB, lugares 46 KB, 11 cuadros 56 KB) | 1 min |
| Ciudad con radio de 8 km (~250 km²) | aprox. 5 a 15 MB (estimado) | 2 a 6 min |
| Zona metropolitana grande, radio 20 km | aprox. 30 a 60 MB (estimado) | puede tardar más de 10 min |

- Si el área pasa de ~1500 km², el programa avisa y pregunta. Más de 20 000 km² no se descarga.
- Un grafo de más de ~30 MB tarda varios segundos en cargarse en el teléfono; mejor usa un radio razonable.
- Overpass (el servidor de OpenStreetMap) a veces está ocupado: el programa reintenta y usa un espejo de respaldo.
  Si aun así falla, espera unos minutos y vuelve a intentar.

## Qué se descarga

- Vías `motorway`, `trunk`, `primary`, `secondary`, `tertiary`, `unclassified`, `residential`, `living_street` y
  `service` (y sus `*_link`), con nombre (o `ref`), `maxspeed` y sentido (`oneway`, glorietas y autopistas).
  Se omiten entradas a cocheras y vías de servicio privadas.
- Lugares con nombre de tipo `amenity`, `shop` y `tourism` (gasolineras, farmacias, restaurantes…).
- Las calles también entran al buscador: una entrada por nombre, en el punto medio de su tramo más largo.

Archivos generados en `datos/mapa/`: `meta.json`, `grafo.json`, `lugares.json` y `tiles/{tx}_{ty}.json`.
La carpeta `datos/` no se sube a git.
