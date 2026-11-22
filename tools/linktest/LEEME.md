# Fase 0: prueba de enlace teléfono ↔ estéreo

Objetivo: comprobar que el estéreo puede mostrar datos que vienen del teléfono, y medir qué tan rápido dibuja el estéreo
y si los botones del volante llegan al navegador.

**Esquema:** el estéreo no instala nada, porque no tiene USB ni microSD.
- Todo corre en el **teléfono**: Termux con el hub, y más adelante la app motor (OBD, GPS y música).
- El estéreo solo abre una página en su Chrome.
- Los dos se conectan por el **hotspot del teléfono**. Es una red local: **no necesita datos móviles** y casi no
  usa ancho de banda (unos KB/s), así que basta con una señal débil a un metro de distancia.

```
TELÉFONO  Termux: python hub/hub.py  ──hotspot WiFi (sin datos)──►  ESTÉREO  Chrome: http://<ip-teléfono>:8080/
```

Al terminar, la pestaña **Reporte** genera un texto para pegarlo en el chat.

## 1. Probar en la PC (opcional)

Doble clic en `hub.bat` y abre dos ventanas en `http://localhost:8080/tools/linktest/`:
en una elige **WiFi → Receptor** y en la otra **WiFi → Emisor**.

## 2. Preparar el teléfono (una vez)

1. Instala **Termux** con el APK oficial de <https://github.com/termux/termux-app/releases/latest>
   (`…github-debug_arm64-v8a.apk`, o `universal` si no estás seguro). Android pedirá permitir "instalar apps desconocidas".
2. En Termux, con datos o WiFi de casa:
   ```sh
   pkg install python git
   git clone -b fase0-enlace https://github.com/FierceWo1f/clio-cluster.git
   ```
3. Para actualizar más adelante: `cd clio-cluster && git pull`.

## 3. En el auto

1. En el teléfono, activa el **hotspot (Zona Wi-Fi)**. Los datos móviles pueden estar apagados.
2. En el estéreo, conéctate a esa red WiFi. Si avisa "sin internet", elige mantener la conexión.
3. En Termux:
   ```sh
   cd clio-cluster && python hub/hub.py
   ```
   El hub muestra las direcciones disponibles. Usa la de la interfaz del hotspot (`ap0`, `swlan0`, `wlan1`…),
   que se ve como `http://192.168.x.x:8080/tools/linktest/`.
4. En el **Chrome del estéreo**, abre esa dirección y guárdala en favoritos.
   - **Equipo**: muestra la versión de Chrome, si tiene "Web Bluetooth" y la GPU.
   - **Pantalla**: toca "Correr las tres" (tarda ~25 s).
   - **Teclas**: presiona los botones del volante.
   - **WiFi → Receptor**.
5. En el **teléfono**, abre en Chrome `http://localhost:8080/tools/linktest/` y toca **WiFi → Emisor** a 30 Hz.
   Déjalo 1–2 minutos **con música sonando por Bluetooth**.
6. Toca **Detener** en los dos y copia el **Reporte** de cada uno.

Valores buenos: RTT p95 < 50 ms, hueco OBD máx < 200 ms y sin cortes en la música.

## Si la señal WiFi del estéreo es mala

Estos estéreos traen una **antena WiFi** (un cable negro delgado, a veces con un conector pequeño) y otra de **GPS**
entre los cables de atrás. Si la antena WiFi quedó desconectada o enrollada detrás del tablero, la señal es muy débil.
Revisa que esté conectada y fuera del metal.

## Bluetooth (más adelante)

Web Bluetooth solo funciona en páginas "seguras" (https o localhost). Como el estéreo abre la página del teléfono por
`http://192.168…`, primero hay que activar en el estéreo `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
con esa dirección. Después se prueba con **nRF Connect** en el teléfono como servidor "Nordic UART". La pestaña
Bluetooth de la página ya está lista para eso.
