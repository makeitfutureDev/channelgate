import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const store = await import("../src/config/store.js");
const { listChannelEnv, patchChannelEnv, resolveChannelEnv } = await import("../src/config/channel-env.js");
const { handleSecretsAction, handleSecretFormSubmission, applyVariableMenu, applySettingsConfirm, handleSettingsFormSubmission } = await import("../src/slack/app.js");
const { buildChannelSettingsView, settingsFieldBlockId } = await import("../src/slack/channel-settings.js");
const { buildSecretsView, buildSecretFormView, secretsMetadata } = await import("../src/slack/secret-explorer.js");

const ownerId = "U_SECRET_TEST";
async function fixture(suffix) {
  const channelId = `C_SECRET_${suffix}`;
  const entry = await store.upsertChannelEntry(channelId, { name: `secret-${suffix}`, type: "channel", isDM: false });
  await store.setUser(ownerId, { approved: true });
  let env = patchChannelEnv({}, { set: { name: "REMOVE_ME", value: "dummy-remove-value-1111" } });
  env = patchChannelEnv(env, { set: { name: "KEEP_ME", value: "dummy-keep-value-2222" } });
  await store.saveChannelMeta(entry.slug, { ...store.defaultChannelMeta({ channelId, name: entry.name }), env, model: "preserve-model" });
  const state = { channelId, slug: entry.slug, ownerId, threadTs: "1.1" };
  const updates = [];
  const pushes = [];
  const acknowledgements = [];
  const client = {
    conversations: { members: async () => ({ members: [ownerId], response_metadata: {} }) },
    views: {
      update: async (args) => { updates.push(args); },
      push: async (args) => { pushes.push(args); },
    },
  };
  return { entry, state, client, updates, pushes, acknowledgements, ack: async (args) => { acknowledgements.push(args); } };
}

test("Settings → Variables removes one variable through ⋯ → Remove → confirm and keeps everything else", async () => {
  const f = await fixture("REMOVE");
  const ctx = async () => ({ entry: f.entry, meta: await store.getChannelMeta(f.entry.slug), clicker: ownerId, userIsAdmin: false, userIsApproved: true });
  const view = buildChannelSettingsView({ secrets: listChannelEnv(await store.getChannelMeta(f.entry.slug)) }, f.state, { tab: "variables", canEditSecrets: true });
  const menu = view.blocks.find((b) => b.text?.text?.includes("REMOVE_ME")).accessory;
  const remove = menu.options.find((option) => option.text.text === "Remove");
  assert.deepEqual(await applyVariableMenu(JSON.parse(remove.value), await ctx()), { confirm: "var-rm:c:REMOVE_ME" });
  assert.deepEqual(Object.keys((await store.getChannelMeta(f.entry.slug)).env).sort(), ["KEEP_ME", "REMOVE_ME"], "nothing is removed before the confirmation");
  const confirming = buildChannelSettingsView({ secrets: listChannelEnv(await store.getChannelMeta(f.entry.slug)) }, { ...f.state, confirm: "var-rm:c:REMOVE_ME" }, { tab: "variables", canEditSecrets: true });
  assert.match(JSON.stringify(confirming), /Remove \*REMOVE_ME\*\?/);
  await applySettingsConfirm("var-rm:c:REMOVE_ME", await ctx());
  const saved = await store.getChannelMeta(f.entry.slug);
  assert.deepEqual(Object.keys(saved.env), ["KEEP_ME"]);
  assert.equal(saved.model, "preserve-model");
  const resolved = await resolveChannelEnv(saved);
  assert.equal(Object.hasOwn(resolved, "REMOVE_ME"), false);
  assert.equal(resolved.KEEP_ME, "dummy-keep-value-2222");
  assert.doesNotMatch(JSON.stringify(buildChannelSettingsView({ secrets: listChannelEnv(saved) }, f.state, { tab: "variables", canEditSecrets: true })), /dummy-(?:remove|keep)-value|REMOVE_ME/);
});

test("Settings → Variables replaces a value in place, repeatedly, on the same view", async () => {
  const f = await fixture("SAVE");
  const context = async () => ({ entry: f.entry, meta: await store.getChannelMeta(f.entry.slug), userIsAdmin: false, userIsApproved: true });
  const rootView = async (_entry, meta, state, _admin, { notice }) => ({ ...buildChannelSettingsView({ secrets: listChannelEnv(meta) }, state, { tab: "variables", canEditSecrets: true }), notice });
  for (let i = 0; i < 4; i++) {
    const form = buildChannelSettingsView({ secrets: listChannelEnv(await store.getChannelMeta(f.entry.slug)) }, { ...f.state, tab: "variables", form: "var-val:c:KEEP_ME" }, { tab: "variables", canEditSecrets: true });
    assert.equal(form.submit.text, "Save");
    const value = `dummy-updated-value-${i}333`;
    await handleSettingsFormSubmission({ ...f, body: { user: { id: ownerId } }, view: { ...form, id: "V_SETTINGS", state: { values: { [settingsFieldBlockId("var-val:c:KEEP_ME", "value")]: { v: { value } } } } } }, { context, rootView });
    const ack = f.acknowledgements.at(-1);
    assert.equal(ack.response_action, "update", "the same modal is updated; nothing is pushed");
    assert.equal(ack.view.notice, "⏳ Saving…");
    const done = f.updates.at(-1);
    assert.equal(done.view_id, "V_SETTINGS");
    assert.equal(done.view.callback_id, "cg_channel_settings_modal");
    assert.equal(JSON.parse(done.view.private_metadata).f, undefined, "the form closed");
    assert.equal((await store.getChannelMeta(f.entry.slug)).env.KEEP_ME.value, value);
    assert.doesNotMatch(JSON.stringify([ack.view, done.view]), /dummy-updated-value/);
  }
  assert.equal(f.pushes.length, 0);
});

test("standalone secrets form refreshes its own manager and removal keeps that surface", async () => {
  const f = await fixture("STANDALONE");
  const form = buildSecretFormView(f.state);
  await handleSecretFormSubmission({ ...f, body: { user: { id: ownerId } }, view: {
    ...form, id: "V_FORM", previous_view_id: "V_SECRETS", state: { values: {
      secret_name: { cg_channel_secrets_name_value: { value: "NEW_ONE" } },
      secret_value: { cg_channel_secrets_value_value: { value: "dummy-new-one-3333" } },
    } },
  } });
  const parent = f.updates.at(-1).view;
  assert.equal(parent.callback_id, "cg_channel_secrets_modal");
  assert.equal(f.updates.at(-1).view_id, "V_SECRETS");
  const action = parent.blocks.find((b) => b.accessory?.value?.includes("NEW_ONE")).accessory;
  await handleSecretsAction({ ...f, action, body: { user: { id: ownerId }, view: { ...parent, id: "V_SECRETS" } } });
  assert.equal(f.updates.at(-1).view.callback_id, "cg_channel_secrets_modal");
  assert.equal(Object.hasOwn((await store.getChannelMeta(f.entry.slug)).env, "NEW_ONE"), false);
});

test("wrong owner, revoked access, and mismatched channel slug cannot remove a secret", async () => {
  const f = await fixture("DENIED");
  const original = await store.getChannelMeta(f.entry.slug);
  const view = buildSecretsView(listChannelEnv(original), f.state, { mayEdit: true });
  const action = view.blocks.find((b) => b.accessory?.value?.includes("REMOVE_ME")).accessory;
  for (const variant of ["owner", "access", "slug"]) {
    await store.setUser(ownerId, { approved: variant !== "access" });
    await handleSecretsAction({ ...f, action, body: {
      user: { id: variant === "owner" ? "U_OTHER" : ownerId },
      view: { ...view, id: "V_SECRETS", private_metadata: secretsMetadata({ ...f.state, ...(variant === "slug" ? { slug: "wrong-slug" } : {}) }) },
    } });
    assert.equal(f.updates.at(-1).view.callback_id, "cg_channel_secrets_error");
    assert.deepEqual((await store.getChannelMeta(f.entry.slug)).env, original.env);
  }
});

test("all 32 supported variables have a ⋯ menu on the page, with no extra manager page", () => {
  const secrets = Array.from({ length: 32 }, (_, i) => ({ name: `VAR_${i}`, last4: "1234", protected: true, hosts: ["api.example.com"] }));
  const view = buildChannelSettingsView({ secrets }, {}, { tab: "variables", canEditSecrets: true });
  assert.equal(view.blocks.filter((b) => b.accessory?.type === "overflow").length, 32);
  assert.ok(view.blocks.length < 100);
  assert.doesNotMatch(JSON.stringify(view), /secrets_manage/);
});

// ── The other two scopes in the same Slack surface (config/scoped-env.js) ────────────────────
// The modal lists all three, but they do NOT share an authority: the organization's reaches every
// conversation and is admin-only, a person's own is always theirs, and the channel's keeps the
// rule it already had.
const { listOrgEnv, listUserEnv, patchOrgEnv, patchUserEnv } = await import("../src/config/scoped-env.js");
const { secretScopeLists } = await import("../src/slack/app.js");

const scopeView = async (f, { canEditOrg = false } = {}) => buildSecretsView(
  await secretScopeLists(await store.getChannelMeta(f.entry.slug), ownerId),
  f.state,
  { channelName: f.entry.name, mayEdit: true, canEditOrg },
);
const rowFor = (view, name) => view.blocks.find((b) => b.accessory?.value?.includes(`"n":"${name}"`))?.accessory;

test("the Slack modal lists all three scopes, and only the viewer's own personal ones", async () => {
  const f = await fixture("SCOPES");
  patchOrgEnv({ set: { name: "ORG_WIDE", value: "org-wide-value-3333" }, actor: "admin UI" });
  await patchUserEnv(ownerId, { set: { name: "MY_OWN", value: "my-own-value-4444" } });
  await store.setUser("U_SECRET_OTHER", { approved: true });
  await patchUserEnv("U_SECRET_OTHER", { set: { name: "SOMEONE_ELSES", value: "not-yours-value-5555" } });

  const view = await scopeView(f);
  const rendered = JSON.stringify(view);
  assert.match(rendered, /ORG_WIDE/);
  assert.match(rendered, /MY_OWN/);
  assert.match(rendered, /KEEP_ME/);
  assert.doesNotMatch(rendered, /SOMEONE_ELSES/, "another person's secrets have no path into this view");
  // Never a value, from any scope.
  assert.doesNotMatch(rendered, /org-wide-value|my-own-value|dummy-keep-value|not-yours-value/);
  // Each scope's rows get their own id space, so three lists can each have an index 0. The
  // organization row only carries a Remove button for someone who may actually remove it.
  assert.doesNotMatch(rendered, /cg_channel_secrets_remove_o0/);
  assert.match(rendered, /cg_channel_secrets_remove_p0/);
  assert.match(rendered, /cg_channel_secrets_remove_c0/);
  assert.match(JSON.stringify(await scopeView(f, { canEditOrg: true })), /cg_channel_secrets_remove_o0/);
});

test("a non-admin can change their own and the channel's secrets, but never the organization's", async () => {
  const f = await fixture("AUTHZ");
  patchOrgEnv({ set: { name: "ORG_WIDE", value: "org-wide-value-3333" }, actor: "admin UI" });
  await store.setUser(ownerId, { approved: true, isAdmin: false });

  // The Add button for the organization is simply absent for a non-admin...
  const view = await scopeView(f, { canEditOrg: false });
  const ids = JSON.stringify(view);
  assert.doesNotMatch(ids, /cg_channel_secrets_add_organization/);
  assert.match(ids, /cg_channel_secrets_add_personal/);

  // ...and the handler refuses even a forged click on an organization row, because authority is
  // re-derived from the action_id rather than trusted from the clicked value.
  const adminView = await scopeView(f, { canEditOrg: true });
  const orgRow = rowFor(adminView, "ORG_WIDE");
  assert.ok(orgRow, "the admin view offers the organization row");
  await handleSecretsAction({
    ...f,
    action: orgRow,
    body: { user: { id: ownerId }, view: { ...adminView, id: "V_AUTHZ", hash: "h" } },
  });
  assert.match(JSON.stringify(f.updates.at(-1).view.blocks), /Only organization admins/);
  assert.ok(listOrgEnv().some((v) => v.name === "ORG_WIDE"), "the organization secret survived the refused click");
});

test("an admin's organization removal reaches every conversation; a personal one only its owner", async () => {
  const f = await fixture("REMOVE_SCOPED");
  await store.setUser(ownerId, { approved: true, isAdmin: true });
  patchOrgEnv({ set: { name: "ORG_WIDE", value: "org-wide-value-3333" }, actor: "admin UI" });
  await patchUserEnv(ownerId, { set: { name: "MY_OWN", value: "my-own-value-4444" } });

  const view = await scopeView(f, { canEditOrg: true });
  await handleSecretsAction({ ...f, action: rowFor(view, "ORG_WIDE"), body: { user: { id: ownerId }, view: { ...view, id: "V1", hash: "h" } } });
  assert.ok(!listOrgEnv().some((v) => v.name === "ORG_WIDE"));
  assert.match(JSON.stringify(f.updates.at(-1).view.blocks), /No conversation receives it any more/);

  const after = await scopeView(f, { canEditOrg: true });
  await handleSecretsAction({ ...f, action: rowFor(after, "MY_OWN"), body: { user: { id: ownerId }, view: { ...after, id: "V2", hash: "h" } } });
  assert.ok(!(await listUserEnv(ownerId)).some((v) => v.name === "MY_OWN"));
  assert.match(JSON.stringify(f.updates.at(-1).view.blocks), /Runs you author no longer receive it/);
  // The channel's own were never touched by either removal.
  assert.deepEqual(Object.keys((await store.getChannelMeta(f.entry.slug)).env).sort(), ["KEEP_ME", "REMOVE_ME"]);
});

test("the entry form says which scope it writes into, and the submission honours it", async () => {
  const f = await fixture("FORM_SCOPE");
  await store.setUser(ownerId, { approved: true, isAdmin: true });

  const orgForm = buildSecretFormView(f.state, { channelName: f.entry.name, scope: "organization" });
  assert.match(JSON.stringify(orgForm.blocks), /whole organization/);
  assert.equal(JSON.parse(orgForm.private_metadata).p, "o");
  const personalForm = buildSecretFormView(f.state, { channelName: f.entry.name, scope: "personal" });
  assert.match(JSON.stringify(personalForm.blocks), /runs \*you\* author/);
  assert.equal(JSON.parse(personalForm.private_metadata).p, "p");
  // The channel scope is the default and carries no marker, so a form from an older build still
  // means what it meant then.
  assert.equal(JSON.parse(buildSecretFormView(f.state, {}).private_metadata).p, undefined);

  const submit = async (view, name, value) => handleSecretFormSubmission({
    ...f,
    body: { user: { id: ownerId } },
    view: {
      ...view,
      id: "V_FORM",
      state: { values: { secret_name: { cg_channel_secrets_name_value: { value: name } }, secret_value: { cg_channel_secrets_value_value: { value } } } },
    },
  });

  await submit(orgForm, "from_form_org", "org-form-value-6666");
  assert.ok(listOrgEnv().some((v) => v.name === "FROM_FORM_ORG"), "case is folded and the org scope received it");
  await submit(personalForm, "FROM_FORM_ME", "personal-form-value-77");
  assert.ok((await listUserEnv(ownerId)).some((v) => v.name === "FROM_FORM_ME"));
  // Neither write leaked into the channel's own env.
  assert.deepEqual(Object.keys((await store.getChannelMeta(f.entry.slug)).env).sort(), ["KEEP_ME", "REMOVE_ME"]);
  assert.doesNotMatch(JSON.stringify(f.updates), /org-form-value|personal-form-value/);
});
