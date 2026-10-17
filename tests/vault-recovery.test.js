const test = require("node:test");
const assert = require("node:assert");
const { spawnSync, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Boot only against synthetic files, then close the ephemeral local server.
function startProxyWithVault(vaultContent, { denyArchive = false, denyReplacement = false,
  previousBackup = null, denyFsync = false, oldTempSymlink = false,
  recordDurability = false, directorySyncFailureAt = 0 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keybridge-vault-test-"));
  const configDir = path.join(tmp, ".config");
  fs.mkdirSync(configDir, { recursive: true });
  if (vaultContent !== null) {
    fs.writeFileSync(path.join(configDir, "vault.json"), vaultContent);
  }
  const previousBackupPath = path.join(configDir, "vault.json.corrupt-2026-10-16T00-00-00-000Z");
  if (previousBackup !== null) fs.writeFileSync(previousBackupPath, previousBackup);
  const child = spawnSync(
    process.execPath,
    ["-e", `
      const fs = require("node:fs");
      const vaultFile = ${JSON.stringify(path.join(configDir, "vault.json"))};
      if (${recordDurability || directorySyncFailureAt > 0}) {
        const events = [];
        let directorySyncs = 0;
        const record = (event) => {
          events.push(event);
          fs.writeFileSync(${JSON.stringify(path.join(tmp, "durability.json"))}, JSON.stringify(events));
        };
        const originalFsync = fs.fsyncSync;
        fs.fsyncSync = (fd) => {
          const directory = fs.fstatSync(fd).isDirectory();
          if (directory) directorySyncs++;
          if (directory && directorySyncs === ${directorySyncFailureAt}) {
            record("directory-sync-failed");
            throw Object.assign(new Error("test directory flush denied"), { code: "EIO" });
          }
          originalFsync(fd);
          record(directory ? "directory-synced" : "file-synced");
        };
        const originalRename = fs.renameSync;
        fs.renameSync = (source, destination) => {
          originalRename(source, destination);
          if (destination === vaultFile) record("vault-replaced");
        };
      }
      if (${denyFsync}) {
        fs.fsyncSync = () => { throw Object.assign(new Error("test flush denied"), { code: "ENOSPC" }); };
      }
      if (${oldTempSymlink}) {
        Date.now = () => 0;
        const external = ${JSON.stringify(path.join(tmp, "external-fixture"))};
        fs.writeFileSync(external, "test_external_data");
        fs.symlinkSync(external, vaultFile + ".tmp-" + process.pid + "-0");
      }
      if (${previousBackup !== null}) {
        Date.prototype.toISOString = () => "2026-10-16T00:00:00.000Z";
      }
      if (${denyArchive}) {
        const originalOpen = fs.openSync;
        fs.openSync = (file, ...args) => {
          if (String(file).startsWith(vaultFile + ".corrupt-")) {
            throw Object.assign(new Error("test archive denied"), { code: "EACCES" });
          }
          return originalOpen(file, ...args);
        };
        for (const name of ["renameSync", "copyFileSync"]) {
          const original = fs[name];
          fs[name] = (source, ...args) => {
            if (source === vaultFile) {
              throw Object.assign(new Error("test archive denied"), { code: "EACCES" });
            }
            return original(source, ...args);
          };
        }
      }
      if (${denyReplacement}) {
        const originalRename = fs.renameSync;
        fs.renameSync = (source, destination) => {
          if (destination === vaultFile) {
            throw Object.assign(new Error("test replacement denied"), { code: "ENOSPC" });
          }
          return originalRename(source, destination);
        };
      }
      const { server } = require(${JSON.stringify(path.join(__dirname, "..", "proxy.js"))});
      server.on("listening", () => server.close());
    `],
    {
      encoding: "utf8",
      timeout: 3000,
      env: {
        PATH: process.env.PATH,
        PROXY_CONFIG_DIR: configDir,
        PROXY_PORT: "0",
        DISABLE_OPENCODE_CONFIG: "1",
      },
    }
  );
  return { tmp, configDir, child };
}

test("corrupt vault.json is archived (never destroyed) and replaced with a fresh vault", () => {
  const corrupt = '{"version":1,"keySalt":"abc","entries":{"a":{';
  const { tmp, configDir, child } = startProxyWithVault(corrupt);
  try {
    assert.strictEqual(child.status, 0, child.stderr);
    // Boot output should carry a loud warning about corruption.
    assert.match(child.stderr || "", /unreadable\/corrupt/);
    // A .corrupt-* archive of the original file must exist.
    const files = fs.readdirSync(configDir);
    const backups = files.filter((f) => f.startsWith("vault.json.corrupt-"));
    assert.ok(backups.length === 1, `expected exactly one corrupt backup, got ${files.join(",")}`);
    const backedUp = fs.readFileSync(path.join(configDir, backups[0]), "utf8");
    assert.strictEqual(backedUp, corrupt, "backup must preserve original bytes exactly");
    if (process.platform !== "win32") {
      assert.strictEqual(fs.statSync(path.join(configDir, backups[0])).mode & 0o777, 0o600);
    }
    // Fresh vault must be valid JSON with empty entries.
    const fresh = JSON.parse(fs.readFileSync(path.join(configDir, "vault.json"), "utf8"));
    assert.deepStrictEqual(fresh.entries, {});
    assert.ok(fresh.keySalt && fresh.keySalt !== "abc");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("healthy vault.json is loaded untouched (no backup created)", () => {
  const healthy = JSON.stringify({ version: 1, keySalt: "c2FsdA==", entries: {
    test_fixture: { version: 1, iv: "test_iv", tag: "test_tag", ciphertext: "test_ciphertext" },
  } });
  const { tmp, configDir, child } = startProxyWithVault(healthy);
  try {
    assert.strictEqual(child.status, 0, child.stderr);
    assert.doesNotMatch(child.stderr || "", /unreadable\/corrupt/);
    const files = fs.readdirSync(configDir).filter((f) => f.startsWith("vault.json.corrupt-"));
    assert.strictEqual(files.length, 0, "no backup should be created for a healthy vault");
    const onDisk = JSON.parse(fs.readFileSync(path.join(configDir, "vault.json"), "utf8"));
    assert.strictEqual(onDisk.keySalt, "c2FsdA==", "salt must be preserved");
    assert.strictEqual(fs.readFileSync(path.join(configDir, "vault.json"), "utf8"), healthy);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("failed archival aborts startup without replacing the original vault", () => {
  const corrupt = '{"entries":{"test_fixture":INVALID';
  const { tmp, configDir, child } = startProxyWithVault(corrupt, { denyArchive: true });
  try {
    assert.notStrictEqual(child.status, 0, "startup must fail when no backup can be made");
    assert.strictEqual(fs.readFileSync(path.join(configDir, "vault.json"), "utf8"), corrupt);
    assert.doesNotMatch(child.stderr, /Original preserved at|Starting an EMPTY vault/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a failed replacement preserves both the original and its recovery backup", () => {
  const corrupt = '{"entries":{"test_fixture":INVALID';
  const { tmp, configDir, child } = startProxyWithVault(corrupt, { denyReplacement: true });
  try {
    assert.notStrictEqual(child.status, 0);
    assert.strictEqual(fs.readFileSync(path.join(configDir, "vault.json"), "utf8"), corrupt);
    const backup = fs.readdirSync(configDir).find((name) => name.startsWith("vault.json.corrupt-"));
    assert.ok(backup);
    assert.strictEqual(fs.readFileSync(path.join(configDir, backup), "utf8"), corrupt);
    assert.deepStrictEqual(fs.readdirSync(configDir).filter((name) => name.includes(".tmp-")), []);
    assert.doesNotMatch(child.stderr, /Starting an EMPTY vault/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("recovery never overwrites an earlier archive with the same timestamp", () => {
  const corrupt = '{"entries":{"test_fixture":INVALID';
  const previousBackup = "test_previous_archive";
  const { tmp, configDir, child } = startProxyWithVault(corrupt, { previousBackup });
  try {
    assert.notStrictEqual(child.status, 0);
    assert.strictEqual(fs.readFileSync(path.join(configDir, "vault.json"), "utf8"), corrupt);
    const backup = path.join(configDir, "vault.json.corrupt-2026-10-16T00-00-00-000Z");
    assert.strictEqual(fs.readFileSync(backup, "utf8"), previousBackup);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("recovery diagnostics do not print corrupt vault contents", () => {
  const secret = "test_key";
  const { tmp, child } = startProxyWithVault(secret);
  try {
    assert.strictEqual(child.status, 0, child.stderr);
    assert.match(child.stderr, /unreadable\/corrupt/);
    assert.ok(!child.stderr.includes(secret), "parser errors must not disclose vault bytes");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("failed backup flush preserves the original and removes partial owned files", () => {
  const corrupt = '{"entries":{"test_fixture":INVALID';
  const { tmp, configDir, child } = startProxyWithVault(corrupt, { denyFsync: true });
  try {
    assert.notStrictEqual(child.status, 0);
    assert.strictEqual(fs.readFileSync(path.join(configDir, "vault.json"), "utf8"), corrupt);
    assert.deepStrictEqual(fs.readdirSync(configDir), ["vault.json"]);
    assert.doesNotMatch(child.stderr, /Starting an EMPTY vault/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a preexisting predictable temporary symlink cannot overwrite an external file", {
  skip: process.platform === "win32" ? "Windows symlink creation may require administrator rights" : false,
}, () => {
  const corrupt = '{"entries":{"test_fixture":INVALID';
  const { tmp, configDir, child } = startProxyWithVault(corrupt, { oldTempSymlink: true });
  try {
    assert.strictEqual(child.status, 0, child.stderr);
    assert.strictEqual(fs.readFileSync(path.join(tmp, "external-fixture"), "utf8"), "test_external_data");
    assert.strictEqual(fs.lstatSync(path.join(configDir, "vault.json")).isSymbolicLink(), false);
    const foreign = fs.readdirSync(configDir).find((name) => name.includes(".tmp-"));
    assert.ok(foreign, "the writer must not delete a temporary file it did not create");
    assert.strictEqual(fs.lstatSync(path.join(configDir, foreign)).isSymbolicLink(), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("proxy entry still parses (guard against regressions)", () => {
  execFileSync("node", ["--check", path.join(__dirname, "..", "proxy.js")], { stdio: "ignore" });
});

const directorySyncOnly = {
  skip: process.platform === "win32" ? "Node directory handles do not support fsync on Windows" : false,
};

test("recovery persists the archive entry before replacing and persisting the vault entry", directorySyncOnly, () => {
  const corrupt = '{"entries":{"test_fixture":INVALID';
  const { tmp, configDir, child } = startProxyWithVault(corrupt, { recordDurability: true });
  try {
    assert.strictEqual(child.status, 0, child.stderr);
    const events = JSON.parse(fs.readFileSync(path.join(tmp, "durability.json"), "utf8"));
    assert.deepStrictEqual(events.slice(0, 5), [
      "file-synced", "directory-synced", "file-synced", "vault-replaced", "directory-synced",
    ]);
    const backup = fs.readdirSync(configDir).find((name) => name.startsWith("vault.json.corrupt-"));
    assert.strictEqual(fs.readFileSync(path.join(configDir, backup), "utf8"), corrupt);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("failed archive-directory sync refuses replacement and retains the original", directorySyncOnly, () => {
  const corrupt = '{"entries":{"test_fixture":INVALID';
  const { tmp, configDir, child } = startProxyWithVault(corrupt, { directorySyncFailureAt: 1 });
  try {
    assert.notStrictEqual(child.status, 0, "unflushed backup must not permit recovery");
    assert.strictEqual(fs.readFileSync(path.join(configDir, "vault.json"), "utf8"), corrupt);
    const events = JSON.parse(fs.readFileSync(path.join(tmp, "durability.json"), "utf8"));
    assert.ok(!events.includes("vault-replaced"));
    assert.doesNotMatch(child.stderr, /Original preserved at|Starting an EMPTY vault/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("failed replacement-directory sync reports failure with the durable archive intact", directorySyncOnly, () => {
  const corrupt = '{"entries":{"test_fixture":INVALID';
  const { tmp, configDir, child } = startProxyWithVault(corrupt, { directorySyncFailureAt: 2 });
  try {
    assert.notStrictEqual(child.status, 0, "unflushed replacement must not report success");
    const backup = fs.readdirSync(configDir).find((name) => name.startsWith("vault.json.corrupt-"));
    assert.strictEqual(fs.readFileSync(path.join(configDir, backup), "utf8"), corrupt);
    assert.deepStrictEqual(fs.readdirSync(configDir).filter((name) => name.includes(".tmp-")), []);
    const events = JSON.parse(fs.readFileSync(path.join(tmp, "durability.json"), "utf8"));
    assert.deepStrictEqual(events.slice(0, 5), [
      "file-synced", "directory-synced", "file-synced", "vault-replaced", "directory-sync-failed",
    ]);
    assert.doesNotMatch(child.stderr, /Starting an EMPTY vault/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
