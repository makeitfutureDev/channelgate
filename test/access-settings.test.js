import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { buildAccessEditorView, readAccessForm, accessSettingsPatch, accessSettingsSnapshot } = await import("../src/slack/access-settings.js");
const { buildChannelSettingsView, editorMetadata } = await import("../src/slack/channel-settings.js");
const { channelSettingsContext, channelSettingsEditOptions, saveAccessSettings, handleAccessSettingsSubmission } = await import("../src/slack/app.js");
const store = await import("../src/config/store.js");
const { PROFILE_FLAGS } = await import("../src/gateway/modes.js");
const { getDb } = await import("../src/db/index.js");
const actor = { authorId: "UMANAGER", isApprovedUser: true, isAdminUser: false };
const base = { access: "approved", manageAccess: "members", ...PROFILE_FLAGS.worker };
const form = { ...accessSettingsSnapshot(base), mode: "admin", autoMode: true, cleanMode: true, allowNetwork: true };
const state = { channelId: "CACCESS", slug: "access-test", ownerId: "UMANAGER" };

test("only admins and current managers see Access; existing tabs remain available", () => {
  for (const [meta, admin, user, expected] of [
    [{ ...base, manageAccess: "admins" }, false, actor, false],
    [base, false, actor, true],
    [{ ...base, manageAccess: "custom", managers: [actor.authorId] }, false, actor, true],
    [{ ...base, manageAccess: "custom", managers: [] }, false, actor, false],
    [{ ...base, manageAccess: "admins" }, true, actor, true],
    [base, false, { ...actor, isApprovedUser: false }, false],
    [{ ...base, isDM: true }, true, actor, false],
  ]) {
    const options = channelSettingsEditOptions(meta, admin, user);
    assert.equal(options.canEditAccess, expected);
    const view = buildChannelSettingsView({ access: meta }, state, { ...options, tab: "access" });
    const buttons = view.blocks.flatMap((block) => block.elements || []);
    assert.equal(buttons.some((b) => b.action_id === "cg_channel_settings_tab_access"), expected);
    assert.equal(buttons.some((b) => b.action_id === "cg_channel_settings_access_edit"), expected);
    assert.ok(buttons.some((b) => b.action_id === "cg_channel_settings_tab_secrets"));
  }
});

test("access form preserves independent mode/Auto/Lean/network flags and clears lists", () => {
  const view = buildAccessEditorView({ ...base, ...form, adminMode: true }, editorMetadata(state, { view: "access" }));
  const values = {};
  for (const block of view.blocks.filter((b) => b.type === "input")) {
    const el = block.element;
    values[block.block_id] = { [el.action_id]: el.type === "static_select"
      ? { selected_option: el.initial_option }
      : el.type === "checkboxes" ? { selected_options: el.initial_options || [] }
        : { selected_users: el.initial_users || [] } };
  }
  // Admin is a base mode; Auto and Lean remain independent options.
  values.settings_access_mode.mode.selected_option = { value: "admin" };
  const parsed = readAccessForm({ state: { values } });
  assert.deepEqual(parsed, form);
  const patch = accessSettingsPatch(base, { ...parsed, workDir: "/forged", isAdmin: true, env: { SECRET: "forged" } }, actor);
  assert.equal(patch.profile, "admin");
  assert.equal(patch.autoMode, true);
  assert.equal(patch.allowBash, true);
  assert.equal(patch.adminMode, true);
  assert.equal(patch.cleanMode, true);
  assert.equal(patch.allowNetwork, true);
  for (const key of ["workDir", "isAdmin", "env"]) assert.equal(Object.hasOwn(patch, key), false);
  values.settings_access_flags.flags.selected_options = [];
  assert.equal(readAccessForm({ state: { values } }).autoMode, false);
  assert.throws(() => readAccessForm({}), /incomplete/);
});

test("access validation fails closed and canonical presets agree with flags", () => {
  assert.throws(() => accessSettingsPatch({ ...base, manageAccess: "admins" }, form, actor), /current channel managers/);
  assert.throws(() => accessSettingsPatch({ ...base, access: "admins" }, form, actor), /current channel managers/);
  for (const bad of [{ mode: "auto" }, { access: "all" }, { manageAccess: "all" }, { autoMode: "true" }, { allowedUsers: ["bad"] }, { managers: null }]) {
    assert.throws(() => accessSettingsPatch(base, { ...form, ...bad }, actor));
  }
  for (const mode of ["read", "worker", "admin"]) {
    const patch = accessSettingsPatch(base, { ...form, mode, autoMode: false, cleanMode: false }, actor);
    assert.equal(patch.profile, mode);
    for (const [key, value] of Object.entries(PROFILE_FLAGS[mode])) assert.equal(patch[key], value);
  }
});

async function fixture() {
  await store.ensureRoot();
  const entry = await store.upsertChannelEntry("CACCESS", { name: "access-test", type: "channel", isDM: false });
  await store.setUser("UMANAGER", { approved: true, isAdmin: false });
  await store.setUser("UADMIN", { approved: true, isAdmin: true });
  await store.saveChannelMeta(entry.slug, { ...store.defaultChannelMeta({ channelId: entry.channelId, name: entry.name }), ...base, engine: "codex", model: "unchanged", composioToken: "keep-token" });
  const client = {
    conversations: { members: async () => ({ members: ["UMANAGER", "UGUEST", "UADMIN", "UBOT"] }) },
    users: { info: async ({ user }) => ({ user: { id: user, is_bot: user === "UBOT", name: user } }) },
  };
  return { client, state: { ...state, slug: entry.slug }, entry };
}

test("real save admits managers, audits policy, preserves unrelated fields, and rechecks stale grants", async () => {
  const { client, state, entry } = await fixture();
  const result = await saveAccessSettings(client, state, state.ownerId, { ...form, allowedUsers: ["UGUEST"], managers: ["UMANAGER"] });
  assert.equal(result.saved.adminMode, true);
  assert.equal(result.saved.cleanMode, true);
  assert.equal(result.saved.allowNetwork, true);
  assert.equal(result.saved.model, "unchanged");
  assert.equal(result.saved.composioToken, "keep-token");
  assert.equal((await store.getUser("UMANAGER")).isAdmin, false);
  const row = getDb().prepare("SELECT * FROM events WHERE event = 'channel_meta_changed' ORDER BY rowid DESC LIMIT 1").get();
  assert.ok(row);
  assert.doesNotMatch(JSON.stringify(row), /keep-token/);
  await store.patchChannelMeta(entry.slug, { manageAccess: "admins" });
  await assert.rejects(() => saveAccessSettings(client, state, state.ownerId, form), /current channel managers/);
  await assert.rejects(() => saveAccessSettings(client, state, "UADMIN", form), /isn't yours/);
  await saveAccessSettings(client, { ...state, ownerId: "UADMIN" }, "UADMIN", form);
});

test("save rejects departed users, bots, outsiders and a revocation during user lookup", async () => {
  const { client, state, entry } = await fixture();
  for (const id of ["UBOT", "UOUTSIDE"]) {
    await assert.rejects(() => saveAccessSettings(client, state, state.ownerId, { ...form, allowedUsers: [id] }), /current human members/);
    assert.equal((await store.getChannelMeta(entry.slug)).adminMode, false);
  }
  await assert.rejects(() => channelSettingsContext({ conversations: { members: async () => ({ members: [] }) } }, {
    channelId: state.channelId, userId: state.ownerId, expectedSlug: state.slug, accessSettings: true, verifyMembership: true,
  }), /no longer a member/);
  client.users.info = async ({ user }) => {
    await store.patchChannelMeta(entry.slug, { manageAccess: "admins" });
    return { user: { id: user, name: user } };
  };
  await assert.rejects(() => saveAccessSettings(client, state, state.ownerId, { ...form, allowedUsers: ["UGUEST"] }), /current channel managers/);
  assert.equal((await store.getChannelMeta(entry.slug)).adminMode, false);
});

test("global role revoked during final membership request cannot save", async () => {
  const { client, state, entry } = await fixture();
  let checks = 0;
  client.conversations.members = async () => {
    if (++checks === 3) await store.setUser("UMANAGER", { approved: false, isAdmin: false });
    return { members: ["UMANAGER", "UGUEST"] };
  };
  await assert.rejects(() => saveAccessSettings(client, state, state.ownerId, { ...form, allowedUsers: ["UGUEST"] }), /current channel managers/);
  assert.equal((await store.getChannelMeta(entry.slug)).adminMode, false);
});

test("submission acknowledges before asynchronous validation and rejects forged owners", async () => {
  const editor = buildAccessEditorView(base, editorMetadata(state, { view: "access" }));
  const values = {};
  for (const block of editor.blocks.filter((b) => b.type === "input")) {
    const el = block.element;
    values[block.block_id] = { [el.action_id]: el.type === "static_select"
      ? { selected_option: el.initial_option }
      : el.type === "checkboxes" ? { selected_options: [] } : { selected_users: [] } };
  }
  const events = [];
  const params = { ack: async (payload) => events.push(["ack", payload]), body: { user: { id: state.ownerId } },
    view: { ...editor, id: "VACCESS", state: { values } },
    client: { views: { update: async (payload) => events.push(["update", payload]) } } };
  await handleAccessSettingsSubmission(params, {
    save: async () => { assert.equal(events[0][0], "ack"); throw new Error("Management revoked"); },
  });
  assert.equal(events.length, 2);
  assert.equal(events[0][1].response_action, "update");
  assert.match(JSON.stringify(events[1]), /Management revoked/);
  events.length = 0;
  await handleAccessSettingsSubmission({ ...params, body: { user: { id: "UOTHER" } } }, {
    save: async () => assert.fail("forged owner must never save"),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0][1].response_action, "errors");
});


test("channel Runtime tab has no duplicate mode controls and Auto promotes Read-only", () => {
  const view = buildChannelSettingsView({ mode: base }, state, { tab: "runtime", canEnableAdmin: true, canEditAccess: true });
  const buttons = view.blocks.flatMap((block) => block.elements || []);
  assert.equal(buttons.some((b) => /cg_channel_settings_(mode|option)_/.test(b.action_id)), false);
  const promoted = accessSettingsPatch(base, { ...form, mode: "read", autoMode: true }, actor);
  assert.equal(promoted.profile, "worker");
  assert.equal(promoted.allowBash, true);
  assert.equal(promoted.adminMode, false);
});
