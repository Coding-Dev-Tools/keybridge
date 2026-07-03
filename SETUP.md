# Universal API Key Router — Setup Guide for All Agents

## Your Local Network

```
Proxy URL:  http://localhost:3456/v1
Dashboard:  http://localhost:3456/dashboard
API Key:    (set via PROXY_API_KEY environment variable)
```

Replace `localhost` with your machine's LAN IP if connecting from other devices on the network.

---

## OpenClaw

OpenClaw uses OpenAI-compatible endpoints. Set these environment variables before starting OpenClaw:

```bash
set OPENAI_BASE_URL=http://localhost:3456/v1
set OPENAI_API_KEY=your_proxy_api_key
```

Or in PowerShell:
```powershell
$env:OPENAI_BASE_URL="http://localhost:3456/v1"
$env:OPENAI_API_KEY="your_proxy_api_key"
```

---

## Hermes / Command Code CLI

Hermes connects to Command Code's native API. Set these to route through the proxy:

```bash
set COMMAND_CODE_API_URL=http://localhost:3456
set COMMAND_CODE_API_KEY=your_proxy_api_key
```

---

## Opencode Agent

Opencode agents use OpenAI-compatible format. Configure:

```bash
set OPENAI_BASE_URL=http://localhost:3456/v1
set OPENAI_API_KEY=your_proxy_api_key
```

---

## Cursor IDE

1. Open Cursor Settings (Ctrl+,)
2. Go to **AI** → **OpenAI API**
3. Set:
   - **Base URL**: `http://localhost:3456/v1`
   - **API Key**: `your_proxy_api_key`
   - **Model**: `deepseek/deepseek-v4-pro` (or any from the list below)

---

## VS Code + Continue.dev

Add to `.vscode/settings.json` or Continue config:

```json
{
  "models": [{
    "title": "Proxy Router",
    "provider": "openai",
    "model": "deepseek/deepseek-v4-pro",
    "apiBase": "http://localhost:3456/v1",
    "apiKey": "your_proxy_api_key"
  }]
}
```

---

## Claude Desktop (Anthropic)

```bash
set ANTHROPIC_BASE_URL=http://localhost:3456/v1
set ANTHROPIC_API_KEY=your_proxy_api_key
```

---

## Any OpenAI-Compatible Tool

All tools that support OpenAI API format work instantly:

```
Base URL: http://localhost:3456/v1
API Key:  your_proxy_api_key
```

---

## Available Models

| Model ID | Provider | Description |
|----------|----------|-------------|
| `deepseek/deepseek-v4-pro` | Command Code | DeepSeek V4 Pro |
| `deepseek/deepseek-v4-flash` | Command Code | DeepSeek V4 Flash |
| `MiniMaxAI/MiniMax-M2.7` | Command Code | MiniMax M2.7 |
| `Qwen/Qwen3.6-Plus` | Command Code | Qwen 3.6 Plus |
| `zai-org/GLM-5.1` | Command Code | GLM 5.1 |
| `moonshotai/Kimi-K2.6` | Command Code | Kimi K2.6 |
| `opencode/go` | Opencode | Opencode Go |
| `opencode/flash` | Opencode | Opencode Flash |
| `gpt-4o` | OpenAI | GPT-4o |
| `claude-3-5-sonnet` | Anthropic | Claude 3.5 Sonnet |

---

## How Routing Works

1. **Every request tries Opencode FIRST** — maximizes your Opencode Go plan
2. **Opencode fails?** → instant fallback to Command Code (or model's native provider)
3. **Command Code retries** if it hits rate limits
4. **Least-used key** selected within each provider
5. **Format conversion** automatic — Claude Messages, Gemini, etc. converted to OpenAI format

---

## RTK — Token Optimization (Optional)

RTK (https://github.com/rtk-ai/rtk) is a CLI proxy that reduces LLM token consumption by 60-90% by filtering command outputs before they reach the AI. It complements this proxy by reducing costs at the shell command level.

### Install

```powershell
# Download latest Windows binary
curl -LO https://github.com/rtk-ai/rtk/releases/latest/download/rtk-x86_64-pc-windows-msvc.zip
# Extract rtk.exe to your PATH
rtk --version
```

### Initialize Agents

```powershell
rtk init -g --opencode      # Opencode plugin
rtk init --agent hermes     # Hermes plugin adapter
rtk init -g --codex         # Codex instruction injection
```

### Verify

```powershell
rtk gain                    # Token savings stats
```

---

## Start the Proxy

```bash
cd command-code-lol
start-proxy.cmd
```

Dashboard: `http://localhost:3456/dashboard`
