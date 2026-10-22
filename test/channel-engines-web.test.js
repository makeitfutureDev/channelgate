import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv, testLicenseEnv } from "./helpers.js";

ensureTestEnv();
const { createChannelsRouter } = await import("../src/web/routes/channels.js");
const { upsertChannelEntry, saveChannelMeta, getChannelMeta, defaultChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { readEvents } = await import("../src/util/logger.js");
const { buildChannelSettingsView, readHarnessSelection, SETTINGS_DEFAULT_VALUE, CHANNEL_SETTINGS_HARNESSES_ACTION_ID } = await import("../src/slack/channel-settings.js");
const { channelSettingsEditOptions, runtimeScopes, applyThreadRuntimeSelection } = await import("../src/slack/app.js");
saveSettings({ engine: "claude", engineEnabled: { claude: true, codex: true } });
const app = express();
app.use(express.json());
app.use(createChannelsRouter());
app.use((error, _req, res, _next) => res.status(error.statusCode || error.status || 500).json({ error: error.message }));
const server = await new Promise(resolve => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
after(() => { server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${server.address().port}`;
const put = (url, body) => fetch(base + url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function fixture(id, isDM = false) {
  testLicenseEnv({ tier: "enterprise" });
  const entry = await upsertChannelEntry(id, { name: id.toLowerCase(), type: isDM ? "im" : "channel", isDM });
  await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId: id, name: entry.name, isDM }), engine: "claude", template: "custom" });
  return entry;
}

test("admin channel API validates policy atomically, audits it, and preserves it through downgrade", async () => {
  const id = "C_WEB_HARNESSES";
  const entry = await fixture(id);
  const url = `/channels/${id}/meta`;
  for (const approvedEngines of [[], ["unknown"], "claude"]) {
    assert.equal((await put(url, { approvedEngines })).status, 400);
  }
  assert.equal((await put(url, { approvedEngines: ["codex"] })).status, 403, "a disallowed default cannot be saved");
  assert.equal((await getChannelMeta(entry.slug)).approvedEngines ?? null, null);
  const ok = await put(url, { approvedEngines: ["claude", "claude"] });
  assert.equal(ok.status, 200, await ok.text());
  assert.deepEqual((await getChannelMeta(entry.slug)).approvedEngines, ["claude"]);
  assert.ok(readEvents({ limit: 20 }).some(e => e.event === "channel_meta_changed" && e.changes?.approvedEngines?.to?.includes("claude")));
  assert.equal((await put(url, { engine: "codex" })).status, 403);
  const login = await fetch(base + `/channels/${id}/codex-login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "device" }) });
  assert.equal(login.status, 403, "refuse dedicated Codex login before starting authentication");
  testLicenseEnv({ tier: "free" });
  assert.equal((await put(url, { approvedEngines: null })).status, 403);
  assert.equal((await put(url, { approvedEngines: ["claude", "codex"] })).status, 403);
  assert.equal((await put(url, { allowNetwork: false })).status, 200, "unrelated edits remain available");
  testLicenseEnv({ tier: "enterprise" });
  assert.equal((await put(url, { approvedEngines: ["codex"], engine: "codex" })).status, 200);
  assert.equal((await put(url, { approvedEngines: null })).status, 200);
});

test("DM API enforces the same Enterprise approvals and selected harness", async () => {
  const id = "D_WEB_HARNESSES";
  const entry = await fixture(id, true);
  const url = `/dms/${id}`;
  assert.equal((await put(url, { approvedEngines: ["claude"] })).status, 200);
  assert.equal((await put(url, { codexAuthSource: "channel" })).status, 403);
  testLicenseEnv({ tier: "free" });
  const denied = await put(url, { approvedEngines: null });
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error, /Enterprise/);
  assert.deepEqual((await getChannelMeta(entry.slug)).approvedEngines, ["claude"]);
});

test("Slack settings expose approvals only to Enterprise admins and filter ordinary runtime choices", async () => {
  const entry = await fixture("C_SLACK_HARNESSES");
  const meta = { ...(await getChannelMeta(entry.slug)), approvedEngines: ["claude"] };
  await saveChannelMeta(entry.slug, meta);
  const runtime = { approvedEngines: ["claude"], harnessOptions: [{ value: "claude", label: "Claude" }, { value: "codex", label: "Codex" }], effectiveEngineId: "claude", configuredEngineId: "claude" };
  const state = { ownerId: "U_HARNESS", channelId: meta.channelId, slug: entry.slug, tab: "agent", threadTs: "thread" };
  const control = (admin) => JSON.stringify(buildChannelSettingsView({ runtime }, state, channelSettingsEditOptions(meta, admin))).includes(CHANNEL_SETTINGS_HARNESSES_ACTION_ID);
  assert.equal(control(true), true);
  assert.equal(control(false), false);
  testLicenseEnv({ tier: "free" });
  assert.equal(control(true), false);
  const scopes = await runtimeScopes(entry.slug, meta, { runtime }, "");
  assert.deepEqual(scopes.channel.options.engines.map(e => e.value), ["claude"]);
  await assert.rejects(applyThreadRuntimeSelection({ entry, meta, state, actorId: state.ownerId, field: "engine", value: "codex" }), /not an approved harness/);
});


test("Slack multi-select can move from All to one harness, then multiple, and back to All", () => {
  const action = (...values) => ({ selected_options: values.map(value => ({ value })) });
  assert.deepEqual(readHarnessSelection(action(SETTINGS_DEFAULT_VALUE, "claude"), {}), ["claude"]);
  assert.deepEqual(readHarnessSelection(action("claude", "codex"), { approvedEngines: ["claude"] }), ["claude", "codex"]);
  assert.equal(readHarnessSelection(action("claude", SETTINGS_DEFAULT_VALUE), { approvedEngines: ["claude"] }), null);
});
