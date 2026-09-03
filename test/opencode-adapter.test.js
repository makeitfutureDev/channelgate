import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { adapterFor } from "../src/engines/registry.js";
import { buildOpenCodeArgs, buildOpenCodeEnv, progressFromOpenCodeEvent, runOpenCode } from "../src/engines/opencode.js";
import { ensureTestEnv } from "./helpers.js";

// runOpenCode() mkdirs the engine's synthetic HOME under the runtime root before it spawns. Without
// the scratch env that root is the operator's real `~/.channelgate/`, so this file used to create
// `~/.channelgate/engine-state/opencode/home` on every run. The path helpers read the environment
// on every call, so pinning it here — before any test body runs — is enough.
ensureTestEnv();

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, "fixtures");
const fixture = path.join(fixtureDir, "opencode");

test.before(async () => chmod(fixture, 0o755));

test("OpenCode admission compiler refuses every capability its policy cannot confine", () => {
  const adapter = adapterFor("opencode");
  assert.deepEqual(adapter.compileConfinement({}), {
    supported: true, reason: "", network: { mode: "off", supported: true }, writable: false, bypass: false,
  });
  for (const request of [{ writable: true }, { allowNetwork: true }, { dangerouslySkip: true }]) {
    const result = adapter.compileConfinement(request);
    assert.equal(result.supported, false);
    assert.match(result.reason, /read-only, network-off/);
  }
});

test("OpenCode argv and env select JSON/read-only operation without carrying gateway secrets", () => {
  const args = buildOpenCodeArgs({ prompt: "inspect", cwd: "/work", sessionId: "ses_1", isNewSession: false, model: "anthropic/test", effort: "high", attachments: ["/work/a.png"] });
  assert.deepEqual(args, ["run", "--format", "json", "--dir", "/work", "--agent", "gateway-readonly", "--session", "ses_1", "--model", "anthropic/test", "--variant", "high", "--file", "/work/a.png", "inspect"]);
  const env = buildOpenCodeEnv({ PATH: "/bin", SLACK_BOT_TOKEN: "secret", OPENAI_API_KEY: "provider" });
  assert.equal(env.SLACK_BOT_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, "provider");
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  for (const action of ["edit", "bash", "shell", "task", "subagent", "skill", "lsp", "webfetch", "websearch", "external_directory", "execute"]) {
    assert.equal(config.permission[action], "deny", action);
  }
  assert.deepEqual(config.permissions.slice(0, 4).map(({ action, effect }) => [action, effect]), [
    ["*", "deny"], ["read", "allow"], ["glob", "allow"], ["grep", "allow"],
  ]);
  assert.equal(config.permissions.at(-1).effect, "deny");
  assert.equal(config.agents["gateway-readonly"].permissions[0].effect, "deny");
  assert.deepEqual(config.mcp, {});
});

test("OpenCode JSON events map to deltas and tool progress", () => {
  assert.deepEqual(progressFromOpenCodeEvent({ type: "text", part: { text: "hello" } }), { delta: "hello" });
  assert.deepEqual(progressFromOpenCodeEvent({ type: "tool_use", part: { tool: "read" } }), { event: { kind: "tool_use", name: "read" } });
});

test("OpenCode stub E2E covers new session, resume, JSON stream, usage, and cost", async () => {
  const oldPath = process.env.PATH;
  process.env.PATH = `${fixtureDir}${path.delimiter}${oldPath}`;
  try {
    const deltas = [];
    const fresh = await runOpenCode({ cwd: here, prompt: "hello", sessionId: "ignored", isNewSession: true, onDelta: (delta) => deltas.push(delta), timeoutMs: 1_000 });
    assert.equal(fresh.content, "stub reply");
    assert.equal(fresh.sessionId, "ses_stub_new");
    // Usage arrives normalized to the gateway's *_tokens convention (reasoning folds into
    // output) — raw OpenCode shapes recorded 0/0 in the ledger and made real turns look empty.
    assert.deepEqual(fresh.usage, { input_tokens: 11, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    assert.equal(fresh.costUSD, 0.002);
    assert.deepEqual(deltas, ["stub reply"]);

    const resumed = await runOpenCode({ cwd: here, prompt: "again", sessionId: "ses_existing", isNewSession: false, timeoutMs: 1_000 });
    assert.equal(resumed.sessionId, "ses_existing");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("OpenCode health uses the registered CLI version probe", async () => {
  const oldPath = process.env.PATH;
  process.env.PATH = `${fixtureDir}${path.delimiter}${oldPath}`;
  try {
    const health = await adapterFor("opencode").health();
    assert.equal(health.ready, true);
    assert.equal(health.version, "opencode 1.0.0-stub");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("OpenCode stub E2E cancellation terminates the process group", async () => {
  const oldPath = process.env.PATH;
  process.env.PATH = `${fixtureDir}${path.delimiter}${oldPath}`;
  const controller = new AbortController();
  try {
    const running = runOpenCode({ cwd: here, prompt: "WAIT_FOR_ABORT", sessionId: "", isNewSession: true, signal: controller.signal, timeoutMs: 5_000 });
    setTimeout(() => controller.abort(), 50).unref();
    await assert.rejects(running, (error) => error.name === "AbortError");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("OpenCode generic process failures are semantic while the raw code stays structured", async () => {
  const oldPath = process.env.PATH;
  process.env.PATH = `${fixtureDir}${path.delimiter}${oldPath}`;
  try {
    await assert.rejects(
      runOpenCode({ cwd: here, prompt: "FAIL_GENERIC", sessionId: "", isNewSession: true, timeoutMs: 1_000 }),
      (error) => {
        assert.equal(error.message, "OpenCode failed because it reported a general error: stub failure detail");
        assert.equal(error.details?.exitCode, 1);
        assert.doesNotMatch(error.message, /exit code|code 1/i);
        return true;
      },
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("OpenCode runs under a synthetic HOME, never the daemon's real one", () => {
  // OpenCode has no OS sandbox behind its config gate; inheriting the real HOME would pull the
  // user's global ~/.config/opencode into the config merge and expose real dotfiles to reads.
  const env = buildOpenCodeEnv({ PATH: "/bin", HOME: "/Users/realuser", XDG_CONFIG_HOME: "/Users/realuser/.config" });
  assert.ok(env.HOME.endsWith(path.join("engine-state", "opencode", "home")), env.HOME);
  assert.equal(env.XDG_CONFIG_HOME, path.join(env.HOME, ".config"));
  assert.equal(env.XDG_DATA_HOME, path.join(env.HOME, ".local", "share"));
  assert.ok(!env.HOME.startsWith("/Users/realuser"));
});
