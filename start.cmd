@echo off
setlocal enabledelayedexpansion
:: Command Code Proxy - Start Script

echo 🚀 Starting Command Code Proxy...

:: Set the Bun path
set BUN_PATH=C:\WINDOWS\system32\config\systemprofile\.bun\bin
set PATH=%BUN_PATH%;%PATH%

:: Kill existing proxy by window title
echo 🔍 Checking for existing proxy instance...
taskkill /FI "WINDOWTITLE eq Command Code Proxy*" /F 2>nul
timeout /t 1 /nobreak >nul

:: Load .env file
echo 📄 Loading .env file...
if exist ".env" (
    for /f "tokens=1,* delims==" %%a in ('findstr /r /c:"^COMMAND_CODE_API_KEY=" .env') do (
        set COMMAND_CODE_API_KEY=%%b
    )
)

:: Start the proxy
echo 🔗 Starting proxy server on port 3000...
if "%COMMAND_CODE_API_KEY%"=="" (
    echo ⚠️ COMMAND_CODE_API_KEY not set in .env file
    pause
    exit /b 1
)
title Command Code Proxy
call node proxy.js

if errorlevel 1 (
    echo ❌ Proxy failed to start
    pause
)