@echo off
setlocal

set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
set "NEXT_BIN=%~dp0node_modules\next\dist\bin\next"

if not exist "%NODE_EXE%" (
  echo Bundled Node.js was not found:
  echo %NODE_EXE%
  echo.
  echo Install Node.js globally or run this project from Codex again.
  exit /b 1
)

if not exist "%NEXT_BIN%" (
  echo Next.js bin was not found:
  echo %NEXT_BIN%
  exit /b 1
)

echo Starting AgriAI on LAN:
echo   Local:   http://127.0.0.1:3000
echo   ESP32:   http://192.168.0.184:3000
echo.
echo If port 3000 is busy, stop the old server with Ctrl+C first.
echo.

"%NODE_EXE%" "%NEXT_BIN%" dev -H 0.0.0.0 -p 3000
