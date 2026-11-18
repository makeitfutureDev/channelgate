import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const settings = await import("../src/config/settings.js");
const { hashPassword } = await import("../src/web/security.js");
const { createWebApp } = await import("../src/web/app.js");

const APP_ID = "3J929KZ29B.com.makeitfuture.channelgate";

async function serve(t) {
  const app = createWebApp();
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, fetch: (path, init) => fetch(base + path, { redirect: "manual", ...init }) };
}

test("apple app identifiers are parsed strictly and deduplicated", () => {
  assert.deepEqual(settings.parseAppleAppIds(` ${APP_ID},\n${APP_ID}  ABCDE12345.com.example.other `), [APP_ID, "ABCDE12345.com.example.other"]);
  assert.deepEqual(settings.parseAppleAppIds(""), []);
  for (const bad of ["com.makeitfuture.channelgate", "3j929kz29b.com.x", "3J929KZ29B.", "3J929KZ29B.com.x/y", `${APP_ID};drop`]) {
    assert.equal(settings.parseAppleAppIds(bad), null, bad);
  }
});

test("the association file is public JSON with no redirect, 404 until an app id is configured, env fallback honoured", async (t) => {
  settings.saveSettings({ appleAppIds: "" });
  delete process.env.GATEWAY_APPLE_APP_IDS;
  t.after(() => { settings.saveSettings({ appleAppIds: "" }); delete process.env.GATEWAY_APPLE_APP_IDS; });
  const { fetch } = await serve(t);
  const missing = await fetch("/.well-known/apple-app-site-association");
  assert.equal(missing.status, 404, "unconfigured gateways answer 404, never a redirect to the login page");
  assert.match(missing.headers.get("content-type"), /^application\/json/);
  assert.equal(missing.headers.get("cache-control"), "no-store");

  process.env.GATEWAY_APPLE_APP_IDS = APP_ID;
  const fromEnv = await fetch("/.well-known/apple-app-site-association");
  assert.equal(fromEnv.status, 200);
  assert.match(fromEnv.headers.get("content-type"), /^application\/json/);
  assert.equal(fromEnv.headers.get("cache-control"), "public, max-age=3600");
  assert.deepEqual(await fromEnv.json(), { webcredentials: { apps: [APP_ID] } });

  // Settings win over the environment, and the saved value is normalised to a comma list.
  settings.saveSettings({ appleAppIds: `ABCDE12345.com.example.one\n${APP_ID}` });
  assert.deepEqual((await (await fetch("/.well-known/apple-app-site-association")).json()).webcredentials.apps, ["ABCDE12345.com.example.one", APP_ID]);
  // The file is served without any session, and with no Host/Origin requirement beyond the baseline.
  assert.equal((await fetch("/.well-known/apple-app-site-association", { headers: { Host: "gateway.example.com" } })).status, 200);
});

test("administrators set the app identifiers through Settings; malformed ids are refused", async (t) => {
  settings.saveSettings({ adminPassword: await hashPassword("aasa-test-password"), appleAppIds: "" });
  t.after(() => settings.saveSettings({ appleAppIds: "" }));
  const { fetch } = await serve(t);
  const login = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-CG-Request": "1" }, body: JSON.stringify({ username: "admin", password: "aasa-test-password" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const put = (appleAppIds) => fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json", "X-CG-Request": "1", Cookie: cookie }, body: JSON.stringify({ appleAppIds }) });
  assert.equal((await put("not-an-app-id")).status, 400);
  assert.equal(settings.getAppleAppIds().length, 0);
  assert.equal((await put(` ${APP_ID} `)).status, 200);
  assert.equal(settings.getSettings().appleAppIds, APP_ID);
  assert.deepEqual((await (await fetch("/.well-known/apple-app-site-association")).json()), { webcredentials: { apps: [APP_ID] } });
  assert.equal((await fetch("/api/settings", { headers: { Cookie: cookie, "X-CG-Request": "1" } })).status, 200);
  const listed = await (await fetch("/api/settings", { headers: { Cookie: cookie, "X-CG-Request": "1" } })).json();
  assert.equal(listed.appleAppIds, APP_ID, "the setting is listed back (it is not a secret)");
});
