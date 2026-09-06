// WHICH Claude login the gateway authenticates with (src/gateway/claude-login.js).
//
// The property that matters: the OPERATOR's own `~/.claude` login is what the gateway uses, and a
// stale copy in the gateway's engine home can never shadow it. That copy is exactly what broke —
// `.credentials.json` used to be symlinked into the engine home, Claude Code replaced the link with
// a plain file on its first rename-on-refresh, and the resulting independent session aged out while
// the operator's own login stayed current.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const login = await import("../src/gateway/claude-login.js");
const { claudeEngineHome } = await import("../src/config/paths.js");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);
const at = () => NOW;
const noSetupToken = () => "";
const BARE = {};

function write(file, { accessToken = "sk-ant-oat01-x", expiresAt = NOW + 4 * HOUR, refreshTokenExpiresAt = NOW + 20 * DAY } = {}) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken: "never-read-by-the-gateway",
      ...(expiresAt === null ? {} : { expiresAt }),
      ...(refreshTokenExpiresAt === null ? {} : { refreshTokenExpiresAt }),
    },
  }), { mode: 0o600 });
  return file;
}

const operatorFile = () => path.join(login.operatorClaudeConfigDir(), ".credentials.json");
const gatewayFile = () => login.gatewayClaudeCredentialsFile();
const clear = () => { for (const f of [operatorFile(), gatewayFile()]) rmSync(f, { force: true }); };

test.beforeEach(clear);
test.after(clear);

test("the OPERATOR's own login is the source, ahead of anything in the gateway's engine home", () => {
  write(operatorFile(), { accessToken: "operator-token" });
  write(gatewayFile(), { accessToken: "engine-home-token" });
  const resolved = login.resolveClaudeLogin({ env: BARE, now: at, configured: noSetupToken });
  assert.equal(resolved.kind, "operator");
  assert.equal(resolved.file, operatorFile());
  assert.equal(resolved.configDir, login.operatorClaudeConfigDir());
  assert.ok(resolved.home, "a refresh turn needs the operator's HOME");
});

test("a HARD-EXPIRED operator session falls through to a usable engine-home login", () => {
  write(operatorFile(), { refreshTokenExpiresAt: NOW - DAY });
  write(gatewayFile(), { accessToken: "engine-home-token" });
  const resolved = login.resolveClaudeLogin({ env: BARE, now: at, configured: noSetupToken });
  assert.equal(resolved.kind, "gateway");
  assert.equal(resolved.file, gatewayFile());
  assert.equal(resolved.configDir, path.join(claudeEngineHome(), ".claude"));
});

test("an expired ACCESS token is still a usable login — refreshing it is the relay's whole job", () => {
  write(operatorFile(), { expiresAt: NOW - HOUR, refreshTokenExpiresAt: NOW + 10 * DAY });
  const resolved = login.resolveClaudeLogin({ env: BARE, now: at, configured: noSetupToken });
  assert.equal(resolved.kind, "operator");
  assert.equal(resolved.accessExpiresAt, NOW - HOUR);
  assert.equal(resolved.expiresAt, NOW + 10 * DAY);
});

test("a login with no session expiry recorded at all is accepted (older CLI writes none)", () => {
  write(operatorFile(), { refreshTokenExpiresAt: null });
  const resolved = login.resolveClaudeLogin({ env: BARE, now: at, configured: noSetupToken });
  assert.equal(resolved.kind, "operator");
  assert.equal(resolved.expiresAt, 0);
});

test("unusable files are skipped and named in the remedy, never treated as a login", () => {
  mkdirSync(path.dirname(operatorFile()), { recursive: true });
  writeFileSync(operatorFile(), "{not json");
  mkdirSync(path.dirname(gatewayFile()), { recursive: true });
  writeFileSync(gatewayFile(), JSON.stringify({ claudeAiOauth: { accessToken: "" } }));
  const resolved = login.resolveClaudeLogin({ env: BARE, now: at, configured: noSetupToken });
  assert.equal(resolved.kind, "none");
  assert.match(resolved.reason, /sign in with `claude` on the gateway host/);
  assert.match(resolved.reason, /not valid JSON/);
  assert.match(resolved.reason, /no access token/);
});

test("precedence: a configured setup-token wins, then the files, then the daemon's API key", () => {
  const setup = () => "sk-ant-oat01-setup";
  write(operatorFile());
  assert.equal(login.resolveClaudeLogin({ env: { ANTHROPIC_API_KEY: "sk-key" }, now: at, configured: setup }).kind, "settings");
  assert.equal(login.resolveClaudeLogin({ env: { ANTHROPIC_API_KEY: "sk-key" }, now: at, configured: noSetupToken }).kind, "operator");
  clear();
  assert.equal(login.resolveClaudeLogin({ env: { ANTHROPIC_API_KEY: "sk-key" }, now: at, configured: noSetupToken }).kind, "api-key");
  assert.equal(login.resolveClaudeLogin({ env: { ANTHROPIC_AUTH_TOKEN: "bearer" }, now: at, configured: noSetupToken }).kind, "api-key");
  assert.equal(login.resolveClaudeLogin({ env: BARE, now: at, configured: noSetupToken }).kind, "none");
});

test("nothing the resolver hands out is token material", () => {
  write(operatorFile(), { accessToken: "sk-ant-oat01-SECRET-VALUE" });
  const resolved = login.resolveClaudeLogin({ env: { ANTHROPIC_API_KEY: "sk-ant-KEY-SECRET" }, now: at, configured: noSetupToken });
  const described = login.describeClaudeLogin(resolved);
  for (const blob of [JSON.stringify(resolved), JSON.stringify(described), login.claudeLoginSummary(resolved)]) {
    assert.ok(!blob.includes("SECRET"), `token material leaked: ${blob}`);
    assert.ok(!blob.includes("never-read-by-the-gateway"), "the refresh token must never leave the file");
  }
  assert.deepEqual(Object.keys(described).sort(), ["accessExpiresAt", "configDir", "detail", "expiresAt", "file", "kind", "summary"]);
  assert.ok(resolved.fingerprint, "an opaque comparison marker is still exposed");
});

test("the fingerprint changes only when the credential does", () => {
  write(operatorFile(), { accessToken: "one" });
  const a = login.resolveClaudeLogin({ env: BARE, now: at, configured: noSetupToken }).fingerprint;
  const again = login.resolveClaudeLogin({ env: BARE, now: at, configured: noSetupToken }).fingerprint;
  assert.equal(a, again);
  write(operatorFile(), { accessToken: "two" });
  assert.notEqual(login.resolveClaudeLogin({ env: BARE, now: at, configured: noSetupToken }).fingerprint, a);
});

test("the session hard expiry is warned about three days ahead and not before", () => {
  const soon = { expiresAt: NOW + 2 * DAY, kind: "operator" };
  const later = { expiresAt: NOW + 9 * DAY, kind: "operator" };
  assert.match(login.claudeLoginExpiryWarning(soon, { now: at }), /expires in 48h/);
  assert.match(login.claudeLoginExpiryWarning(soon, { now: at }), /sign in with `claude`/);
  assert.equal(login.claudeLoginExpiryWarning(later, { now: at }), "");
  assert.match(login.claudeLoginExpiryWarning({ expiresAt: NOW - HOUR, kind: "operator" }, { now: at }), /EXPIRED/);
  // A setup-token and an API key have no session of their own to expire.
  assert.equal(login.claudeLoginExpiryWarning({ expiresAt: 0, kind: "settings" }, { now: at }), "");
});

test("the summary names the source and the date the login dies, and nothing else", () => {
  write(operatorFile(), { refreshTokenExpiresAt: Date.UTC(2026, 9, 1) });
  const summary = login.claudeLoginSummary(login.resolveClaudeLogin({ env: BARE, now: at, configured: noSetupToken }));
  assert.match(summary, /^operator \(/);
  assert.match(summary, /session expires 2026-10-01$/);
});

test("the missing-login warning is throttled to once an hour, so it cannot flood a busy daemon", () => {
  login.resetClaudeLoginWarnings();
  const seen = [];
  const log = { warn: (m) => seen.push(m) };
  let clock = NOW;
  const now = () => clock;
  assert.equal(login.warnClaudeLoginMissing("no login", { log, now }), true);
  assert.equal(login.warnClaudeLoginMissing("no login", { log, now }), false);
  clock += 61 * 60_000;
  assert.equal(login.warnClaudeLoginMissing("no login", { log, now }), true);
  assert.equal(seen.length, 2);
  assert.match(seen[0], /\[claude-login\] WARNING: no login/);
  login.resetClaudeLoginWarnings();
});

// ── How the rest of the daemon SEES the resolved login ────────────────────────────────────────
// The two surfaces an operator actually reads: the Claude engine's credential/health hooks (boot
// log + /api/health) and the /status line.

const { engineCredentialState } = await import("../src/engines/registry.js");
const { formatClaudeLoginLine } = await import("../src/slack/status-controller.js");

test("the Claude engine's credential probe names the login source and compares by fingerprint", async () => {
  write(operatorFile(), { accessToken: "one" });
  const first = await engineCredentialState("claude");
  assert.equal(first.known, true);
  assert.equal(first.authenticated, true);
  assert.ok(first.fingerprint);
  assert.equal((await engineCredentialState("claude")).fingerprint, first.fingerprint);
  // A new sign-in rewrites the file, which is exactly what must release an auth-failure cooldown.
  write(operatorFile(), { accessToken: "two" });
  assert.notEqual((await engineCredentialState("claude")).fingerprint, first.fingerprint);
  clear();
  const gone = await engineCredentialState("claude");
  assert.equal(gone.known, true);
  assert.equal(gone.authenticated, false, "no usable login anywhere is a positive 'not signed in'");
});

test("/status names whose Claude subscription answers here, and flags a login about to die", () => {
  const operator = { kind: "operator", configDir: "/home/op/.claude", file: "/home/op/.claude/.credentials.json", expiresAt: Date.UTC(2026, 9, 1), accessExpiresAt: 0, detail: "d", reason: "" };
  const line = formatClaudeLoginLine(operator);
  assert.match(line, /Claude login/);
  assert.match(line, /operator/);
  assert.match(line, /\/home\/op\/\.claude/);
  assert.match(line, /session expires 2026-10-01/);
  assert.ok(!line.includes("⚠️"));
  assert.match(formatClaudeLoginLine(operator, "expires in 40h"), /⚠️/);
  const missing = formatClaudeLoginLine({ kind: "none", configDir: "", file: "", expiresAt: 0, accessExpiresAt: 0, detail: "no login — sign in with `claude`", reason: "" });
  assert.match(missing, /⚠️ none — no login — sign in with `claude`/);
});
