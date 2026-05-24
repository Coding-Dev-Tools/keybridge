# Command Code Vault Proxy

Local-first credential vault and OpenAI-compatible proxy for Command Code and other AI providers.

## What It Is

This project now ships as a **single-user localhost vault**:

- Stores Command Code keys, OpenAI-compatible API keys, bearer tokens, and OAuth token bundles in one place
- Encrypts secrets at rest under `.config/`
- Keeps secrets out of normal `GET` responses
- Provides a local dashboard at `http://localhost:3000/dashboard`
- Exposes OpenAI-compatible endpoints for model listing and chat completions

The proxy is intentionally **localhost only** for this release.

## Core Features

- Encrypted credential vault with schema migration from legacy `apiKeys`
- Unified dashboard for all providers and credential types
- Masked secret reads by default
- Explicit reveal and copy flows
- Command Code quota, usage, and account validation
- OpenAI-compatible provider pass-through for non-Command-Code models
- Round-robin credential selection per provider/model
- Automatic `~/.opencode/opencode.json` setup for the local proxy

## Supported Credential Types

- `api_key`
- `bearer_token`
- `oauth_token_bundle`

## Supported Providers

- `commandcode`
- `openai`
- `opencode-compatible`
- `chatgpt`
- `anthropic`
- `google-ai`
- `groq`
- `openrouter`
- `nvidia`
- `other`

## Quick Start

```cmd
set COMMAND_CODE_API_KEY=your_fallback_commandcode_key
bun run proxy.js
```

Or with Node:

```cmd
set COMMAND_CODE_API_KEY=your_fallback_commandcode_key
node proxy.js
```

Open:

- Dashboard: `http://localhost:3000/dashboard`
- Health: `http://localhost:3000/health`

## Local Storage Layout

The app stores local state under `.config/`:

- `config.json`: non-secret metadata only
- `vault.json`: encrypted secret payloads
- `.vault-key`: local vault seed used with machine/user-bound derivation

If a legacy config contains plain-text `apiKeys`, startup migrates them into the vault automatically.

## Management API

### `GET /api/config`

Returns non-secret proxy configuration only.

### `POST /api/config`

Updates local proxy configuration.

### `GET /api/credentials`

Returns masked credential records:

- `id`
- `name`
- `provider`
- `credentialType`
- `authType`
- `baseUrl`
- `status`
- `models`
- `labels`
- `notes`
- `maskedValue`
- `usage`
- `validation`
- `expiresAt`
- `updatedAt`

### `POST /api/credentials`

Creates a credential.

For `api_key` or `bearer_token`, send `secretValue`.

For `oauth_token_bundle`, send:

- `accessToken`
- `refreshToken` (optional)
- `expiresAt` (optional)

### `PUT /api/credentials`

Updates an existing credential by `id`. Leaving secret fields blank preserves the stored secret.

### `DELETE /api/credentials`

Deletes a credential by `id`.

### `POST /api/credentials/reveal`

Explicitly reveals the stored secret or token bundle for a specific credential.

### `POST /api/credentials/validate`

Validates one credential and stores the latest validation summary.

### `POST /api/credentials/validate-all`

Validates every credential in the vault.

### Compatibility Endpoints

Legacy `/api/keys`, `/api/keys/quota`, and `/api/keys/validate-all` are still available for compatibility, but they return masked data and map to the new vault model.

## Standard Endpoints

### `GET /health`

Returns runtime, config directory, and local-only status.

### `GET /v1/models`

Returns enabled models in OpenAI-compatible format.

### `POST /v1/chat/completions`

Routes requests using the selected model's provider:

- Command Code models use the proprietary `/alpha/generate` bridge
- Other providers use OpenAI-compatible `/chat/completions`

## Security Notes

- Secrets are encrypted at rest before being written to disk
- Normal read APIs never return raw secret values
- The server binds to `127.0.0.1` only
- This is a single-user local tool, not a hosted multi-user secrets service
- Full machine compromise still compromises local secrets; this is hardening for local-at-rest storage, not an HSM

## Testing

Run the smoke test:

```cmd
npm test
```

The test covers:

- health endpoint
- legacy `apiKeys` migration
- masked credential reads
- encrypted vault storage
- explicit reveal endpoint
- `/v1/models`

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `COMMAND_CODE_API_KEY` | unset | Fallback Command Code key if the vault has none |
| `COMMAND_CODE_API_URL` | `https://api.commandcode.ai` | Default Command Code upstream |
| `COMMAND_CODE_CLI_VERSION` | `0.26.24` | Command Code version header |
| `PROXY_PORT` | `3000` | Local proxy port |
| `PROXY_CONFIG_DIR` | `.config` | Override config/vault directory |
| `DISABLE_OPENCODE_CONFIG` | unset | Set to `1` to skip opencode auto-config |
| `COMMANDCODE_PROXY_MASTER_KEY` | unset | Optional extra secret mixed into vault key derivation |

## Known Boundaries

- ChatGPT support in this release is **secure token storage**, not a browser OAuth sign-in flow
- Streaming token usage for some third-party providers is best-effort unless the upstream includes usage chunks
- Port changes are saved immediately but need a proxy restart to take effect
