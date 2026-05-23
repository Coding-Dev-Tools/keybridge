# Command Code Proxy

**Inspired by [commandcode-bridge](https://github.com/yelixir-dev/commandcode-bridge)**

A Bun-based proxy that creates OpenAI-compatible endpoints for the Command Code API (`api.commandcode.ai`). This proxy lets any OpenAI-compatible client use Command Code's models directly.

## Features

- ✅ **OpenAI-compatible `/v1/*` endpoints**
- ✅ **Streaming and non-streaming chat completions**
- ✅ **Tool calling support** (function tools, tool-calls, tool-results)
- ✅ **Reasoning events** (hidden by default, maps to internal reasoning)
- ✅ **Multi-model support** (DeepSeek, MiniMax, Qwen, GLM, Kimi)
- ✅ **Usage statistics** (input/output tokens, cache hits)
- ✅ **Health check endpoint** with CLI version reporting
- ✅ **Proper SSE chunk formatting** per OpenAI spec
- ✅ **Web Dashboard** with API key management

## Quick Start

```cmd
set COMMAND_CODE_API_KEY=your_key_here
bun run proxy.js
```

Proxy runs on `http://localhost:3000`

### Web Dashboard

Open your browser to `http://localhost:3000/dashboard` to access the web dashboard where you can:

- Manage multiple API keys
- Enable/disable models
- Configure proxy settings
- Monitor proxy health
- Test connections

## Opencode Integration

The proxy automatically creates an opencode configuration file at `%USERPROFILE%\.opencode\opencode.json` when it starts. This configures opencode to use the proxy as a provider.

**To use with opencode:**

1. Start the proxy
2. Run `opencode` in your terminal
3. Run `/connect` and select **Command Code Proxy**
4. Run `/models` and select a model

The config includes all supported models:
- DeepSeek V4 Pro
- DeepSeek V4 Flash
- MiniMax M2.7
- Qwen 3.6 Plus
- GLM 5.1
- Kimi K2.6

## API Endpoints

### Dashboard

#### `GET /dashboard`

Web-based dashboard for managing API keys and proxy configuration.

Access at: `http://localhost:3000/dashboard`

### Management API

#### `GET /api/config`

Get current proxy configuration.

#### `POST /api/config`

Update proxy configuration.

#### `GET /api/keys`

List all configured API keys.

#### `POST /api/keys`

Add a new API key.

#### `PUT /api/keys`

Update an existing API key.

#### `DELETE /api/keys`

Delete an API key.

#### `GET /api/models`

List all models with enabled status.

#### `POST /api/models`

Update model enabled status.

#### `POST /api/restart`

Initiate proxy restart.

### Standard Endpoints

### `GET /health`

Health check with version info.

```json
{"status":"ok","version":"1.0.0","cli_version":"0.26.24"}
```

### `GET /v1/models`

List available models.

```json
{
  "object": "list",
  "data": [
    {"id": "deepseek/deepseek-v4-pro", "object": "model", "created": 1234567890, "owned_by": "deepseek"},
    {"id": "deepseek/deepseek-v4-flash", "object": "model", "created": 1234567890, "owned_by": "deepseek"},
    ...
  ]
}
```

### `POST /v1/chat/completions`

Create a chat completion.

**Non-streaming:**
```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer any-key" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "say hello in 3 words"}]
  }'
```

**Streaming:**
```bash
curl -N -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer any-key" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "count to 5"}],
    "stream": true
  }'
```

**With tools:**
```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer any-key" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "what time is it?"}],
    "tools": [{"type": "function", "function": {"name": "get_time", "parameters": {"type": "object"}}}]
  }'
```

## Supported Models

| Model ID | Enabled | Provider |
|----------|---------|----------|
| `deepseek/deepseek-v4-pro` | ✅ | DeepSeek |
| `deepseek/deepseek-v4-flash` | ✅ | DeepSeek |
| `MiniMaxAI/MiniMax-M2.7` | ✅ | MiniMax |
| `Qwen/Qwen3.6-Plus` | ✅ | Qwen |
| `zai-org/GLM-5.1` | ✅ | ZAI |
| `moonshotai/Kimi-K2.6` | ✅ | Moonshot |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COMMAND_CODE_API_KEY` | **required** | Your Command Code API key |
| `COMMAND_CODE_API_URL` | `https://api.commandcode.ai` | API base URL |
| `COMMAND_CODE_CLI_VERSION` | `0.26.24` | CLI version header |
| `PROXY_PORT` | `3000` | Proxy server port |

## Configuration File

The proxy stores configuration in `proxy-config.json` in the working directory. This includes:

- API keys (multiple keys supported)
- Model enabled/disabled status
- Bind host and port settings
- API URL and CLI version

The web dashboard automatically reads/writes this file.

## Message Format

### Request Conversion (OpenAI → Command Code)

| OpenAI Role | Command Code Role |
|-------------|------------------|
| `system` | `system` (extracted to `params.system`) |
| `user` | `user` with text content |
| `assistant` | `assistant` with optional `tool_calls` |
| `tool` | `user` (tool result as plain string) |

### Response Conversion (Command Code → OpenAI)

| Command Code Event | OpenAI Format |
|--------------------|---------------|
| `text-delta` | `delta.content` chunk |
| `tool-input-start/delta/end` | `delta.tool_calls` chunk |
| `tool-call` | `delta.tool_calls` chunk |
| `finish` | final chunk with `finish_reason` and `usage` |
| `error` | error chunk with `finish_reason: 'error'` |

## Tool Calls

The proxy fully supports OpenAI tool-calls:

1. **Tool definitions** → `params.tools` array with `{name, input_schema}`
2. **Tool call events** → SSE chunks with `delta.tool_calls`
3. **Tool results** → sent as `user` message with tool result content

## Architecture

```
OpenAI Client
     │
     ▼
POST /v1/chat/completions
     │
     ▼
Proxy (Bun.serve)
     │
     ├── Converts OpenAI → Command Code format
     │
     ▼
POST /alpha/generate (Command Code API)
     │
     ▼
SSE stream parsing
     │
     ├── text-delta, tool-call, finish, error events
     │
     ▼
Converts → OpenAI SSE chunks
     │
     ▼
OpenAI Client
```

## Known Limitations

- `tools` parameter requires proper OpenAI function format
- `tool_choice` must be `"auto"` or `"none"` (forced tool selection unsupported)
- `response_format` / `json_schema` not fully implemented
- `stream_options.include_usage` sends usage in final chunk

## Security

- Never expose this proxy on public internet without auth
- The proxy injects your `COMMAND_CODE_API_KEY` to upstream calls
- Use firewall/VPN/Auth for non-localhost deployments

## Credits

**Inspired by [commandcode-bridge](https://github.com/yelixir-dev/commandcode-bridge)** by [yelixir-dev](https://github.com/yelixir-dev).

This implementation is a simplified Bun-based version of the original TypeScript bridge, focused on single-key operation without the multi-key routing infrastructure.

## License

MIT — Use at your own risk.