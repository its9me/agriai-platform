@echo off
setlocal

set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
set "NEXT_BIN=%~dp0node_modules\next\dist\bin\next"

echo Starting AgriAI on LAN port 3001:
echo   Local:   http://127.0.0.1:3001
echo   ESP32:   http://192.168.0.184:3001
echo.

"%NODE_EXE%" "%NEXT_BIN%" dev -H 0.0.0.0 -p 3001
