@echo off
title Clio Cluster
cd /d "%~dp0"
echo.
echo  ===== Clio Cluster =====
echo  Servidor local en http://localhost:8080
echo  Deja esta ventana abierta mientras usas la app (o instala la app y ya no hara falta).
echo.

set "URL=http://localhost:8080"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

set "BROWSER=msedge"
if exist "%CHROME%" set "BROWSER=%CHROME%"

rem Abre el navegador (Chrome o Edge: soportan Web Serial) 2 segundos despues de iniciar el servidor
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 2; Start-Process '%BROWSER%' '%URL%'"

where python >nul 2>nul
if %errorlevel%==0 (
  python -m http.server 8080 --bind 127.0.0.1
) else (
  npx --yes http-server -p 8080 -a 127.0.0.1 -c-1
)
