const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_BASE = process.env.COMMAND_CODE_API_URL || 'https://api.commandcode.ai';
const DEFAULT_CLI_VER = process.env.COMMAND_CODE_CLI_VERSION || '0.26.24';
const DEFAULT_PORT = parseInt(process.env.PROXY_PORT || '3000', 10);
// Security: bind to loopback by default. A credential vault must never be
// LAN-reachable unless the operator explicitly opts in via PROXY_BIND_HOST.
const DEFAULT_BIND_HOST = process.env.PROXY_BIND_HOST || '127.0.0.1';
const PROXY_API_KEY = process.env.PROXY_API_KEY || '';
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
    label: 'ChatGPT (OpenAI OAuth)',
    baseUrl: 'https://api.openai.com/v1',
    authType: 'bearer',
    validationPath: '/models',
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
    authHeaders: () => ({ 'HTTP-Referer': `http://${DEFAULT_BIND_HOST === '0.0.0.0' ? 'localhost' : DEFAULT_BIND_HOST}:${getPort()}` }),
    validationPath: '/models',
  },
  nvidia: {
    label: 'NVIDIA',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    authType: 'bearer',
    validationPath: '/models',
  },
  wafer: {
    label: 'Wafer',
    baseUrl: 'https://api.wafer.ai/v1',
    authType: 'bearer',
    validationPath: '/models',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    authType: 'bearer',
    validationPath: '/models',
  },
  azure: {
    label: 'Azure OpenAI',
    baseUrl: '',
    authType: 'bearer',
    validationPath: '/models',
  },
  cohere: {
    label: 'Cohere',
    baseUrl: 'https://api.cohere.com/v1',
    authType: 'bearer',
    validationPath: '/models',
  },
  mistral: {
    label: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    authType: 'bearer',
    validationPath: '/models',
  },
  ollama: {
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    authType: 'bearer',
    validationPath: '/models',
  },
  xai: {
    label: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    authType: 'bearer',
    validationPath: '/models',
  },
  perplexity: {
    label: 'Perplexity',
    baseUrl: 'https://api.perplexity.ai',
    authType: 'bearer',
    validationPath: '/models',
  },
  together: {
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    authType: 'bearer',
    validationPath: '/models',
  },
  fireworks: {
    label: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    authType: 'bearer',
    validationPath: '/models',
  },
  other: {
    label: 'Other',
    baseUrl: '',
    authType: 'bearer',
    validationPath: '/models',
  },
  nousresearch: {
    label: 'Nous Research',
    baseUrl: 'https://portal.nousresearch.com/api/v1',
    authType: 'oauth',
    authUrl: 'https://portal.nousresearch.com/oauth/authorize',
    tokenUrl: 'https://portal.nousresearch.com/oauth/token',
    scopes: 'openid profile',
    validationPath: '/models',
  },
};

let customProviders = {};

// Simple in-memory response cache for non-streaming identical requests
const responseCache = new Map();
const CACHE_MAX_SIZE = 100;
const CACHE_TTL_MS = 30000; // 30 seconds

function getCacheKey(reqBody) {
  // Cache key based on model, messages, temperature, max_tokens
  const key = JSON.stringify({
    model: reqBody.model,
    messages: reqBody.messages,
    temperature: reqBody.temperature,
    max_tokens: reqBody.max_tokens,
    top_p: reqBody.top_p,
  });
  return crypto.createHash('sha256').update(key).digest('hex');
}

function getCachedResponse(cacheKey) {
  const entry = responseCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    responseCache.delete(cacheKey);
    return null;
  }
  return entry.data;
}

function setCachedResponse(cacheKey, data) {
  if (responseCache.size >= CACHE_MAX_SIZE) {
    const firstKey = responseCache.keys().next().value;
    responseCache.delete(firstKey);
  }
  responseCache.set(cacheKey, { timestamp: Date.now(), data });
}

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

function htmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;
    req.on('data', (chunk) => {
      totalLength += chunk.length;
      if (totalLength > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
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

async function parseFormBody(req) {
  try {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const result = {};
    for (const [key, value] of params) {
      result[key] = value;
    }
    return result;
  } catch (_) {
    return {};
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

// Durable atomic write: write to a temp file then rename, so a crash or full
// disk can never truncate the vault/config, and failures surface to callers
// (bubbling up to the request handler's catch -> 500) instead of being lost
// in an async callback.
function writeFileAtomicSync(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function saveVault() {
  ensureConfigDir();
  try {
    writeFileAtomicSync(VAULT_FILE, stableJson(vaultState));
  } catch (err) {
    console.error('[proxy] saveVault write error:', err.message);
    throw err;
  }
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
    priority: credential.priority ?? 0,
    tools: safeArray(credential.tools),
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
    providers: {},
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
  if (authType === 'oauth') return 'oauth_token_bundle';
  if (authType === 'bearer') return 'bearer_token';
  return 'api_key';
}

function normalizeCredentialMeta(meta, knownProviders = {}) {
  const provider = (PROVIDER_DEFAULTS[meta.provider] || knownProviders[meta.provider]) ? meta.provider : 'other';
  const defaults = getProviderDefaults(provider, knownProviders);
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
    priority: Number.isInteger(Number(meta.priority)) ? Number(meta.priority) : 0,
    tools: safeArray(meta.tools).map(t => String(t).trim().toLowerCase()).filter(Boolean),
  };
}

function saveConfig(config) {
  ensureConfigDir();
  const { apiKeys, ...configWithoutLegacyKeys } = config;
  const knownProviders = { ...PROVIDER_DEFAULTS, ...(config.providers || {}) };
  const safeConfig = {
    ...configWithoutLegacyKeys,
    version: CONFIG_VERSION,
    bindHost: DEFAULT_BIND_HOST,
    credentials: safeArray(config.credentials).map((credential) => {
      const normalized = normalizeCredentialMeta(credential, knownProviders);
      return normalized;
    }),
    models: safeArray(config.models).map(normalizeModel).filter((model) => model.id && model.name),
    providers: config.providers && typeof config.providers === 'object' ? config.providers : {},
  };
  try {
    writeFileAtomicSync(CONFIG_FILE, stableJson(safeConfig));
  } catch (err) {
    console.error('[proxy] saveConfig write error:', err.message);
    throw err;
  }
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
  const knownProviders = { ...PROVIDER_DEFAULTS, ...(merged.providers || {}) };
  let credentials = safeArray(merged.credentials).map((credential) => {
    const normalized = normalizeCredentialMeta(credential, knownProviders);
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
      const provider = (PROVIDER_DEFAULTS[legacyKey.provider] || knownProviders[legacyKey.provider]) ? legacyKey.provider : 'commandcode';
      const defaults = getProviderDefaults(provider, knownProviders);
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

var proxyConfig = loadConfig();

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

function getProviderDefaults(provider, knownProviders = null) {
  const allProviders = knownProviders || { ...PROVIDER_DEFAULTS, ...(typeof proxyConfig !== 'undefined' && proxyConfig ? proxyConfig.providers : {}) };
  const custom = allProviders[provider];
  if (custom) return custom;
  return PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.other;
}

function getCredentialById(credentialId) {
  return safeArray(proxyConfig.credentials).find((credential) => credential.id === credentialId) || null;
}

function getModelProvider(modelId) {
  const match = safeArray(proxyConfig.models).find((model) => model.id === modelId);
  return match?.provider || 'commandcode';
}

function detectClientTool(req) {
  const source = (req.headers['x-source'] || req.headers['x-tool'] || '').toLowerCase().trim();
  if (source) return source;
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const patterns = {
    openclaw: /openclaw/i,
    hermes: /hermes/i,
    cursor: /cursor/i,
    vscode: /vscode|vs-code|copilot/i,
    'claude-desktop': /claude-desktop/i,
  };
  for (const [tool, regex] of Object.entries(patterns)) {
    if (regex.test(ua)) return tool;
  }
  return null;
}



function getEligibleCredentials(provider, modelId) {
  return safeArray(proxyConfig.credentials)
    .filter((credential) => credential.status === 'active')
    .filter((credential) => credential.provider === provider)
    .filter((credential) => safeArray(credential.models).length === 0 || credential.models.includes(modelId))
    .filter((credential) => Boolean(getCredentialSecretString(credential)));
}

function getGlobalOrderedCredentials(modelId, toolId) {
  const eligible = safeArray(proxyConfig.credentials)
    .filter(cred => cred.status === 'active')
    .filter(cred => Boolean(getCredentialSecretString(cred)))
    .filter(cred => safeArray(cred.models).length === 0 || cred.models.includes(modelId))
    .filter(cred => {
      const tools = safeArray(cred.tools);
      if (tools.length === 0) return true;
      if (!toolId) return true;
      return tools.includes(toolId);
    });

  if (eligible.length === 0 && toolId) {
    const unbound = safeArray(proxyConfig.credentials)
      .filter(cred => cred.status === 'active')
      .filter(cred => Boolean(getCredentialSecretString(cred)))
      .filter(cred => safeArray(cred.models).length === 0 || cred.models.includes(modelId))
      .filter(cred => safeArray(cred.tools).length === 0);
    return sortByPriority(unbound);
  }

  return sortByPriority(eligible);
}

function sortByPriority(credentials) {
  credentials.sort((a, b) => {
    const ap = Number(a.priority) || 0;
    const bp = Number(b.priority) || 0;
    if (bp !== ap) return bp - ap;
    const aIdx = safeArray(proxyConfig.credentials).indexOf(a);
    const bIdx = safeArray(proxyConfig.credentials).indexOf(b);
    return aIdx - bIdx;
  });
  return credentials;
}

function getUsageRatio(credential) {
  const limit = Number(credential.monthlyLimit || 0);
  if (limit <= 0) return 0;
  const used = Number(credential.usage?.requestCount || credential.usage?.totalTokens || 0);
  return used / limit;
}

async function refreshOAuthToken(credential) {
  const secretPayload = getSecretPayload(credential.id);
  if (!secretPayload || !secretPayload.refreshToken) return null;
  const defaults = getProviderDefaults(credential.provider);
  const tokenUrl = defaults.tokenUrl || `${defaults.baseUrl}/oauth/token`;
  try {
    const resp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: secretPayload.refreshToken,
        client_id: credential.clientId || '',
        client_secret: credential.clientSecret || '',
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const newPayload = {
      ...secretPayload,
      accessToken: data.access_token,
      secretValue: data.access_token,
      refreshToken: data.refresh_token || secretPayload.refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    };
    putSecretPayload(credential.id, newPayload);
    return data.access_token;
  } catch (e) {
    return null;
  }
}

function isTokenExpired(credential) {
  const secretPayload = getSecretPayload(credential.id);
  if (!secretPayload || !secretPayload.expiresAt) return false;
  return Date.now() >= secretPayload.expiresAt - 60000; // 1 min buffer
}

async function getCredentialSecretWithRefresh(credential) {
  if (credential.credentialType === 'oauth_token_bundle' && isTokenExpired(credential)) {
    const refreshed = await refreshOAuthToken(credential);
    if (refreshed) return refreshed;
  }
  return getCredentialSecretString(credential);
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

// Format Conversion: OpenAI ↔ Claude Messages API
function convertOpenAIToClaudeMessages(reqBody) {
  const messages = safeArray(reqBody.messages);
  const systemMessage = messages.find((m) => m.role === 'system');
  const claudeMessages = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }],
        };
      }
      if (m.role === 'assistant' && m.tool_calls) {
        return {
          role: 'assistant',
          content: m.tool_calls.map((tc) => ({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: typeof tc.function.arguments === 'string' ? parseMaybeJson(tc.function.arguments) : tc.function.arguments,
          })),
        };
      }
      return {
        role: m.role,
        content: typeof m.content === 'string' ? m.content : m.content?.map?.((c) => c.text || c).join('') || '',
      };
    });

  const tools = safeArray(reqBody.tools)
    .filter((t) => t.type === 'function')
    .map((t) => ({
      name: t.function.name,
      description: t.function.description || '',
      input_schema: t.function.parameters || { type: 'object', properties: {} },
    }));

  return {
    model: reqBody.model,
    max_tokens: reqBody.max_tokens || 4096,
    temperature: reqBody.temperature ?? 0.7,
    top_p: reqBody.top_p,
    system: systemMessage?.content || undefined,
    messages: claudeMessages,
    tools: tools.length > 0 ? tools : undefined,
    stream: reqBody.stream ?? true,
  };
}

function convertClaudeStreamToOpenAI(line, modelId) {
  const payload = line.replace(/^data: /, '');
  const event = parseMaybeJson(payload);
  if (!event) return null;
  if (event.type === 'content_block_delta' && event.delta?.text) {
    return buildOpenAIChunk(`chatcmpl-${randomUUID()}`, modelId, 0, { content: event.delta.text }, null);
  }
  if (event.type === 'message_stop') {
    return buildOpenAIChunk(`chatcmpl-${randomUUID()}`, modelId, 0, {}, 'stop');
  }
  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    return buildOpenAIChunk(`chatcmpl-${randomUUID()}`, modelId, 0, {
      tool_calls: [{ index: 0, id: event.content_block.id, type: 'function', function: { name: event.content_block.name, arguments: '' } }],
    }, null);
  }
  return null;
}

function convertClaudeResponseToOpenAI(claudeRes, modelId) {
  const content = claudeRes.content || [];
  const textBlocks = content.filter((c) => c.type === 'text');
  const toolBlocks = content.filter((c) => c.type === 'tool_use');

  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: textBlocks.map((c) => c.text).join('') || null,
        tool_calls: toolBlocks.length > 0 ? toolBlocks.map((tc, i) => ({
          index: i,
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.input || {}) },
        })) : undefined,
      },
      finish_reason: claudeRes.stop_reason || 'stop',
    }],
    usage: {
      prompt_tokens: claudeRes.usage?.input_tokens || 0,
      completion_tokens: claudeRes.usage?.output_tokens || 0,
      total_tokens: (claudeRes.usage?.input_tokens || 0) + (claudeRes.usage?.output_tokens || 0),
    },
  };
}

// Format Conversion: OpenAI ↔ Google Gemini
function convertOpenAIToGemini(reqBody) {
  const messages = safeArray(reqBody.messages);
  const systemMessage = messages.find((m) => m.role === 'system');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
    }));

  const tools = safeArray(reqBody.tools)
    .filter((t) => t.type === 'function')
    .map((t) => ({
      name: t.function.name,
      description: t.function.description || '',
      parameters: t.function.parameters || { type: 'object', properties: {} },
    }));

  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: reqBody.max_tokens || 4096,
      temperature: reqBody.temperature ?? 0.7,
      topP: reqBody.top_p ?? 0.95,
    },
  };
  if (systemMessage) body.systemInstruction = { parts: [{ text: systemMessage.content }] };
  if (tools.length > 0) body.tools = [{ functionDeclarations: tools }];
  return body;
}

function convertGeminiResponseToOpenAI(geminiRes, modelId) {
  const candidate = geminiRes.candidates?.[0];
  const content = candidate?.content;
  const parts = content?.parts || [];
  const text = parts.filter((p) => p.text).map((p) => p.text).join('');
  const functionCalls = parts.filter((p) => p.functionCall);

  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text || null,
        tool_calls: functionCalls.length > 0 ? functionCalls.map((fc, i) => ({
          index: i,
          id: fc.functionCall?.name || `call_${i}`,
          type: 'function',
          function: {
            name: fc.functionCall?.name || '',
            arguments: JSON.stringify(fc.functionCall?.args || {}),
          },
        })) : undefined,
      },
      finish_reason: candidate?.finishReason === 'STOP' ? 'stop' : 'stop',
    }],
    usage: {
      prompt_tokens: geminiRes.usageMetadata?.promptTokenCount || 0,
      completion_tokens: geminiRes.usageMetadata?.candidatesTokenCount || 0,
      total_tokens: (geminiRes.usageMetadata?.promptTokenCount || 0) + (geminiRes.usageMetadata?.candidatesTokenCount || 0),
    },
  };
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
  if (!resp.body) return [];
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
  const provider = (PROVIDER_DEFAULTS[input.provider] || (proxyConfig && proxyConfig.providers && proxyConfig.providers[input.provider]))
    ? input.provider
    : (existingCredential?.provider || 'commandcode');
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
  const priority = Number.isInteger(Number(input.priority ?? existingCredential?.priority))
    ? Number(input.priority ?? existingCredential?.priority)
    : (existingCredential?.priority || 0);
  const tools = safeArray(input.tools ?? existingCredential?.tools)
    .map(t => String(t).trim().toLowerCase()).filter(Boolean);

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
    const providers = { ...PROVIDER_DEFAULTS, ...(proxyConfig && proxyConfig.providers || {}) };
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
        priority,
        tools,
        updatedAt: nowIso(),
      }, providers),
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

  const providers = { ...PROVIDER_DEFAULTS, ...(proxyConfig && proxyConfig.providers || {}) };
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
      priority,
      tools,
      updatedAt: nowIso(),
    }, providers),
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
  let html = fs.readFileSync(DASHBOARD_FILE, 'utf8');
  // Security: only auto-inject the master key for direct, same-origin
  // navigations from this machine. Cross-origin fetches (drive-by JS on a
  // page the operator happens to visit) carry an Origin header and must
  // never receive the key; remote hosts must never receive it either.
  // The dashboard falls back to prompting for the key when not injected.
  if (PROXY_API_KEY && isLocalDirectRequest(req)) {
    const safeKey = PROXY_API_KEY.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/</g, '\\x3c');
    const inject = `<script>window.PROXY_API_KEY='${safeKey}';</script>`;
    html = html.replace('</head>', `${inject}</head>`);
  }
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' });
  res.end(html);
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

async function handleReorderCredentials(req, res) {
  const input = await parseJsonBody(req, res);
  if (!input) return;
  const { orderedIds } = input;
  if (!Array.isArray(orderedIds)) {
    return sendError(res, 400, 'orderedIds (string array) is required', 'invalid_request_error');
  }
  const credentials = safeArray(proxyConfig.credentials);
  orderedIds.forEach((id, index) => {
    const cred = credentials.find(c => c.id === id);
    if (cred) {
      cred.priority = orderedIds.length - index;
      cred.updatedAt = nowIso();
    }
  });
  proxyConfig = saveConfig(proxyConfig);
  sendJson(res, 200, { success: true });
}

// Reveal endpoint returns plaintext secrets, so it gets defense in depth:
// a sliding-window rate limit plus an audit log of every attempt.
const REVEAL_WINDOW_MS = 60 * 1000;
const REVEAL_MAX_PER_WINDOW = 10;
const revealAttempts = [];

async function handleRevealCredential(req, res) {
  const now = Date.now();
  while (revealAttempts.length && now - revealAttempts[0] > REVEAL_WINDOW_MS) {
    revealAttempts.shift();
  }
  if (revealAttempts.length >= REVEAL_MAX_PER_WINDOW) {
    console.warn(`[audit] credential reveal RATE-LIMITED from=${req.socket.remoteAddress}`);
    sendError(res, 429, 'Too many reveal requests; wait a minute and retry.', 'rate_limit_error');
    return;
  }
  revealAttempts.push(now);
  const input = await parseJsonBody(req, res);
  if (!input) return;
  console.warn(`[audit] credential reveal id=${input.id} from=${req.socket.remoteAddress}`);
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

// OAuth Server: Proxy acts as the OAuth provider that ChatGPT/Apps connect to
async function handleOAuthAuthorize(req, res, provider, parsedUrl) {
  const clientId = parsedUrl.searchParams.get('client_id') || '';
  const redirectUri = parsedUrl.searchParams.get('redirect_uri') || '';
  const scope = parsedUrl.searchParams.get('scope') || 'openid profile';
  const state = parsedUrl.searchParams.get('state') || '';

  if (!redirectUri) {
    sendError(res, 400, 'Missing redirect_uri parameter');
    return;
  }

  // Generate authorization code
  const code = crypto.randomBytes(32).toString('hex');

  // Store pending authorization (purging any expired codes first so leaked
  // old codes cannot linger forever in the config file)
  if (!proxyConfig.oauthPending) proxyConfig.oauthPending = {};
  purgeExpiredOAuthCodes();
  proxyConfig.oauthPending[code] = {
    provider,
    clientId,
    redirectUri,
    scope,
    state,
    createdAt: Date.now(),
  };
  saveConfig(proxyConfig);

  // Serve approval page
  const escProvider = htmlEscape(provider);
  const escScope = htmlEscape(scope);
  const escState = htmlEscape(state);
  const escCode = htmlEscape(code);
  const escRedirectUri = htmlEscape(redirectUri);
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Authorize ${escProvider}</title>
<style>
body{font-family:system-ui,sans-serif;background:#0a1512;color:#e8f5ee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#111f1b;border:1px solid #1a2e28;border-radius:12px;padding:32px;max-width:420px;width:90%}
h1{margin:0 0 8px;font-size:20px}
p{color:#8da396;margin:0 0 24px}
.scope{background:#0a1512;border:1px solid #1a2e28;border-radius:6px;padding:12px;margin-bottom:24px}
.scope li{color:#8da396;margin:4px 0}
.btn{display:block;width:100%;padding:12px;border-radius:6px;border:none;cursor:pointer;font-size:14px;margin-bottom:8px}
.approve{background:#2d6a4f;color:#fff}
.deny{background:transparent;color:#8da396;border:1px solid #1a2e28}
</style></head>
<body>
<div class="card">
<h1>Authorize ${escProvider}</h1>
<p>An application is requesting access to your proxy credentials for <strong>${escProvider}</strong>.</p>
<div class="scope">
<strong>Scopes requested:</strong>
<ul><li>${escScope.split(' ').join('</li><li>')}</li></ul>
</div>
<form method="POST" action="/oauth/approve/${escProvider}">
<input type="hidden" name="code" value="${escCode}">
<input type="hidden" name="state" value="${escState}">
<button class="btn approve" type="submit">Approve Access</button>
</form>
<a href="${escRedirectUri}?error=access_denied&amp;state=${encodeURIComponent(state)}">
<button class="btn deny">Deny</button>
</a>
</div>
</body></html>`;

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

// Authorization codes are single-use, short-lived artifacts. Ten minutes is
// generous for a human approval flow; anything older is treated as leaked.
const OAUTH_CODE_TTL_MS = 10 * 60 * 1000;

function isExpiredOAuthCode(pending) {
  return !pending.createdAt || Date.now() - pending.createdAt > OAUTH_CODE_TTL_MS;
}

function purgeExpiredOAuthCodes() {
  const pendingMap = proxyConfig.oauthPending;
  if (!pendingMap) return;
  for (const [code, pending] of Object.entries(pendingMap)) {
    if (isExpiredOAuthCode(pending)) delete pendingMap[code];
  }
}

async function handleOAuthApprove(req, res, provider, parsedUrl) {
  const body = await parseFormBody(req);
  const code = body.code;
  const state = body.state;

  const pending = proxyConfig.oauthPending?.[code];
  if (!pending || pending.provider !== provider || isExpiredOAuthCode(pending)) {
    if (pending) {
      delete proxyConfig.oauthPending[code];
      saveConfig(proxyConfig);
    }
    sendError(res, 400, 'Invalid or expired authorization code');
    return;
  }

  // Mark as approved
  pending.approved = true;
  pending.approvedAt = Date.now();
  saveConfig(proxyConfig);

  // Redirect back to client with code
  const redirectUri = new URL(pending.redirectUri);
  redirectUri.searchParams.set('code', code);
  if (state) redirectUri.searchParams.set('state', state);

  res.writeHead(302, { Location: redirectUri.toString() });
  res.end();
}

async function handleOAuthToken(req, res) {
  const body = await parseFormBody(req);
  const grantType = body.grant_type;

  if (grantType === 'authorization_code') {
    const code = body.code;
    const pending = proxyConfig.oauthPending?.[code];

    if (!pending || !pending.approved || isExpiredOAuthCode(pending)) {
      if (pending) {
        delete proxyConfig.oauthPending[code];
        saveConfig(proxyConfig);
      }
      sendError(res, 400, 'Invalid or unapproved authorization code');
      return;
    }

    // Generate tokens
    const accessToken = crypto.randomBytes(32).toString('hex');
    const refreshToken = crypto.randomBytes(32).toString('hex');
    const expiresIn = 3600;

    // Create credential
    const credentialId = `oauth_${pending.provider}_${Date.now()}`;
    const credential = {
      id: credentialId,
      name: `${pending.provider} OAuth App (${new Date().toISOString().split('T')[0]})`,
      provider: pending.provider,
      status: 'active',
      credentialType: 'oauth_token_bundle',
      authType: 'oauth',
      baseUrl: getProviderDefaults(pending.provider).baseUrl,
      models: [],
      tags: ['oauth', 'app'],
      notes: `OAuth app: client_id=${pending.clientId}, scope=${pending.scope}`,
      monthlyLimit: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      usage: { requestCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, lastUsed: null },
    };

    proxyConfig.credentials = safeArray(proxyConfig.credentials);
    proxyConfig.credentials.push(credential);

    // Clean up pending
    delete proxyConfig.oauthPending[code];
    saveConfig(proxyConfig);

    putSecretPayload(credentialId, {
      accessToken,
      secretValue: accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    });

    sendJson(res, 200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refreshToken,
    });
    return;
  }

  if (grantType === 'refresh_token') {
    const refreshToken = body.refresh_token;
    // Find credential by refresh token
    const creds = safeArray(proxyConfig.credentials).filter(c => c.credentialType === 'oauth_token_bundle');
    let matched = null;
    for (const c of creds) {
      const payload = getSecretPayload(c.id);
      if (payload && payload.refreshToken === refreshToken) {
        matched = c;
        break;
      }
    }

    if (!matched) {
      sendError(res, 400, 'Invalid refresh token');
      return;
    }

    const newAccess = crypto.randomBytes(32).toString('hex');
    const newRefresh = crypto.randomBytes(32).toString('hex');
    const expiresIn = 3600;

    putSecretPayload(matched.id, {
      ...getSecretPayload(matched.id),
      accessToken: newAccess,
      secretValue: newAccess,
      refreshToken: newRefresh,
      expiresAt: Date.now() + expiresIn * 1000,
    });

    sendJson(res, 200, {
      access_token: newAccess,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: newRefresh,
    });
    return;
  }

  sendError(res, 400, 'Unsupported grant_type');
}

// === OAuth Client Flow — Proxy logs INTO external providers ===

async function handleOAuthClientLogin(req, res, provider, parsedUrl) {
  const defaults = getProviderDefaults(provider);
  if (!defaults.authUrl || !defaults.tokenUrl) {
    return sendError(res, 400, `Provider "${provider}" does not support OAuth login. Add authUrl and tokenUrl to provider config.`);
  }

  const state = crypto.randomBytes(20).toString('hex');
  const port = getPort();
  const host = req.headers.host || `localhost:${port}`;
  const callbackUrl = `http://${host}/oauth/client/callback`;

  if (!proxyConfig.oauthClientStates) proxyConfig.oauthClientStates = {};
  proxyConfig.oauthClientStates[state] = {
    provider,
    createdAt: Date.now(),
  };
  saveConfig(proxyConfig);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: defaults.clientId || '',
    redirect_uri: callbackUrl,
    scope: defaults.scopes || 'openid profile',
    state,
  });

  const redirectUrl = `${defaults.authUrl}?${params.toString()}`;
  res.writeHead(302, { Location: redirectUrl });
  res.end();
}

async function handleOAuthClientCallback(req, res, parsedUrl) {
  const code = parsedUrl.searchParams.get('code');
  const state = parsedUrl.searchParams.get('state');
  const error = parsedUrl.searchParams.get('error');

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body style="font-family:sans-serif;background:#0a0a0a;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh"><div><h1>OAuth Failed</h1><p>${htmlEscape(error)}: ${htmlEscape(parsedUrl.searchParams.get('error_description') || '')}</p></div></body></html>`);
    return;
  }

  if (!code || !state) {
    return sendError(res, 400, 'Missing code or state parameter');
  }

  const pending = proxyConfig.oauthClientStates?.[state];
  if (!pending) {
    return sendError(res, 400, 'Invalid or expired OAuth state');
  }

  const provider = pending.provider;
  const defaults = getProviderDefaults(provider);
  const port = getPort();
  const host = req.headers.host || `localhost:${port}`;
  const callbackUrl = `http://${host}/oauth/client/callback`;

  // Exchange code for tokens
  try {
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl,
      client_id: defaults.clientId || '',
      client_secret: defaults.clientSecret || '',
    });

    const tokenResp = await fetch(defaults.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: tokenBody,
    });

    if (!tokenResp.ok) {
      const errBody = await tokenResp.text().catch(() => 'Unknown error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body style="font-family:sans-serif;background:#0a0a0a;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh"><div><h1>Token Exchange Failed</h1><p>HTTP ${tokenResp.status}: ${htmlEscape(errBody.substring(0, 200))}</p></div></body></html>`);
      return;
    }

    const tokenData = await tokenResp.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || '';
    const expiresIn = tokenData.expires_in || 3600;

    if (!accessToken) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body style="font-family:sans-serif;background:#0a0a0a;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh"><div><h1>Token Missing</h1><p>No access_token in response.</p></div></body></html>');
      return;
    }

    // Create credential
    const credentialId = `oauth_client_${provider}_${Date.now()}`;
    const credential = {
      id: credentialId,
      name: `${defaults.label} OAuth (${new Date().toISOString().split('T')[0]})`,
      provider,
      status: 'active',
      credentialType: 'oauth_token_bundle',
      authType: 'oauth',
      baseUrl: defaults.baseUrl,
      models: [],
      labels: ['oauth'],
      notes: `OAuth login to ${defaults.label}. ${refreshToken ? 'Refresh token available.' : 'No refresh token.'}`,
      monthlyLimit: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      usage: { requestCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, lastUsed: null },
    };

    proxyConfig.credentials = safeArray(proxyConfig.credentials);
    proxyConfig.credentials.push(credential);
    delete proxyConfig.oauthClientStates[state];
    saveConfig(proxyConfig);

    putSecretPayload(credentialId, {
      accessToken,
      secretValue: accessToken,
      refreshToken,
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
    });

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Connected — ${htmlEscape(defaults.label)}</title>
<style>
body{font-family:system-ui,sans-serif;background:#0a1512;color:#e8f5ee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#111f1b;border:1px solid #1a2e28;border-radius:12px;padding:32px;max-width:420px;width:90%;text-align:center}
h1{font-size:22px;margin:0 0 8px}
p{color:#8da396;margin:0 0 20px;font-size:0.95rem}
.badge{display:inline-block;padding:4px 12px;border-radius:999px;background:rgba(72,182,125,0.14);color:#a6f2c7;font-size:0.8rem;margin-top:12px}
</style></head>
<body>
<div class="card">
<h1>Connected to ${htmlEscape(defaults.label)}</h1>
<p>Your credential has been saved to the vault. You can close this window.</p>
<span class="badge">${htmlEscape(credential.name)}</span>
</div>
</body></html>`);

  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body style="font-family:sans-serif;background:#0a0a0a;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh"><div><h1>OAuth Error</h1><p>${htmlEscape(err.message)}</p></div></body></html>`);
  }
}

function handleOAuthClientCheck(req, res, parsedUrl) {
  const provider = parsedUrl.searchParams.get('provider') || '';
  const defaults = provider ? getProviderDefaults(provider) : null;
  if (!defaults || !defaults.authUrl) {
    sendJson(res, 200, { available: false });
    return;
  }
  sendJson(res, 200, {
    available: true,
    provider: htmlEscape(provider),
    label: defaults.label,
    authUrl: defaults.authUrl,
    scopes: defaults.scopes || 'openid profile',
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
  const merged = { ...PROVIDER_DEFAULTS, ...(proxyConfig.providers || {}) };
  sendJson(res, 200, {
    providers: Object.entries(merged).map(([id, provider]) => ({
      id,
      label: provider.label || id,
      baseUrl: provider.baseUrl || '',
      authType: provider.authType || 'bearer',
    })),
    credentialTypes: SUPPORTED_CREDENTIAL_TYPES,
  });
}

async function handleCreateProvider(req, res) {
  const body = await parseJsonBody(req, res);
  if (!body) return;
  const id = String(body.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!id) return sendError(res, 400, 'Provider ID is required', 'validation_error');
  if (PROVIDER_DEFAULTS[id]) return sendError(res, 409, 'Cannot override built-in provider', 'conflict_error');
  if (proxyConfig.providers && proxyConfig.providers[id]) return sendError(res, 409, 'Provider already exists', 'conflict_error');
  const provider = {
    label: String(body.label || id).trim(),
    baseUrl: normalizeBaseUrl(body.baseUrl || ''),
    authType: String(body.authType || 'bearer').trim(),
    validationPath: String(body.validationPath || '/models').trim(),
    authUrl: String(body.authUrl || '').trim() || undefined,
    tokenUrl: String(body.tokenUrl || '').trim() || undefined,
    clientId: String(body.clientId || '').trim() || undefined,
    clientSecret: String(body.clientSecret || '').trim() || undefined,
    scopes: String(body.scopes || '').trim() || undefined,
  };
  proxyConfig.providers = { ...(proxyConfig.providers || {}), [id]: provider };
  saveConfig(proxyConfig);
  sendJson(res, 201, { id, ...provider });
}

async function handleUpdateProvider(req, res) {
  const body = await parseJsonBody(req, res);
  if (!body) return;
  const id = String(body.id || '').trim();
  if (!id || !proxyConfig.providers || !proxyConfig.providers[id]) {
    return sendError(res, 404, 'Provider not found', 'not_found_error');
  }
  if (PROVIDER_DEFAULTS[id]) return sendError(res, 409, 'Cannot modify built-in provider', 'conflict_error');
  const existing = proxyConfig.providers[id];
  proxyConfig.providers[id] = {
    ...existing,
    label: String(body.label || existing.label).trim(),
    baseUrl: normalizeBaseUrl(body.baseUrl || existing.baseUrl),
    authType: String(body.authType || existing.authType).trim(),
    validationPath: String(body.validationPath || existing.validationPath).trim(),
    authUrl: body.authUrl !== undefined ? String(body.authUrl || '').trim() || undefined : existing.authUrl,
    tokenUrl: body.tokenUrl !== undefined ? String(body.tokenUrl || '').trim() || undefined : existing.tokenUrl,
    clientId: body.clientId !== undefined ? String(body.clientId || '').trim() || undefined : existing.clientId,
    clientSecret: body.clientSecret !== undefined ? String(body.clientSecret || '').trim() || undefined : existing.clientSecret,
    scopes: body.scopes !== undefined ? String(body.scopes || '').trim() || undefined : existing.scopes,
  };
  saveConfig(proxyConfig);
  sendJson(res, 200, { id, ...proxyConfig.providers[id] });
}

async function handleDeleteProvider(req, res) {
  const body = await parseJsonBody(req, res);
  if (!body) return;
  const id = String(body.id || '').trim();
  if (!id || !proxyConfig.providers || !proxyConfig.providers[id]) {
    return sendError(res, 404, 'Provider not found', 'not_found_error');
  }
  if (PROVIDER_DEFAULTS[id]) return sendError(res, 409, 'Cannot delete built-in provider', 'conflict_error');
  const inUse = safeArray(proxyConfig.credentials).some((c) => c.provider === id);
  if (inUse) return sendError(res, 409, 'Provider in use by credentials', 'conflict_error');
  delete proxyConfig.providers[id];
  saveConfig(proxyConfig);
  sendJson(res, 200, { deleted: id });
}

async function handleHealth(req, res) {
  const runtime = process.env.PROXY_RUNTIME === 'node'
    ? `Node.js ${process.version}`
    : typeof Bun !== 'undefined'
      ? `Bun ${Bun?.version || ''}`
      : `Node.js ${process.version}`;
  // Unauthenticated callers get a bare liveness signal; system details
  // (paths, platform, runtime) are only for authenticated operators.
  if (!checkProxyAuth(req)) {
    sendJson(res, 200, { status: 'ok', version: '2.0.0' });
    return;
  }
  sendJson(res, 200, {
    status: 'ok',
    version: '2.0.0',
    cli_version: getCliVersion(),
    runtime,
    platform: `${process.platform}-${process.arch}`,
    cwd: process.cwd(),
    config_dir: CONFIG_DIR,
    vault_file: VAULT_FILE,
    local_only: isLoopbackAddress(DEFAULT_BIND_HOST) || DEFAULT_BIND_HOST === 'localhost',
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

// Retry with exponential backoff
async function withRetry(fn, maxRetries = 3, baseDelay = 500) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      // Don't retry on 4xx client errors (except 429 rate limit)
      const status = error.status || 500;
      if (status >= 400 && status < 500 && status !== 429) {
        throw error;
      }
      if (attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

async function handleChatCompletions(req, res) {
  const reqBody = await parseJsonBody(req, res);
  if (!reqBody) return;

  const modelId = reqBody.model || 'deepseek/deepseek-v4-pro';
  const toolId = detectClientTool(req);

  // Check cache for non-streaming identical requests
  if (!reqBody.stream) {
    const cacheKey = getCacheKey(reqBody);
    const cached = getCachedResponse(cacheKey);
    if (cached) {
      sendJson(res, 200, cached);
      return;
    }
  }

  // Global priority routing: credentials tried in #1, #2, #3... order across all providers
  const orderedCredentials = getGlobalOrderedCredentials(modelId, toolId);
  const envKey = (process.env.COMMAND_CODE_API_KEY && !orderedCredentials.some(c => c.provider === 'commandcode'))
    ? { id: 'env-commandcode', provider: 'commandcode', authType: 'bearer', baseUrl: getApiBase(), getSecret: async () => process.env.COMMAND_CODE_API_KEY }
    : null;

  const credentialsToTry = envKey ? [...orderedCredentials, envKey] : orderedCredentials;

  if (credentialsToTry.length === 0) {
    sendError(res, 500, 'No active credentials available', 'configuration_error');
    return;
  }

  let lastError = null;

  for (const credentialRecord of credentialsToTry) {
    let credential;
    if (credentialRecord.id === 'env-commandcode') {
      credential = credentialRecord;
    } else {
      const defaults = getProviderDefaults(credentialRecord.provider);
      credential = {
        ...credentialRecord,
        authType: credentialRecord.authType || defaults.authType || 'bearer',
        baseUrl: normalizeBaseUrl(credentialRecord.baseUrl || defaults.baseUrl || ''),
        getSecret: async () => getCredentialSecretWithRefresh(credentialRecord),
      };
    }

    const provider = credentialRecord.provider;
    const secretValue = await credential.getSecret();
    const authHeaders = {
      ...buildAuthHeaders(credential.authType, secretValue),
      ...getStaticProviderHeaders(provider),
    };

    try {
      let result;
      if (provider === 'commandcode') {
        result = await withRetry(() => routeCommandCode(req, res, reqBody, modelId, credential, authHeaders));
      } else {
        result = await withRetry(() => routeOpenAICompatible(req, res, reqBody, modelId, credential, authHeaders, provider));
      }
      if (result) return;
    } catch (error) {
      lastError = { status: error.status || 502, message: error.message || String(error), type: 'api_error' };
    }
  }

  // All providers exhausted
  if (lastError) {
    sendError(res, lastError.status, lastError.message, lastError.type);
  } else {
    sendError(res, 500, 'No providers available', 'configuration_error');
  }
}

async function routeCommandCode(req, res, reqBody, modelId, credential, authHeaders) {
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
    const error = new Error(message);
    error.status = upstream.status;
    throw error;
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
    return true;
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
  // Cache non-streaming responses
  if (!reqBody.stream) {
    setCachedResponse(getCacheKey(reqBody), response);
  }
  return true;
}

async function routeOpenAICompatible(req, res, reqBody, modelId, credential, authHeaders, provider) {
  const defaults = getProviderDefaults(provider);
  const baseUrl = normalizeBaseUrl(credential.baseUrl || defaults.baseUrl || '');
  if (!baseUrl) {
    throw new Error(`Credential ${credential.name} is missing a base URL`);
  }

  // Provider-specific format conversion and endpoint selection
  let upstreamUrl = `${baseUrl}/chat/completions`;
  let upstreamBody = { ...reqBody, model: modelId };
  let isClaude = false;
  let isGemini = false;

  // Translate model ID to provider-native format
  if (provider === 'opencode') {
    const OPTO_MODEL_MAP = {
      'deepseek/deepseek-v4-pro': 'deepseek-v4-pro',
      'deepseek/deepseek-v4-flash': 'deepseek-v4-flash',
      'Qwen/Qwen3.6-Plus': 'qwen3.6-plus',
      'zai-org/GLM-5.1': 'glm-5.1',
      'moonshotai/Kimi-K2.6': 'kimi-k2.6',
      'MiniMaxAI/MiniMax-M2.7': 'minimax-m2.7',
    };
    upstreamBody.model = OPTO_MODEL_MAP[modelId] || modelId;
  } else if (provider === 'opencode-compatible') {
    // No model ID translation needed
  }

  if (provider === 'anthropic') {
    isClaude = true;
    upstreamUrl = `${baseUrl}/messages`;
    upstreamBody = convertOpenAIToClaudeMessages(reqBody);
  } else if (provider === 'google-ai') {
    isGemini = true;
    upstreamUrl = `${baseUrl}/models/${modelId}:generateContent`;
    upstreamBody = convertOpenAIToGemini(reqBody);
  }

  const upstream = await fetch(upstreamUrl, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(upstreamBody),
  });

  if (!upstream.ok) {
    const message = await upstream.text().catch(() => 'Upstream error');
    const error = new Error(message);
    error.status = upstream.status;
    throw error;
  }

  // Non-streaming: convert response back to OpenAI format
  if (!reqBody.stream) {
    const data = await upstream.json();
    let response = data;
    if (isClaude) response = convertClaudeResponseToOpenAI(data, modelId);
    if (isGemini) response = convertGeminiResponseToOpenAI(data, modelId);
    sendJson(res, 200, response);
    updateCredentialUsage(credential.id, response.usage || {});
    // Cache non-streaming responses
    if (!reqBody.stream) {
      setCachedResponse(getCacheKey(reqBody), response);
    }
    return true;
  }

  // Streaming
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  if (!upstream.body) {
    res.write('data: [DONE]\n\n');
    res.end();
    return true;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });

    if (isClaude) {
      // Convert Claude SSE to OpenAI SSE
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const converted = convertClaudeStreamToOpenAI(line, modelId);
          if (converted) {
            res.write(`data: ${JSON.stringify(converted)}\n\n`);
          }
        } else if (line.trim()) {
          res.write(line + '\n');
        }
      }
    } else {
      res.write(chunk);
    }
    buffer += chunk;
  }

  res.write('data: [DONE]\n\n');
  res.end();
  updateCredentialUsage(credential.id, parseUsageFromSseBuffer(buffer));
  return true;
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

function checkProxyAuth(req) {
  if (!PROXY_API_KEY) return true;
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (token.length !== PROXY_API_KEY.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(PROXY_API_KEY));
  } catch (_) {
    return false;
  }
}

const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function isLoopbackAddress(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// True only for direct requests from this machine that did NOT originate from
// a cross-origin browser context (cross-origin fetches always send Origin).
function isLocalDirectRequest(req) {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  const origin = req.headers.origin;
  if (origin && !LOCAL_ORIGIN_RE.test(origin)) return false;
  return true;
}

// Security: never use a wildcard. Only reflect local origins; foreign web
// pages get no CORS grant, so browsers refuse to hand them our responses.
function setCorsHeaders(res, req) {
  const origin = req && req.headers.origin;
  if (origin && LOCAL_ORIGIN_RE.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

async function handleRequest(req, res) {
  setCorsHeaders(res, req);

  // Handle preflight OPTIONS requests
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = parsedUrl.pathname;

  if (pathname === '/' || pathname === '/dashboard') {
    return handleDashboard(req, res);
  }

  if (pathname === '/health' && req.method === 'GET') {
    return handleHealth(req, res);
  }

  // OAuth Server endpoints (proxy IS the OAuth provider for ChatGPT apps)
  if (pathname.startsWith('/oauth/authorize/')) {
    const provider = pathname.replace('/oauth/authorize/', '');
    return handleOAuthAuthorize(req, res, provider, parsedUrl);
  }
  if (pathname.startsWith('/oauth/approve/') && req.method === 'POST') {
    const provider = pathname.replace('/oauth/approve/', '');
    return handleOAuthApprove(req, res, provider, parsedUrl);
  }
  if (pathname === '/oauth/token' && req.method === 'POST') {
    return handleOAuthToken(req, res);
  }

  // OAUth Client endpoints (proxy logs INTO external providers)
  if (pathname.startsWith('/oauth/client/login/')) {
    const provider = pathname.replace('/oauth/client/login/', '');
    return handleOAuthClientLogin(req, res, provider, parsedUrl);
  }
  if (pathname === '/oauth/client/callback') {
    return handleOAuthClientCallback(req, res, parsedUrl);
  }
  if (pathname === '/api/oauth/check') {
    return handleOAuthClientCheck(req, res, parsedUrl);
  }

  if (!checkProxyAuth(req)) {
    return sendError(res, 401, 'Invalid or missing proxy API key. Set PROXY_API_KEY env var and include it as Bearer token in Authorization header.', 'authentication_error');
  }

  if (pathname === '/api/config') {
    if (req.method === 'GET') return handleGetConfig(req, res);
    if (req.method === 'POST') return handleUpdateConfig(req, res);
  }

  if (pathname === '/api/providers') {
    if (req.method === 'GET') return handleGetProviders(req, res);
    if (req.method === 'POST') return handleCreateProvider(req, res);
    if (req.method === 'PUT') return handleUpdateProvider(req, res);
    if (req.method === 'DELETE') return handleDeleteProvider(req, res);
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

  if (pathname === '/api/credentials/reorder' && req.method === 'POST') {
    return handleReorderCredentials(req, res);
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

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${getPort()} is already in use. Set PROXY_PORT to a different port.`);
    process.exit(1);
  }
  console.error('Server error:', error.message);
  process.exit(1);
});

server.listen(getPort(), DEFAULT_BIND_HOST, () => {
  const displayHost = DEFAULT_BIND_HOST === '0.0.0.0' ? 'localhost' : DEFAULT_BIND_HOST;
  console.log(`Command Code Proxy on http://${displayHost}:${getPort()}`);
  console.log(`Binding to: ${DEFAULT_BIND_HOST}:${getPort()}`);
  console.log(`Vault config: ${CONFIG_DIR}`);
  if (!PROXY_API_KEY) {
    console.warn('[proxy] WARNING: PROXY_API_KEY is not set — all management APIs are UNAUTHENTICATED. Set it before storing real credentials.');
  }
  if (!process.env.COMMANDCODE_PROXY_MASTER_KEY) {
    console.warn('[proxy] WARNING: COMMANDCODE_PROXY_MASTER_KEY is not set — vault encryption falls back to a machine-derived key that local processes can reproduce.');
  }
  if (DEFAULT_BIND_HOST === '0.0.0.0' || DEFAULT_BIND_HOST === '::') {
    console.warn('[proxy] WARNING: binding to all interfaces — the vault is reachable from your network.');
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

module.exports = {
  server,
  CONFIG_DIR,
  CONFIG_FILE,
  VAULT_FILE,
};
