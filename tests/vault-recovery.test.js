const test = require("node:test");
const assert = require("node:assert");
const { spawnSync, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Spawns proxy.js with a temp PROXY_CONFIG_DIR and an ephemeral port, waits
// for /health, then lets the caller inspect the config dir. Returns cleanup fn.
function startProxyWithVault(vaultContent) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keybridge-vault-test-"));
  const configDir = path.join(tmp, ".config");
  fs.mkdirSync(configDir, { recursive: true });
  if (vaultContent !== null) {
    fs.writeFileSync(path.join(configDir, "vault.json"), vaultContent);
  }
  const port = 3400 + Math.floor(Math.random() * 400);
  const child = spawnSync(
    process.execPath,
    ["-e", `
      process.env.PROXY_CONFIG_DIR = ${JSON.stringify(configDir)};
      process.env.PROXY_PORT = String(${port});
      require(${JSON.stringify(path.join(__dirname, "..", "proxy.js"))});
    `],
    { encoding: "utf8", timeout: 3000 }
  );
  // The -e wrapper exits after the server closes; instead run in-process check:
  // simpler — just load the module in a child that we can't keep alive easily,
  // so verify recovery artifacts directly after a short-lived boot.
  return { tmp, configDir, child };
}

test("corrupt vault.json is archived (never destroyed) and replaced with a fresh vault", () => {
  const corrupt = '{"version":1,"keySalt":"abc","entries":{"a":{';
  const { tmp, configDir, child } = startProxyWithVault(corrupt);
  try {
    // Boot output should carry a loud warning about corruption.
    assert.match(child.stderr || "", /unreadable\/corrupt/);
    // A .corrupt-* archive of the original file must exist.
    const files = fs.readdirSync(configDir);
    const backups = files.filter((f) => f.startsWith("vault.json.corrupt-"));
    assert.ok(backups.length === 1, `expected exactly one corrupt backup, got ${files.join(",")}`);
    const backedUp = fs.readFileSync(path.join(configDir, backups[0]), "utf8");
    assert.strictEqual(backedUp, corrupt, "backup must preserve original bytes exactly");
    // Fresh vault must be valid JSON with empty entries.
    const fresh = JSON.parse(fs.readFileSync(path.join(configDir, "vault.json"), "utf8"));
    assert.deepStrictEqual(fresh.entries, {});
    assert.ok(fresh.keySalt && fresh.keySalt !== "abc");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("healthy vault.json is loaded untouched (no backup created)", () => {
  const healthy = JSON.stringify({ version: 1, keySalt: "c2FsdA==", entries: {} });
  const { tmp, configDir, child } = startProxyWithVault(healthy);
  try {
    assert.doesNotMatch(child.stderr || "", /unreadable\/corrupt/);
    const files = fs.readdirSync(configDir).filter((f) => f.startsWith("vault.json.corrupt-"));
    assert.strictEqual(files.length, 0, "no backup should be created for a healthy vault");
    const onDisk = JSON.parse(fs.readFileSync(path.join(configDir, "vault.json"), "utf8"));
    assert.strictEqual(onDisk.keySalt, "c2FsdA==", "salt must be preserved");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("proxy entry still parses (guard against regressions)", () => {
  execFileSync("node", ["--check", path.join(__dirname, "..", "proxy.js")], { stdio: "ignore" });
});
