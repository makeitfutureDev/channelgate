// Turning "which login" (src/gateway/claude-login.js) into the thing a subprocess can use: a
// current ACCESS token in CLAUDE_CODE_OAUTH_TOKEN, refreshed against the login's OWN config dir.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const relay = await import("../src/gateway/claude-token-relay.js");
const { claudeCredentialsFile } = await import("../src/runtimes/container/credentials.js");
const { operatorClaudeConfigDir } = await import("../src/gateway/claude-login.js");

const HOUR = 3_600_000;
const operatorFile = () => path.join(operatorClaudeConfigDir(), ".credentials.json");

function writeCreds(file, { accessToken = "sk-ant-oat01-fresh", expiresAt = Date.now() + 4 * HOUR } = {}) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken: "never-relayed", expiresAt, refreshTokenExpiresAt: Date.now() + 20 * 24 * HOUR, subscriptionType: "max" },
  }), { mode: 0o600 });
  return file;
}
const writeOperatorCreds = (opts) => writeCreds(operatorFile(), opts);
const writeGatewayCreds = (opts) => writeCreds(claudeCredentialsFile(), opts);
const clear = () => { for (const f of [operatorFile(), claudeCredentialsFile()]) rmSync(f, { force: true }); };

test.beforeEach(clear);
test.after(clear);

test("a configured setup-token wins and nothing is read or refreshed", async () => {
  let reads = 0;
  const r = await relay.resolveContainerClaudeToken({ configured: () => "sk-ant-oat01-setup", read: () => { reads++; return null; }, refresh: async () => { throw new Error("must not refresh"); } });
  assert.equal(r.token, "sk-ant-oat01-setup");
  assert.equal(r.source, "settings");
  assert.equal(r.expiresAt, 0);
  assert.equal(reads, 0);
});

test("relay: the OPERATOR's own login is what a fresh access token comes from", async () => {
  const exp = Date.now() + 4 * HOUR;
  writeOperatorCreds({ accessToken: "sk-ant-oat01-operator", expiresAt: exp });
  writeGatewayCreds({ accessToken: "sk-ant-oat01-engine-home", expiresAt: exp });
  let refreshed = 0;
  const r = await relay.resolveContainerClaudeToken({ configured: () => "", refresh: async () => { refreshed++; } });
  assert.equal(r.source, "operator", "an engine-home copy must never shadow the operator's login");
  assert.equal(r.token, "sk-ant-oat01-operator");
  assert.equal(r.expiresAt, exp);
  assert.equal(refreshed, 0);
});

test("relay: a login signed in to the gateway's engine home still works when there is no operator one", async () => {
  writeGatewayCreds({ accessToken: "sk-ant-oat01-engine-home" });
  const r = await relay.resolveContainerClaudeToken({ configured: () => "" });
  assert.equal(r.source, "gateway");
  assert.equal(r.token, "sk-ant-oat01-engine-home");
});

test("relay: a token near expiry triggers ONE refresh (serialized) and the renewed token is used", async () => {
  writeOperatorCreds({ accessToken: "sk-ant-oat01-old", expiresAt: Date.now() + 5 * 60_000 });
  let refreshed = 0;
  let refreshedIn = "";
  const refresh = async ({ source }) => {
    refreshed++;
    refreshedIn = source.configDir;
    await new Promise((r) => setTimeout(r, 20));
    writeOperatorCreds({ accessToken: "sk-ant-oat01-renewed", expiresAt: Date.now() + 8 * HOUR });
  };
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => relay.resolveContainerClaudeToken({ configured: () => "", refresh })));
  assert.equal(refreshed, 1, "concurrent runs share one refresh");
  assert.equal(refreshedIn, operatorClaudeConfigDir(), "the operator's session is renewed in the operator's own config dir");
  for (const r of [a, b, c]) assert.equal(r.token, "sk-ant-oat01-renewed");
});

test("relay: no login at all, or a refresh that does not renew, reports the reason", async () => {
  const none = await relay.resolveContainerClaudeToken({ configured: () => "", env: {} });
  assert.equal(none.token, "");
  assert.equal(none.source, "none");
  assert.match(none.error, /no usable Claude login/);
  assert.match(none.error, /sign in with `claude` on the gateway host/);

  writeOperatorCreds({ accessToken: "sk-ant-oat01-stale", expiresAt: Date.now() - 1000 });
  const stale = await relay.resolveContainerClaudeToken({ configured: () => "", refresh: async () => {}, env: {} });
  assert.equal(stale.token, "");
  assert.equal(stale.source, "operator");
  assert.match(stale.error, /expired/);
});

test("readDaemonClaudeAccessToken reads the RESOLVED source and never returns the refresh token", () => {
  writeGatewayCreds({ accessToken: "engine-home-only" });
  assert.equal(relay.readDaemonClaudeAccessToken().token, "engine-home-only");
  writeOperatorCreds({ accessToken: "operator-wins" });
  const entry = relay.readDaemonClaudeAccessToken();
  assert.equal(entry.token, "operator-wins");
  assert.deepEqual(Object.keys(entry).sort(), ["expiresAt", "token"]);
  assert.ok(!JSON.stringify(entry).includes("never-relayed"));
  assert.equal(relay.readDaemonClaudeAccessToken({ file: "" }), null);
});

test("the refresh turn is a cheap, MCP-free haiku turn in the RESOLVED login's own config dir", async () => {
  writeOperatorCreds();
  let seen = null;
  const fakeSpawn = (cmd, args, opts) => {
    seen = { cmd, args, opts };
    const { EventEmitter } = process.getBuiltinModule("node:events");
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };
  await relay.refreshDaemonClaudeToken({ spawnImpl: fakeSpawn, log: { warn() {} } });
  assert.equal(seen.cmd, "claude");
  assert.ok(seen.args.includes("--max-turns") && seen.args.includes(relay.RELAY_REFRESH_MODEL) && seen.args.includes("--strict-mcp-config"));
  assert.equal(seen.opts.env.CLAUDE_CONFIG_DIR, operatorClaudeConfigDir(), "the operator's session can only be renewed in the operator's config dir");
  assert.ok(seen.opts.cwd.includes("claude-relay"), "…but the turn runs in a scratch cwd under the gateway root, not in the login dir");

  // With no login resolved there is nothing to refresh, and no `claude` is spawned at all.
  clear();
  let spawned = 0;
  await relay.refreshDaemonClaudeToken({ spawnImpl: () => { spawned++; }, log: { warn() {} } });
  assert.equal(spawned, 0);
});

test("the warm-pool fingerprint keys on the login SOURCE and expiry, never the token text", async () => {
  const exp = Date.now() + 4 * HOUR;
  writeOperatorCreds({ accessToken: "sk-ant-oat01-secret-token", expiresAt: exp });
  const first = await relay.resolveContainerClaudeToken({ configured: () => "" });
  const fp = relay.claudeTokenFingerprint(first);
  assert.ok(!fp.includes("sk-ant-oat01-secret-token"));
  assert.ok(fp.startsWith("operator|"));
  assert.ok(fp.includes(operatorFile()));
  // The same file at the same expiry keeps a warm process; a refresh moves the expiry and retires it.
  assert.equal(relay.claudeTokenFingerprint(await relay.resolveContainerClaudeToken({ configured: () => "" })), fp);
  writeOperatorCreds({ accessToken: "sk-ant-oat01-renewed", expiresAt: exp + HOUR });
  assert.notEqual(relay.claudeTokenFingerprint(await relay.resolveContainerClaudeToken({ configured: () => "" })), fp);
  // A rotated setup-token must retire warm processes too, even though it has no file and no expiry.
  const one = relay.claudeTokenFingerprint(await relay.resolveContainerClaudeToken({ configured: () => "setup-a" }));
  const two = relay.claudeTokenFingerprint(await relay.resolveContainerClaudeToken({ configured: () => "setup-b" }));
  assert.notEqual(one, two);
  assert.ok(!`${one}${two}`.includes("setup-a"));
  assert.equal(relay.claudeTokenFingerprint(null), "");
});
