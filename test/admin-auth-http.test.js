import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
delete process.env.ADMIN_PASSWORD;
const settings = await import("../src/config/settings.js");
const { hashPassword } = await import("../src/web/security.js");
const { createWebApp } = await import("../src/web/app.js");
const store = await import("../src/config/admin-accounts.js");
const { adminRelyingParty } = await import("../src/web/admin-auth.js");

test("passkey origin is configured explicitly and never chosen by a forwarded host", () => {
  settings.saveSettings({ publicUrl: "https://gateway.example.test" });
  assert.deepEqual(adminRelyingParty({ headers: { host: "attacker.test", "x-forwarded-host": "attacker.test" } }), {
    origin: "https://gateway.example.test", rpID: "gateway.example.test",
  });
  settings.saveSettings({ publicUrl: "http://gateway.example.test" });
  assert.throws(() => adminRelyingParty({ headers: {} }), /HTTPS/);
  settings.saveSettings({ publicUrl: "" });
  assert.throws(() => adminRelyingParty({ headers: { host: "attacker.test" } }), /HTTPS/);
  assert.deepEqual(adminRelyingParty({ headers: { host: "localhost:43210" } }), {
    origin: "http://localhost:43210", rpID: "localhost",
  });
});

test("HTTP authentication gates remain closed through bootstrap, invitations and failed ceremonies", async (t) => {
  const password = "disposable-http-bootstrap";
  settings.saveSettings({ publicUrl: "", adminPassword: await hashPassword(password), apiKey: "" });
  const app = createWebApp();
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, body, extra = {}) {
    const response = await fetch(`${base}${route}`, { method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "X-CG-Request": "1", ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, body: await response.json() };
  }
  for (const route of ["/api/settings", "/api/auth/me", "/api/auth/accounts"]) {
    assert.equal((await request(route)).response.status, 401);
  }
  const initial = await request("/api/auth/status");
  assert.equal(initial.body.bootstrapAvailable, true);
  assert.equal(initial.response.headers.get("cache-control"), "no-store");
  const login = await request("/api/login", { username: "admin", password });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get("set-cookie").split(";")[0];
  assert.equal((await request("/api/auth/accounts", { username: "cannot-invite-yet" }, { Cookie: cookie })).response.status, 410);

  const admin = store.ensureBootstrapAdmin();
  // Storage fixtures cannot authenticate: public-key parsing and signature verification still run.
  store.saveAdminPasskey({ accountId: admin.id, authVersion: admin.authVersion,
    credential: { id: "Zml4dHVyZS1rZXk", publicKey: new Uint8Array([1]), counter: 0, transports: ["internal"] },
    name: "Fixture only", deviceType: "singleDevice", backedUp: false });
  assert.equal((await request("/api/settings", undefined, { Cookie: cookie })).response.status, 401);
  assert.equal((await request("/api/login", { username: "admin", password })).response.status, 401);
  settings.saveSettings({ adminPassword: await hashPassword("changed-shared-password") });
  assert.equal((await request("/api/auth/status")).body.bootstrapAvailable, false);
  const options = await request("/api/auth/login/options", {});
  assert.equal(options.response.status, 200);
  assert.equal(options.body.options.userVerification, "required");
  assert.deepEqual(options.body.options.allowCredentials ?? [], []);
  assert.equal(JSON.stringify(options.body).includes("Zml4dHVyZS1rZXk"), false, "public login options never list stored credentials");
  const binding = options.response.headers.get("set-cookie").split(";")[0];
  const invalid = await request("/api/auth/login/verify", { response: { id: "Zml4dHVyZS1rZXk", type: "public-key", response: {} } }, { Cookie: binding });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.response.headers.get("set-cookie"), null, "invalid assertions cannot mint a session");
  const replay = await request("/api/auth/login/verify", { response: {} }, { Cookie: binding });
  assert.equal(replay.response.status, 400);
  const invited = store.createAdminAccount("http-invite");
  const token = store.createAdminEnrollment(invited.id);
  assert.equal((await request("/api/settings", undefined, { Cookie: `setup=${token}` })).response.status, 401);
  assert.equal((await request("/api/auth/accounts", undefined, { Authorization: `Bearer ${token}` })).response.status, 401);
});
