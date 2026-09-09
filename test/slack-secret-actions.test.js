import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const store = await import("../src/config/store.js");
const { listChannelEnv, patchChannelEnv, resolveChannelEnv } = await import("../src/config/channel-env.js");
const { handleSecretsAction, handleSecretFormSubmission } = await import("../src/slack/app.js");
const { buildChannelSettingsView } = await import("../src/slack/channel-settings.js");
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

test("Settings removal persists only the selected deletion and refreshes the same Secrets tab", async () => {
  const f = await fixture("REMOVE");
  const meta = await store.getChannelMeta(f.entry.slug);
  const view = buildChannelSettingsView({ secrets: listChannelEnv(meta) }, f.state, { tab: "secrets", canEditSecrets: true });
  const action = view.blocks.find((b) => b.accessory?.value.includes("REMOVE_ME")).accessory;
  assert.equal(action.confirm.confirm.text, "Remove");
  assert.equal(action.confirm.deny.text, "Keep");
  await handleSecretsAction({ ...f, action, body: { user: { id: ownerId }, view: { ...view, id: "V_SETTINGS", hash: "hash-1" } } });
  assert.deepEqual(f.acknowledgements, [undefined]);
  assert.equal(f.pushes.length, 0);
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0].view_id, "V_SETTINGS");
  assert.equal(f.updates[0].hash, "hash-1");
  assert.equal(f.updates[0].view.callback_id, "cg_channel_settings_modal");
  assert.equal(JSON.parse(f.updates[0].view.private_metadata).p, "secrets");
  assert.ok(!f.updates[0].view.blocks.some((b) => b.accessory?.value.includes("REMOVE_ME")));
  const saved = await store.getChannelMeta(f.entry.slug);
  assert.deepEqual(Object.keys(saved.env), ["KEEP_ME"]);
  assert.equal(saved.model, "preserve-model");
  const resolved = await resolveChannelEnv(saved);
  assert.equal(Object.hasOwn(resolved, "REMOVE_ME"), false);
  assert.equal(resolved.KEEP_ME, "dummy-keep-value-2222");
  assert.doesNotMatch(JSON.stringify(f.updates), /dummy-(?:remove|keep)-value/);
  assert.doesNotMatch(JSON.stringify(buildSecretsView(listChannelEnv(saved), f.state)), /REMOVE_ME/);
});

test("Settings add opens only the entry form and repeated saves pop back to its existing parent", async () => {
  const f = await fixture("SAVE");
  let parent = buildChannelSettingsView({}, f.state, { tab: "secrets", canEditSecrets: true });
  for (let i = 0; i < 4; i++) {
    const action = parent.blocks.flatMap((b) => b.elements || []).find((b) => b.action_id === "cg_channel_secrets_add");
    await handleSecretsAction({ ...f, action, body: { trigger_id: `trigger-${i}`, user: { id: ownerId }, view: { ...parent, id: "V_SETTINGS" } } });
    const form = f.pushes.at(-1).view;
    assert.equal(form.callback_id, "cg_channel_secrets_form");
    assert.equal(JSON.parse(form.private_metadata).r, "settings");
    assert.equal(form.close.text, "Cancel");
    const value = `dummy-updated-value-${i}333`;
    await handleSecretFormSubmission({ ...f, body: { user: { id: ownerId } }, view: {
      ...form, id: `V_FORM_${i}`, previous_view_id: "V_SETTINGS",
      state: { values: {
        secret_name: { cg_channel_secrets_name_value: { value: "keep_me" } },
        secret_value: { cg_channel_secrets_value_value: { value } },
      } },
    } });
    assert.equal(f.acknowledgements.at(-1), undefined, "empty ack pops form instead of retaining another list");
    assert.equal(f.updates.at(-1).view_id, "V_SETTINGS");
    parent = f.updates.at(-1).view;
    assert.equal(parent.callback_id, "cg_channel_settings_modal");
    assert.equal(JSON.parse(parent.private_metadata).p, "secrets");
    assert.equal((await store.getChannelMeta(f.entry.slug)).env.KEEP_ME.value, value);
    assert.doesNotMatch(JSON.stringify(parent), /dummy-updated-value/);
  }
  assert.equal(f.pushes.length, 4);
  assert.equal(f.updates.length, 4);
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
  const action = parent.blocks.find((b) => b.accessory?.value.includes("NEW_ONE")).accessory;
  await handleSecretsAction({ ...f, action, body: { user: { id: ownerId }, view: { ...parent, id: "V_SECRETS" } } });
  assert.equal(f.updates.at(-1).view.callback_id, "cg_channel_secrets_modal");
  assert.equal(Object.hasOwn((await store.getChannelMeta(f.entry.slug)).env, "NEW_ONE"), false);
});

test("wrong owner, revoked access, and mismatched channel slug cannot remove a secret", async () => {
  const f = await fixture("DENIED");
  const original = await store.getChannelMeta(f.entry.slug);
  const view = buildSecretsView(listChannelEnv(original), f.state, { mayEdit: true });
  const action = view.blocks.find((b) => b.accessory?.value.includes("REMOVE_ME")).accessory;
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

test("all 32 supported secrets have inline removal controls, with no extra manager page", () => {
  const secrets = Array.from({ length: 32 }, (_, i) => ({ name: `VAR_${i}`, last4: "1234" }));
  const view = buildChannelSettingsView({ secrets }, {}, { tab: "secrets", canEditSecrets: true });
  assert.equal(view.blocks.filter((b) => b.accessory?.text.text === "Remove").length, 32);
  assert.ok(view.blocks.length < 100);
  assert.doesNotMatch(JSON.stringify(view), /secrets_manage/);
});
