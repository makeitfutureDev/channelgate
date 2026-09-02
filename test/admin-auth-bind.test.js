import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
delete process.env.ADMIN_PASSWORD;
delete process.env.CG_API_KEY;

const { saveSettings } = await import("../src/config/settings.js");
const { noPasswordLockdown, authMiddleware, isAuthenticated, handleLogin, NO_PASSWORD_ERROR } = await import("../src/web/auth.js");

// Authentication used to be waived for the whole admin API whenever the daemon was BOUND to
// loopback — which is the exact inverse of the threat. A loopback bind is what a reverse proxy, a
// Cloudflare tunnel and `ssh -L` all present, so the entire internet can arrive as 127.0.0.1, and
// every other process and account on the host has that address natively. These routes hand over
// the stored Slack/Composio tokens, the filesystem browser, and the admin/workDir switches, so
// they must authenticate on every bind — and with no password configured they refuse, because
// harden.js gives new installs one on first boot (passwordless = legacy or half-configured).

function fakeRes() {
  const res = { statusCode: 200, body: null, redirectedTo: "" };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.redirect = (to) => { res.redirectedTo = to; return res; };
  return res;
}

function call(middleware, req) {
  const res = fakeRes();
  let passed = false;
  middleware({ method: "GET", headers: {}, ...req }, res, () => { passed = true; });
  return { res, passed };
}

const loopbackNoPassword = () => saveSettings({ bindHost: "127.0.0.1", adminPassword: "", apiKey: "" });

test("a loopback bind does not exempt a secret-bearing route from authentication", async () => {
  loopbackNoPassword();
  // /api/settings serves (and writes) the workspace's stored credentials — the single most
  // valuable thing behind this gate.
  const { res, passed } = call(noPasswordLockdown, { path: "/api/settings" });
  assert.equal(passed, false, "a passwordless install must not serve the settings route on loopback");
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /Set an admin password first/);
});

test("mutating admin routes are refused on loopback too, not just reads", async () => {
  loopbackNoPassword();
  for (const path of ["/api/channels/general", "/api/users/U123", "/api/fs/list"]) {
    const { res, passed } = call(noPasswordLockdown, { method: "POST", path });
    assert.equal(passed, false, `${path} must be refused`);
    assert.equal(res.statusCode, 403);
  }
});

test("non-secret liveness stays reachable so the UI can still detect a restart", () => {
  loopbackNoPassword();
  assert.equal(call(noPasswordLockdown, { path: "/api/health" }).passed, true);
  assert.equal(call(noPasswordLockdown, { path: "/login.html" }).passed, true, "the shell must load so the operator sees why");
});

test("health volunteers nothing to an unauthenticated caller, password or not", () => {
  loopbackNoPassword();
  // The old shortcut answered "authenticated" whenever no password existed, which handed the
  // privileged health payload — absolute gateway path (→ OS username), Slack workspace and bot
  // names — to any caller on the very install that can least afford it.
  assert.equal(isAuthenticated({ headers: {} }), false);
  assert.equal(isAuthenticated({ headers: { cookie: "cg_session=made-up" } }), false);
});

test("a configured run-API key is a credential and still opens the run routes", () => {
  saveSettings({ bindHost: "127.0.0.1", adminPassword: "", apiKey: "cg-run-key-test" });
  assert.equal(call(noPasswordLockdown, { path: "/api/runs", headers: { "x-api-key": "cg-run-key-test" } }).passed, true);
  const refused = call(noPasswordLockdown, { path: "/api/runs", headers: { "x-api-key": "wrong" } });
  assert.equal(refused.passed, false);
  assert.equal(refused.res.statusCode, 403);
});

test("login refuses with instructions instead of pretending a passwordless install signed you in", async () => {
  loopbackNoPassword();
  const res = fakeRes();
  await handleLogin({ headers: {}, body: { password: "anything" } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, NO_PASSWORD_ERROR);
});

test("with a password configured the lockdown steps aside and the session gate takes over", () => {
  saveSettings({ bindHost: "127.0.0.1", adminPassword: "correct horse battery staple", apiKey: "" });
  assert.equal(call(noPasswordLockdown, { path: "/api/settings" }).passed, true, "the lockdown is about the MISSING password only");

  const { res, passed } = call(authMiddleware, { path: "/api/settings" });
  assert.equal(passed, false, "…and an unauthenticated caller is then refused by the session gate");
  assert.equal(res.statusCode, 401);

  saveSettings({ adminPassword: "" });
});
