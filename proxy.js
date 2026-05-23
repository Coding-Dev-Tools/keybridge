const BASE = process.env.COMMAND_CODE_API_URL || 'https://api.commandcode.ai';
const CLI_VER = process.env.COMMAND_CODE_CLI_VERSION || '0.26.24';
const PORT = parseInt(process.env.PROXY_PORT || '3000');

let keyPool = [];

function getActiveApiKey() {
  const activeKeys = (proxyConfig.apiKeys || []).filter(k => k.status === 'active');
  if (activeKeys.length === 0) return process.env.COMMAND_CODE_API_KEY;

  if (keyPool.length === 0) {
    keyPool = [...activeKeys];
    // Fisher-Yates shuffle for even, unpredictable rotation
    for (let i = keyPool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [keyPool[i], keyPool[j]] = [keyPool[j], keyPool[i]];
    }
  }

  const key = keyPool.pop();
  return key.value;
}

function setupOpencodeConfig() {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  
  const opencodeDir = path.join(os.homedir(), '.opencode');
  const configFile = path.join(opencodeDir, 'opencode.json');
  
  try {
    if (!fs.existsSync(opencodeDir)) {
      fs.mkdirSync(opencodeDir, { recursive: true });
    }
    
    let config = {
      $schema: 'https://opencode.ai/config.json'
    };
    
    if (fs.existsSync(configFile)) {
      config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    }
    
    if (!config.provider || typeof config.provider !== 'object') {
      config.provider = {};
    }
    
    config.provider['commandcode'] = {
      npm: '@ai-sdk/openai-compatible',
      name: 'Command Code Proxy',
      options: {
        baseURL: `http://localhost:${PORT}/v1`
      },
      models: {
        'deepseek/deepseek-v4-pro': { name: 'DeepSeek V4 Pro' },
        'deepseek/deepseek-v4-flash': { name: 'DeepSeek V4 Flash' },
        'MiniMaxAI/MiniMax-M2.7': { name: 'MiniMax M2.7' },
        'Qwen/Qwen3.6-Plus': { name: 'Qwen 3.6 Plus' },
        'zai-org/GLM-5.1': { name: 'GLM 5.1' },
        'moonshotai/Kimi-K2.6': { name: 'Kimi K2.6' }
      }
    };
    
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    console.log(`Opencode config updated at ${configFile}`);
  } catch (e) {
    console.error('Failed to update opencode config:', e.message);
  }
}

setupOpencodeConfig();

function convertMessage(m) {
  if (m.role === 'system') return null;
  if (m.role === 'tool') {
    const content = typeof m.content === 'string' ? m.content : 
      (Array.isArray(m.content) ? m.content.find(c => c.type === 'tool-result')?.content || '' : '');
    return { role: 'user', content };
  }
  if (m.role === 'assistant' && m.tool_calls) {
    return {
      role: 'assistant',
      content: [],
      tool_calls: m.tool_calls.map(t => ({
        id: t.id, type: 'function', function: { 
          name: t.function.name, 
          arguments: typeof t.function.arguments === 'string' ? t.function.arguments : JSON.stringify(t.function.arguments)
        }
      }))
    };
  }
  let text = '';
  if (Array.isArray(m.content)) {
    const textObj = m.content.find(c => c.type === 'text');
    text = textObj?.text || '';
  } else if (typeof m.content === 'string') {
    text = m.content;
  }
  return { role: m.role, content: text };
}

function convertTools(tools) {
  if (!tools || tools.length === 0) return [];
  return tools.map(t => {
    if (t.type === 'function' && t.function) {
      return { name: t.function.name, input_schema: t.function.parameters || {} };
    }
    if (t.name) return { name: t.name, input_schema: t.input_schema || {} };
    return null;
  }).filter(Boolean);
}

// crypto.randomUUID helper for Bun / Node cross-compat
function randomUUID() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return randomUUID();
    }
  } catch (err) {}
  const { randomUUID: nodeRandomUUID } = require('crypto');
  return nodeRandomUUID();
}

async function readAllEvents(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try { events.push(JSON.parse(t)); } catch (e) {}
    }
  }
  return events;
}

function buildOpenAIChunk(id, model, index, delta, finishReason) {
  return { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index, delta, finish_reason: finishReason }] };
}

const fs = require('fs');
const path = require('path');
const os = require('os');

let CONFIG_DIR = path.join(__dirname || '.', '.config');
let CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function ensureConfigDir() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      console.log(`Created config directory at ${CONFIG_DIR}`);
    }
  } catch (e) {
    console.error('Failed to create config directory:', e.message);
  }
}

function loadConfig() {
  ensureConfigDir();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      console.log(`Loaded config from ${CONFIG_FILE}`);
      return config;
    }
  } catch (e) {
    console.error('Failed to load config:', e.message);
  }
  
  const defaultConfig = {
    bindHost: 'localhost',
    port: PORT,
    apiUrl: BASE,
    cliVersion: CLI_VER,
    apiKeys: [],
    models: [
      { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true },
      { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', enabled: true },
      { id: 'MiniMaxAI/MiniMax-M2.7', name: 'MiniMax M2.7', enabled: true },
      { id: 'Qwen/Qwen3.6-Plus', name: 'Qwen 3.6 Plus', enabled: true },
      { id: 'zai-org/GLM-5.1', name: 'GLM 5.1', enabled: true },
      { id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6', enabled: true }
    ]
  };
  
  saveConfig(defaultConfig);
  return defaultConfig;
}

function saveConfig(config) {
  try {
    ensureConfigDir();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`Config saved to ${CONFIG_FILE}`);
    return true;
  } catch (e) {
    console.error('Failed to save config:', e.message);
    return false;
  }
}

let proxyConfig = loadConfig();

async function checkKeyQuota(apiKey) {
  try {
    const response = await fetch(`${BASE}/alpha/billing/credits`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'x-command-code-version': CLI_VER
      }
    });
    
    if (!response.ok) {
      return { error: `HTTP ${response.status}`, valid: false };
    }
    
    const data = await response.json();
    const creditsObj = data.credits || {};
    const credits = Number(creditsObj.monthlyCredits ?? creditsObj.purchasedCredits ?? data.balance ?? 0);
    return {
      valid: true,
      credits,
      currency: data.currency || 'USD',
      subscription: data.subscription || null,
      usage: creditsObj,
      raw: data
    };
  } catch (e) {
    return { error: e.message, valid: false };
  }
}

async function checkKeyUsage(apiKey) {
  try {
    const response = await fetch(`${BASE}/alpha/usage/summary`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'x-command-code-version': CLI_VER
      }
    });
    
    if (!response.ok) {
      return { error: `HTTP ${response.status}`, valid: false };
    }
    
    const data = await response.json();
    const credits = Number(data.credits ?? data.balance ?? data.total_credits ?? data.remaining ?? 0);
    const usageData = data.usage || data.summary || data.total_usage || {};
    const totalTokens = Number(
      data.totalTokens ??
      data.total_tokens ??
      (data.completionTokens && data.promptTokens ? data.completionTokens + data.promptTokens : undefined) ??
      usageData.totalTokens ??
      usageData.total_tokens ??
      (usageData.completionTokens && usageData.promptTokens ? usageData.completionTokens + usageData.promptTokens : undefined) ??
      0
    );
    return {
      valid: true,
      credits: isNaN(credits) ? 0 : credits,
      currency: data.currency || 'USD',
      subscription: data.subscription || null,
      totalTokens: isNaN(totalTokens) ? 0 : totalTokens,
      inputTokens: Number(data.inputTokens ?? data.promptTokens ?? data.totalTokensIn ?? usageData.inputTokens ?? usageData.promptTokens ?? usageData.totalTokensIn ?? 0),
      outputTokens: Number(data.outputTokens ?? data.completionTokens ?? data.totalTokensOut ?? usageData.outputTokens ?? usageData.completionTokens ?? usageData.totalTokensOut ?? 0),
      raw: data
    };
  } catch (e) {
    return { error: e.message, valid: false };
  }
}

async function getKeyInfo(apiKey) {
  try {
    const response = await fetch(`${BASE}/alpha/whoami`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'x-command-code-version': CLI_VER
      }
    });
    
    if (!response.ok) {
      return { error: `HTTP ${response.status}`, valid: false };
    }
    
    const data = await response.json();
    let credits = 0;
    if (data.credits && typeof data.credits === 'object') {
      credits = Number(data.credits.monthlyCredits ?? data.credits.purchasedCredits ?? data.credits.freeCredits ?? 0);
    } else {
      credits = Number(data.credits ?? data.balance ?? 0);
    }
    return {
      valid: true,
      credits,
      currency: data.currency || 'USD',
      subscription: data.subscription || null,
      usage: data.usage || null,
      raw: data
    };
  } catch (e) {
    return { error: e.message, valid: false };
  }
}

const http = require('http');
const url = require('url');

// Determine content-type helper
function getContentType(pathname) {
  if (pathname.endsWith('.html')) return 'text/html';
  if (pathname.endsWith('.js')) return 'application/javascript';
  if (pathname.endsWith('.css')) return 'text/css';
  if (pathname.endsWith('.json')) return 'application/json';
  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

async function handleRequest(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  if (pathname === '/dashboard' || pathname === '/') {
    const dashboardPath = path.join(process.cwd(), 'dashboard.html');
    if (fs.existsSync(dashboardPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(dashboardPath));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Dashboard not found');
    return;
  }

  if (pathname === '/api/config') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(proxyConfig));
      return;
    }
    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        const newConfig = JSON.parse(body);
        proxyConfig = { ...proxyConfig, ...newConfig };
        if (saveConfig(proxyConfig)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, config: proxyConfig }));
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to save config' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
  }

  if (pathname === '/api/keys') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: proxyConfig.apiKeys || [] }));
      return;
    }
    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { name, value, status } = JSON.parse(body);
        if (!name || !value) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Name and value required' }));
          return;
        }
        if (!proxyConfig.apiKeys) proxyConfig.apiKeys = [];
        proxyConfig.apiKeys.push({ name, value, status: status || 'active' });
        saveConfig(proxyConfig);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, keys: proxyConfig.apiKeys }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (req.method === 'DELETE') {
      try {
        const body = await readBody(req);
        const { index } = JSON.parse(body);
        if (index === undefined || index < 0 || index >= (proxyConfig.apiKeys?.length || 0)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid index' }));
          return;
        }
        proxyConfig.apiKeys.splice(index, 1);
        saveConfig(proxyConfig);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, keys: proxyConfig.apiKeys }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (req.method === 'PUT') {
      try {
        const body = await readBody(req);
        const { index, name, value, status } = JSON.parse(body);
        if (index === undefined || index < 0 || index >= (proxyConfig.apiKeys?.length || 0)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid index' }));
          return;
        }
        if (!name || !value) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Name and value required' }));
          return;
        }
        proxyConfig.apiKeys[index] = { name, value, status: status || 'active' };
        saveConfig(proxyConfig);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, keys: proxyConfig.apiKeys }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
  }

  if (pathname === '/api/models') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: proxyConfig.models || [] }));
      return;
    }
    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { models } = JSON.parse(body);
        proxyConfig.models = models;
        saveConfig(proxyConfig);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, models: proxyConfig.models }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
  }

  if (pathname === '/api/restart') {
    if (req.method === 'POST') {
      console.log('Restart requested...');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Restart initiated' }));
      return;
    }
  }

  if (pathname === '/api/keys/quota') {
    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { index } = JSON.parse(body);
        if (index === undefined || index < 0 || index >= (proxyConfig.apiKeys?.length || 0)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid index' }));
          return;
        }

        const apiKey = proxyConfig.apiKeys[index].value;
        const [quota, usage, info] = await Promise.all([
          checkKeyQuota(apiKey),
          checkKeyUsage(apiKey),
          getKeyInfo(apiKey)
        ]);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          quota,
          usage,
          info,
          timestamp: new Date().toISOString()
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
  }

  if (pathname === '/api/keys/validate-all') {
    if (req.method === 'POST') {
      try {
        const results = [];
        for (let i = 0; i < (proxyConfig.apiKeys?.length || 0); i++) {
          const apiKey = proxyConfig.apiKeys[i].value;
          const [quota, usage, info] = await Promise.all([
            checkKeyQuota(apiKey),
            checkKeyUsage(apiKey),
            getKeyInfo(apiKey)
          ]);
          results.push({
            index: i,
            name: proxyConfig.apiKeys[i].name,
            quota,
            usage,
            info
          });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          results,
          timestamp: new Date().toISOString()
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
  }

  if (pathname === '/api/bg') {
    try {
      const resp = await fetch('https://peapix.com/bing/feed');
      const data = await resp.json();
      const item = Array.isArray(data) ? data[0] : data;
      const imgUrl = item.fullUrl || item.imageUrl || item.url || '';
      if (imgUrl) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: imgUrl }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

    if (pathname === '/health') {
      let runtime = process.env.PROXY_RUNTIME || '';
      if (runtime === 'node') {
        runtime = 'Node.js ' + process.version;
      } else if (!runtime) {
        runtime = typeof Bun !== 'undefined' ? 'Bun ' + (Bun?.version || '') : 'Node.js ' + process.version;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        version: '1.0.0',
        cli_version: CLI_VER,
        runtime,
        platform: process.platform + '-' + process.arch,
        cwd: process.cwd()
      }));
      return;
    }

  if (pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list', data: [
        { id: 'deepseek/deepseek-v4-pro', object: 'model', created: Date.now(), owned_by: 'deepseek' },
        { id: 'deepseek/deepseek-v4-flash', object: 'model', created: Date.now(), owned_by: 'deepseek' },
        { id: 'MiniMaxAI/MiniMax-M2.7', object: 'model', created: Date.now(), owned_by: 'minimax' },
        { id: 'Qwen/Qwen3.6-Plus', object: 'model', created: Date.now(), owned_by: 'qwen' },
        { id: 'zai-org/GLM-5.1', object: 'model', created: Date.now(), owned_by: 'zai' },
        { id: 'moonshotai/Kimi-K2.6', object: 'model', created: Date.now(), owned_by: 'moonshot' },
      ]
    }));
    return;
  }

  if (pathname === '/v1/chat/completions') {
    let reqBody;
    try {
      const body = await readBody(req);
      reqBody = JSON.parse(body);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }));
      return;
    }

    const sysMsg = (reqBody.messages || []).find(m => m.role === 'system')?.content || '';
    const msgs = (reqBody.messages || []).map(m => convertMessage(m)).filter(Boolean);
    const tools = convertTools(reqBody.tools || []);

    const ccBody = {
      config: {
        workingDir: process.cwd(), 
        date: new Date().toISOString().split('T')[0],
        environment: `${process.platform}-${process.arch}`,
        structure: [], isGitRepo: false, currentBranch: 'main', mainBranch: 'main', gitStatus: '', recentCommits: []
      },
      memory: '', taste: '', skills: null, permissionMode: 'standard',
      params: {
        model: reqBody.model || 'deepseek/deepseek-v4-pro',
        messages: msgs,
        tools: tools,
        system: sysMsg,
        max_tokens: reqBody.max_tokens || 4096,
        temperature: reqBody.temperature ?? 0.3,
        stream: true
      },
      threadId: randomUUID()
    };

    const apiKey = getActiveApiKey();
    if (!apiKey) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'No API key configured', type: 'configuration_error' } }));
      return;
    }

    const r = await fetch(`${BASE}/alpha/generate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'x-command-code-version': CLI_VER
      },
      body: JSON.stringify(ccBody)
    });

    if (!r.ok) {
      const text = await r.text();
      let msg = text;
      try { msg = JSON.parse(text).error?.message || msg; } catch (e) {}
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: msg, type: 'api_error' } }));
      return;
    }

    const events = await readAllEvents(r);
    let textContent = '';
    let toolCalls = [];
    let usage = {};
    let finishReason = 'stop';
    let currentToolCall = null;

    for (const ev of events) {
      const t = ev.type;
      if (t === 'text-delta') textContent += ev.text || '';
      else if (t === 'tool-input-start') {
        currentToolCall = { index: toolCalls.length, id: ev.id, name: ev.toolName, args: '' };
      }
      else if (t === 'tool-input-delta' && currentToolCall) {
        currentToolCall.args += ev.delta || '';
      }
      else if (t === 'tool-input-end' && currentToolCall) {
        toolCalls.push({
          id: currentToolCall.id, type: 'function',
          function: { name: currentToolCall.name, arguments: currentToolCall.args }
        });
        currentToolCall = null;
      }
      else if (t === 'tool-call') {
        toolCalls.push({
          id: ev.toolCallId, type: 'function',
          function: { name: ev.toolName, arguments: JSON.stringify(ev.input || {}) }
        });
      }
      else if (t === 'finish' || t === 'finish-step') {
        if (ev.finishReason === 'tool-calls') finishReason = 'tool_calls';
        else if (ev.finishReason === 'stop' || ev.finishReason === 'end_turn') finishReason = 'stop';
        else if (ev.finishReason) finishReason = ev.finishReason;
        usage = ev.totalUsage || ev.usage || {};
      }
    }

    if (reqBody.stream === true) {
      // Node.js streaming response
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      let currentToolCall = null;
      let toolCallIndex = 0;
      for (const ev of events) {
        const t = ev.type;
        if (t === 'text-delta') {
          const c = ev.text || '';
          const data = `data: ${JSON.stringify(buildOpenAIChunk(`chatcmpl-${randomUUID()}`, reqBody.model, 0, { content: c }, null))}\n\n`;
          res.write(data);
        } else if (t === 'tool-input-start') {
          currentToolCall = { index: toolCallIndex++, id: ev.id, name: ev.toolName, args: '' };
        } else if (t === 'tool-input-delta' && currentToolCall) {
          currentToolCall.args += ev.delta || '';
        } else if (t === 'tool-input-end' && currentToolCall) {
          const data = `data: ${JSON.stringify(buildOpenAIChunk(`chatcmpl-${randomUUID()}`, reqBody.model, 0, {
            tool_calls: [{ index: currentToolCall.index, id: currentToolCall.id, type: 'function', function: { name: currentToolCall.name, arguments: currentToolCall.args } }]
          }, null))}\n\n`;
          res.write(data);
          currentToolCall = null;
        } else if (t === 'tool-call') {
          const data = `data: ${JSON.stringify(buildOpenAIChunk(`chatcmpl-${randomUUID()}`, reqBody.model, 0, {
            tool_calls: [{ index: toolCallIndex++, id: ev.toolCallId, type: 'function', function: { name: ev.toolName, arguments: JSON.stringify(ev.input || {}) } }]
          }, null))}\n\n`;
          res.write(data);
        } else if (t === 'finish' || t === 'finish-step') {
          const fr = ev.finishReason === 'tool-calls' ? 'tool_calls' : (ev.finishReason === 'stop' || ev.finishReason === 'end_turn' ? 'stop' : ev.finishReason || 'stop');
          const u = ev.totalUsage || ev.usage || {};
          const final = {
            id: `chatcmpl-${randomUUID()}`, object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000), model: reqBody.model,
            choices: [{ index: 0, delta: {}, finish_reason: fr }]
          };
          if (u.totalTokens) final.usage = { prompt_tokens: u.inputTokens || 0, completion_tokens: u.outputTokens || 0, total_tokens: u.totalTokens || 0 };
          res.write(`data: ${JSON.stringify(final)}\n\n`);
          res.write(`data: [DONE]\n\n`);
        } else if (t === 'error') {
          const data = `data: ${JSON.stringify({ id: `chatcmpl-${randomUUID()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: reqBody.model, choices: [{ index: 0, delta: {}, finish_reason: 'error' }] })}\n\n`;
          res.write(data);
          res.write(`data: [DONE]\n\n`);
        }
      }
      res.end();
      return;
    }

    const response = {
      id: `chatcmpl-${randomUUID()}`, object: 'chat.completion',
      created: Math.floor(Date.now() / 1000), model: reqBody.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: textContent || null },
        finish_reason: finishReason
      }],
      usage: { prompt_tokens: usage.inputTokens || 0, completion_tokens: usage.outputTokens || 0, total_tokens: usage.totalTokens || 0 }
    };

    if (toolCalls.length > 0) {
      response.choices[0].message.tool_calls = toolCalls;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(handleRequest);
// Always bind to localhost only — never expose to raw IP / all interfaces
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Command Code Proxy on http://localhost:${PORT}`);
});