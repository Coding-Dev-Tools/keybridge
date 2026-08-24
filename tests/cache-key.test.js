const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Regression tests for the /v1/chat/completions response cache.
//
// The probe runs in a CHILD process because requiring proxy.js boots the
// HTTP server as a side effect; the child binds port 0 (ephemeral) with an
// isolated PROXY_CONFIG_DIR and exits when done.

function runProbe() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keybridge-cache-probe-"));
  process.env.PROXY_CONFIG_DIR = path.join(tmp, ".config");
  process.env.PROXY_PORT = "0";
  const proxy = require(path.join(__dirname, "..", "proxy.js"));

  const base = {
    model: "deepseek/deepseek-v4-flash",
    messages: [{ role: "user", content: "list files" }],
    temperature: 0.3,
    max_tokens: 256,
  };
  const withTools = {
    ...base,
    tools: [{ type: "function", function: { name: "list_files", parameters: { type: "object" } } }],
  };

  let n = 0;
  const check = (name, cond) => {
    n += 1;
    if (!cond) throw new Error(`scenario ${name} failed`);
    process.stdout.write(`PROBE:${name}:ok
`);
  };

  // 1. Deterministic for identical bodies.
  check("deterministic", proxy.getCacheKey(base) === proxy.getCacheKey({ ...base }));

  // 2. THE REGRESSION: adding tools must change the key. Previously the key
  // ignored tools, so a tools-bearing request was served a cached answer
  // generated without them (tool_calls silently dropped).
  check("tools-change-key", proxy.getCacheKey(withTools) !== proxy.getCacheKey(base));

  // 3. Other response-affecting fields must change the key too.
  const variants = {
    tool_choice: { ...base, tool_choice: "auto" },
    response_format: { ...base, response_format: { type: "json_object" } },
    temperature: { ...base, temperature: 0.7 },
    max_tokens: { ...base, max_tokens: 512 },
    top_p: { ...base, top_p: 0.5 },
    stop: { ...base, stop: ["END"] },
    seed: { ...base, seed: 42 },
    presence_penalty: { ...base, presence_penalty: 0.1 },
    frequency_penalty: { ...base, frequency_penalty: 0.1 },
  };
  for (const [field, body] of Object.entries(variants)) {
    check(`${field}-changes-key`, proxy.getCacheKey(body) !== proxy.getCacheKey(base));
  }

  // 4. End-to-end: an entry stored for the plain request must NOT be served
  // to the tools-bearing request, and must still hit for the exact request.
  proxy.responseCache.clear();
  const fakeResponse = { id: "chatcmpl-test", choices: [] };
  proxy.setCachedResponse(proxy.getCacheKey(base), fakeResponse);
  check(
    "no-cross-tool-serving",
    proxy.getCachedResponse(proxy.getCacheKey(withTools)) === null
  );
  const hit = proxy.getCachedResponse(proxy.getCacheKey(base));
  check("exact-request-hits", hit !== null && hit.id === "chatcmpl-test");

  // 5. Documented exclusion: only the stream flag is ignored (entries are
  // written and read exclusively for non-streaming requests).
  check(
    "stream-flag-excluded",
    proxy.getCacheKey({ ...base, stream: false }) === proxy.getCacheKey({ ...base, stream: true })
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  process.stdout.write(`CACHE_PROBE_OK scenarios=${n}
`);
  process.exit(0);
}

if (process.env.CACHE_PROBE_CHILD === "1") {
  runProbe();
} else {
  test("response cache key covers every request-affecting field", () => {
    const child = spawnSync(process.execPath, [__filename], {
      env: { ...process.env, CACHE_PROBE_CHILD: "1" },
      encoding: "utf8",
      timeout: 20000,
    });
    assert.match(child.stdout || "", /CACHE_PROBE_OK/, `probe failed: ${child.stderr}`);
    assert.strictEqual(child.status, 0, `probe exited nonzero: ${child.stderr}`);
    assert.match(child.stdout, /PROBE:tools-change-key:ok/);
    assert.match(child.stdout, /PROBE:no-cross-tool-serving:ok/);
    assert.match(child.stdout, /PROBE:exact-request-hits:ok/);
  });
}
