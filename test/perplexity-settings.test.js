import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const settings = await import("../src/config/settings.js");
const { createSettingsRouter } = await import("../src/web/routes/settings.js");
const app = express();
app.use(express.json());
app.use(createSettingsRouter());
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());
beforeEach(() => settings.saveSettings({ perplexityResearchEnabled: false, perplexitySessionToken: "" }));

async function put(body) {
  const response = await fetch(`${base}/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectSlack: false, ...body }),
  });
  return { status: response.status, body: await response.json() };
}
async function get() {
  const response = await fetch(`${base}/settings`);
  assert.equal(response.status, 200);
  return response.json();
}

test("Perplexity research defaults disabled and the subscription token never appears in API responses", async () => {
  assert.deepEqual(settings.getPerplexityResearchConfig(), { enabled: false, sessionToken: "" });
  assert.deepEqual((await get()).perplexityResearch, { enabled: false, hasSessionToken: false });
  const token = "fixture.perplexity-subscription-session_0001";
  const saved = await put({ perplexityResearchEnabled: true, perplexitySessionToken: token });
  assert.equal(saved.status, 200);
  assert.deepEqual(settings.getPerplexityResearchConfig(), { enabled: true, sessionToken: token });
  for (const payload of [saved.body, await get(), settings.settingsForApi()]) {
    assert.deepEqual(payload.perplexityResearch, { enabled: true, hasSessionToken: true });
    assert.equal(Object.hasOwn(payload, "perplexitySessionToken"), false);
    assert.equal(JSON.stringify(payload).includes(token), false);
  }
});

test("blank and unrelated saves retain the login, rotation replaces it, and explicit clear removes it", async () => {
  const first = "fixture-subscription-first";
  assert.equal((await put({ perplexityResearchEnabled: true, perplexitySessionToken: first })).status, 200);
  assert.equal((await put({ perplexitySessionToken: "", clearPerplexitySessionToken: false })).status, 200);
  assert.equal((await put({ showMessageCost: false })).status, 200);
  assert.equal(settings.getPerplexityResearchConfig().sessionToken, first);
  assert.equal((await put({ perplexitySessionToken: "fixture-subscription-rotated" })).status, 200);
  assert.equal(settings.getPerplexityResearchConfig().sessionToken, "fixture-subscription-rotated");
  assert.equal((await put({ perplexityResearchEnabled: false })).status, 200);
  assert.equal(settings.getPerplexityResearchConfig().sessionToken, "fixture-subscription-rotated");
  const cleared = await put({ clearPerplexitySessionToken: true });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.perplexityResearch, { enabled: false, hasSessionToken: false });
  assert.deepEqual(settings.getPerplexityResearchConfig(), { enabled: false, sessionToken: "" });
});

test("invalid Perplexity types and cookie/header injection attempts reject the whole settings patch", async () => {
  const token = "fixture-session-preserved";
  settings.saveSettings({ perplexityResearchEnabled: true, perplexitySessionToken: token });
  const invalid = [
    { perplexityResearchEnabled: "true" }, { perplexityResearchEnabled: null },
    { clearPerplexitySessionToken: "true" }, { clearPerplexitySessionToken: null },
    { perplexitySessionToken: null }, { perplexitySessionToken: 1 }, { perplexitySessionToken: {} },
    ...[" leading", "trailing ", "two words", "token;second=cookie", "token\r\nX-Header: value", "token\n", "token\t", '"quoted"', "token,second", "token\\escape", "token\u007f", "token\u0000", "tökén", "x".repeat(16385)]
      .map((value) => ({ perplexitySessionToken: value })),
  ];
  const version = settings.getSettingsVersion();
  for (const patch of invalid) {
    const result = await put({ perplexityResearchEnabled: false, ...patch });
    assert.equal(result.status, 400);
    assert.equal(settings.getSettingsVersion(), version);
    assert.deepEqual(settings.getPerplexityResearchConfig(), { enabled: true, sessionToken: token });
    assert.equal(JSON.stringify(result.body).includes(token), false);
  }
});

test("Perplexity login uses the normal settings version check, including clear requests", async () => {
  settings.saveSettings({ perplexityResearchEnabled: true, perplexitySessionToken: "fixture-old-session" });
  const stale = (await get()).settingsVersion;
  settings.saveSettings({ perplexitySessionToken: "fixture-current-session" });
  const result = await put({ clearPerplexitySessionToken: true, settingsVersion: stale });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "settings_version_conflict");
  assert.deepEqual(result.body.perplexityResearch, { enabled: true, hasSessionToken: true });
  assert.equal(settings.getPerplexityResearchConfig().sessionToken, "fixture-current-session");
  assert.equal(JSON.stringify(result.body).includes("fixture-current-session"), false);
  assert.equal((await put({ clearPerplexitySessionToken: true, settingsVersion: result.body.settingsVersion })).status, 200);
  assert.equal(settings.getPerplexityResearchConfig().sessionToken, "");
});

test("malformed stored Perplexity settings fail closed and never read ambient credentials", () => {
  settings.saveSettings({ perplexityResearchEnabled: "true", perplexitySessionToken: "invalid;cookie=value" });
  assert.deepEqual(settings.getPerplexityResearchConfig(), { enabled: false, sessionToken: "" });
  const old = process.env.PERPLEXITY_SESSION_TOKEN;
  try {
    process.env.PERPLEXITY_SESSION_TOKEN = "fixture-ambient-session";
    settings.saveSettings({ perplexityResearchEnabled: true, perplexitySessionToken: "" });
    assert.deepEqual(settings.getPerplexityResearchConfig(), { enabled: true, sessionToken: "" });
  } finally {
    if (old === undefined) delete process.env.PERPLEXITY_SESSION_TOKEN;
    else process.env.PERPLEXITY_SESSION_TOKEN = old;
  }
});

test("Perplexity session accepts bounded cookie values and stays outside the secret reveal allowlist", async () => {
  const token = "x".repeat(16384);
  assert.equal((await put({ perplexitySessionToken: token })).status, 200);
  assert.equal(settings.getPerplexityResearchConfig().sessionToken, token);
  const response = await fetch(`${base}/secrets/reveal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "settings", field: "perplexitySessionToken" }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /not revealable/);
  assert.equal(Object.hasOwn(body, "value"), false);
});
