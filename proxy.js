const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_BASE = process.env.COMMAND_CODE_API_URL || 'https://api.commandcode.ai';
const DEFAULT_CLI_VER = process.env.COMMAND_CODE_CLI_VERSION || '0.26.24';
const DEFAULT_PORT = parseInt(process.env.PROXY_PORT || '3000', 10);
const DEFAULT_BIND_HOST = '127.0.0.1';
const CONFIG_VERSION = 2;
const DASHBOARD_FILE = path.join(process.cwd(), 'dashboard.html');
const CONFIG_DIR = process.env.PROXY_CONFIG_DIR
  ? path.resolve(process.env.PROXY_CONFIG_DIR)
  : path.join(__dirname || '.', '.config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const VAULT_FILE = path.join(CONFIG_DIR, 'vault.json');
const VAULT_KEY_FILE = path.join(CONFIG_DIR, '.vault-key');

const PROVIDER_DEFAULTS = {
  commandcode: {
    label: 'Command Code',
    baseUrl: 'https://api.commandcode.ai',
    authType: 'bearer',
    authHeaders: () => ({ 'x-command-code-version': getCliVersion() }),
    validationPath: '/alpha/whoami',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    authType: 'bearer',
    validationPath: '/models',
  },
  opencode: {
    label: 'Opencode',
    baseUrl: 'https://api.opencode.ai/v1',
    authType: 'bearer',
    validationPath: '/models',
  },
  'opencode-compatible': {
    label: 'Opencode-Compatible',
    baseUrl: '',
    authType: 'bearer',
    validationPath: '/models',
  },
  chatgpt: {
    label: 'ChatGPT OAuth',
    baseUrl: '',
    authType: 'oauth',
    validationPath: '',
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    authType: 'x-api-key',
    authHeaders: () => ({ 'anthropic-version': '2023-06-01' }),
    validationPath: '/models',
  },
  'google-ai': {
    label: 'Google AI',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authType: 'x-goog-api-key',
    validationPath: '/models',
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    authType: 'bearer',
    validationPath: '/models',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    authType: 'bearer',
    authHeaders: () => ({ 'HTTP-Referer': `http://localhost:${getPort()}` }),
    validationPath: '/models',
  },
  nvidia: {
    label: 'NVIDIA',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    authType: 'bearer',
    validationPath: '/models',
  },
  other: {
    label: 'Other',
    baseUrl: '',
    authType: 'bearer',
    validationPath: '/models',
  },
};

const SUPPORTED_CREDENTIAL_TYPES = ['api_key', 'bearer_token', 'oauth_token_bundle'];
const SUPPORTED_STATUSES = ['active', 'inactive'];

function defaultModels() {
  return [
    { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true, provider: 'commandcode' },
    { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', enabled: true, provider: 'commandcode' },
    { id: 'MiniMaxAI/MiniMax-M2.7', name: 'MiniMax M2.7', enabled: true, provider: 'commandcode' },
    { id: 'Qwen/Qwen3.6-Plus', name: 'Qwen 3.6 Plus', enabled: true, provider: 'commandcode' },
    { id: 'zai-org/GLM-5.1', name: 'GLM 5.1', enabled: true, provider: 'commandcode' },
    { id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6', enabled: true, provider: 'commandcode' },
  ];
}

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

function normalizeBaseUrl(baseUrl) {
  return typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/, '') : '';
}

function normalizeLabels(labels) {
  if (!labels) return [];
  const raw = Array.isArray(labels) ? labels : String(labels).split(',');
  return Array.from(new Set(raw.map((item) => String(item).trim()).filter(Boolean)));
}

function nowIso() {
  return new Date().toISOString();
}

function randomUUID() {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch (_) {}
  return require('crypto').randomUUID();
}

function maskSecret(secretValue) {
  if (!secretValue) return '';
  const value = String(secretValue);
  if (value.length <= 8) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function normalizeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendError(res, statusCode, message, type = 'invalid_request_error', extra = {}) {
  sendJson(res, statusCode, {
    error: {
      message,
      type,
      ...extra,
    },
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function parseJsonBody(req, res) {
  try {
    const body = await readBody(req);
    return body ? JSON.parse(body) : {};
  } catch (error) {
    sendError(res, 400, 'Invalid JSON body');
    return null;
  }
}

function getMachineFingerprint() {
  const parts = [
    os.hostname(),
    os.userInfo().username,
    os.homedir(),
    process.platform,
    process.arch,
  ];
  return parts.join('|');
}

function loadVaultFile() {
  ensureConfigDir();
  if (!fs.existsSync(VAULT_FILE)) {
    const freshVault = {
      version: 1,
      keySalt: crypto.randomBytes(16).toString('base64'),
      entries: {},
    };
    fs.writeFileSync(VAULT_FILE, stableJson(freshVault));
    return freshVault;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
    return {
      version: parsed.version || 1,
      keySalt: parsed.keySalt || crypto.randomBytes(16).toString('base64'),
      entries: parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {},
    };
  } catch (_) {
    const recoveredVault = {
      version: 1,
      keySalt: crypto.randomBytes(16).toString('base64'),
      entries: {},
    };
    fs.writeFileSync(VAULT_FILE, stableJson(recoveredVault));
    return recoveredVault;
  }
}

function ensureVaultLocalSecret() {
  ensureConfigDir();
  if (!fs.existsSync(VAULT_KEY_FILE)) {
    fs.writeFileSync(VAULT_KEY_FILE, crypto.randomBytes(32).toString('base64'));
  }
  return fs.readFileSync(VAULT_KEY_FILE, 'utf8').trim();
}

let vaultState = loadVaultFile();
let vaultKeyCache = null;

function getVaultKey() {
  if (vaultKeyCache) return vaultKeyCache;
  const envSecret = process.env.COMMANDCODE_PROXY_MASTER_KEY || '';
  const localSecret = ensureVaultLocalSecret();
  const secretMaterial = envSecret || `${getMachineFingerprint()}|${localSecret}`;
  vaultKeyCache = crypto.scryptSync(secretMaterial, Buffer.from(vaultState.keySalt, 'base64'), 32);
  return vaultKeyCache;
}

function saveVault() {
  ensureConfigDir();
  fs.writeFileSync(VAULT_FILE, stableJson(vaultState));
}

function encryptSecretPayload(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getVaultKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptSecretPayload(entry) {
  if (!entry) return null;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getVaultKey(),
    Buffer.from(entry.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(entry.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}

function getSecretPayload(credentialId) {
  const entry = vaultState.entries[credentialId];
  if (!entry) return null;
  try {
    return decryptSecretPayload(entry);
  } catch (error) {
    return null;
  }
}

function putSecretPayload(credentialId, payload) {
  vaultState.entries[credentialId] = encryptSecretPayload(payload);
  saveVault();
}

function deleteSecretPayload(credentialId) {
  delete vaultState.entries[credentialId];
  saveVault();
}

function getCredentialSecretString(credential) {
  const secretPayload = getSecretPayload(credential.id);
  if (!secretPayload) return '';
  if (credential.credentialType === 'oauth_token_bundle') {
    return secretPayload.accessToken || secretPayload.secretValue || '';
  }
  return secretPayload.secretValue || '';
}

function getCredentialMaskedValue(credential) {
  const secretPayload = getSecretPayload(credential.id);
  if (!secretPayload) return '';
  if (credential.credentialType === 'oauth_token_bundle') {
    return maskSecret(secretPayload.accessToken || secretPayload.secretValue || '');
  }
  return maskSecret(secretPayload.secretValue || '');
}

function sanitizeCredential(credential) {
  return {
    id: credential.id,
    name: credential.name,
    provider: credential.provider,
    providerLabel: (PROVIDER_DEFAULTS[credential.provider] || PROVIDER_DEFAULTS.other).label,
    credentialType: credential.credentialType,
    authType: credential.authType,
    baseUrl: credential.baseUrl,
    status: credential.status,
    models: safeArray(credential.models),
    labels: normalizeLabels(credential.labels),
    notes: credential.notes || '',
    expiresAt: credential.expiresAt || null,
    maskedValue: getCredentialMaskedValue(credential),
    usage: credential.usage || { requestCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, lastUsed: null },
    validation: credential.validation || null,
    lastValidatedAt: credential.lastValidatedAt || null,
    updatedAt: credential.updatedAt,
    createdAt: credential.createdAt,
    hasSecret: Boolean(getSecretPayload(credential.id)),
  };
}

function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    bindHost: DEFAULT_BIND_HOST,
    port: DEFAULT_PORT,
    apiUrl: DEFAULT_BASE,
    cliVersion: DEFAULT_CLI_VER,
    credentials: [],
    models: defaultModels(),
  };
}

function normalizeModel(model) {
  return {
    id: String(model.id || '').trim(),
    name: String(model.name || model.id || '').trim(),
    enabled: model.enabled !== false,
    provider: String(model.provider || 'commandcode').trim() || 'commandcode',
  };
}

function inferCredentialType(provider, authType) {
  if (provider === 'chatgpt' || authType === 'oauth') return 'oauth_token_bundle';
  if (authType === 'bearer') return 'bearer_token';
  return 'api_key';
}

function normalizeCredentialMeta(meta) {
  const provider = PROVIDER_DEFAULTS[meta.provider] ? meta.provider : 'other';
  const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.other;
  const credentialType = SUPPORTED_CREDENTIAL_TYPES.includes(meta.credentialType)
    ? meta.credentialType
    : inferCredentialType(provider, meta.authType || defaults.authType);
  const authType = String(meta.authType || defaults.authType || 'bearer').trim();
  const usage = meta.usage && typeof meta.usage === 'object'
    ? {
        requestCount: Number(meta.usage.requestCount || 0),
        totalTokens: Number(meta.usage.totalTokens || 0),
        inputTokens: Number(meta.usage.inputTokens || 0),
        outputTokens: Number(meta.usage.outputTokens || 0),
        lastUsed: meta.usage.lastUsed || null,
      }
    : { requestCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, lastUsed: null };
  return {
    id: String(meta.id || randomUUID()),
    name: String(meta.name || 'Untitled credential').trim(),
    provider,
    credentialType,
    authType,
    baseUrl: normalizeBaseUrl(meta.baseUrl || defaults.baseUrl || ''),
    status: SUPPORTED_STATUSES.includes(meta.status) ? meta.status : 'active',
    models: safeArray(meta.models).map((item) => String(item).trim()).filter(Boolean),
    labels: normalizeLabels(meta.labels),
    notes: typeof meta.notes === 'string' ? meta.notes.trim() : '',
    expiresAt: normalizeDate(meta.expiresAt),
    monthlyLimit: isFinite(Number(meta.monthlyLimit)) ? Number(meta.monthlyLimit) : 0,
    validation: meta.validation || null,
    lastValidatedAt: meta.lastValidatedAt || null,
    usage,
    createdAt: meta.createdAt || nowIso(),
    updatedAt: meta.updatedAt || nowIso(),
  };
}

function saveConfig(config) {
  ensureConfigDir();
  const { apiKeys, ...configWithoutLegacyKeys } = config;
  const safeConfig = {
    ...configWithoutLegacyKeys,
    version: CONFIG_VERSION,
    bindHost: DEFAULT_BIND_HOST,
    credentials: safeArray(config.credentials).map((credential) => {
      const normalized = normalizeCredentialMeta(credential);
      return normalized;
    }),
    models: safeArray(config.models).map(normalizeModel).filter((model) => model.id && model.name),
  };
  fs.writeFileSync(CONFIG_FILE, stableJson(safeConfig));
  return safeConfig;
}

function loadConfig() {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    const fresh = saveConfig(defaultConfig());
    return fresh;
  }

  let rawConfig = {};
  try {
    rawConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) {
    rawConfig = {};
  }

  const merged = {
    ...defaultConfig(),
    ...rawConfig,
  };

  let migrated = false;
  let credentials = safeArray(merged.credentials).map((credential) => {
    const normalized = normalizeCredentialMeta(credential);
    if (credential && typeof credential === 'object' && (credential.value || credential.secretValue || credential.accessToken || credential.refreshToken)) {
      putSecretPayload(normalized.id, {
        secretValue: credential.secretValue || credential.value || credential.accessToken || '',
        accessToken: credential.accessToken || undefined,
        refreshToken: credential.refreshToken || undefined,
      });
      migrated = true;
    }
    return normalized;
  });

  if (Array.isArray(rawConfig.apiKeys) && rawConfig.apiKeys.length > 0) {
    for (const legacyKey of rawConfig.apiKeys) {
      const provider = PROVIDER_DEFAULTS[legacyKey.provider] ? legacyKey.provider : 'commandcode';
      const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.commandcode;
      const credential = normalizeCredentialMeta({
        id: randomUUID(),
        name: legacyKey.name,
        provider,
        credentialType: inferCredentialType(provider, legacyKey.authType || defaults.authType),
        authType: legacyKey.authType || defaults.authType,
        baseUrl: legacyKey.baseUrl || defaults.baseUrl,
        status: legacyKey.status || 'active',
        models: legacyKey.models || [],
        usage: legacyKey.usage || {},
        validation: legacyKey.validation || null,
        lastValidatedAt: legacyKey.lastValidatedAt || null,
      });
      credentials.push(credential);
      putSecretPayload(credential.id, { secretValue: legacyKey.value || '' });
      migrated = true;
    }
  }

  const normalized = saveConfig({
    ...merged,
    version: CONFIG_VERSION,
    bindHost: DEFAULT_BIND_HOST,
    apiUrl: normalizeBaseUrl(merged.apiUrl || DEFAULT_BASE) || DEFAULT_BASE,
    cliVersion: String(merged.cliVersion || DEFAULT_CLI_VER),
    port: Number.isInteger(Number(merged.port)) ? Number(merged.port) : DEFAULT_PORT,
    credentials,
    models: safeArray(merged.models).map(normalizeModel).filter((model) => model.id && model.name),
  });

  if (migrated || rawConfig.version !== CONFIG_VERSION || rawConfig.bindHost !== DEFAULT_BIND_HOST || rawConfig.apiKeys) {
    saveConfig(normalized);
  }

  return normalized;
}

let proxyConfig = loadConfig();

function getApiBase() {
  return normalizeBaseUrl(proxyConfig.apiUrl || DEFAULT_BASE) || DEFAULT_BASE;
}

function getCliVersion() {
  return String(proxyConfig.cliVersion || DEFAULT_CLI_VER);
}

function getPort() {
  return Number(proxyConfig.port || DEFAULT_PORT) || DEFAULT_PORT;
}

function sanitizeConfigForClient(config) {
  return {
    version: config.version,
    bindHost: DEFAULT_BIND_HOST,
    port: getPort(),
    apiUrl: getApiBase(),
    cliVersion: getCliVersion(),
    models: safeArray(config.models).map(normalizeModel),
  };
}

function getProviderDefaults(provider) {
  return PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.other;
}

function getCredentialById(credentialId) {
  return safeArray(proxyConfig.credentials).find((credential) => credential.id === credentialId) || null;
}

function getModelProvider(modelId) {
  const match = safeArray(proxyConfig.models).find((model) => model.id === modelId);
  return match?.provider || 'commandcode';
}



function getEligibleCredentials(provider, modelId) {
  return safeArray(proxyConfig.credentials)
    .filter((credential) => credential.status === 'active')
    .filter((credential) => credential.provider === provider)
    .filter((credential) => safeArray(credential.models).length === 0 || credential.models.includes(modelId))
    .filter((credential) => Boolean(getCredentialSecretString(credential)));
}

function getBestCredential(provider, modelId) {
  const eligible = getEligibleCredentials(provider, modelId);
  if (eligible.length === 0) {
    if (provider === 'commandcode' && process.env.COMMAND_CODE_API_KEY) {
      return {
        id: 'env-commandcode',
        provider: 'commandcode',
        authType: 'bearer',
        baseUrl: getApiBase(),
        getSecret: () => process.env.COMMAND_CODE_API_KEY,
      };
    }
    return null;
  }

  // Sort by usage ratio then requestCount — least saturated key goes first
  eligible.sort((a, b) => {
    const aRatio = getUsageRatio(a);
    const bRatio = getUsageRatio(b);
    if (Math.abs(aRatio - bRatio) > 0.001) return aRatio - bRatio;
    const aCount = (a.usage?.requestCount || 0);
    const bCount = (b.usage?.requestCount || 0);
    if (aCount !== bCount) return aCount - bCount;
    const aLast = a.usage?.lastUsed ? new Date(a.usage.lastUsed).getTime() : 0;
    const bLast = b.usage?.lastUsed ? new Date(b.usage.lastUsed).getTime() : 0;
    return aLast - bLast;
  });

  const selected = eligible[0];
  const defaults = getProviderDefaults(selected.provider);
  return {
    ...selected,
    authType: selected.authType || defaults.authType || 'bearer',
    baseUrl: normalizeBaseUrl(selected.baseUrl || defaults.baseUrl || ''),
    getSecret: () => getCredentialSecretString(selected),
  };
}

function getUsageRatio(credential) {
  const limit = Number(credential.monthlyLimit || 0);
  if (limit <= 0) return 0;
  const used = Number(credential.usage?.requestCount || credential.usage?.totalTokens || 0);
  return used / limit;
}

function buildAuthHeaders(authType, secretValue) {
  switch (authType) {
    case 'bearer':
    case 'oauth':
      return { Authorization: `Bearer ${secretValue}` };
    case 'x-api-key':
      return { 'x-api-key': secretValue };
    case 'x-goog-api-key':
      return { 'x-goog-api-key': secretValue };
    default:
      return { Authorization: `Bearer ${secretValue}` };
  }
}

function getStaticProviderHeaders(provider) {
  const defaults = getProviderDefaults(provider);
  return typeof defaults.authHeaders === 'function' ? defaults.authHeaders() : (defaults.authHeaders || {});
}

function updateCredentialUsage(credentialId, usage = {}) {
  if (!credentialId || credentialId === 'env-commandcode') return;
  const credential = getCredentialById(credentialId);
  if (!credential) return;
  credential.usage = credential.usage || { requestCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, lastUsed: null };
  credential.usage.requestCount += 1;
  credential.usage.totalTokens += Number(usage.total_tokens || usage.totalTokens || 0);
  credential.usage.inputTokens += Number(usage.prompt_tokens || usage.inputTokens || 0);
  credential.usage.outputTokens += Number(usage.completion_tokens || usage.outputTokens || 0);
  credential.usage.lastUsed = nowIso();
  credential.updatedAt = nowIso();
  proxyConfig = saveConfig(proxyConfig);
}

function convertMessageCC(message) {
  if (message.role === 'system') return null;
  if (message.role === 'tool') {
    const content = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.find((item) => item.type === 'tool-result')?.content || ''
        : '';
    return { role: 'user', content };
  }
  if (message.role === 'assistant' && message.tool_calls) {
    return {
      role: 'assistant',
      content: [],
      tool_calls: message.tool_calls.map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.function.name,
          arguments: typeof toolCall.function.arguments === 'string'
            ? toolCall.function.arguments
            : JSON.stringify(toolCall.function.arguments),
        },
      })),
    };
  }
  let text = '';
  if (Array.isArray(message.content)) {
    const textBlock = message.content.find((item) => item.type === 'text');
    text = textBlock?.text || '';
  } else if (typeof message.content === 'string') {
    text = message.content;
  }
  return { role: message.role, content: text };
}

function convertToolsCC(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  return tools
    .map((tool) => {
      if (tool.type === 'function' && tool.function) {
        return { name: tool.function.name, input_schema: tool.function.parameters || {} };
      }
      if (tool.name) {
        return { name: tool.name, input_schema: tool.input_schema || {} };
      }
      return null;
    })
    .filter(Boolean);
}

function buildOpenAIChunk(id, model, index, delta, finishReason) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index, delta, finish_reason: finishReason }],
  };
}

async function readAllEvents(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = parseMaybeJson(trimmed);
      if (parsed) events.push(parsed);
    }
  }
  return events;
}

function parseUsageFromSseBuffer(buffer) {
  let usage = {};
  const lines = buffer.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data: ')) continue;
    const payload = trimmed.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    const parsed = parseMaybeJson(payload);
    if (!parsed) continue;
    if (parsed.usage) usage = parsed.usage;
  }
  return usage;
}

async function checkCommandCodeCredential(secretValue) {
  try {
    const headers = {
      Authorization: `Bearer ${secretValue}`,
      'x-command-code-version': getCliVersion(),
    };
    const [quotaResp, usageResp, infoResp] = await Promise.all([
      fetch(`${getApiBase()}/alpha/billing/credits`, { headers }),
      fetch(`${getApiBase()}/alpha/usage/summary`, { headers }),
      fetch(`${getApiBase()}/alpha/whoami`, { headers }),
    ]);

    const quotaData = quotaResp.ok ? await quotaResp.json() : null;
    const usageData = usageResp.ok ? await usageResp.json() : null;
    const infoData = infoResp.ok ? await infoResp.json() : null;

    return {
      valid: quotaResp.ok && usageResp.ok && infoResp.ok,
      checkedAt: nowIso(),
      quota: quotaData ? {
        credits: quotaData.credits || quotaData.balance || 0,
        currency: quotaData.currency || 'USD',
        subscription: quotaData.subscription || null,
      } : null,
      usage: usageData ? {
        totalTokens: Number(usageData.totalTokens ?? usageData.total_tokens ?? 0),
        inputTokens: Number(usageData.inputTokens ?? usageData.promptTokens ?? 0),
        outputTokens: Number(usageData.outputTokens ?? usageData.completionTokens ?? 0),
      } : null,
      account: infoData ? {
        userName: infoData.user?.name || infoData.user?.userName || infoData.userName || null,
        email: infoData.user?.email || infoData.email || null,
      } : null,
      error: quotaResp.ok && usageResp.ok && infoResp.ok
        ? null
        : `Validation failed (${quotaResp.status}/${usageResp.status}/${infoResp.status})`,
    };
  } catch (error) {
    return {
      valid: false,
      checkedAt: nowIso(),
      error: error.message,
    };
  }
}

async function validateGenericCredential(credential, secretValue) {
  const defaults = getProviderDefaults(credential.provider);
  const authType = credential.authType || defaults.authType || 'bearer';
  const baseUrl = normalizeBaseUrl(credential.baseUrl || defaults.baseUrl || '');
  const validationPath = defaults.validationPath || '/models';
  if (!baseUrl || !validationPath) {
    return {
      valid: true,
      checkedAt: nowIso(),
      note: 'Stored only. No validation endpoint configured.',
    };
  }

  try {
    const headers = {
      'Content-Type': 'application/json',
      ...buildAuthHeaders(authType, secretValue),
      ...getStaticProviderHeaders(credential.provider),
    };
    const resp = await fetch(`${baseUrl}${validationPath}`, { headers });
    const data = resp.ok ? await resp.json().catch(() => null) : null;
    return {
      valid: resp.ok,
      checkedAt: nowIso(),
      status: resp.status,
      models: Array.isArray(data?.data) ? data.data.length : null,
      error: resp.ok ? null : `HTTP ${resp.status}`,
    };
  } catch (error) {
    return {
      valid: false,
      checkedAt: nowIso(),
      error: error.message,
    };
  }
}

async function validateCredentialRecord(credential) {
  const secretValue = getCredentialSecretString(credential);
  if (!secretValue) {
    const missing = {
      valid: false,
      checkedAt: nowIso(),
      error: 'No secret stored for this credential.',
    };
    credential.validation = missing;
    credential.lastValidatedAt = missing.checkedAt;
    credential.updatedAt = nowIso();
    proxyConfig = saveConfig(proxyConfig);
    return missing;
  }

  const result = credential.provider === 'commandcode'
    ? await checkCommandCodeCredential(secretValue)
    : await validateGenericCredential(credential, secretValue);

  credential.validation = result;
  credential.lastValidatedAt = result.checkedAt;
  credential.updatedAt = nowIso();
  proxyConfig = saveConfig(proxyConfig);
  return result;
}

function normalizeCredentialInput(input, existingCredential = null) {
  const provider = PROVIDER_DEFAULTS[input.provider] ? input.provider : (existingCredential?.provider || 'commandcode');
  const defaults = getProviderDefaults(provider);
  const credentialType = SUPPORTED_CREDENTIAL_TYPES.includes(input.credentialType)
    ? input.credentialType
    : existingCredential?.credentialType || inferCredentialType(provider, input.authType || defaults.authType);
  const authType = String(input.authType || existingCredential?.authType || defaults.authType || 'bearer').trim();
  const baseUrl = normalizeBaseUrl(input.baseUrl || existingCredential?.baseUrl || defaults.baseUrl || '');
  const name = String(input.name || existingCredential?.name || '').trim();
  const status = SUPPORTED_STATUSES.includes(input.status) ? input.status : (existingCredential?.status || 'active');
  const models = safeArray(input.models).map((item) => String(item).trim()).filter(Boolean);
  const labels = normalizeLabels(input.labels || existingCredential?.labels || []);
  const notes = typeof input.notes === 'string' ? input.notes.trim() : (existingCredential?.notes || '');
  const expiresAt = normalizeDate(input.expiresAt || existingCredential?.expiresAt || null);
  const monthlyLimit = isFinite(Number(input.monthlyLimit ?? existingCredential?.monthlyLimit))
    ? Number(input.monthlyLimit ?? existingCredential?.monthlyLimit)
    : (existingCredential?.monthlyLimit || 0);

  if (!name) {
    throw new Error('Credential name is required.');
  }

  const secretPayload = existingCredential ? (getSecretPayload(existingCredential.id) || {}) : {};
  if (credentialType === 'oauth_token_bundle') {
    const accessToken = typeof input.accessToken === 'string' && input.accessToken.trim()
      ? input.accessToken.trim()
      : secretPayload.accessToken || '';
    const refreshToken = typeof input.refreshToken === 'string' && input.refreshToken.trim()
      ? input.refreshToken.trim()
      : secretPayload.refreshToken || '';
    if (!accessToken && !existingCredential) {
      throw new Error('Access token is required for OAuth token bundles.');
    }
    return {
      credential: normalizeCredentialMeta({
        ...(existingCredential || {}),
        name,
        provider,
        credentialType,
        authType,
        baseUrl,
        status,
        models,
        labels,
        notes,
        expiresAt,
        monthlyLimit,
        updatedAt: nowIso(),
      }),
      secretPayload: {
        accessToken,
        refreshToken,
        secretValue: accessToken,
      },
    };
  }

  const secretValue = typeof input.secretValue === 'string' && input.secretValue.trim()
    ? input.secretValue.trim()
    : secretPayload.secretValue || '';

  if (!secretValue && !existingCredential) {
    throw new Error('Secret value is required.');
  }

  return {
    credential: normalizeCredentialMeta({
      ...(existingCredential || {}),
      name,
      provider,
      credentialType,
      authType,
      baseUrl,
      status,
      models,
      labels,
      notes,
      expiresAt,
      monthlyLimit,
      updatedAt: nowIso(),
    }),
    secretPayload: {
      secretValue,
    },
  };
}

function setupOpencodeConfig() {
  if (process.env.DISABLE_OPENCODE_CONFIG === '1') return;
  const opencodeDir = path.join(os.homedir(), '.opencode');
  const configFile = path.join(opencodeDir, 'opencode.json');
  try {
    if (!fs.existsSync(opencodeDir)) fs.mkdirSync(opencodeDir, { recursive: true });
    let config = { $schema: 'https://opencode.ai/config.json' };
    if (fs.existsSync(configFile)) {
      config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    }
    if (!config.provider || typeof config.provider !== 'object') config.provider = {};
    const models = safeArray(proxyConfig.models).reduce((accumulator, model) => {
      if (model.enabled !== false) accumulator[model.id] = { name: model.name };
      return accumulator;
    }, {});
    config.provider.commandcode = {
      npm: '@ai-sdk/openai-compatible',
      name: 'Command Code Proxy',
      options: { baseURL: `http://localhost:${getPort()}/v1` },
      models: Object.keys(models).length > 0 ? models : defaultModels().reduce((accumulator, model) => {
        accumulator[model.id] = { name: model.name };
        return accumulator;
      }, {}),
    };
    fs.writeFileSync(configFile, stableJson(config));
  } catch (_) {
    // Local convenience only; failures should not block the proxy.
  }
}

setupOpencodeConfig();

async function handleDashboard(req, res) {
  if (!fs.existsSync(DASHBOARD_FILE)) {
    sendError(res, 404, 'Dashboard not found', 'not_found_error');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(fs.readFileSync(DASHBOARD_FILE));
}

async function handleGetConfig(req, res) {
  sendJson(res, 200, sanitizeConfigForClient(proxyConfig));
}

async function handleUpdateConfig(req, res) {
  const input = await parseJsonBody(req, res);
  if (!input) return;
  const previousPort = getPort();
  const nextPort = Number(input.port || proxyConfig.port || DEFAULT_PORT);
  if (!Number.isInteger(nextPort) || nextPort < 1024 || nextPort > 65535) {
    sendError(res, 400, 'Port must be an integer between 1024 and 65535.');
    return;
  }
  proxyConfig = saveConfig({
    ...proxyConfig,
    port: nextPort,
    apiUrl: normalizeBaseUrl(input.apiUrl || proxyConfig.apiUrl || DEFAULT_BASE) || DEFAULT_BASE,
    cliVersion: String(input.cliVersion || proxyConfig.cliVersion || DEFAULT_CLI_VER),
    bindHost: DEFAULT_BIND_HOST,
  });
  setupOpencodeConfig();
  sendJson(res, 200, {
    success: true,
    config: sanitizeConfigForClient(proxyConfig),
    restartRequired: previousPort !== nextPort,
  });
}

function createCredentialFromInput(input) {
  const { credential, secretPayload } = normalizeCredentialInput(input);
  proxyConfig.credentials.push(credential);
  putSecretPayload(credential.id, secretPayload);
  proxyConfig = saveConfig(proxyConfig);
  return credential;
}

function updateCredentialFromInput(input) {
  const credential = getCredentialById(input.id);
  if (!credential) {
    throw new Error('Credential not found');
  }
  const { credential: updatedCredential, secretPayload } = normalizeCredentialInput(input, credential);
  const index = proxyConfig.credentials.findIndex((item) => item.id === credential.id);
  proxyConfig.credentials[index] = updatedCredential;
  putSecretPayload(updatedCredential.id, secretPayload);
  proxyConfig = saveConfig(proxyConfig);
  return updatedCredential;
}

async function handleGetCredentials(req, res) {
  sendJson(res, 200, { credentials: safeArray(proxyConfig.credentials).map(sanitizeCredential) });
}

async function handleCreateCredential(req, res) {
  const input = await parseJsonBody(req, res);
  if (!input) return;
  try {
    const credential = createCredentialFromInput(input);
    sendJson(res, 200, { success: true, credential: sanitizeCredential(credential) });
  } catch (error) {
    sendError(res, 400, error.message);
  }
}

async function handleUpdateCredential(req, res) {
  const input = await parseJsonBody(req, res);
  if (!input) return;
  try {
    const updatedCredential = updateCredentialFromInput(input);
    sendJson(res, 200, { success: true, credential: sanitizeCredential(updatedCredential) });
  } catch (error) {
    sendError(res, error.message === 'Credential not found' ? 404 : 400, error.message, error.message === 'Credential not found' ? 'not_found_error' : 'invalid_request_error');
  }
}

async function handleDeleteCredential(req, res) {
  const input = await parseJsonBody(req, res);
  if (!input) return;
  const credential = getCredentialById(input.id);
  if (!credential) {
    sendError(res, 404, 'Credential not found', 'not_found_error');
    return;
  }
  proxyConfig.credentials = safeArray(proxyConfig.credentials).filter((item) => item.id !== credential.id);
  deleteSecretPayload(credential.id);
  proxyConfig = saveConfig(proxyConfig);
  sendJson(res, 200, { success: true });
}

async function handleRevealCredential(req, res) {
  const input = await parseJsonBody(req, res);
  if (!input) return;
  const credential = getCredentialById(input.id);
  if (!credential) {
    sendError(res, 404, 'Credential not found', 'not_found_error');
    return;
  }
  const secretPayload = getSecretPayload(credential.id);
  if (!secretPayload) {
    sendError(res, 404, 'No secret stored for this credential', 'not_found_error');
    return;
  }
  sendJson(res, 200, {
    success: true,
    id: credential.id,
    credentialType: credential.credentialType,
    secretValue: secretPayload.secretValue || '',
    accessToken: secretPayload.accessToken || '',
    refreshToken: secretPayload.refreshToken || '',
  });
}

async function handleValidateCredential(req, res) {
  const input = await parseJsonBody(req, res);
  if (!input) return;
  const credential = getCredentialById(input.id);
  if (!credential) {
    sendError(res, 404, 'Credential not found', 'not_found_error');
    return;
  }
  const validation = await validateCredentialRecord(credential);
  sendJson(res, 200, {
    success: true,
    credential: sanitizeCredential(credential),
    validation,
  });
}

async function handleValidateAllCredentials(req, res) {
  const results = [];
  for (const credential of safeArray(proxyConfig.credentials)) {
    results.push({
      id: credential.id,
      name: credential.name,
      provider: credential.provider,
      validation: await validateCredentialRecord(credential),
    });
  }
  sendJson(res, 200, {
    success: true,
    results,
    credentials: safeArray(proxyConfig.credentials).map(sanitizeCredential),
  });
}

async function handleGetModels(req, res) {
  sendJson(res, 200, { models: safeArray(proxyConfig.models).map(normalizeModel) });
}

async function handleUpdateModels(req, res) {
  const input = await parseJsonBody(req, res);
  if (!input) return;
  if (!Array.isArray(input.models)) {
    sendError(res, 400, 'Models array is required.');
    return;
  }
  const normalizedModels = input.models.map(normalizeModel).filter((model) => model.id && model.name);
  proxyConfig.models = normalizedModels;
  proxyConfig = saveConfig(proxyConfig);
  setupOpencodeConfig();
  sendJson(res, 200, { success: true, models: proxyConfig.models });
}

async function handleGetProviders(req, res) {
  sendJson(res, 200, {
    providers: Object.entries(PROVIDER_DEFAULTS).map(([id, provider]) => ({
      id,
      label: provider.label,
      baseUrl: provider.baseUrl,
      authType: provider.authType,
    })),
    credentialTypes: SUPPORTED_CREDENTIAL_TYPES,
  });
}

async function handleHealth(req, res) {
  const runtime = process.env.PROXY_RUNTIME === 'node'
    ? `Node.js ${process.version}`
    : typeof Bun !== 'undefined'
      ? `Bun ${Bun?.version || ''}`
      : `Node.js ${process.version}`;
  sendJson(res, 200, {
    status: 'ok',
    version: '2.0.0',
    cli_version: getCliVersion(),
    runtime,
    platform: `${process.platform}-${process.arch}`,
    cwd: process.cwd(),
    config_dir: CONFIG_DIR,
    vault_file: VAULT_FILE,
    local_only: true,
  });
}

async function handleModelList(req, res) {
  const models = safeArray(proxyConfig.models)
    .filter((model) => model.enabled !== false)
    .map((model) => ({
      id: model.id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: model.provider || 'commandcode',
    }));
  sendJson(res, 200, { object: 'list', data: models });
}

async function handleChatCompletions(req, res) {
  const reqBody = await parseJsonBody(req, res);
  if (!reqBody) return;

  const modelId = reqBody.model || 'deepseek/deepseek-v4-pro';
  const provider = getModelProvider(modelId);
  const credential = getBestCredential(provider, modelId);
  if (!credential) {
    sendError(res, 500, `No active credential available for provider ${provider}.`, 'configuration_error');
    return;
  }

  const secretValue = credential.getSecret();
  const authHeaders = {
    ...buildAuthHeaders(credential.authType, secretValue),
    ...getStaticProviderHeaders(provider),
  };

  if (provider === 'commandcode') {
    const systemMessage = safeArray(reqBody.messages).find((message) => message.role === 'system')?.content || '';
    const ccBody = {
      config: {
        workingDir: process.cwd(),
        date: new Date().toISOString().split('T')[0],
        environment: `${process.platform}-${process.arch}`,
        structure: [],
        isGitRepo: false,
        currentBranch: 'main',
        mainBranch: 'main',
        gitStatus: '',
        recentCommits: [],
      },
      memory: '',
      taste: '',
      skills: null,
      permissionMode: 'standard',
      params: {
        model: modelId,
        messages: safeArray(reqBody.messages).map(convertMessageCC).filter(Boolean),
        tools: convertToolsCC(reqBody.tools || []),
        system: systemMessage,
        max_tokens: reqBody.max_tokens || 4096,
        temperature: reqBody.temperature ?? 0.3,
        stream: true,
      },
      threadId: randomUUID(),
    };

    const upstream = await fetch(`${getApiBase()}/alpha/generate`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(ccBody),
    });

    if (!upstream.ok) {
      const message = await upstream.text().catch(() => 'Upstream error');
      sendError(res, upstream.status, message, 'api_error');
      return;
    }

    const events = await readAllEvents(upstream);
    let textContent = '';
    let toolCalls = [];
    let usage = {};
    let finishReason = 'stop';
    let currentToolCall = null;

    for (const event of events) {
      if (event.type === 'text-delta') textContent += event.text || '';
      else if (event.type === 'tool-input-start') currentToolCall = { index: toolCalls.length, id: event.id, name: event.toolName, args: '' };
      else if (event.type === 'tool-input-delta' && currentToolCall) currentToolCall.args += event.delta || '';
      else if (event.type === 'tool-input-end' && currentToolCall) {
        toolCalls.push({
          id: currentToolCall.id,
          type: 'function',
          function: { name: currentToolCall.name, arguments: currentToolCall.args },
        });
        currentToolCall = null;
      } else if (event.type === 'tool-call') {
        toolCalls.push({
          id: event.toolCallId,
          type: 'function',
          function: { name: event.toolName, arguments: JSON.stringify(event.input || {}) },
        });
      } else if (event.type === 'finish' || event.type === 'finish-step') {
        finishReason = event.finishReason === 'tool-calls'
          ? 'tool_calls'
          : event.finishReason === 'stop' || event.finishReason === 'end_turn'
            ? 'stop'
            : event.finishReason || 'stop';
        usage = event.totalUsage || event.usage || {};
      }
    }

    if (reqBody.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      let streamToolCall = null;
      let toolCallIndex = 0;
      for (const event of events) {
        if (event.type === 'text-delta') {
          res.write(`data: ${JSON.stringify(buildOpenAIChunk(`chatcmpl-${randomUUID()}`, modelId, 0, { content: event.text || '' }, null))}\n\n`);
        } else if (event.type === 'tool-input-start') {
          streamToolCall = { index: toolCallIndex++, id: event.id, name: event.toolName, args: '' };
        } else if (event.type === 'tool-input-delta' && streamToolCall) {
          streamToolCall.args += event.delta || '';
        } else if (event.type === 'tool-input-end' && streamToolCall) {
          res.write(`data: ${JSON.stringify(buildOpenAIChunk(`chatcmpl-${randomUUID()}`, modelId, 0, { tool_calls: [{ index: streamToolCall.index, id: streamToolCall.id, type: 'function', function: { name: streamToolCall.name, arguments: streamToolCall.args } }] }, null))}\n\n`);
          streamToolCall = null;
        } else if (event.type === 'tool-call') {
          res.write(`data: ${JSON.stringify(buildOpenAIChunk(`chatcmpl-${randomUUID()}`, modelId, 0, { tool_calls: [{ index: toolCallIndex++, id: event.toolCallId, type: 'function', function: { name: event.toolName, arguments: JSON.stringify(event.input || {}) } }] }, null))}\n\n`);
        } else if (event.type === 'finish' || event.type === 'finish-step') {
          const finalChunk = {
            id: `chatcmpl-${randomUUID()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          };
          if (usage.totalTokens) {
            finalChunk.usage = {
              prompt_tokens: usage.inputTokens || 0,
              completion_tokens: usage.outputTokens || 0,
              total_tokens: usage.totalTokens || 0,
            };
          }
          res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
          res.write('data: [DONE]\n\n');
        } else if (event.type === 'error') {
          res.write(`data: ${JSON.stringify({ id: `chatcmpl-${randomUUID()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelId, choices: [{ index: 0, delta: {}, finish_reason: 'error' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
        }
      }
      res.end();
      updateCredentialUsage(credential.id, usage);
      return;
    }

    const response = {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: textContent || null,
        },
        finish_reason: finishReason,
      }],
      usage: {
        prompt_tokens: usage.inputTokens || 0,
        completion_tokens: usage.outputTokens || 0,
        total_tokens: usage.totalTokens || 0,
      },
    };
    if (toolCalls.length > 0) response.choices[0].message.tool_calls = toolCalls;
    sendJson(res, 200, response);
    updateCredentialUsage(credential.id, usage);
    return;
  }

  const defaults = getProviderDefaults(provider);
  const baseUrl = normalizeBaseUrl(credential.baseUrl || defaults.baseUrl || '');
  if (!baseUrl) {
    sendError(res, 500, `Credential ${credential.name} is missing a base URL.`, 'configuration_error');
    return;
  }

  const upstream = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...reqBody, model: modelId }),
  });

  if (!upstream.ok) {
    const message = await upstream.text().catch(() => 'Upstream error');
    sendError(res, upstream.status, message, 'api_error');
    return;
  }

  if (reqBody.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      res.write(chunk);
    }
    res.end();
    updateCredentialUsage(credential.id, parseUsageFromSseBuffer(buffer));
    return;
  }

  const data = await upstream.json();
  sendJson(res, 200, data);
  updateCredentialUsage(credential.id, data.usage || {});
}

async function handleLegacyKeys(req, res) {
  if (req.method === 'GET') {
    sendJson(res, 200, {
      keys: safeArray(proxyConfig.credentials).map((credential) => ({
        id: credential.id,
        name: credential.name,
        provider: credential.provider,
        status: credential.status,
        value: getCredentialMaskedValue(credential),
        models: credential.models,
        authType: credential.authType,
        baseUrl: credential.baseUrl,
        usage: credential.usage || {},
        validation: credential.validation || null,
      })),
    });
    return;
  }

  const body = await parseJsonBody(req, res);
  if (!body) return;

  if (req.method === 'POST') {
    try {
      const credential = createCredentialFromInput({
        ...body,
        secretValue: body.value,
        credentialType: body.credentialType || inferCredentialType(body.provider || 'commandcode', body.authType || 'bearer'),
      });
      sendJson(res, 200, { success: true, keys: safeArray(proxyConfig.credentials).map(sanitizeCredential), credential: sanitizeCredential(credential) });
    } catch (error) {
      sendError(res, 400, error.message);
    }
    return;
  }

  const list = safeArray(proxyConfig.credentials);
  const legacyIndex = Number(body.index);
  const credential = list[legacyIndex];
  if (!credential) {
    sendError(res, 404, 'Credential not found', 'not_found_error');
    return;
  }

  if (req.method === 'PUT') {
    try {
      const updatedCredential = updateCredentialFromInput({
        ...body,
        id: credential.id,
        secretValue: body.value,
      });
      sendJson(res, 200, { success: true, keys: safeArray(proxyConfig.credentials).map(sanitizeCredential), credential: sanitizeCredential(updatedCredential) });
    } catch (error) {
      sendError(res, error.message === 'Credential not found' ? 404 : 400, error.message, error.message === 'Credential not found' ? 'not_found_error' : 'invalid_request_error');
    }
    return;
  }

  if (req.method === 'DELETE') {
    proxyConfig.credentials = list.filter((item) => item.id !== credential.id);
    deleteSecretPayload(credential.id);
    proxyConfig = saveConfig(proxyConfig);
    sendJson(res, 200, { success: true });
  }
}

async function handleLegacyValidation(req, res, validateAll = false) {
  if (validateAll) {
    return handleValidateAllCredentials(req, res);
  }
  const input = await parseJsonBody(req, res);
  if (!input) return;
  const list = safeArray(proxyConfig.credentials);
  const credential = list[Number(input.index)];
  if (!credential) {
    sendError(res, 404, 'Credential not found', 'not_found_error');
    return;
  }
  const validation = await validateCredentialRecord(credential);
  sendJson(res, 200, {
    success: true,
    quota: validation.quota || null,
    usage: validation.usage || null,
    info: validation.account || null,
    validation,
  });
}

async function handleRequest(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = parsedUrl.pathname;

  if (pathname === '/' || pathname === '/dashboard') {
    return handleDashboard(req, res);
  }

  if (pathname === '/api/config') {
    if (req.method === 'GET') return handleGetConfig(req, res);
    if (req.method === 'POST') return handleUpdateConfig(req, res);
  }

  if (pathname === '/api/providers' && req.method === 'GET') {
    return handleGetProviders(req, res);
  }

  if (pathname === '/api/credentials') {
    if (req.method === 'GET') return handleGetCredentials(req, res);
    if (req.method === 'POST') return handleCreateCredential(req, res);
    if (req.method === 'PUT') return handleUpdateCredential(req, res);
    if (req.method === 'DELETE') return handleDeleteCredential(req, res);
  }

  if (pathname === '/api/credentials/reveal' && req.method === 'POST') {
    return handleRevealCredential(req, res);
  }

  if (pathname === '/api/credentials/validate' && req.method === 'POST') {
    return handleValidateCredential(req, res);
  }

  if (pathname === '/api/credentials/validate-all' && req.method === 'POST') {
    return handleValidateAllCredentials(req, res);
  }

  if (pathname === '/api/models') {
    if (req.method === 'GET') return handleGetModels(req, res);
    if (req.method === 'POST') return handleUpdateModels(req, res);
  }

  if (pathname === '/api/keys') {
    return handleLegacyKeys(req, res);
  }

  if (pathname === '/api/keys/quota' && req.method === 'POST') {
    return handleLegacyValidation(req, res, false);
  }

  if (pathname === '/api/keys/validate-all' && req.method === 'POST') {
    return handleLegacyValidation(req, res, true);
  }

  if (pathname === '/api/restart' && req.method === 'POST') {
    return sendJson(res, 200, {
      success: true,
      message: 'Restart requested. Restart the local proxy process to apply port changes.',
    });
  }

  if (pathname === '/health' && req.method === 'GET') {
    return handleHealth(req, res);
  }

  if (pathname === '/v1/models' && req.method === 'GET') {
    return handleModelList(req, res);
  }

  if (pathname === '/v1/chat/completions' && req.method === 'POST') {
    return handleChatCompletions(req, res);
  }

  sendError(res, 404, 'Not found', 'not_found_error');
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error('Unhandled request error:', error);
    sendError(res, 500, 'Internal server error', 'server_error');
  });
});

server.listen(getPort(), DEFAULT_BIND_HOST, () => {
  console.log(`Command Code Proxy on http://localhost:${getPort()}`);
  console.log(`Vault config: ${CONFIG_DIR}`);
});

module.exports = {
  server,
  CONFIG_DIR,
  CONFIG_FILE,
  VAULT_FILE,
};
