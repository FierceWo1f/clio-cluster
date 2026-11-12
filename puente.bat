@echo off
title Clio Cluster - Puente de red (ELM327 WiFi)
cd /d "%~dp0"
set "PY=%~dp0emulador\.venv\Scripts\python.exe"
if not exist "%PY%" (
  python -m venv emulador\.venv
  "%PY%" -m pip install --disable-pip-version-check -q ELM327-emulator websockets
)
echo Conecta la PC a la red WiFi del ELM327 y en la app elige "Red" con 192.168.0.10 : 35000
"%PY%" emulador\puente.py
