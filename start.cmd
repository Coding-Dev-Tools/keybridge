@echo off
setlocal enabledelayedexpansion
:: Command Code Proxy - Start Script

echo 🚀 Starting Command Code Proxy...

:: Set the Bun path
set BUN_PATH=C:\WINDOWS\system32\config\systemprofile\.bun\bin
set PATH=%BUN_PATH%;%PATH%

:: Kill all bun.exe processes first
echo 🔥 Killing existing bun processes...
taskkill /F /IM bun.exe 2>nul

timeout /t 2 /nobreak >nul

:: Start the proxy
echo 🔗 Starting proxy server on port 3000...
if "%COMMAND_CODE_API_KEY%"=="" (
    echo ⚠️ COMMAND_CODE_API_KEY not set. Please set it via: setx COMMAND_CODE_API_KEY "your_key"
    pause
    exit /b 1
)
call bun run proxy.js

if errorlevel 1 (
    echo ❌ Proxy failed to start
    pause
)