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
const adminActor = { authorId: "UADMIN", isApprovedUser: true, isAdminUser: true };
const base = { access: "approved", manageAccess: "members", ...PROFILE_FLAGS.worker };
// Admin mode is what an organization ADMIN sets; a channel manager's form keeps Worker.
const form = { ...accessSettingsSnapshot(base), mode: "admin", autoMode: true, cleanMode: true, allowNetwork: true };
const managerForm = { ...form, mode: "worker" };
const state = { channelId: "CACCESS", slug: "access-test", ownerId: "UMANAGER" };

test("only admins and current managers edit access: mode on Agent, policy and member ticks on Access", () => {
  const members = [
    { id: "UADMIN", isAdmin: true, approved: true, use: true, manage: false },
    { id: "UMANAGER", approved: true, use: true, manage: false },
    { id: "UGUEST", guest: true, use: true, manage: false },
    { id: "USTRANGER", use: false, manage: false },
  ];
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
    const controls = (view) => [
      ...view.blocks.map((block) => block.accessory).filter(Boolean),
      ...view.blocks.flatMap((block) => block.elements || []),
    ].filter((element) => String(element.action_id || "").startsWith(ACCESS_FIELD_PREFIX));
    // Agent: the mode dropdown and the Auto/Lean/Internet checkboxes, editable only by a manager.
    const agent = buildChannelSettingsView({ access: meta, mode: meta, isDM: Boolean(meta.isDM) }, state, { ...options, tab: "agent" });
    assert.deepEqual(controls(agent).map((element) => element.type).sort(), expected ? ["checkboxes", "static_select"] : []);
    if (!expected && !meta.isDM) assert.match(JSON.stringify(agent), /Managers and admins change the mode/);
    // Access: the two policy dropdowns and one Use tick per non-admin member (admins are always in).
    const view = buildChannelSettingsView({ access: meta, mode: meta, isDM: Boolean(meta.isDM), people: members }, state, { ...options, tab: "access" });
    if (meta.isDM) {
      assert.equal(JSON.parse(view.private_metadata).p, "agent", "a DM has no Access page");
      continue;
    }
    assert.equal(JSON.parse(view.private_metadata).p, "access");
    assert.deepEqual(controls(view).map((element) => element.type).sort(), expected ? ["static_select", "static_select"] : []);
    const ticks = view.blocks.filter((block) => block.accessory?.type === "checkboxes");
    assert.equal(ticks.length, expected ? 3 : 0);
    if (expected) {
      assert.deepEqual(ticks.map((block) => block.block_id), ["cg_member_UMANAGER", "cg_member_UGUEST", "cg_member_USTRANGER"]);
      assert.deepEqual(ticks.map((block) => (block.accessory.initial_options || []).map((entry) => entry.value)), [["use"], ["use"], []]);
      // A Manage tick appears only when the channel names its managers.
      assert.equal(ticks[0].accessory.options.some((entry) => entry.value === "manage"), meta.manageAccess === "custom");
    } else {
      assert.match(JSON.stringify(view), /Only managers and admins change access/);
    }
    assert.equal(JSON.stringify(view).includes("cg_channel_settings_access_edit"), false, "no pushed editor");
  }
});

test("a member's Use tick grants a guest or excludes an approved member; admins are never excluded", async () => {
  const { memberAccessForm, memberCanUse } = await import("../src/slack/access-settings.js");
  const approved = { isApprovedUser: true };
  // Ticking someone the policy would refuse makes them a guest; unticking removes the grant.
  let form = memberAccessForm(base, "USTRANGER", { use: true }, {});
  assert.deepEqual(form.allowedUsers, ["USTRANGER"]);
  assert.deepEqual(form.excludedUsers, []);
  assert.equal(memberCanUse({ ...base, ...form }, "USTRANGER", {}), true);
  form = memberAccessForm({ ...base, allowedUsers: ["USTRANGER"] }, "USTRANGER", { use: false }, {});
  assert.deepEqual(form.allowedUsers, []);
  // Unticking an approved member of an "approved" channel records an exclusion, which the run gate honors.
  form = memberAccessForm(base, "UMEMBER", { use: false }, approved);
  assert.deepEqual(form.excludedUsers, ["UMEMBER"]);
  assert.equal(memberCanUse({ ...base, ...form }, "UMEMBER", approved), false);
  form = memberAccessForm({ ...base, excludedUsers: ["UMEMBER"] }, "UMEMBER", { use: true }, approved);
  assert.deepEqual(form.excludedUsers, []);
  assert.deepEqual(form.allowedUsers, [], "an approved member needs no guest grant");
  // An admin cannot be excluded, even when the list says so.
  assert.deepEqual(memberAccessForm(base, "UADMIN", { use: false }, { isAdminUser: true }).excludedUsers, []);
  assert.equal(memberCanUse({ ...base, excludedUsers: ["UADMIN"] }, "UADMIN", { isAdminUser: true }), true);
  // Manage edits the named managers list only.
  assert.deepEqual(memberAccessForm({ ...base, manageAccess: "custom" }, "UMEMBER", { manage: true }, approved).managers, ["UMEMBER"]);
  // The exclusion list is validated like the other lists.
  assert.throws(() => accessSettingsPatch(base, { ...accessSettingsSnapshot(base), excludedUsers: ["not-a-user"] }, { ...actor, isAdminUser: true }), /valid users/);
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
    workDir: "/forged", isAdmin: true, env: { SECRET: "forged" } }, adminActor);
  assert.equal(patch.profile, "admin");
  assert.equal(patch.autoMode, true);
  assert.equal(patch.allowBash, true);
  assert.equal(patch.adminMode, true);
  assert.equal(patch.cleanMode, true);
  assert.equal(patch.allowNetwork, true);
  for (const key of ["workDir", "isAdmin", "env"]) assert.equal(Object.hasOwn(patch, key), false);
  const cleared = accessSettingsPatch(base, { ...form, ...readAccessFieldValue("flags", { selected_options: [] }) }, adminActor);
  assert.equal(cleared.autoMode, false);
  assert.equal(cleared.cleanMode, false);
  assert.equal(cleared.allowNetwork, false);
  assert.equal(cleared.profile, "admin", "clearing the options does not disturb the base mode");
});

test("only an organization admin switches a channel INTO Admin mode; a manager may keep or leave it", () => {
  // The Settings mode control used to hand Admin mode to any channel manager — the one switch
  // that turns the engine's permission prompts off for every admin author in the channel. It is
  // admin-only here exactly as it is for `/mode admin` and the set_channel_admin_mode tool.
  assert.throws(() => accessSettingsPatch(base, form, actor), /Only administrators can enable Admin mode/);
  assert.throws(() => accessSettingsPatch(base, { ...form, ...readAccessFieldValue("mode", { selected_option: { value: "admin" } }) }, actor),
    /Only administrators can enable Admin mode/);
  assert.equal(accessSettingsPatch(base, form, adminActor).adminMode, true);
  // A channel already in Admin mode: the manager's other controls still work (the unchanged mode
  // is not a request to enable it), and the manager may step the channel back down.
  const adminChannel = { ...base, ...PROFILE_FLAGS.admin, profile: "admin" };
  const kept = accessSettingsPatch(adminChannel, { ...form, ...readAccessFieldValue("flags", { selected_options: [{ value: "allowNetwork" }] }) }, actor);
  assert.equal(kept.adminMode, true);
  assert.equal(kept.allowNetwork, true);
  assert.equal(kept.autoMode, false);
  assert.equal(accessSettingsPatch(adminChannel, managerForm, actor).adminMode, false);
  // The picker shows "Admin" only to someone who may enable it, or when it is already the mode.
  const modeOptions = (view) => {
    const select = [...view.blocks.map((block) => block.accessory), ...view.blocks.flatMap((block) => block.elements || [])]
      .find((element) => element?.action_id === `${ACCESS_FIELD_PREFIX}mode`);
    assert.ok(select, "the Agent page renders the mode picker");
    return select.options.map((option) => option.value);
  };
  assert.deepEqual(modeOptions(buildChannelSettingsView({ mode: base, access: base }, state, { tab: "agent", canEditAccess: true, canEnableAdmin: false })), ["read", "worker"]);
  assert.deepEqual(modeOptions(buildChannelSettingsView({ mode: base, access: base }, state, { tab: "agent", canEditAccess: true, canEnableAdmin: true })), ["read", "worker", "admin"]);
  assert.deepEqual(modeOptions(buildChannelSettingsView({ mode: adminChannel, access: adminChannel }, state, { tab: "agent", canEditAccess: true, canEnableAdmin: false })), ["read", "worker", "admin"]);
});

test("access validation fails closed and canonical presets agree with flags", () => {
  assert.throws(() => accessSettingsPatch({ ...base, manageAccess: "admins" }, managerForm, actor), /current channel managers/);
  assert.throws(() => accessSettingsPatch({ ...base, access: "admins" }, managerForm, actor), /current channel managers/);
  for (const bad of [{ mode: "auto" }, { access: "all" }, { manageAccess: "all" }, { autoMode: "true" }, { allowedUsers: ["bad"] }, { managers: null }]) {
    assert.throws(() => accessSettingsPatch(base, { ...managerForm, ...bad }, actor));
  }
  for (const mode of ["read", "worker", "admin"]) {
    const patch = accessSettingsPatch(base, { ...form, mode, autoMode: false, cleanMode: false }, mode === "admin" ? adminActor : actor);
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
  // The manager's own role is read from the store on save: Admin mode is refused and nothing is written.
  await assert.rejects(() => saveAccessSettings(client, state, state.ownerId, { ...form, allowedUsers: ["UGUEST"], managers: ["UMANAGER"] }), /Only administrators can enable Admin mode/);
  assert.equal((await store.getChannelMeta(entry.slug)).adminMode, false);
  const result = await saveAccessSettings(client, state, state.ownerId, { ...managerForm, allowedUsers: ["UGUEST"], managers: ["UMANAGER"] });
  assert.equal(result.saved.adminMode, false);
  assert.equal(result.saved.cleanMode, true);
  assert.equal(result.saved.allowNetwork, true);
  assert.equal(result.saved.model, "unchanged");
  assert.equal(result.saved.composioToken, "keep-token");
  assert.equal((await store.getUser("UMANAGER")).isAdmin, false);
  const row = getDb().prepare("SELECT * FROM events WHERE event = 'channel_meta_changed' ORDER BY rowid DESC LIMIT 1").get();
  assert.ok(row);
  assert.doesNotMatch(JSON.stringify(row), /keep-token/);
  await store.patchChannelMeta(entry.slug, { manageAccess: "admins" });
  await assert.rejects(() => saveAccessSettings(client, state, state.ownerId, managerForm), /current channel managers/);
  await assert.rejects(() => saveAccessSettings(client, state, "UADMIN", form), /isn't yours/);
  const byAdmin = await saveAccessSettings(client, { ...state, ownerId: "UADMIN" }, "UADMIN", form);
  assert.equal(byAdmin.saved.adminMode, true, "an organization admin enables Admin mode from the same control");
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

  // The manager's mode control cannot enable Admin; an admin's can, and the manager's later
  // controls then work in the Admin-mode channel without disturbing it.
  await assert.rejects(() => save("mode", { selected_option: { value: "admin" } }), /Only administrators can enable Admin mode/);
  assert.equal((await store.getChannelMeta(entry.slug)).adminMode, false);
  stored = (await saveAccessSettings(client, { ...state, ownerId: "UADMIN" }, "UADMIN",
    { ...accessSettingsSnapshot(meta()), ...readAccessFieldValue("mode", { selected_option: { value: "admin" } }) })).saved;
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
    await assert.rejects(() => saveAccessSettings(client, state, state.ownerId, { ...managerForm, allowedUsers: [id] }), /current human members/);
    assert.equal((await store.getChannelMeta(entry.slug)).allowNetwork, false);
  }
  await assert.rejects(() => channelSettingsContext({ conversations: { members: async () => ({ members: [] }) } }, {
    channelId: state.channelId, userId: state.ownerId, expectedSlug: state.slug, accessSettings: true, verifyMembership: true,
  }), /no longer a member/);
  client.users.info = async ({ user }) => {
    await store.patchChannelMeta(entry.slug, { manageAccess: "admins" });
    return { user: { id: user, name: user } };
  };
  await assert.rejects(() => saveAccessSettings(client, state, state.ownerId, { ...managerForm, allowedUsers: ["UGUEST"] }), /current channel managers/);
  assert.equal((await store.getChannelMeta(entry.slug)).allowNetwork, false);
});

test("global role revoked during final membership request cannot save", async () => {
  const { client, state, entry } = await fixture();
  let checks = 0;
  client.conversations.members = async () => {
    if (++checks === 3) await store.setUser("UMANAGER", { approved: false, isAdmin: false });
    return { members: ["UMANAGER", "UGUEST"] };
  };
  await assert.rejects(() => saveAccessSettings(client, state, state.ownerId, { ...managerForm, allowedUsers: ["UGUEST"] }), /current channel managers/);
  assert.equal((await store.getChannelMeta(entry.slug)).allowNetwork, false);
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

test("Access lists only the people with a setting of their own, and a people search reaches anyone", async () => {
  const { parseSettingsMetadata, ACCESS_PEOPLE_LIMIT } = await import("../src/slack/channel-settings.js");
  const options = channelSettingsEditOptions(base, true, actor);
  const people = [
    { id: "UEXCLUDED", approved: true, excluded: true, use: false },
    { id: "UGUEST", guest: true, use: true },
  ];
  const view = (snapshot = {}, extra = {}) => buildChannelSettingsView({ access: base, mode: base, people, ...snapshot }, { ...state, ...extra }, { ...options, tab: "access" });
  const ticks = (v) => v.blocks.filter((block) => block.accessory?.type === "checkboxes").map((block) => block.block_id.slice("cg_member_".length));
  const text = (v) => JSON.stringify(v);

  // The default list is the exceptions only, labelled; no pager anywhere.
  assert.deepEqual(ticks(view()), ["UEXCLUDED", "UGUEST"]);
  assert.match(text(view()), /excluded here/);
  assert.match(text(view()), /guest here/);
  assert.doesNotMatch(text(view()), /Previous|Next ›/);
  assert.match(text(view({ people: [] })), /No one has a setting of their own here/);

  // Search is Slack's own people picker; picking someone shows just their row.
  const find = (v) => v.blocks.find((block) => block.block_id === "cg_member_find").elements;
  assert.equal(find(view())[0].type, "users_select");
  const focused = view({ focusMember: { id: "UANYONE", approved: true, use: true, inChannel: true } }, { memberFocus: "UANYONE" });
  assert.deepEqual(ticks(focused), ["UANYONE"]);
  assert.equal(find(focused)[0].initial_user, "UANYONE");
  assert.ok(find(focused).some((el) => el.text?.text === "Show list"));
  assert.equal(parseSettingsMetadata(focused.private_metadata).memberFocus, "UANYONE");
  assert.match(text(view({ focusMember: { id: "UOUT", inChannel: false } }, { memberFocus: "UOUT" })), /isn't in this channel/);
  assert.match(text(view({ focusMember: null }, { memberFocus: "ULOST" })), /Couldn't look that person up/);

  // A very long exceptions list is bounded, and says how to reach the rest.
  const many = Array.from({ length: ACCESS_PEOPLE_LIMIT + 5 }, (_, i) => ({ id: `UG${i}`, guest: true, use: true }));
  const long = view({ people: many });
  assert.equal(ticks(long).length, ACCESS_PEOPLE_LIMIT);
  assert.match(text(long), /5 more — search for a person/);
  assert.ok(long.blocks.length <= 100);
});


test("the Access people list comes from the channel record and the user store, with no Slack call", async () => {
  const { accessPeople } = await import("../src/slack/app.js");
  await store.setUser("UPEOPLE_ADMIN", { approved: true, isAdmin: true, name: "Admin" });
  await store.setUser("UPEOPLE_MEMBER", { approved: true, name: "Member" });
  const meta = { ...base, manageAccess: "custom", allowedUsers: ["UPEOPLE_GUEST"], excludedUsers: ["UPEOPLE_MEMBER", "UPEOPLE_ADMIN"], managers: ["UPEOPLE_MEMBER"] };
  const { people, focus } = await accessPeople(meta, "CPEOPLE", "UPEOPLE_SEARCHED");
  const byId = Object.fromEntries(people.map((person) => [person.id, person]));
  assert.deepEqual(Object.keys(byId).sort(), ["UPEOPLE_ADMIN", "UPEOPLE_GUEST", "UPEOPLE_MEMBER"]);
  assert.equal(byId.UPEOPLE_MEMBER.excluded, true);
  assert.equal(byId.UPEOPLE_MEMBER.use, false);
  assert.equal(byId.UPEOPLE_MEMBER.manage, true);
  assert.equal(byId.UPEOPLE_GUEST.guest, true);
  assert.equal(byId.UPEOPLE_GUEST.use, true);
  assert.equal(byId.UPEOPLE_ADMIN.excluded, false, "an admin is never shown as excluded");
  assert.equal(byId.UPEOPLE_ADMIN.use, true);
  assert.equal(focus.id, "UPEOPLE_SEARCHED");
  assert.equal(focus.inChannel, null, "membership unknown without a Slack client — saving still validates it");
  assert.deepEqual(await accessPeople({ isDM: true }, "D1"), { people: [], focus: null });
});

// ── Narrowing the use policy evicts the seeded members (security audit batch 4) ─────────────────
test("switching a channel to Admins only or Locked drops the seeded approved members and keeps explicit guests", async () => {
  const { restrictedAccessAllowedUsers } = await import("../src/slack/access-settings.js");
  const { isAuthorized } = await import("../src/gateway/modes.js");
  const users = { UADMIN: { approved: true, isAdmin: true }, UMEMBER: { approved: true }, UMEMBER2: { approved: true }, UGUEST: { approved: false } };
  const seeded = { ...base, access: "approved", allowedUsers: ["UMEMBER", "UMEMBER2", "UGUEST", "UADMIN"] };
  for (const access of ["admins", "none"]) {
    const narrowed = restrictedAccessAllowedUsers(seeded, { access, allowedUsers: seeded.allowedUsers }, users);
    assert.deepEqual(narrowed, { allowedUsers: ["UGUEST", "UADMIN"], dropped: 2 }, access);
    const after = { ...seeded, access, allowedUsers: narrowed.allowedUsers };
    assert.equal(isAuthorized(after, "UMEMBER", false, { isApprovedUser: true }), false, `${access}: a seeded member is out`);
    assert.equal(isAuthorized(after, "UGUEST", false, {}), true, `${access}: the explicit guest stays in`);
    assert.equal(isAuthorized(after, "UADMIN", false, { isAdminUser: true }), true, `${access}: an admin on the list is not locked out by the switch`);
  }
  // Not a narrowing: nothing is dropped, and the list is left exactly as submitted.
  assert.equal(restrictedAccessAllowedUsers(seeded, { access: "approved", allowedUsers: seeded.allowedUsers }, users), null);
  assert.equal(restrictedAccessAllowedUsers({ ...seeded, access: "admins", allowedUsers: ["UGUEST"] }, { access: "none", allowedUsers: ["UGUEST"] }, users), null);
  assert.equal(restrictedAccessAllowedUsers({ ...seeded, access: "admins", allowedUsers: [] }, { access: "approved", allowedUsers: [] }, users), null, "widening resurrects nobody by itself");
  assert.equal(restrictedAccessAllowedUsers(seeded, { access: "admins", allowedUsers: ["UGUEST"] }, users), null, "a list with no seed drops nothing");
});

test("the Slack Access control evicts seeded members on save, audits the count, and the people rows show them unticked", async () => {
  const { memberCanUse } = await import("../src/slack/access-settings.js");
  const { client, state, entry } = await fixture();
  await store.setUser("UMEMBER2", { approved: true, isAdmin: false });
  await store.setUser("UGUEST", { approved: false, isAdmin: false });
  client.conversations.members = async () => ({ members: ["UMANAGER", "UMEMBER2", "UGUEST", "UADMIN", "UBOT"] });
  await store.patchChannelMeta(entry.slug, { allowedUsers: ["UMANAGER", "UMEMBER2", "UGUEST"] });
  const adminState = { ...state, ownerId: "UADMIN" };
  const save = (field, action) => saveAccessSettings(client, adminState, "UADMIN",
    { ...accessSettingsSnapshot(current), ...readAccessFieldValue(field, action) });
  let current = await store.getChannelMeta(entry.slug);
  const result = await save("access", { selected_option: { value: "admins" } });
  assert.equal(result.saved.access, "admins");
  assert.deepEqual(result.saved.allowedUsers, ["UGUEST"], "approved members were the seed; the guest is a deliberate grant");
  assert.equal(result.dropped, 2);
  const row = getDb().prepare("SELECT * FROM events WHERE event = 'channel_access_members_evicted' ORDER BY rowid DESC LIMIT 1").get();
  assert.ok(row);
  assert.match(String(row.data), /"count":2/);
  assert.equal(memberCanUse(result.saved, "UMEMBER2", { isApprovedUser: true }), false);
  assert.equal(memberCanUse(result.saved, "UGUEST", {}), true);
  // Widening back to "approved" does not re-admit anyone by itself (the seed happens on the next message).
  current = result.saved;
  const widened = await save("access", { selected_option: { value: "approved" } });
  assert.deepEqual(widened.saved.allowedUsers, ["UGUEST"]);
  assert.equal(widened.dropped, 0);
  // Admins-only → Locked moves nothing more: no approved user is left on the list.
  current = widened.saved;
  await store.patchChannelMeta(entry.slug, { access: "admins" });
  current = await store.getChannelMeta(entry.slug);
  const locked = await save("access", { selected_option: { value: "none" } });
  assert.deepEqual(locked.saved.allowedUsers, ["UGUEST"]);
  assert.equal(locked.dropped, 0);
});
