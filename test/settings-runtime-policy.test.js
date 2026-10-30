// Security audit batch 4: the Slack Settings runtime controls (channel engine / model / effort,
// thread pins and their reset) follow the gateway's model-change policy exactly like `/model`,
// the wizard, the shortcuts and the platform controls — they used to be the one surface that
// ignored it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { saveSettings } = await import("../src/config/settings.js");
const { channelSettingsEditOptions, assertRuntimeChangeAllowed } = await import("../src/slack/app.js");
const { buildChannelSettingsView, CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID } = await import("../src/slack/channel-settings.js");

const channel = { access: "approved", manageAccess: "admins" };
const state = { channelId: "CRUNTIME", slug: "runtime-policy", ownerId: "UMEMBER" };
const elements = (view) => [...view.blocks.map((b) => b.accessory).filter(Boolean), ...view.blocks.flatMap((b) => b.elements || [])];

test("with the default (admins-only) policy a member cannot change the runtime from Settings; an admin and a DM owner can", () => {
  saveSettings({ modelChangeAccess: "admins" });
  assert.equal(channelSettingsEditOptions(channel, false, { authorId: "UMEMBER", isApprovedUser: true }).canEditRuntime, false);
  assert.equal(channelSettingsEditOptions(channel, true, { authorId: "UADMIN", isApprovedUser: true }).canEditRuntime, true);
  assert.equal(channelSettingsEditOptions({ ...channel, isDM: true }, false, { authorId: "UMEMBER", isApprovedUser: true }).canEditRuntime, true);
  assert.throws(() => assertRuntimeChangeAllowed(channel, false), /Only admins can change the harness, model, or effort in a channel/);
  assert.doesNotThrow(() => assertRuntimeChangeAllowed(channel, true));
  assert.doesNotThrow(() => assertRuntimeChangeAllowed({ ...channel, isDM: true }, false));
  // The page renders the lock line and no runtime pickers for the member.
  const locked = buildChannelSettingsView({ mode: channel, access: channel, runtime: {} }, state, { tab: "agent", canEditRuntime: false });
  assert.match(JSON.stringify(locked), /policy limits engine changes to admins/);
  assert.equal(elements(locked).some((e) => e.action_id === CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID), false);
  const open = buildChannelSettingsView({ mode: channel, access: channel, runtime: {} }, state, { tab: "agent", canEditRuntime: true });
  assert.equal(elements(open).some((e) => e.action_id === CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID), true);
});

test("with the policy at \"users\" every authorized member keeps the runtime controls", () => {
  saveSettings({ modelChangeAccess: "users" });
  assert.equal(channelSettingsEditOptions(channel, false, { authorId: "UMEMBER", isApprovedUser: true }).canEditRuntime, true);
  assert.doesNotThrow(() => assertRuntimeChangeAllowed(channel, false));
  saveSettings({ modelChangeAccess: "admins" });
});

test("the Settings runtime handlers call the policy check before writing anything", () => {
  const src = readFileSync(new URL("../src/slack/app.js", import.meta.url), "utf8");
  const select = src.match(/const runtimeTarget = runtimeSelectTarget\(actionId\);\s*if \(runtimeTarget\) \{[\s\S]*?patchAuditedChannelSettings/)?.[0] || "";
  assert.match(select, /assertRuntimeChangeAllowed\(meta, userIsAdmin\)/);
  const reset = src.match(/if \(actionId === CHANNEL_SETTINGS_THREAD_RESET_ACTION_ID\) \{[\s\S]*?clearThreadRuntime/)?.[0] || "";
  assert.match(reset, /assertRuntimeChangeAllowed\(meta, userIsAdmin\)/);
  assert.ok(select.indexOf("assertRuntimeChangeAllowed") < select.indexOf("patchAuditedChannelSettings"));
});
