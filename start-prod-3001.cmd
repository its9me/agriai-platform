@echo off
cd /d "%~dp0"
echo Starting AgriAI platform in stable production mode on http://0.0.0.0:3001
echo Use http://127.0.0.1:3001 on this laptop, or http://192.168.0.184:3001 from ESP32/LAN.
"C:\Users\alial\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" ".\node_modules\next\dist\bin\next" start -H 0.0.0.0 -p 3001
pause
