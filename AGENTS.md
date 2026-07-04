# keybridge — Agent Guidelines

keybridge is a local-first encrypted credential vault and OpenAI-compatible LLM proxy.
It bridges API keys between AI tools and upstream providers (Command Code, OpenAI,
OpenRouter, Anthropic, etc.) with automatic rotation and failover.

## Project Layout

- `proxy.js` — Express proxy server (OpenAI-compatible `/v1/chat/completions`, `/v1/models`)
- `test-proxy.js` — Integration test harness for the proxy
- `dashboard.html` — Local web UI for credential management
- `SETUP.md` — Install + first-run walkthrough
- `CONFIG.md` — Routing, priority, and rotation rules
- `DASHBOARD_GUIDE.md` — UI reference

## Conventions

- **Node.js 18+** required.
- **Localhost only by default.** Do not bind to public interfaces without explicit
  `KEYBRIDGE_ALLOW_REMOTE=1` and `KEYBRIDGE_PASSWORD` set.
- **Secrets at rest** are encrypted under `.config/`; never commit `.config/`.
- **No telemetry.** Proxy is offline-first; no phone-home.

## Testing

```bash
npm test          # runs: node test-proxy.js
npm run lint      # eslint
```

## Merge Checklist

- [ ] `npm test` passes (proxy returns 200 for `/v1/models`)
- [ ] `.config/` is gitignored and not present
- [ ] No real API keys in `test-proxy.js` — use `test_*` prefixed placeholders
- [ ] README, SETUP, CONFIG, DASHBOARD_GUIDE, AGENTS all reference the same
      proxy name (`keybridge`) and port (default `3467`)
