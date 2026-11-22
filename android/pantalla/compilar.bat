@echo off
rem Compila la app de la pantalla del estereo y deja el APK en dist\clio-pantalla.apk
cd /d "%~dp0"
if not defined JAVA_HOME for /d %%J in ("%USERPROFILE%\.jdks\jdk-17*") do set "JAVA_HOME=%%~fJ"
if not exist local.properties echo sdk.dir=%LOCALAPPDATA:\=/%/Android/Sdk> local.properties
call "%~dp0gradlew.bat" --no-daemon -q assembleDebug || (pause & exit /b 1)
copy /y app\build\outputs\apk\debug\app-debug.apk ..\..\dist\clio-pantalla.apk >nul
echo Listo: dist\clio-pantalla.apk
