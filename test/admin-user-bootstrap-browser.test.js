import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

// The test runner gives this file its own process/database: known administrators must exist
// before the first credential, independently of the legacy-unlinked migration browser fixture.
ensureTestEnv();
delete process.env.ADMIN_PASSWORD;
const { saveSettings } = await import("../src/config/settings.js");
const { hashPassword } = await import("../src/web/security.js");
const { setUser } = await import("../src/config/store.js");
const { createWebApp } = await import("../src/web/app.js");
const password = "disposable-known-admin-bootstrap-password";

async function api(page, route, body, method = "POST") {
  return page.evaluate(async ({ route, body, method }) => {
    const response = await fetch(route, {
      method,
      headers: { "Content-Type": "application/json", "X-CG-Request": "1" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }, { route, body, method });
}

test("initial setup verifies an existing admin privately before its first real passkey", { skip: !process.env.CG_BROWSER_MODULE, timeout: 45_000 }, async (t) => {
  saveSettings({ publicUrl: "", adminPassword: await hashPassword(password), apiKey: "" });
  await setUser("UKNOWNOWNER", { name: "Known operator", isAdmin: true });
  await setUser("UMEMBER", { name: "Regular member", isAdmin: false });
  await setUser("api", { name: "Synthetic API principal", isAdmin: true });
  const deliveries = [];
  const app = createWebApp({ adminIdentityDelivery: async (userId, text) => { deliveries.push({ userId, text }); return true; } });
  const server = await new Promise((resolve) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://localhost:${server.address().port}`;
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } });

  await page.goto(`${base}/login.html`);
  await page.locator("#bootstrap").waitFor({ state: "visible" });
  await page.locator("#bootstrap summary").click();
  await page.locator("#pw").fill(password);
  await page.locator("#bootstrap-submit").click();
  await page.locator("#link-panel").waitFor({ state: "visible" });
  assert.equal(await page.locator("#enroll-form").isVisible(), false, "the browser must not offer first-key enrollment before owner verification");
  assert.deepEqual(await page.locator("#link-user option").evaluateAll((options) => options.map((option) => option.value)), ["UKNOWNOWNER"]);
  const before = (await api(page, "/api/auth/me", undefined, "GET")).body;
  assert.equal(before.bootstrap, true);
  assert.equal(before.linkRequired, true);
  assert.equal(before.account.userId, null);
  assert.equal((await api(page, "/api/auth/register/options", {})).status, 403, "API enrollment must enforce the same owner-proof requirement");
  assert.equal((await api(page, "/api/settings", undefined, "GET")).body.code, "identity_link_required");

  const sent = page.waitForResponse((response) => response.url().endsWith("/api/auth/link/options") && response.request().method() === "POST");
  await page.locator("#link-send").click();
  const proofResponse = await sent;
  assert.equal(proofResponse.status(), 200);
  const proof = await proofResponse.json();
  assert.deepEqual(Object.keys(proof).sort(), ["expiresAt", "requestId"]);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].userId, "UKNOWNOWNER");
  const code = deliveries[0].text.match(/\b\d{8}\b/)?.[0];
  assert.match(code, /^\d{8}$/);
  assert.equal((await page.locator("body").textContent()).includes(code), false, "the private verification code must not be rendered by the dashboard response");
  await page.locator("#link-code").fill(code);
  await page.locator("#link-verify").click();
  await page.locator("#enroll-form").waitFor({ state: "visible" });
  assert.equal(await page.locator("#link-panel").isVisible(), false);
  const linked = (await api(page, "/api/auth/me", undefined, "GET")).body;
  assert.equal(linked.account.id, before.account.id, "owner proof links the existing credential container");
  assert.equal(linked.account.userId, "UKNOWNOWNER");
  assert.equal(linked.linkRequired, false);
  assert.equal(linked.bootstrap, true);
  assert.equal(linked.passkeys.length, 0);
  const bootstrapCookie = (await context.cookies()).find((cookie) => cookie.name === "cg_session").value;

  await page.locator("#passkey-name").fill("Known operator primary key");
  await Promise.all([
    page.waitForURL(`${base}/settings#set-admin-access`),
    page.locator("#enroll-submit").click(),
  ]);
  await page.locator('[data-access="identity"]').filter({ hasText: "Known operator" }).waitFor();
  assert.equal(await page.locator('[data-access="account-form"]').count(), 0, "Settings must not create another user directory");
  const enrolled = (await api(page, "/api/auth/me", undefined, "GET")).body;
  assert.equal(enrolled.account.userId, "UKNOWNOWNER");
  assert.equal(enrolled.bootstrap, false);
  assert.equal(enrolled.passkeys.length, 1);
  assert.equal(enrolled.passkeys[0].name, "Known operator primary key");
  assert.equal((await api(page, "/api/auth/status", undefined, "GET")).body.bootstrapAvailable, false);
  assert.equal((await api(page, "/api/login", { username: "admin", password })).status, 401);
  const oldSession = await fetch(`${base}/api/settings`, { headers: { Cookie: `cg_session=${bootstrapCookie}` } });
  assert.equal(oldSession.status, 401);
  await oldSession.arrayBuffer();

  await api(page, "/api/logout", {});
  await page.goto(`${base}/login.html`);
  await page.waitForFunction(() => !globalThis.document.getElementById("sign-in").disabled);
  assert.equal(await page.locator("#bootstrap").isVisible(), false);
  assert.equal(await page.locator("#username").count(), 0);
  await Promise.all([page.waitForURL(`${base}/`), page.locator("#sign-in").click()]);
  const signedIn = (await api(page, "/api/auth/me", undefined, "GET")).body;
  assert.equal(signedIn.account.userId, "UKNOWNOWNER");
  assert.equal(signedIn.passkeys[0].id, enrolled.passkeys[0].id);
  assert.equal((await api(page, "/api/settings", undefined, "GET")).status, 200);
  assert.deepEqual(errors, []);
});
