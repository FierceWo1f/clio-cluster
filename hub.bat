@echo off
title Clio - Hub (web + relay)
cd /d "%~dp0"
echo Abre http://localhost:8080/tools/linktest/  en el navegador.
python hub\hub.py %*
