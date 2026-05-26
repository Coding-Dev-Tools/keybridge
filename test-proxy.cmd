@echo off
setlocal
:: Command Code Proxy - Test Script
:: Runs the smoke test against the local proxy

echo Testing Command Code Proxy...

node test-proxy.js
if errorlevel 1 (
    echo Test failed
    exit /b 1
)

echo.
echo All tests passed. Proxy is working correctly.
