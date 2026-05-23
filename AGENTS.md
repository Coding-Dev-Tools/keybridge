# Command Code Proxy — Project Instructions

This is a Bun-based proxy server that creates OpenAI-compatible endpoints for the Command Code API.

## Project Status

**Functional and ready for use.** Core features working:
- Non-streaming chat completions ✅
- Streaming chat completions ✅
- Tool calls (function tools, tool-calls) ✅
- Model list endpoint ✅
- Health check endpoint ✅
- Opencode auto-configuration ✅
- Web dashboard with multi-key management ✅
- Key quota/balance (monthlyCredits) display per key ✅
- Real user name (userName) display per key ✅
- Auto-validate all keys on dashboard load ✅

## Architecture

```
OpenAI SDK Client → Proxy (port 3000) → Command Code API (/alpha/generate)
```

The proxy:
1. Accepts OpenAI-format requests at `/v1/chat/completions`
2. Converts them to Command Code format
3. Forwards to `https://api.commandcode.ai/alpha/generate`
4. Parses SSE events and converts back to OpenAI format

## Key Files

- `proxy.js` — Main proxy server (Bun)
- `start.cmd` — Windows startup script
- `.env` — Environment configuration (API key)
- `.env.example` — Example environment file
- `README.md` — Documentation
- `AGENTS.md` — This file (project memory)

## Opencode Auto-Configuration

On startup, the proxy creates/updates `%USERPROFILE%\.opencode\opencode.json` with:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "commandcode": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Command Code Proxy",
      "options": {
        "baseURL": "http://localhost:3000/v1"
      },
      "models": {
        "deepseek/deepseek-v4-pro": { "name": "DeepSeek V4 Pro" },
        "deepseek/deepseek-v4-flash": { "name": "DeepSeek V4 Flash" },
        "MiniMaxAI/MiniMax-M2.7": { "name": "MiniMax M2.7" },
        "Qwen/Qwen3.6-Plus": { "name": "Qwen 3.6 Plus" },
        "zai-org/GLM-5.1": { "name": "GLM 5.1" },
        "moonshotai/Kimi-K2.6": { "name": "Kimi K2.6" }
      }
    }
  }
}
```

This allows opencode users to connect via `/connect` command without manual configuration.

## Environment Variables

```env
COMMAND_CODE_API_KEY=    # Required: your Command Code API key
COMMAND_CODE_API_URL=    # Default: https://api.commandcode.ai
COMMAND_CODE_CLI_VERSION= # Default: 0.26.24
PROXY_PORT=              # Default: 3000
```

## Running

```cmd
set COMMAND_CODE_API_KEY=your_key_here
bun run proxy.js
```

Or use `start.cmd` which handles cleanup automatically.

## Command Code API Notes

### Request Format

```json
{
  "config": {
    "workingDir": "C:\\...",
    "date": "2026-05-23",
    "environment": "win32-x64",
    "structure": [],
    "isGitRepo": false,
    "currentBranch": "main",
    "mainBranch": "main",
    "gitStatus": "",
    "recentCommits": []
  },
  "memory": "",
  "taste": "",
  "skills": null,
  "permissionMode": "standard",
  "params": {
    "model": "deepseek/deepseek-v4-flash",
    "messages": [...],
    "tools": [...],
    "system": "",
    "max_tokens": 4096,
    "temperature": 0.3,
    "stream": true
  },
  "threadId": "uuid-v4"
}
```

### Response Events (SSE)

- `text-delta` — text content chunk (use `.text` field)
- `tool-input-start/delta/end` — incremental tool input building
- `tool-call` — completed tool call (use `.toolCallId`, `.toolName`, `.input`)
- `finish` / `finish-step` — final response with usage
- `error` — upstream error in SSE format

### Message Conversion

**OpenAI → Command Code:**
- `system` → extracted to `params.system`
- `user` → `{role:'user', content: 'text'}`
- `assistant` with `tool_calls` → `{role:'assistant', content:[], tool_calls:[...]}`
- `tool` role → `{role:'user', content: 'tool result as string'}`

**Tool result must be plain string** — API rejects array content for tool role messages.

### Tool Call Flow

1. Assistant message includes `tool_calls` array
2. Tool result sent as user message with plain string content
3. API responds with final text

## Supported Models

- `deepseek/deepseek-v4-pro` — DeepSeek Pro
- `deepseek/deepseek-v4-flash` — DeepSeek Flash (fast)
- `MiniMaxAI/MiniMax-M2.7` — MiniMax M2.7
- `Qwen/Qwen3.6-Plus` — Qwen 3.6 Plus
- `zai-org/GLM-5.1` — GLM 5.1
- `moonshotai/Kimi-K2.6` — Kimi K2.6

## Known Issues

1. **Message content array handling** — Some OpenAI clients send content as array with `{type:'text',text:'...'}` format. The proxy converts this to plain string.

2. **Tool choice** — Only `"auto"` and `"none"` supported. Forced tool selection returns error.

3. **Stream options** — `stream_options.include_usage` partially implemented (usage in final chunk only).

4. **Model validation** — No model allowlist enforcement. Unknown models passed upstream.

## Reference

- **Original bridge**: https://github.com/yelixir-dev/commandcode-bridge
- **Command Code API docs**: https://commandcode.ai/docs
- **OpenAI Chat API**: https://platform.openai.com/docs/api-reference/chat