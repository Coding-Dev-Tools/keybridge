@echo off
setlocal enabledelayedexpansion
:: Command Code Proxy - Start Script

echo Starting Command Code Proxy...

:: Kill existing proxy by window title
taskkill /FI "WINDOWTITLE eq Command Code Proxy*" /F 2>nul
timeout /t 1 /nobreak >nul

:: Start the proxy
if not defined PROXY_PORT set PROXY_PORT=3000
echo Starting proxy server on port %PROXY_PORT%...
title Command Code Proxy
node proxy.js

if errorlevel 1 (
    echo Proxy failed to start
    pause
)
