import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { readSecret, revealableFields } = await import("../src/web/secrets.js");
const { settingsForApi, saveSettings } = await import("../src/config/settings.js");

// Listing endpoints used to return every token in cleartext so the UI's eye toggle could show
// them. That made the blast radius of any admin-surface weakness — a stolen cookie, a tunnel
// misconfiguration — the whole workspace's credentials at once, including each person's personal
// Composio token. Values are now handed over one at a time, by name, to a re-authenticated caller.

test("settingsForApi carries no secret values, only has*/last4", () => {
  saveSettings({
    slackBotToken: "xoxb-not-in-the-list-1111",
    apiKey: "cg_key_not_in_the_list_2222",
    defaultComposioToken: "comp_secret_3333",
  });
  const body = JSON.stringify(settingsForApi());
  for (const secret of ["xoxb-not-in-the-list-1111", "cg_key_not_in_the_list_2222", "comp_secret_3333"]) {
    assert.ok(!body.includes(secret), `${secret.slice(0, 12)}… must not be served by the list endpoint`);
  }
  const s = settingsForApi();
  assert.equal(s.tokens.hasBotToken, true, "presence is still reported");
  assert.equal(s.tokens.botTokenLast4, "1111", "and enough to identify which token is stored");
});

test("readSecret returns a named settings value", async () => {
  saveSettings({ slackBotToken: "xoxb-reveal-me-4444" });
  assert.equal(await readSecret({ scope: "settings", field: "slackBotToken" }), "xoxb-reveal-me-4444");
});

test("readSecret refuses anything not on the allowlist", async () => {
  // The allowlist is the point: this endpoint must never become "read an arbitrary config key".
  await assert.rejects(() => readSecret({ scope: "settings", field: "adminPassword" }), /not revealable/);
  await assert.rejects(() => readSecret({ scope: "settings", field: "__proto__" }), /not revealable/);
  await assert.rejects(() => readSecret({ scope: "nope", field: "slackBotToken" }), /unknown scope/);
});

test("the admin password is deliberately not revealable", () => {
  // It is stored as a scrypt hash, so there is nothing to reveal — and a "show me the password"
  // affordance is exactly what someone with a borrowed session would reach for.
  assert.ok(!revealableFields("settings").includes("adminPassword"));
});

test("an unset field reveals as empty rather than throwing", async () => {
  saveSettings({ slackAdminUserToken: "" });
  assert.equal(await readSecret({ scope: "settings", field: "slackAdminUserToken" }), "");
});

test("every revealable field is a real, readable key", async () => {
  for (const field of revealableFields("settings")) {
    assert.equal(typeof (await readSecret({ scope: "settings", field })), "string", `${field} must resolve`);
  }
});
