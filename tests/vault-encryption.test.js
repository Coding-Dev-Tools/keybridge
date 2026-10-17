const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('actual API encryption survives restart and rejects authenticated-ciphertext tampering', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keybridge-crypto-test-'));
  const configDir = path.join(tmp, '.config');
  const proxy = path.join(__dirname, '..', 'proxy.js');
  const script = `
    const assert = require('node:assert/strict');
    const crypto = require('node:crypto');
    const fs = require('node:fs');
    const path = require('node:path');
    const proxy = ${JSON.stringify(proxy)};
    const config = ${JSON.stringify(configDir)};
    const secret = 'test_private_synthetic_credential';
    const master = process.env.COMMANDCODE_PROXY_MASTER_KEY;
    let server;
    async function start() {
      delete require.cache[require.resolve(proxy)];
      server = require(proxy).server;
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      return 'http://127.0.0.1:' + server.address().port;
    }
    async function stop() {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    async function reveal(base, id) {
      return fetch(base + '/api/credentials/reveal', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_proxy_auth' },
        body: JSON.stringify({ id }),
      });
    }
    (async () => {
      try {
        let base = await start();
        const created = await fetch(base + '/api/credentials', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_proxy_auth' },
          body: JSON.stringify({ name: 'test_fixture', provider: 'other', credentialType: 'api_key',
            authType: 'bearer', baseUrl: 'http://127.0.0.1:1', secretValue: secret, status: 'active' }),
        });
        assert.equal(created.status, 200);
        const id = (await created.json()).credential.id;
        const vaultPath = path.join(config, 'vault.json');
        const keyPath = path.join(config, '.vault-key');
        const vaultBytes = fs.readFileSync(vaultPath, 'utf8');
        const vault = JSON.parse(vaultBytes);
        const keyBytes = fs.readFileSync(keyPath);
        const entry = vault.entries[id];
        assert.equal(Buffer.from(entry.iv, 'base64').length, 12);
        assert.equal(Buffer.from(entry.tag, 'base64').length, 16);
        assert.ok(!vaultBytes.includes(secret));
        assert.ok(!fs.readFileSync(path.join(config, 'config.json'), 'utf8').includes(secret));
        if (process.platform !== 'win32') {
          assert.equal(fs.statSync(vaultPath).mode & 0o777, 0o600);
          assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
        }
        const key = crypto.scryptSync(master, Buffer.from(vault.keySalt, 'base64'), 32);
        const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
        cipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
        const plain = Buffer.concat([cipher.update(Buffer.from(entry.ciphertext, 'base64')), cipher.final()]);
        assert.equal(JSON.parse(plain.toString('utf8')).secretValue, secret);
        await stop();
        base = await start();
        let response = await reveal(base, id);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).secretValue, secret);
        assert.deepEqual(fs.readFileSync(keyPath), keyBytes);
        assert.equal(fs.readFileSync(vaultPath, 'utf8'), vaultBytes);
        await stop();
        const altered = Buffer.from(entry.ciphertext, 'base64');
        altered[0] ^= 1;
        entry.ciphertext = altered.toString('base64');
        fs.writeFileSync(vaultPath, JSON.stringify(vault));
        base = await start();
        response = await reveal(base, id);
        assert.equal(response.status, 404);
        assert.ok(!(await response.text()).includes(secret));
        assert.deepEqual(fs.readFileSync(keyPath), keyBytes);
        assert.equal(JSON.parse(fs.readFileSync(vaultPath, 'utf8')).entries[id].ciphertext, entry.ciphertext);
      } finally {
        if (server) await stop();
      }
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  try {
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8', timeout: 15000,
      env: { PATH: process.env.PATH, PROXY_CONFIG_DIR: configDir, PROXY_PORT: '0',
        PROXY_API_KEY: 'test_proxy_auth', COMMANDCODE_PROXY_MASTER_KEY: 'test_master_synthetic_secret',
        DISABLE_OPENCODE_CONFIG: '1' },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.ok(!child.stderr.includes('test_private_synthetic_credential'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
