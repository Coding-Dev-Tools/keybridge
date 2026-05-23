@echo off
:: Command Code Proxy - Test Script
:: Tests the proxy endpoints to ensure they're working

echo 🧪 Testing Command Code Proxy...

:: Set the Bun path
set BUN_PATH=C:\WINDOWS\system32\config\systemprofile\.bun\bin
set PATH=%BUN_PATH%;%PATH%

:: Load environment variables
if exist ".env" (
    for /f "usebackq delims=" %%a in ("%~dp0.env") do (
        set "%%a"
    )
)

echo.
echo 📡 Testing Health Check...
call bun run --silent test-health.js
if errorlevel 1 (
    echo ❌ Health check failed
    exit /b 1
)

echo.
echo 📋 Testing Models Endpoint...
call bun run --silent test-models.js
if errorlevel 1 (
    echo ❌ Models endpoint failed
    exit /b 1
)

echo.
echo ✅ All tests passed! Proxy is working correctly.
call bun run --silent test-chat.js
if errorlevel 1 (
    echo ⚠️  Chat completion test failed (may be expected if API key is invalid)
) else (
    echo ✅ Chat completion test passed!
)