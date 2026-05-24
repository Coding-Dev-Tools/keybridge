# Dashboard Guide

The dashboard is now a **local credential vault UI**, not just a Command Code key table.

Open it at:

`http://localhost:3000/dashboard`

## What You Can Do

- Add Command Code keys, OpenAI-compatible keys, bearer tokens, and OAuth bundles
- Group everything in one unified vault view
- Filter by provider, credential type, and status
- Validate one credential or the entire vault
- Reveal or copy a secret only when you explicitly ask
- Manage model routing and local proxy settings

## Adding A Credential

1. Click **Add Credential**
2. Choose a provider
3. Choose a credential type
4. Fill in the secret fields for that type
5. Optionally bind the credential to specific models
6. Save

## Editing A Credential

- Open **Edit**
- Update metadata freely
- Leave secret fields blank to keep the current stored secret

## Validation

- **Command Code** credentials show quota, usage, and account info when validation succeeds
- **Other providers** validate against the credential's configured `baseUrl` and `authType`
- Validation summaries are stored as non-secret metadata for quick display

## Secret Safety

- Normal dashboard loads never fetch raw secrets
- The browser no longer caches secrets in `localStorage`
- **Reveal** and **Copy** use an explicit request to the server

## Model Routing

- Every model belongs to a provider
- Credentials can optionally bind themselves to a subset of models
- If no model binding is selected, the credential can serve all models for its provider

## Local-Only Design

- This release always binds to `localhost`
- Port changes are saved, but you need to restart the proxy process for the new port to take effect

## Troubleshooting

### A credential says it needs attention

- Re-run validation
- Confirm the secret is current
- Confirm `baseUrl` and `authType` match the provider

### A model has no usable credential

- Make sure at least one active credential exists for that provider
- If model binding is enabled, make sure the credential includes that model

### Legacy keys disappeared

They were likely migrated into the vault automatically. Check the unified **Credentials** view rather than looking for the old `apiKeys` list.
