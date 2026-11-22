# Fase 0: prueba de enlace teléfono ↔ estéreo

Objetivo: medir en el auto si conviene **WiFi** o **Bluetooth** para mandar los datos del teléfono (OBD, GPS y música)
a la pantalla del estéreo. Además se revisa qué tan rápido dibuja el estéreo y si los botones del volante llegan al navegador.

Todo se hace con la página `tools/linktest/`, que sirve el hub (`hub/hub.py`, solo Python estándar).
Al terminar, la pestaña **Reporte** genera un texto para pegarlo en el chat.

## 1. Probar en la PC (opcional)

Doble clic en `hub.bat`, luego abre dos ventanas en `http://localhost:8080/tools/linktest/`:
en una elige **WiFi → Receptor** y en la otra **WiFi → Emisor**.

## 2. Preparar el estéreo (una vez)

1. Instala **Termux** desde F-Droid (la versión de Play Store ya no se actualiza) y, si quieres que el hub arranque solo,
   **Termux:Boot**.
2. En Termux:
   ```sh
   pkg install python git
   git clone https://github.com/FierceWo1f/clio-cluster.git
   cd clio-cluster
   python hub/hub.py
   ```
3. Abre Chrome en el estéreo con `http://localhost:8080/tools/linktest/`.
   - **Equipo**: anota la versión de Chrome, si dice "Web Bluetooth: sí" y la GPU.
   - **Pantalla**: toca "Correr las tres" (tarda ~25 s).
   - **Teclas**: presiona los botones del volante.

## 3. Prueba WiFi

1. En el estéreo: Ajustes → Red → **Punto de acceso WiFi** (hotspot) activado. No necesita internet ni SIM.
2. Conecta el teléfono a esa red. Si dice "sin internet", elige mantener la conexión; tus datos móviles siguen funcionando.
3. En el estéreo: página de prueba → **WiFi → Receptor**.
4. En el teléfono, abre `http://192.168.43.1:8080/tools/linktest/`. Si no carga, busca la IP del estéreo en
   Termux con `ip addr`. Luego toca **WiFi → Emisor** a 30 Hz.
5. Déjalo 1–2 minutos **con música sonando por Bluetooth** y con el ELM327 conectado a la app del cluster.
6. Toca **Detener** en los dos y copia el **Reporte** de cada uno.

Valores buenos: RTT p95 < 50 ms, hueco OBD máx < 200 ms y sin cortes en la música.

## 4. Prueba Bluetooth (sin programar nada)

Solo confirma que el estéreo puede conectarse al teléfono por BLE desde el navegador.

1. En el teléfono, instala **nRF Connect for Mobile** (Nordic).
2. Menú ☰ → **Configure GATT server** → agrega la configuración de ejemplo con **Nordic UART Service**.
3. Pestaña **Advertiser** → crea un anuncio que incluya el servicio NUS (`6E400001-…`) y actívalo.
4. En el estéreo (página abierta desde `localhost`): **Bluetooth → Conectar** y elige el teléfono.
5. En nRF Connect, en la conexión entrante, manda un valor (texto) a la característica **TX** (`6E400003-…`).
   Debe aparecer en la página del estéreo. "Enviar hola" debe llegar a la característica RX del teléfono.

Si esto funciona, el siguiente paso es una app BLE mínima en el teléfono que mande datos al mismo ritmo que la prueba WiFi,
para comparar los dos enlaces con música sonando. La página del estéreo ya responde a sus pings (`P<id>` → `Q<id>`).

## Qué mandar de regreso

El texto de **Reporte** del estéreo y del teléfono, más tus notas: si la música se cortó, si el hotspot funcionó, etc.
