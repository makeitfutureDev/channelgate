import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { ACCESS_FIELD_PREFIX, accessFieldTarget, accessSettingsPatch, accessSettingsSnapshot, readAccessFieldValue } = await import("../src/slack/access-settings.js");
const { buildChannelSettingsView, editorMetadata } = await import("../src/slack/channel-settings.js");
const { channelSettingsContext, channelSettingsEditOptions, saveAccessSettings, handleAccessSettingsSubmission } = await import("../src/slack/app.js");
const store = await import("../src/config/store.js");
const { PROFILE_FLAGS } = await import("../src/gateway/modes.js");
const { getDb } = await import("../src/db/index.js");
const actor = { authorId: "UMANAGER", isApprovedUser: true, isAdminUser: false };
const base = { access: "approved", manageAccess: "members", ...PROFILE_FLAGS.worker };
const form = { ...accessSettingsSnapshot(base), mode: "admin", autoMode: true, cleanMode: true, allowNetwork: true };
const state = { channelId: "CACCESS", slug: "access-test", ownerId: "UMANAGER" };

test("only admins and current managers see the Access section of General Settings", () => {
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
    // A Settings view opened before the merge carries "access" in its metadata; it must land on
    // the page that now owns those controls rather than on an empty first page.
    const view = buildChannelSettingsView({ access: meta, isDM: Boolean(meta.isDM) }, state, { ...options, tab: "access" });
    assert.equal(JSON.parse(view.private_metadata).p, "general");
    // Every access control is on the page itself, and only for a manager: the three selects, the
    // Auto/Lean/Network checkboxes and the two member pickers.
    const controls = [
      ...view.blocks.map((block) => block.accessory).filter(Boolean),
      ...view.blocks.flatMap((block) => block.elements || []),
    ].filter((element) => String(element.action_id || "").startsWith(ACCESS_FIELD_PREFIX));
    assert.equal(controls.length, expected ? 6 : 0);
    if (expected) {
      assert.deepEqual(controls.map((element) => element.type).sort(),
        ["checkboxes", "multi_users_select", "multi_users_select", "static_select", "static_select", "static_select"]);
      // No pushed editor any more — the page is the editor.
      assert.equal(JSON.stringify(view).includes("cg_channel_settings_access_edit"), false);
    }
    // The access controls are manager-only; the page around them is not. A DM has no access
    // policy at all, so it gets neither the controls nor the line explaining their absence.
    const headers = view.blocks.filter((block) => block.type === "header").map((block) => block.text.text);
    assert.equal(headers.includes("Access"), !meta.isDM);
    assert.equal(JSON.stringify(view).includes("Who may use and manage this channel is shown"), !expected && !meta.isDM);
    const pages = view.blocks.find((block) => block.block_id === "cg_channel_settings_tabs").elements;
    assert.ok(pages.some((page) => JSON.parse(page.value).p === "secrets"));
  }
});

test("each inline access control contributes only its own field, and unknown ones contribute nothing", () => {
  // Every control saves on its own now, so one dispatch must describe exactly one field: the rest
  // of the form is read back from the record, never from the repainted neighbours.
  assert.deepEqual(readAccessFieldValue("mode", { selected_option: { value: "admin" } }), { mode: "admin" });
  assert.deepEqual(readAccessFieldValue("access", { selected_option: { value: "none" } }), { access: "none" });
  assert.deepEqual(readAccessFieldValue("manageAccess", { selected_option: { value: "custom" } }), { manageAccess: "custom" });
  assert.deepEqual(readAccessFieldValue("allowedUsers", { selected_users: ["UGUEST"] }), { allowedUsers: ["UGUEST"] });
  assert.deepEqual(readAccessFieldValue("managers", { selected_users: [] }), { managers: [] });
  // The checkbox group reports its WHOLE selection, which is what makes an unchecked box a false
  // rather than a key the patch would reject as missing.
  assert.deepEqual(readAccessFieldValue("flags", { selected_options: [{ value: "autoMode" }, { value: "allowNetwork" }] }),
    { autoMode: true, cleanMode: false, allowNetwork: true });
  assert.deepEqual(readAccessFieldValue("flags", { selected_options: [] }), { autoMode: false, cleanMode: false, allowNetwork: false });

  for (const [field, action] of [["mode", { selected_option: { value: "auto" } }], ["access", {}], ["manageAccess", { selected_option: {} }],
    ["flags", {}], ["flags", { selected_options: [{ value: "isAdmin" }] }], ["allowedUsers", {}], ["managers", { selected_users: "UONE" }],
    ["workDir", { selected_option: { value: "/forged" } }]]) {
    assert.throws(() => readAccessFieldValue(field, action), `${field} must fail closed`);
  }

  // Only this page's access controls route here; every other control on it is somebody else's.
  for (const field of ["mode", "access", "manageAccess", "flags", "allowedUsers", "managers"]) {
    assert.equal(accessFieldTarget(`${ACCESS_FIELD_PREFIX}${field}`), field);
  }
  for (const foreign of ["", "cg_channel_settings_runtime_model", `${ACCESS_FIELD_PREFIX}isAdmin`, "cg_channel_settings_tab_select"]) {
    assert.equal(accessFieldTarget(foreign), "");
  }
});

test("a patch built from one control's value still refuses forged fields and keeps the flags independent", () => {
  const patch = accessSettingsPatch(base, { ...form, ...readAccessFieldValue("mode", { selected_option: { value: "admin" } }),
    workDir: "/forged", isAdmin: true, env: { SECRET: "forged" } }, actor);
  assert.equal(patch.profile, "admin");
  assert.equal(patch.autoMode, true);
  assert.equal(patch.allowBash, true);
  assert.equal(patch.adminMode, true);
  assert.equal(patch.cleanMode, true);
  assert.equal(patch.allowNetwork, true);
  for (const key of ["workDir", "isAdmin", "env"]) assert.equal(Object.hasOwn(patch, key), false);
  const cleared = accessSettingsPatch(base, { ...form, ...readAccessFieldValue("flags", { selected_options: [] }) }, actor);
  assert.equal(cleared.autoMode, false);
  assert.equal(cleared.cleanMode, false);
  assert.equal(cleared.allowNetwork, false);
  assert.equal(cleared.profile, "admin", "clearing the options does not disturb the base mode");
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

test("one inline control changes one field and leaves the rest of the policy alone", async () => {
  const { client, state, entry } = await fixture();
  // What the handler does for a dispatch: the changed field from the payload, everything else read
  // back from the record.
  const save = (field, action) => saveAccessSettings(client, state, state.ownerId,
    { ...accessSettingsSnapshot(meta()), ...readAccessFieldValue(field, action) });
  const meta = () => stored;
  let stored = await store.getChannelMeta(entry.slug);

  stored = (await save("allowedUsers", { selected_users: ["UGUEST"] })).saved;
  assert.deepEqual(stored.allowedUsers, ["UGUEST"]);
  assert.equal(stored.access, base.access, "picking a guest did not touch the use policy");
  assert.equal(stored.adminMode, false, "…or the mode");

  stored = (await save("mode", { selected_option: { value: "admin" } })).saved;
  assert.equal(stored.adminMode, true);
  assert.deepEqual(stored.allowedUsers, ["UGUEST"], "the guest saved a moment ago survives the next control");
  assert.equal(stored.model, "unchanged", "unrelated channel settings are untouched throughout");

  stored = (await save("flags", { selected_options: [{ value: "allowNetwork" }] })).saved;
  assert.equal(stored.allowNetwork, true);
  assert.equal(stored.autoMode, false);
  assert.equal(stored.adminMode, true, "the options are independent of the base mode");

  // The same guarantees the submitted form had: a rejected value writes nothing at all.
  await assert.rejects(() => save("allowedUsers", { selected_users: ["UOUTSIDE"] }), /current human members/);
  assert.deepEqual((await store.getChannelMeta(entry.slug)).allowedUsers, ["UGUEST"]);
  await store.patchChannelMeta(entry.slug, { manageAccess: "admins" });
  stored = await store.getChannelMeta(entry.slug);
  await assert.rejects(() => save("access", { selected_option: { value: "none" } }), /current channel managers/);
  assert.equal((await store.getChannelMeta(entry.slug)).access, base.access);
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

test("an access form left open from before the move says where its controls went, and saves nothing", async () => {
  const events = [];
  await handleAccessSettingsSubmission({
    ack: async (payload) => events.push(payload),
    body: { user: { id: state.ownerId } },
    view: { id: "VACCESS", private_metadata: editorMetadata(state, { view: "access" }), state: { values: { forged: true } } },
    client: { views: { update: async () => assert.fail("a retired form must not write a view") } },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].response_action, "update");
  assert.match(JSON.stringify(events[0].view), /General Settings/);
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
