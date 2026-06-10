# Universal API Key Router — Configuration Guide

## ONE KEY TO RULE THEM ALL

All your tools connect to this proxy using a **single API key**. The proxy handles provider selection, key rotation, and failover automatically.

### Proxy Endpoint
```
Base URL: http://localhost:3456/v1
API Key:  (set via PROXY_API_KEY environment variable)
```

---

## How Routing Works (Optimal for ALL Agents)

1. **Request arrives** at `http://localhost:3456/v1/chat/completions` with your proxy key
2. **Priority-ordered credentials** tried in sequence — highest priority first
3. **If #1 fails** (rate limit, error, model not supported) → **automatic fallback to #2, then #3**
4. **Usage tracked** per credential (request count, tokens, last used)

This means:
- **OpenClaw** → sends to proxy → proxy tries Opencode → falls back to Command Code/Anthropic/OpenAI
- **Hermes** → sends to proxy → proxy tries Opencode → falls back to Command Code
- **Cursor** → sends to proxy → proxy tries Opencode → falls back to any available
- **Any OpenAI-compatible tool** → works instantly

---

## Supported Providers (Built-in)

| Provider | Auth Type | Base URL |
|----------|-----------|----------|
| Command Code | Bearer | `https://api.commandcode.ai` |
| OpenAI | Bearer | `https://api.openai.com/v1` |
| Opencode | Bearer | `https://api.opencode.ai/v1` |
| Anthropic | x-api-key | `https://api.anthropic.com/v1` |
| Google AI | x-goog-api-key | `https://generativelanguage.googleapis.com/v1beta` |
| Groq | Bearer | `https://api.groq.com/openai/v1` |
| OpenRouter | Bearer | `https://openrouter.ai/api/v1` |
| NVIDIA | Bearer | `https://integrate.api.nvidia.com/v1` |
| DeepSeek | Bearer | `https://api.deepseek.com/v1` |
| xAI (Grok) | Bearer | `https://api.x.ai/v1` |
| Mistral AI | Bearer | `https://api.mistral.ai/v1` |
| Cohere | Bearer | `https://api.cohere.com/v1` |
| Perplexity | Bearer | `https://api.perplexity.ai` |
| Together AI | Bearer | `https://api.together.xyz/v1` |
| Fireworks AI | Bearer | `https://api.fireworks.ai/inference/v1` |
| Ollama | Bearer | `http://localhost:11434/v1` |
| Other | Bearer | (custom) |

Add custom providers via the dashboard.

---

## Available Models (Configurable)

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

Add more models via the dashboard.

---

## Tool Configuration

### OpenClaw
```bash
set OPENAI_BASE_URL=http://localhost:3456/v1
set OPENAI_API_KEY=your_proxy_api_key
```

### Hermes / Command Code CLI
```bash
set COMMAND_CODE_API_URL=http://localhost:3456
set COMMAND_CODE_API_KEY=your_proxy_api_key
```

### Cursor IDE
Settings → AI → OpenAI API:
- Base URL: `http://localhost:3456/v1`
- API Key: `your_proxy_api_key`
- Model: `deepseek/deepseek-v4-pro`

### VS Code + Continue.dev
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

### Claude Desktop (Anthropic)
```bash
set ANTHROPIC_BASE_URL=http://localhost:3456/v1
set ANTHROPIC_API_KEY=your_proxy_api_key
```

### Any OpenAI-compatible tool
```
Base URL: http://localhost:3456/v1
API Key:  your_proxy_api_key
```

---

## Dashboard

Open `http://localhost:3456/dashboard` to:
- Add/remove provider API keys
- Bind credentials to specific models and tools
- Set priority ordering for credential fallback
- View usage stats and validation status
- Add custom providers and models
- Monitor which provider served each request

---

## Security

- **Proxy API key** required for all API access (set via `PROXY_API_KEY` env var)
- **Provider keys** encrypted at rest in `.config/vault.json` (AES-256-GCM)
- **Dashboard** accessible without auth (localhost by default)
- **Network binding** configurable via `PROXY_BIND_HOST`

---

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `PROXY_API_KEY` | Single key for all proxy access | (none — no auth required) |
| `PROXY_PORT` | Proxy listening port | `3000` |
| `PROXY_BIND_HOST` | Network interface | `0.0.0.0` |
| `COMMAND_CODE_API_KEY` | Fallback Command Code key | (none) |
| `COMMANDCODE_PROXY_MASTER_KEY` | Extra secret mixed into vault encryption | (none) |
| `PROXY_CONFIG_DIR` | Config/vault directory | `./.config` |

---

## Adding a New Provider

1. Open dashboard → click **Add Provider** in sidebar
2. Enter:
   - Provider ID: `myprovider`
   - Display name: `My Provider`
   - Base URL: `https://api.myprovider.com/v1`
   - Auth type: `bearer` (or `x-api-key`, etc.)
3. Click **Add Credential**
4. Select your new provider, paste API key, save
5. (Optional) Add models for this provider in the Models section

---

## ChatGPT OAuth (For Plugins/Actions)

When building ChatGPT plugins/actions:

1. **Set OAuth URLs in your app manifest:**
   - Authorization URL: `http://localhost:3456/oauth/authorize/chatgpt`
   - Token URL: `http://localhost:3456/oauth/token`

2. **User connects** → approval page → auto-creates credential in vault

3. **Proxy auto-refreshes** tokens before expiry on every request
