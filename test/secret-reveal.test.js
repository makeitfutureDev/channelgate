import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { readSecret, revealableFields } = await import("../src/web/secrets.js");
const { settingsForApi, saveSettings } = await import("../src/config/settings.js");
const { createAdminRouter } = await import("../src/web/routes/admin.js");
const { readEvents } = await import("../src/util/logger.js");

const app = express();
app.use(express.json());
app.use(createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }) } }));
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const reveal = async (body) => {
  const response = await fetch(`${base}/secrets/reveal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, json: await response.json() };
};
const revealEvents = (kind) => readEvents({ limit: 200 }).filter((e) => e.event === kind);

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

// ── The REFUSED reveal ────────────────────────────────────────────────────────────────────────
// readSecret throws for anything off the allowlist, and the handler used to answer 400 before any
// logEvent ran. So someone holding a stolen session could sweep the endpoint for revealable field
// names — probing adminPassword, __proto__, every config key they could think of — and leave the
// audit completely empty. Only a wrong password logged anything at all.

test("a refused reveal is audited with the requested field name — and never a value", async () => {
  saveSettings({ slackBotToken: "xoxb-sweep-target-9999" });
  const before = revealEvents("secret_reveal_rejected").length;

  const denied = await reveal({ scope: "settings", field: "adminPassword" });
  assert.equal(denied.response.status, 400);
  assert.match(denied.json.error, /not revealable/);

  const events = revealEvents("secret_reveal_rejected");
  assert.equal(events.length, before + 1, "the sweep leaves a trace");
  assert.equal(events[0].field, "adminPassword", "the requested NAME is what identifies the probe");
  assert.equal(events[0].scope, "settings");
  assert.equal(events[0].actor, "admin-ui");
  assert.equal(events[0].author, "admin-ui", "the admin principal is recorded, not left blank");
  assert.match(events[0].reason, /not revealable/);
  assert.equal("value" in events[0], false, "a refused reveal has no value to log — and must never invent one");
});

test("every shape of refusal is audited, and the field name is bounded", async () => {
  const before = revealEvents("secret_reveal_rejected").length;
  await reveal({ scope: "nope", field: "slackBotToken" }); // unknown scope
  await reveal({ scope: "settings", field: "__proto__" }); // prototype probe
  await reveal({ scope: "user", field: "composioToken", id: "U_DOES_NOT_EXIST" }); // unknown user
  assert.equal(revealEvents("secret_reveal_rejected").length, before + 3);

  // A padded request body must not be able to inflate the events table.
  await reveal({ scope: "settings", field: "z".repeat(5000) });
  assert.ok(revealEvents("secret_reveal_rejected")[0].field.length <= 120, "labels are clipped");
});

test("a successful reveal still logs secret_revealed, and no rejection", async () => {
  saveSettings({ slackBotToken: "xoxb-reveal-audited-7777" });
  const rejectedBefore = revealEvents("secret_reveal_rejected").length;
  const ok = await reveal({ scope: "settings", field: "slackBotToken" });
  assert.equal(ok.response.status, 200);
  assert.equal(ok.json.value, "xoxb-reveal-audited-7777");
  const granted = revealEvents("secret_revealed")[0];
  assert.equal(granted.field, "slackBotToken");
  // Every outcome of this endpoint names the principal — the admin UI's sessions carry no personal
  // identity, so a row that left `author` empty read as if nobody had asked for the secret.
  assert.equal(granted.actor, "admin-ui");
  assert.equal(granted.author, "admin-ui");
  assert.equal(revealEvents("secret_reveal_rejected").length, rejectedBefore, "a granted reveal is not a rejection");
  assert.ok(!JSON.stringify(readEvents({ limit: 200 })).includes("xoxb-reveal-audited-7777"), "the value itself is never in the audit");
});

test("a wrong-password reveal is audited with the principal too", async () => {
  saveSettings({ adminPassword: "correct horse battery staple" });
  try {
    const before = revealEvents("secret_reveal_denied").length;
    const denied = await reveal({ scope: "settings", field: "slackBotToken", password: "not-it" });
    assert.equal(denied.response.status, 401);
    const events = revealEvents("secret_reveal_denied");
    assert.equal(events.length, before + 1);
    assert.equal(events[0].field, "slackBotToken");
    assert.equal(events[0].actor, "admin-ui");
    assert.equal(events[0].author, "admin-ui");
    assert.ok(!JSON.stringify(events[0]).includes("not-it"), "the attempted password is never logged");
  } finally {
    saveSettings({ adminPassword: "" }); // leave the shared scratch env as it was found
  }
});
