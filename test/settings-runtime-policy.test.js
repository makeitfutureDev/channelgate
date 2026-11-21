// Who may change what on the Slack Settings Agent page. The runtime controls (the channel's
// harness, license, model and effort, a thread's pins and their reset) belong to every participant
// who may open Settings in the conversation; what a pick may name is bounded by the channel's allow
// list (Approved harnesses), and only an organization administrator changes that list.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { saveSettings, settingsForApi } = await import("../src/config/settings.js");
const { channelSettingsEditOptions } = await import("../src/slack/app.js");
const { buildChannelSettingsView, CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID, CHANNEL_SETTINGS_HARNESSES_ACTION_ID } = await import("../src/slack/channel-settings.js");

const channel = { access: "approved", manageAccess: "admins" };
const state = { channelId: "CRUNTIME", slug: "runtime-policy", ownerId: "UMEMBER" };
const elements = (view) => [...view.blocks.map((b) => b.accessory).filter(Boolean), ...view.blocks.flatMap((b) => b.elements || [])];
const has = (view, actionId) => elements(view).some((e) => e.action_id === actionId);

test("a member gets the runtime pickers on the Agent page; only an administrator gets the allow list", () => {
  const member = channelSettingsEditOptions(channel, false, { authorId: "UMEMBER", isApprovedUser: true });
  const admin = channelSettingsEditOptions(channel, true, { authorId: "UADMIN", isApprovedUser: true });
  assert.equal(Object.hasOwn(member, "canEditRuntime"), false, "nothing gates the runtime controls any more");
  assert.equal(member.canApproveHarnesses, false);
  assert.equal(admin.canApproveHarnesses, true);
  const snapshot = { mode: channel, access: channel, runtime: {} };
  const memberView = buildChannelSettingsView(snapshot, state, { tab: "agent", ...member });
  assert.equal(has(memberView, CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID), true);
  assert.equal(has(memberView, CHANNEL_SETTINGS_HARNESSES_ACTION_ID), false);
  assert.doesNotMatch(JSON.stringify(memberView), /policy limits engine changes to admins/);
  const adminView = buildChannelSettingsView(snapshot, state, { tab: "agent", ...admin });
  assert.equal(has(adminView, CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID), true);
  assert.equal(has(adminView, CHANNEL_SETTINGS_HARNESSES_ACTION_ID), true);
});

test("the retired gateway setting is neither reported nor honored when an earlier release stored it", () => {
  saveSettings({ modelChangeAccess: "admins" });
  assert.equal(Object.hasOwn(settingsForApi(), "modelChangeAccess"), false);
  assert.equal(has(buildChannelSettingsView({ mode: channel, access: channel, runtime: {} }, state, {
    tab: "agent", ...channelSettingsEditOptions(channel, false, { authorId: "UMEMBER", isApprovedUser: true }),
  }), CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID), true);
});

test("the Settings handlers keep the allow list with administrators and check a pick against it before writing", () => {
  const src = readFileSync(new URL("../src/slack/app.js", import.meta.url), "utf8");
  const harnesses = src.match(/if \(actionId === CHANNEL_SETTINGS_HARNESSES_ACTION_ID\) \{[\s\S]*?patchAuditedChannelSettings/)?.[0] || "";
  assert.match(harnesses, /if \(!\(await isAdmin\(clicker\)\)\) throw new Error\("Only organization admins can approve channel harnesses\."\)/);
  const select = src.match(/const runtimeTarget = runtimeSelectTarget\(actionId\);\s*if \(runtimeTarget\) \{[\s\S]*?patchAuditedChannelSettings/)?.[0] || "";
  assert.match(select, /assertChannelEngineApproved\(meta, actualEngine\)/);
  assert.ok(select.indexOf("assertChannelEngineApproved") < select.indexOf("patchAuditedChannelSettings"));
  for (const file of ["../src/slack/app.js", "../src/slack/message-pipeline.js", "../src/slack/model-wizard.js", "../src/platforms/conversation-controls.js", "../src/platforms/msteams/controls.js", "../src/config/settings.js"]) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /canChangeChannelRuntime|getModelChangeAccess/, file);
  }
});
