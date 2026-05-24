const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const repoDir = __dirname;
const port = 3467;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commandcode-vault-test-'));
const configDir = path.join(tempDir, '.config');
fs.mkdirSync(configDir, { recursive: true });

const legacyConfig = {
  version: 1,
  port,
  apiUrl: 'https://api.commandcode.ai',
  cliVersion: '0.26.24',
  apiKeys: [
    {
      name: 'Legacy Command Code',
      value: 'user_legacy_secret_1234567890',
      provider: 'commandcode',
      status: 'active',
      authType: 'bearer',
      models: ['deepseek/deepseek-v4-flash'],
    },
  ],
  models: [
    { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', enabled: true, provider: 'commandcode' },
    { id: 'gpt-4o-mini', name: 'GPT-4o mini', enabled: true, provider: 'openai' },
  ],
};

fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(legacyConfig, null, 2));

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth() {
  const healthUrl = `http://127.0.0.1:${port}/health`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
    } catch (_) {}
    await wait(250);
  }
  throw new Error('Proxy did not become healthy in time.');
}

async function request(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = { raw: text };
  }
  return { response, data };
}

async function run() {
  process.env.PROXY_PORT = String(port);
  process.env.PROXY_CONFIG_DIR = configDir;
  process.env.DISABLE_OPENCODE_CONFIG = '1';
  process.env.PROXY_RUNTIME = 'node';
  const { server } = require(path.join(repoDir, 'proxy.js'));

  try {
    await waitForHealth();

    const health = await request('/health');
    assert.equal(health.response.status, 200);
    assert.equal(health.data.status, 'ok');

    const config = await request('/api/config');
    assert.equal(config.response.status, 200);
    assert.ok(!('credentials' in config.data), 'Config response should not include credentials');

    const credentials = await request('/api/credentials');
    assert.equal(credentials.response.status, 200);
    assert.equal(credentials.data.credentials.length, 1);
    assert.equal(credentials.data.credentials[0].name, 'Legacy Command Code');
    assert.notEqual(credentials.data.credentials[0].maskedValue, 'user_legacy_secret_1234567890');
    assert.equal(credentials.data.credentials[0].hasSecret, true);

    const rawConfig = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
    assert.ok(Array.isArray(rawConfig.credentials), 'Migrated config should contain credentials');
    assert.ok(!rawConfig.apiKeys, 'Legacy apiKeys should be removed during migration');
    assert.ok(!('value' in rawConfig.credentials[0]), 'Secret value should not remain in config.json');

    const vaultContents = fs.readFileSync(path.join(configDir, 'vault.json'), 'utf8');
    assert.ok(!vaultContents.includes('user_legacy_secret_1234567890'), 'Vault file should not contain the raw secret');

    const create = await request('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'OpenAI Bearer',
        provider: 'openai',
        credentialType: 'bearer_token',
        authType: 'bearer',
        baseUrl: 'https://api.openai.com/v1',
        secretValue: 'sk-test-openai-1234567890',
        status: 'active',
        models: ['gpt-4o-mini'],
      }),
    });
    assert.equal(create.response.status, 200);
    assert.equal(create.data.credential.provider, 'openai');
    assert.notEqual(create.data.credential.maskedValue, 'sk-test-openai-1234567890');

    const listAfterCreate = await request('/api/credentials');
    const created = listAfterCreate.data.credentials.find((credential) => credential.name === 'OpenAI Bearer');
    assert.ok(created, 'Created credential should be listed');

    const reveal = await request('/api/credentials/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: created.id }),
    });
    assert.equal(reveal.response.status, 200);
    assert.equal(reveal.data.secretValue, 'sk-test-openai-1234567890');

    const modelList = await request('/v1/models');
    assert.equal(modelList.response.status, 200);
    assert.ok(Array.isArray(modelList.data.data));
    assert.ok(modelList.data.data.some((model) => model.id === 'gpt-4o-mini'));

    console.log('Smoke test passed.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
