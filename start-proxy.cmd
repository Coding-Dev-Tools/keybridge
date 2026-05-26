@echo off
setlocal
:: Copy .env.example to .env and set your keys, then run this script.
:: PROXY_API_KEY and COMMAND_CODE_API_KEY must be set before starting.
if not defined PROXY_PORT set PROXY_PORT=3456
if not defined PROXY_BIND_HOST set PROXY_BIND_HOST=0.0.0.0
node proxy.js
