import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
delete process.env.ADMIN_PASSWORD;
const { saveSettings } = await import("../src/config/settings.js");
const { hashPassword } = await import("../src/web/security.js");
const { createWebApp } = await import("../src/web/app.js");
const password = "disposable-passkey-bootstrap-password";

async function api(page, route, body, method = "POST") {
  return page.evaluate(async ({ route, body, method }) => {
    const response = await fetch(route, { method, headers: { "Content-Type": "application/json", "X-CG-Request": "1" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, retryAfter: Number(response.headers.get("Retry-After") || 0), body: await response.json() };
  }, { route, body, method });
}

test("real WebAuthn signatures protect named admin login, enrollment, revocation and recovery", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  saveSettings({ publicUrl: "", adminPassword: await hashPassword(password), apiKey: "", slackBotToken: "xoxb-disposable-secret" });
  const app = createWebApp();
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://localhost:${server.address().port}`;
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  const errors = [];
  const realNow = Date.now;
  let clockOffset = 0;
  Date.now = () => realNow() + clockOffset;
  t.after(() => { Date.now = realNow; });
  async function newAdminBrowser() {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    } });
    return { context, page, cdp, authenticatorId };
  }
  const admin = await newAdminBrowser();
  let bootstrapCookie;
  async function assertion(page = admin.page, username = "admin", optionsOverride = {}) {
    let result = await api(page, "/api/auth/login/options", { username });
    for (let attempt = 0; result.status === 429 && attempt < 3; attempt++) {
      assert.ok(result.retryAfter <= 10, "bounded negative cases should not create a long lockout");
      await new Promise((resolve) => setTimeout(resolve, result.retryAfter * 1000 + 100));
      result = await api(page, "/api/auth/login/options", { username });
    }
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return page.evaluate(async (options) => globalThis.ChannelGatePasskeys.get(options), { ...result.body.options, ...optionsOverride });
  }
  async function signIn(page = admin.page, username = "admin") {
    const response = await assertion(page, username);
    const result = await api(page, "/api/auth/login/verify", { response });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return response;
  }

  await t.test("first-time username/password setup enrolls a verified passkey through the real UI", async () => {
    await admin.page.goto(`${base}/login.html`);
    await admin.page.locator("#bootstrap").waitFor({ state: "visible" });
    await admin.page.locator("#bootstrap summary").click();
    await admin.page.locator("#pw").fill("wrong-fixture-password");
    await admin.page.locator("#bootstrap-submit").click();
    await admin.page.locator("#err").filter({ hasText: /password/i }).waitFor();
    await admin.page.locator("#pw").fill(password);
    await admin.page.locator("#bootstrap-submit").click();
    await admin.page.locator("#enroll-form").waitFor({ state: "visible" });
    bootstrapCookie = (await admin.context.cookies()).find((cookie) => cookie.name === "cg_session").value;
    await admin.page.locator("#passkey-name").fill("Primary fixture key");
    await Promise.all([admin.page.waitForURL(`${base}/settings#set-admin-access`), admin.page.locator("#enroll-submit").click()]);
    await admin.page.locator('[data-access="identity"]').filter({ hasText: "admin" }).waitFor();
    const me = await api(admin.page, "/api/auth/me", undefined, "GET");
    assert.equal(me.body.account.username, "admin");
    assert.equal(me.body.bootstrap, false);
    assert.equal(me.body.passkeys.length, 1);
    const session = (await admin.context.cookies()).find((cookie) => cookie.name === "cg_session");
    assert.equal(session.httpOnly, true);
    assert.equal(session.sameSite, "Strict");
    assert.ok(session.expires * 1000 - Date.now() < 12 * 60 * 60_000 + 1000);
  });

  await t.test("first enrollment revokes the old password/session and blocks password-setting fallback", async () => {
    assert.equal((await api(admin.page, "/api/login", { username: "admin", password })).status, 401);
    const old = await fetch(`${base}/api/settings`, { headers: { Cookie: `cg_session=${bootstrapCookie}` } });
    assert.equal(old.status, 401);
    await old.arrayBuffer();
    assert.equal((await api(admin.page, "/api/settings", { adminPassword: password, currentAdminPassword: password, connectSlack: false }, "PUT")).status, 409);
    const me = await api(admin.page, "/api/auth/me", undefined, "GET");
    assert.equal((await api(admin.page, `/api/auth/passkeys/${me.body.passkeys[0].id}`, undefined, "DELETE")).status, 400);
  });

  await t.test("a logged-out browser signs in by username and passkey without password UI", async () => {
    await api(admin.page, "/api/logout", {});
    await admin.page.goto(`${base}/login.html`);
    await admin.page.waitForFunction(() => globalThis.document.querySelector("#sign-in").disabled === false);
    assert.equal(await admin.page.locator("#bootstrap").isVisible(), false);
    await admin.page.locator("#username").fill("admin");
    await Promise.all([admin.page.waitForURL(`${base}/`), admin.page.locator("#sign-in").click()]);
    assert.equal((await api(admin.page, "/api/settings", undefined, "GET")).status, 200);
  });

  await t.test("binding, signature tampering and replay cannot mint a session", async () => {
    const response = await assertion();
    const noBinding = await fetch(`${base}/api/auth/login/verify`, { method: "POST", headers: { "Content-Type": "application/json", "X-CG-Request": "1", Origin: base }, body: JSON.stringify({ response }) });
    assert.equal(noBinding.status, 400); await noBinding.arrayBuffer();
    const forged = structuredClone(response);
    forged.response.signature = `A${forged.response.signature.slice(1)}`;
    if (forged.response.signature === response.response.signature) forged.response.signature = `B${forged.response.signature.slice(1)}`;
    assert.equal((await api(admin.page, "/api/auth/login/verify", { response: forged })).status, 401);
    assert.equal((await api(admin.page, "/api/auth/login/verify", { response })).status, 400);
    await signIn();
    const valid = await assertion();
    assert.equal((await api(admin.page, "/api/auth/login/verify", { response: valid })).status, 200);
    assert.equal((await api(admin.page, "/api/auth/login/verify", { response: valid })).status, 400);
    await signIn();
  });

  await t.test("user verification, ceremony type and allowed origin are enforced", async () => {
    await admin.cdp.send("WebAuthn.setUserVerified", { authenticatorId: admin.authenticatorId, isUserVerified: false });
    try {
      const response = await assertion(admin.page, "admin", { userVerification: "discouraged" });
      assert.equal((await api(admin.page, "/api/auth/login/verify", { response })).status, 401);
    } finally { await admin.cdp.send("WebAuthn.setUserVerified", { authenticatorId: admin.authenticatorId, isUserVerified: true }); }
    await signIn();
    const response = await assertion();
    assert.equal((await api(admin.page, "/api/auth/reauth/verify", { response })).status, 400);
    await signIn();
    const hostile = await fetch(`${base}/api/auth/login/options`, { method: "POST", headers: { "Content-Type": "application/json", "X-CG-Request": "1", Origin: "https://attacker.invalid" }, body: JSON.stringify({ username: "admin" }) });
    assert.equal(hostile.status, 403); await hostile.arrayBuffer();
    const missingCSRF = await fetch(`${base}/api/auth/login/options`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin" }) });
    assert.equal(missingCSRF.status, 403); await missingCSRF.arrayBuffer();
    await signIn();
  });

  await t.test("expired challenges and stale sessions need fresh passkey authentication", async () => {
    const response = await assertion();
    clockOffset += 6 * 60_000;
      assert.equal((await api(admin.page, "/api/auth/login/verify", { response })).status, 400);
      assert.equal((await api(admin.page, "/api/auth/register/options", {})).status, 403);
      assert.equal((await api(admin.page, "/api/auth/accounts", { username: "stale", displayName: "Stale" })).status, 403);
      assert.equal((await api(admin.page, "/api/secrets/reveal", { scope: "settings", field: "slackBotToken", password })).status, 403);
      clockOffset += 10_000; // Honor the negative-attempt backoff before proving reauthentication.
      const reauth = await api(admin.page, "/api/auth/reauth/options", {});
      assert.equal(reauth.status, 200);
      const signed = await admin.page.evaluate((options) => globalThis.ChannelGatePasskeys.get(options), reauth.body.options);
      assert.equal((await api(admin.page, "/api/auth/reauth/verify", { response: signed })).status, 200);
      assert.equal((await api(admin.page, "/api/secrets/reveal", { scope: "settings", field: "slackBotToken" })).status, 200);
    await signIn();
  });

  let second;
  let secondId;
  await t.test("a second named account gets a single-use registration-only setup link", async () => {
    await admin.page.goto(`${base}/settings#set-admin-access`);
    await admin.page.locator('[data-access="identity"]').filter({ hasText: "admin" }).waitFor();
    await admin.page.locator('[data-access="account-username"]').fill("operator-two");
    await admin.page.locator('[data-access="account-name"]').fill("Second operator");
    await admin.page.getByRole("button", { name: "Create admin account", exact: true }).click();
    await admin.page.locator('[data-access="invite"]').waitFor({ state: "visible" });
    const setupUrl = await admin.page.locator('[data-access="invite-url"]').inputValue();
    const token = new URLSearchParams(new URL(setupUrl).hash.slice(1)).get("setup");
    assert.ok(token);
    second = await newAdminBrowser();
    await second.page.goto(setupUrl);
    await second.page.locator("#enroll-form").waitFor({ state: "visible" });
    assert.equal(new URL(second.page.url()).hash, "", "the browser removes the setup secret from its address bar");
    assert.equal((await api(second.page, "/api/settings", undefined, "GET")).status, 401);
    await second.page.locator("#passkey-name").fill("Second operator key");
    await Promise.all([second.page.waitForURL(`${base}/settings#set-admin-access`), second.page.locator("#enroll-submit").click()]);
    const me = await api(second.page, "/api/auth/me", undefined, "GET");
    assert.equal(me.body.account.username, "operator-two");
    secondId = me.body.account.id;
    assert.equal((await api(second.page, "/api/auth/enroll/options", { token })).status, 401);
    const wrong = await assertion();
    assert.equal((await api(admin.page, "/api/auth/login/options", { username: "operator-two" })).status, 200);
    assert.equal((await api(admin.page, "/api/auth/login/verify", { response: wrong })).status, 401);
    await signIn();
  });

  await t.test("disabling an account revokes its sessions and in-flight authentication", async () => {
    const response = await assertion(second.page, "operator-two");
    assert.equal((await api(admin.page, `/api/auth/accounts/${secondId}`, { enabled: false }, "PATCH")).status, 200);
    assert.equal((await api(second.page, "/api/settings", undefined, "GET")).status, 401);
    assert.equal((await api(second.page, "/api/auth/login/verify", { response })).status, 401);
    assert.equal((await api(admin.page, `/api/auth/accounts/${secondId}`, { enabled: true }, "PATCH")).status, 200);
    await signIn(second.page, "operator-two");
    assert.equal((await api(second.page, "/api/settings", undefined, "GET")).status, 200);
  });

  await t.test("a spare authenticator can replace a key without retaining old sessions", async () => {
    const before = await api(admin.page, "/api/auth/me", undefined, "GET");
    const oldKey = before.body.passkeys[0].id;
    const oldCookie = (await admin.context.cookies()).find((cookie) => cookie.name === "cg_session").value;
    await admin.cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: admin.authenticatorId });
    const spare = await admin.cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    } });
    admin.authenticatorId = spare.authenticatorId;
    await admin.page.locator('[data-access="key-name"]').fill("Spare fixture key");
    await admin.page.locator('[data-access="register"]').click();
    await admin.page.locator('[data-access="message"]').filter({ hasText: "Passkey added" }).waitFor();
    assert.equal((await api(admin.page, "/api/auth/me", undefined, "GET")).body.passkeys.length, 2);
    assert.equal((await api(admin.page, `/api/auth/passkeys/${oldKey}`, undefined, "DELETE")).status, 200);
    const revoked = await fetch(`${base}/api/settings`, { headers: { Cookie: `cg_session=${oldCookie}` } });
    assert.equal(revoked.status, 401); await revoked.arrayBuffer();
    await signIn();
  });

  await t.test("host recovery revokes keys and sessions and grants enrollment only", async () => {
    const { createAdminEnrollment } = await import("../src/config/admin-accounts.js");
    const token = createAdminEnrollment(secondId, { recover: true });
    assert.equal((await api(second.page, "/api/settings", undefined, "GET")).status, 401);
    assert.equal((await api(admin.page, "/api/login", { username: "admin", password })).status, 401);
    const recovered = await newAdminBrowser();
    await recovered.page.goto(`${base}/login.html#setup=${token}`);
    assert.equal((await api(recovered.page, "/api/settings", undefined, "GET")).status, 401);
    await recovered.page.locator("#passkey-name").fill("Recovered fixture key");
    await Promise.all([recovered.page.waitForURL(`${base}/settings#set-admin-access`), recovered.page.locator("#enroll-submit").click()]);
    assert.equal((await api(recovered.page, "/api/auth/me", undefined, "GET")).body.account.username, "operator-two");
    assert.equal((await api(recovered.page, "/api/auth/enroll/options", { token })).status, 401);
  });

  await t.test("sessions enforce both idle expiry and the absolute lifetime despite keepalives", async () => {
    await signIn();
    clockOffset += 31 * 60_000;
    assert.equal((await api(admin.page, "/api/auth/me", undefined, "GET")).status, 401);
    await signIn();
    for (let step = 0; step < 35; step++) {
      clockOffset += 20 * 60_000;
      assert.equal((await api(admin.page, "/api/auth/me", undefined, "GET")).status, 200);
    }
    clockOffset += 21 * 60_000;
    assert.equal((await api(admin.page, "/api/auth/me", undefined, "GET")).status, 401);
    await signIn();
  });
  assert.deepEqual(errors, []);
});
