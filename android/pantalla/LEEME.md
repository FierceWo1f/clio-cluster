# Clio Pantalla (app del estéreo)

Es un cascarón muy pequeño (~25 KB) que convierte el estéreo en la pantalla del teléfono:

- **Busca sola al teléfono.** Con el hotspot del teléfono, el teléfono es la "puerta de enlace" de la red, así que
  la app lo encuentra aunque cambie la IP. También prueba la última IP usada, 192.168.43.1 y una IP manual si la pones.
- **Muestra a pantalla completa** la interfaz web que sirve el hub (`/pantalla/`), sin barra de navegador.
- **Se puede elegir como pantalla de inicio**, así aparece al encender el estéreo o al tocar el botón de inicio.
- **Nunca te deja atrapado.** Mientras no encuentra al teléfono muestra los botones **Apps**, **WiFi**, **IP manual** y **Ajustes**.
  Con el teléfono conectado, **mantén presionado Atrás** o toca "Apps del estéreo" para abrir la radio, el Bluetooth, etc.

Toda la interfaz vive en el teléfono (`pantalla/` en este repo). Para cambiar la interfaz **no hay que reinstalar la app**:
basta con `git pull` en Termux. La app solo se reinstala si cambia este cascarón.

## Instalar en el estéreo (sin USB ni internet)

1. En el teléfono: activa el hotspot, conecta el estéreo a esa red y arranca el hub en Termux:
   `cd clio-cluster && git pull && python hub/hub.py`
2. En el **Chrome del estéreo** abre la dirección que muestra el hub, cambiando el final por el APK:
   `http://192.168.x.x:8080/dist/clio-pantalla.apk`
3. Descárgalo. Si Chrome avisa que el archivo puede ser dañino, elige **Descargar de todos modos**. Luego ábrelo y permite
   **"instalar apps desconocidas"** para Chrome.
4. Toca el botón de **inicio**. Android pregunta qué pantalla de inicio usar: elige **Clio** → **Siempre**.
   Si no pregunta: Ajustes → Apps → Apps predeterminadas → **App de inicio** → Clio.

Para volver a la interfaz del fabricante: Ajustes → Apps → Apps predeterminadas → App de inicio → la original.

## Para la web: `window.ClioShell`

| Función | Qué hace |
|---|---|
| `ClioShell.showApps()` | abre el panel de apps del estéreo |
| `ClioShell.apps()` | JSON `[{label, pkg}]` con las apps instaladas |
| `ClioShell.open(pkg)` | abre una app (por ejemplo, la radio) |
| `ClioShell.settings()` / `ClioShell.wifi()` | abre los ajustes de Android / del WiFi |
| `ClioShell.host()` / `ClioShell.version()` | IP del teléfono / versión del cascarón |

Fuera de la app (en un navegador normal), `window.ClioShell` no existe; la web debe funcionar igual sin él.

## Compilar (en la PC)

Doble clic en `compilar.bat`, que deja el APK en `dist/clio-pantalla.apk`. Necesita:
- el Android SDK (el de Android Studio)
- un JDK 17; el script usa `%USERPROFILE%\.jdks\jdk-17*` si no hay `JAVA_HOME`

**Importante:** el APK se firma con la llave de depuración de la PC (`%USERPROFILE%\.android\debug.keystore`).
Android solo acepta actualizaciones firmadas con la misma llave. Compila siempre en la misma PC, o desinstala la app
del estéreo antes de instalar una versión compilada en otra.
