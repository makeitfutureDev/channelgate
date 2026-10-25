import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
delete process.env.ADMIN_PASSWORD;
delete process.env.CG_API_KEY;

const { saveSettings } = await import("../src/config/settings.js");
const { hashPassword } = await import("../src/web/security.js");
const { createWebApp } = await import("../src/web/app.js");
const password = "disposable-login-browser-fixture";

async function startApp(t) {
  saveSettings({ adminPassword: await hashPassword(password), apiKey: "" });
  const app = createWebApp();
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("logged-out sign-in serves its real assets while the dashboard stays gated", async (t) => {
  const base = await startApp(t);
  const page = await fetch(`${base}/login.html`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(html, /\{\{ASSET_V\}\}/);
  const stampedScripts = [...html.matchAll(/src="\/(?:login|passkeys)\.js\?v=([a-f0-9]{12})"/g)];
  assert.equal(stampedScripts.length, 2, "both classic login scripts must bypass stale edge cache entries");
  assert.equal(stampedScripts[0][1], stampedScripts[1][1], "HTML and both scripts use one deployment version");
  const assets = [...html.matchAll(/(?:src=|href=|url\()"([^"?]+)(?:\?[^\"]*)?"/g)].map((match) => match[1]);
  assert.ok(assets.includes("/login.js"), "exercise the actual login page's script dependency");
  assert.ok(assets.some((asset) => asset.endsWith(".woff2")), "exercise the login page's font dependencies");
  for (const asset of assets) {
    const response = await fetch(`${base}${asset}?v=login-regression`, { redirect: "manual" });
    assert.equal(response.status, 200, `${asset} must load without a session or redirect`);
    assert.equal(response.headers.get("location"), null);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (asset.endsWith(".js")) {
      assert.match(response.headers.get("content-type"), /javascript/);
      assert.doesNotMatch(bytes.toString(), /^\s*</, "JavaScript must not be login HTML");
      if (asset === "/login.js") assert.match(bytes.toString(), /addEventListener/);
      assert.equal(response.headers.get("cache-control"), "no-cache");
    } else if (asset.endsWith(".woff2")) {
      assert.match(response.headers.get("content-type"), /font\/woff2/);
      assert.equal(bytes.subarray(0, 4).toString(), "wOF2");
    } else {
      assert.match(response.headers.get("content-type"), /image\/svg\+xml/);
    }
    const head = await fetch(`${base}${asset}`, { method: "HEAD", redirect: "manual" });
    assert.equal(head.status, 200);
  }
  for (const route of ["/", "/app.js", "/styles.css", "/fonts/poppins-500-latin.woff2", "/login.js-extra"]) {
    const response = await fetch(`${base}${route}`, { redirect: "manual" });
    assert.equal(response.status, 302, `${route} must remain session-gated`);
    assert.equal(response.headers.get("location"), "/login.html");
    await response.arrayBuffer();
  }
  const settings = await fetch(`${base}/api/settings`);
  assert.equal(settings.status, 401);
  await settings.arrayBuffer();
});

test("fresh browser can bootstrap enrollment and return to working setup after logout", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const base = await startApp(t);
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  assert.equal(new URL(page.url()).pathname, "/login.html");
  assert.deepEqual(await context.cookies(), []);
  await page.locator("#bootstrap").waitFor({ state: "visible" });
  await page.locator("#bootstrap summary").click();
  await page.locator("#pw").fill("wrong-disposable-password");
  await page.locator("#bootstrap-submit").click();
  await page.locator("#err").filter({ hasText: /Wrong.*password/ }).waitFor();
  await page.locator("#pw").fill(password);
  await page.locator("#bootstrap-submit").click();
  await page.locator("#enroll-form").waitFor({ state: "visible" });
  const session = (await context.cookies()).find((cookie) => cookie.name === "cg_session");
  assert.ok(session);
  assert.equal(session.httpOnly, true);
  assert.equal(session.sameSite, "Strict");
  assert.equal(await page.evaluate(async () => (await fetch("/api/settings")).status), 200);
  assert.equal(await page.evaluate(async () => (await fetch("/api/logout", { method: "POST" })).status), 200);
  await page.goto(base);
  assert.equal(new URL(page.url()).pathname, "/login.html");
  await page.locator("#bootstrap").waitFor({ state: "visible" });
  await page.locator("#bootstrap summary").click();
  await page.locator("#pw").fill(password);
  await page.locator("#bootstrap-submit").click();
  await page.locator("#enroll-form").waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
});
