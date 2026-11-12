@echo off
title Clio Cluster - Emulador
cd /d "%~dp0"
set "PY=%~dp0emulador\.venv\Scripts\python.exe"

if not exist "%PY%" (
  echo Instalando el emulador por primera vez...
  python -m venv emulador\.venv || goto :error
  "%PY%" -m pip install --disable-pip-version-check -q ELM327-emulator websockets || goto :error
)

set "ESCENARIO=%~1"
if "%ESCENARIO%"=="" set "ESCENARIO=car"

echo.
echo  ===== Emulador ELM327 =====
echo  Escenario: %ESCENARIO%   (otros: engineoff, default)
echo  Emulador en 127.0.0.1:35000  ^|  Puente para la app en ws://127.0.0.1:35001
echo.
echo  En la app: Conectar -^> "Red: emulador o ELM327 WiFi" -^> 127.0.0.1 : 35000
echo  En esta ventana puedes escribir comandos del emulador, por ejemplo:
echo     scenario engineoff     (cambia a motor apagado)
echo     help                   (lista de comandos)
echo.

start "Clio Cluster - Puente" /min "%PY%" emulador\puente.py
rem El emulador escribe elm.log en la carpeta actual: lo dejamos dentro de "emulador"
cd emulador
"%PY%" emulador.py -n 35000 -s %ESCENARIO%
goto :eof

:error
echo.
echo No se pudo instalar el emulador. Verifica que Python este instalado.
pause
