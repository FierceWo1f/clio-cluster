# Protocolo teléfono ↔ estéreo (contrato entre módulos)

Arquitectura:
- **Teléfono:** la app `index.html` (Chrome, servida por el hub en `http://localhost:8080`) se conecta al relay del hub con `role=motor`.
- **Estéreo:** las páginas de `pantalla/` se conectan con `role=pantalla-<nombre>`.
- **El hub** (`hub/hub.py`) reenvía cada mensaje a todos los demás clientes, sin interpretarlo. Además anuncia
  `{"t":"hub","clients":[roles…]}` cada vez que alguien entra o sale.

Todos los mensajes son JSON de texto, excepto el espectro de audio, que es binario. Los campos sin dato **se omiten**
(`undefined` no viaja en JSON); el receptor debe tolerar que falten.

## Teléfono: módulos y contexto

Cada función del teléfono es un módulo ES con una clase que recibe un `ctx` y expone:

```js
class Modulo {
  constructor(ctx) {}
  mount(el) {}       // dibuja su interfaz del teléfono dentro de <section> (pestaña propia)
  command(m) {}      // comandos del estéreo cuyo m.a empieza con su prefijo ("music.", "nav.", ...)
  resend() {}        // entró una pantalla nueva: reenviar el estado actual (pista, ruta, odómetro...)
}
```

`ctx` (lo arma `js/app.js`):

| Campo | Qué es |
|---|---|
| `ctx.publish(msg)` | envía JSON al estéreo (no hace nada si no hay pantallas) |
| `ctx.publishBinary(arrayBuffer)` | envía binario al estéreo |
| `ctx.obd()` | último snapshot OBD: `{on, speed, rpm, gear, cool, volt, thr, lh, l100, trip:{km,ms,fuel}}` (velocidad en km/h, puede faltar) |
| `ctx.toast(msg, err=false)` | aviso en la app del teléfono |
| `ctx.modules` | `{music, gps, nav, trips}`, para que se usen entre sí (por ejemplo, nav baja el volumen de la música para hablar) |

Interfaces que se usan entre módulos:
- `music.duck(on: boolean)` baja o restaura el volumen. Lo usa nav mientras habla.
- `gps.last` es la última posición: `{lat, lon, acc, hdg, spd, ts}` (`spd` en m/s, `hdg` en grados, `null` si no hay).
- `gps.onFix(fn)` llama a `fn(fix)` con cada posición nueva.

## Música (`js/media.js`, prefijo de comandos `music.`)

Teléfono → estéreo:
- `{"t":"track","id":n,"title","artist","album","cover":"data:image/jpeg;base64,…"|null,"dur":segundos,"lyrics":[[ms,"línea"],…]|null,"plain":"letra sin tiempos"|null}`
  - Se manda al cambiar de canción, cuando llega la letra (con el mismo `id`) y en `resend()`.
  - La portada va reducida a ≤ 256 px en JPEG.
- `{"t":"play","id":n,"playing":bool,"pos":segundos,"dur":segundos,"shuffle":bool,"repeat":"off|all|one","vol":0..1}`
  - 2 veces por segundo, y en cada cambio. El estéreo interpola `pos` con su propio reloj.
- `{"t":"queue","cur":índice,"items":[{"i":índice,"title","artist"}]}`
  - Se manda cuando cambia la lista, hasta 500 elementos.
- **Binario del espectro**, unas 30 veces por segundo mientras suena:
  - 97 bytes: `[0x46 ('F'), 32 bandas 0..255 (graves→agudos, escala log), 64 muestras de onda 0..255 (128 = 0)]`.

Estéreo → teléfono (`{"t":"cmd","a":…,"v":…}`):
- sin valor: `music.toggle`, `music.play`, `music.pause`, `music.next`, `music.prev`
- con valor:
  - `music.seek` (segundos)
  - `music.playIdx` (índice en la cola)
  - `music.shuffle` (bool)
  - `music.repeat` (`"off"`, `"all"` o `"one"`)
  - `music.vol` (0..1)

## GPS (`js/gps.js`, sin comandos)

- `{"t":"gps","lat","lon","acc":m,"hdg":grados|null,"spd":m/s|null,"ts":epoch_ms}`, en cada posición nueva (~1 Hz).
  - Si el GPS no da el rumbo, `hdg` se calcula con dos posiciones separadas por más de 8 m.

## Navegación (`js/nav.js` + `js/router.worker.js`, prefijo `nav.`)

Teléfono → estéreo:
- `{"t":"route","id":n,"dest":{"name","lat","lon"},"pts":[[lat,lon],…],"man":[…],"len":m,"time":s}`
  - `pts` es la geometría completa de la ruta, con 5 decimales.
  - Cada maniobra de `man` es `{"i":índice en pts,"d":metros desde el inicio,"type":"turn|curve|arrive|start","dir":"left|right|straight|uturn","sev":"slight|normal|sharp","angle":grados,"name":"calle siguiente","grade":1..6}`.
    - `grade` es la nota de curva estilo rally: 1 = horquilla … 6 = casi recta.
- `{"t":"nav","id":n,"next":índice en man,"dnext":m,"done":m,"remain":m,"eta":s,"off":bool,"street":"calle actual","limit":km/h|0}`
  - En cada posición nueva mientras hay ruta.
- `{"t":"navoff"}` al terminar o cancelar.
- `{"t":"navstatus","map":bool,"graph":bool,"msg":"texto"}`
  - Dice si hay datos de mapa y grafo. Se manda en `resend()` y cuando cambia.

Estéreo → teléfono:
- `nav.go` con `v:{lat,lon,name}`
- `nav.stop`
- `nav.voice` con `v:"normal"|"copiloto"|"off"`

La voz se genera **en el teléfono** con `speechSynthesis` (es-MX/es-ES) y suena por el Bluetooth del estéreo.

## Viajes, odómetro y mantenimiento (`js/trips.js`, prefijo `trips.` y `maint.`)

Teléfono → estéreo:
- `{"t":"odo","km":total,"items":[{"id","name","everyKm","everyMonths","lastKm","lastDate":"YYYY-MM-DD"|null,"leftKm","leftDays"|null,"pct":0..1+}]}`
- `{"t":"trips","items":[{"id","start":epoch_ms,"end":epoch_ms,"km","maxSpeed","avgSpeed","fuel":L|null}]}`
  - Con los más recientes primero.
- `{"t":"trip","id","summary":{…igual que arriba},"pts":[[lat,lon,kmh],…]}`
  - Es la respuesta a `trips.get`.

Estéreo → teléfono:
- `trips.list`
- `trips.get` con `v:id`
- `maint.done` con `v:id` (marca "hecho hoy" con el km actual)
- `maint.setOdo` con `v:km` (calibra el odómetro al valor real del tablero)

## Cluster (ya existe)
- Teléfono → estéreo:
  - `{"t":"obd",…}` 10 veces por segundo
  - `{"t":"cfg",…}`
- Estéreo → teléfono: `{"t":"cmd","a":"mode","v":"eco|normal|sport"}`

## Datos de mapa (los genera `tools/mapa/descargar.py`; el hub los sirve desde `/datos/mapa/`)

La carpeta `datos/` no se sube a git. Las coordenadas van en **enteros de 1e-5 grados**. Las clases de vía son:

| Código | Vía |
|---|---|
| 0 | motorway |
| 1 | trunk |
| 2 | primary |
| 3 | secondary |
| 4 | tertiary |
| 5 | unclassified |
| 6 | residential |
| 7 | living_street |
| 8 | service |

Los `*_link` usan la clase de su vía principal.

- `meta.json`: `{"version":1,"bbox":[s,w,n,e],"tile":0.01,"created":"ISO","ways":n,"nodes":n,"places":n}`
- `tiles/{tx}_{ty}.json`, con `tx=floor(lon/0.01)` y `ty=floor(lat/0.01)` (pueden ser negativos, por ejemplo `-9874_2012.json`).
  - Contenido: `{"names":[…],"roads":[[cls,nameIdx|-1,maxspeed|0,lat0,lon0,dlat1,dlon1,dlat2,dlon2,…]]}`.
  - Las coordenadas van en deltas respecto al punto anterior.
  - Una vía aparece en cada tile que toca.
- `grafo.json`: `{"names":[…],"lat":[…],"lon":[…],"ways":[[cls,nameIdx|-1,maxspeed|0,oneway,n0,n1,…]]}`.
  - `oneway`: 0 = doble sentido, 1 = sentido de los nodos, -1 = contrario.
  - `n*` son índices en `lat/lon`.
- `lugares.json`: `[[nombre,lat,lon,"tipo"],…]`, con coordenadas en grados (float).
  - `tipo` es `"calle"` o el valor de amenity/shop/tourism (por ejemplo `"fuel"`).

## Páginas del estéreo: `pantalla/common.js`

```js
import { Hub, $, esc, startClock } from './common.js';
const hub = new Hub('pantalla-musica');     // role=pantalla-musica
hub.on('track', m => …);                    // por tipo de mensaje ("t")
hub.on('*', m => …);                        // todos los JSON
hub.onBinary(buf => …);                     // ArrayBuffer
hub.on('open', () => …); hub.on('close', () => …);
hub.cmd('music.next');  hub.cmd('music.seek', 42);
hub.motor                                    // true si el teléfono (role motor*) está conectado
startClock($('#clock'));                     // HH:MM
```
