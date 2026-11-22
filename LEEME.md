# Clio Cluster

Cluster digital y herramienta de diagnóstico OBD-II para el **Renault Clio II 1.6 16V (2002)** con un adaptador **ELM327**.
Es una app web (PWA) que se instala en la PC y funciona sin internet.

## Cómo usarla

1. Doble clic en **`iniciar.bat`**. Se abre Chrome o Edge en `http://localhost:8080`.
2. Clic en **Conectar** y elige:
   - **Bluetooth clásico / USB (puerto COM)**: para la mayoría de los ELM327 Bluetooth.
   - **Bluetooth LE**: para adaptadores BLE.
   - **Simulador**: un Clio virtual para probar en casa.
3. Para instalarla, usa el botón **⬇ Instalar en la PC** (o el ícono de instalar en la barra de direcciones).
   Después se abre desde el menú Inicio, incluso sin `iniciar.bat`.

> Usa Chrome o Edge. Firefox no soporta Web Serial ni Web Bluetooth.

## Probar sin el auto

Hay dos formas:

| | Simulador integrado | Emulador ELM327-emulator |
|---|---|---|
| Cómo | Conectar → **Simulador integrado** | Doble clic en **`emulador.bat`**, luego Conectar → **Red** → `127.0.0.1 : 35000` |
| Protocolo | Línea K, como tu Clio | CAN (auto moderno) |
| Datos | Manejo realista (acelera, cambia marchas, se calienta) | Valores aleatorios, 47 PIDs, VIN, monitores |
| Sirve para | Ver el cluster y la interfaz | Probar el driver con un ELM "de verdad" por red |

`emulador.bat` abre dos ventanas: el emulador y el puente de red (minimizado). En la ventana del emulador
se pueden escribir comandos, por ejemplo `scenario engineoff` (motor apagado) o `help`.
Para usar otro escenario desde el inicio: `emulador.bat engineoff`.

`puente.bat` sirve para conectar un **ELM327 WiFi** real. Conecta la PC a la red WiFi del ELM y en la app
elige Red → `192.168.0.10 : 35000`.

## Emparejar el ELM327 Bluetooth en Windows

1. Conecta el ELM327 al puerto OBD del auto y pon el contacto en ON.
2. Configuración → Bluetooth y dispositivos → Agregar dispositivo → Bluetooth → **OBDII**. El PIN es `1234` o `0000`.
3. Windows crea uno o dos puertos COM. En la app elige "Conexión serie estándar por vínculo Bluetooth (COMx)".
   Si no responde, prueba con el otro COM.

## Funciones

- **Cluster**: tacómetro, velocímetro, marcha estimada, temperatura, luces de cambio, testigos (check engine, temperatura, batería), viaje, consumo instantáneo y promedio.
- **Modos de manejo** (botones arriba del cluster o teclas `E` / `N` / `S`):
  - **ECO**: banda verde hasta 2500 rpm, flecha ▲ para subir de marcha a tiempo, reloj de consumo.
  - **NORMAL**: cluster estándar, reloj de batería.
  - **SPORT**: banda amarilla del rango óptimo (4000–6000 rpm), flechas ▲▼ y reloj de carga del motor.
  - **Diseño** (botones junto a los modos o teclas `D` / `C`): **Deportivo** (tacómetro con velocidad digital
    y dos relojes pequeños) o **Clásico** (tacómetro y velocímetro separados, con los valores en el centro).
  - Los rangos se ajustan en Ajustes → Modos de manejo. El color (rojo o morado) se cambia en Ajustes → Cluster.
- **Sensores**: todos los PIDs que soporta tu ECU, con mínimo y máximo.
- **Gráficas**: hasta 8 señales en tiempo real (clic en un sensor para agregarlo).
- **Diagnóstico**: leer y borrar códigos de falla, códigos pendientes, monitores de preparación, freeze frame y VIN.
- **Consola**: enviar comandos AT y OBD directamente al ELM327.
- **Grabar**: guarda todos los datos en un archivo CSV que se abre con Excel.

## Notas sobre el Clio 2002

- Usa el protocolo ISO 14230 (KWP2000, línea K), que es lento: unas 8 a 15 lecturas por segundo en total.
  La app lee más seguido RPM y velocidad, y la temperatura cada pocos segundos.
- No tiene sensor MAF, así que el consumo se **estima** con MAP, RPM y temperatura.
  Ajusta la "Eficiencia volumétrica" en Ajustes comparando con lo que realmente cargas de gasolina.
- Calibra las marchas en Ajustes → Marchas → "Usar actual" para que la marcha estimada sea exacta.
- Por OBD estándar no se pueden leer odómetro, direccionales, puertas ni nivel de combustible.
  Eso requiere comandos propios de Renault (se puede experimentar en la Consola).

## Estructura

```
index.html            interfaz
css/app.css           estilos
js/app.js             lógica de la app, lectura continua, alertas, consumo
js/elm327.js          driver del ELM327 (comandos AT, OBD, DTC)
js/transport.js       conexión: Web Serial, Web Bluetooth, simulador
js/simulator.js       ECU simulada del Clio
js/pids.js            PIDs OBD-II y fórmulas
js/dtc.js             códigos de falla y descripciones
js/gauges.js          relojes analógicos
js/chart.js           gráfica en tiempo real
sw.js, manifest       instalación como app (PWA) y modo sin conexión
emulador/emulador.py  lanza ELM327-emulator (con corrección para Windows)
emulador/puente.py    puente WebSocket <-> TCP (emulador o ELM327 WiFi)
emulador/.venv        Python aislado con el emulador instalado
hub/hub.py            hub web + relay WebSocket; corre en el teléfono (Termux), solo Python estándar
tools/linktest/       prueba de enlace WiFi / Bluetooth (Fase 0), ver tools/linktest/LEEME.md
```
