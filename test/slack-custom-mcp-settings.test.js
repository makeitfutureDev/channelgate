// Custom MCP servers on the Slack Settings → MCPs page (src/slack/channel-settings.js + app.js):
// the conversation's servers (`custom-<name>`, managers and admins) and the viewer's own
// (`my-<name>`), masked rows, the pushed add/update form, and the handlers' authority and refusals.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const {
  buildChannelSettingsView,
  buildCustomMcpEditorView,
  readCustomMcpForm,
  parseEditorMetadata,
  CHANNEL_SETTINGS_CUSTOM_MCP_ADD_ACTION_ID,
  CHANNEL_SETTINGS_CUSTOM_MCP_REMOVE_ACTION_ID,
  CHANNEL_SETTINGS_CUSTOM_MCP_CALLBACK_ID,
  CUSTOM_MCP_NAME_BLOCK_ID,
  CUSTOM_MCP_URL_BLOCK_ID,
  CUSTOM_MCP_TOKEN_BLOCK_ID,
  settingsCommand,
} = await import("../src/slack/channel-settings.js");
const { applyCustomMcpAction, channelSettingsEditOptions, customMcpErrorBlock, handleCustomMcpFormSubmission, handleCustomMcpSettingsAction } = await import("../src/slack/app.js");
const store = await import("../src/config/store.js");

const state = { channelId: "C_SLACK_CMCP", slug: "slack-cmcp", threadTs: "", ownerId: "U_OWNER" };
const PUBLIC_URL = "https://93.184.215.14/mcp"; // a literal public address: no DNS needed offline
const entry = await store.upsertChannelEntry(state.channelId, { name: "slack-cmcp", type: "channel", isDM: false });
state.slug = entry.slug;
await store.saveChannelMeta(entry.slug, store.defaultChannelMeta({ channelId: state.channelId, name: "slack-cmcp", type: "channel", isDM: false }));
await store.setUser("U_OWNER", { name: "Owner", approved: true });

const masked = {
  channel: [{ name: "linear", serverName: "custom-linear", url: "https://mcp.linear.app/mcp", hasToken: true, tokenLast4: "ABCD" }],
  personal: [{ name: "notes", serverName: "my-notes", url: "https://notes.example.com/mcp", hasToken: true, tokenLast4: "WXYZ" }],
};
const flat = (view) => JSON.stringify(view);
const buttons = (view, actionId) => view.blocks.flatMap((block) => [...(block.elements || []), ...(block.accessory ? [block.accessory] : [])])
  .filter((element) => element?.action_id === actionId);

test("the MCPs page lists both scopes masked, with conversation controls only for a manager", () => {
  const manager = buildChannelSettingsView({ customMcps: masked }, { ...state, tab: "mcp" }, { tab: "mcp", canManageCustomMcp: true });
  assert.match(flat(manager), /Custom MCP servers/);
  assert.match(flat(manager), /custom-linear/);
  assert.match(flat(manager), /my-notes/);
  assert.match(flat(manager), /••••ABCD/);
  const managerAdds = buttons(manager, CHANNEL_SETTINGS_CUSTOM_MCP_ADD_ACTION_ID).map((b) => settingsCommand(b).s);
  assert.deepEqual(managerAdds, ["c", "p"]);
  const removes = buttons(manager, CHANNEL_SETTINGS_CUSTOM_MCP_REMOVE_ACTION_ID).map((b) => settingsCommand(b));
  assert.deepEqual(removes.map((c) => [c.s, c.n]), [["c", "linear"], ["p", "notes"]]);
  assert.ok(removes.length && buttons(manager, CHANNEL_SETTINGS_CUSTOM_MCP_REMOVE_ACTION_ID).every((b) => b.confirm), "removal asks first");

  const member = buildChannelSettingsView({ customMcps: masked }, { ...state, tab: "mcp" }, { tab: "mcp", canManageCustomMcp: false });
  assert.deepEqual(buttons(member, CHANNEL_SETTINGS_CUSTOM_MCP_ADD_ACTION_ID).map((b) => settingsCommand(b).s), ["p"], "a member edits only their own");
  assert.deepEqual(buttons(member, CHANNEL_SETTINGS_CUSTOM_MCP_REMOVE_ACTION_ID).map((b) => settingsCommand(b).s), ["p"]);
  assert.match(flat(member), /Only this channel's managers and admins/);

  const empty = buildChannelSettingsView({}, { ...state, tab: "mcp" }, { tab: "mcp" });
  assert.match(flat(empty), /_none_/);
});

test("the form is never prefilled, names the scope, and parses only what was typed", () => {
  const view = buildCustomMcpEditorView(state, { scope: "channel", channelName: "slack-cmcp", existing: masked.channel });
  assert.equal(view.callback_id, CHANNEL_SETTINGS_CUSTOM_MCP_CALLBACK_ID);
  assert.equal(parseEditorMetadata(view.private_metadata).view, "custom_mcp_c");
  assert.equal(parseEditorMetadata(buildCustomMcpEditorView(state, { scope: "user" }).private_metadata).view, "custom_mcp_p");
  assert.deepEqual(view.blocks.filter((b) => b.type === "input").map((b) => [b.block_id, Boolean(b.optional)]), [
    [CUSTOM_MCP_NAME_BLOCK_ID, false], [CUSTOM_MCP_URL_BLOCK_ID, false], [CUSTOM_MCP_TOKEN_BLOCK_ID, true],
  ]);
  assert.ok(view.blocks.every((b) => !b.element?.initial_value), "nothing is prefilled");
  assert.match(flat(view), /linear/, "the hint names the existing servers so one can be updated");
  const values = {
    [CUSTOM_MCP_NAME_BLOCK_ID]: { value: { value: " Linear " } },
    [CUSTOM_MCP_URL_BLOCK_ID]: { value: { value: " https://x.example.com/mcp " } },
    [CUSTOM_MCP_TOKEN_BLOCK_ID]: { value: { value: null } },
  };
  assert.deepEqual(readCustomMcpForm({ state: { values } }), { name: "Linear", url: "https://x.example.com/mcp", token: "" });
});

test("refusals land under the field they are about", () => {
  assert.equal(customMcpErrorBlock("URL refused: refuses to reach a loopback address"), CUSTOM_MCP_URL_BLOCK_ID);
  assert.equal(customMcpErrorBlock("URL must use https://"), CUSTOM_MCP_URL_BLOCK_ID);
  assert.equal(customMcpErrorBlock("A Bearer token is required for a new custom MCP"), CUSTOM_MCP_TOKEN_BLOCK_ID);
  assert.equal(customMcpErrorBlock("Token must be at least 8 characters"), CUSTOM_MCP_TOKEN_BLOCK_ID);
  assert.equal(customMcpErrorBlock("Name must be 1-32 characters"), CUSTOM_MCP_NAME_BLOCK_ID);
  assert.equal(customMcpErrorBlock("At most 5 custom MCP servers here — remove one first"), CUSTOM_MCP_NAME_BLOCK_ID);
});

test("conversation servers follow the channel's manage policy; admins always qualify", () => {
  const meta = { manageAccess: "admins" };
  assert.equal(channelSettingsEditOptions(meta, true, { authorId: "U1" }).canManageCustomMcp, true);
  assert.equal(channelSettingsEditOptions(meta, false, { authorId: "U1", isApprovedUser: true }).canManageCustomMcp, false);
  assert.equal(channelSettingsEditOptions({ manageAccess: "members" }, false, { authorId: "U1", isApprovedUser: true }).canManageCustomMcp, true);
});

function submission(view, values, clicker = "U_OWNER", updates = []) {
  return { client: { views: { update: async (payload) => updates.push(payload) } }, body: { user: { id: clicker } }, view: { private_metadata: view.private_metadata, state: { values } } };
}
const formValues = ({ name, url, token = "" }) => ({
  [CUSTOM_MCP_NAME_BLOCK_ID]: { value: { value: name } },
  [CUSTOM_MCP_URL_BLOCK_ID]: { value: { value: url } },
  [CUSTOM_MCP_TOKEN_BLOCK_ID]: { value: { value: token } },
});
const ctxFor = (overrides = {}) => async () => ({ entry, meta: (await store.getChannelMeta(entry.slug)) || {}, userIsAdmin: false, userIsApproved: true, ...overrides });
const rootView = async (_entry, _meta, _state, _admin, { notice }) => ({ type: "modal", notice });

test("the form saves the viewer's own server, writes it to THEIR record, and returns to the page", async () => {
  const acks = [];
  const view = buildCustomMcpEditorView(state, { scope: "user" });
  await handleCustomMcpFormSubmission({ ack: async (a) => acks.push(a), ...submission(view, formValues({ name: "Notes", url: PUBLIC_URL, token: "slack-user-token-4242" })) }, { context: ctxFor(), rootView });
  assert.equal(acks[0].response_action, "update");
  assert.match(JSON.stringify(acks[0].view), /Checking access/);
  assert.equal((await store.getUser("U_OWNER")).customMcps[0].token, "slack-user-token-4242");
  assert.ok(!JSON.stringify(acks).includes("slack-user-token"), "the reply never echoes the token");
});

test("the form refuses internal URLs, a missing token, and a non-manager's conversation write", async () => {
  const userView = buildCustomMcpEditorView(state, { scope: "user" });
  let acks = [];
  const updates = [];
  await handleCustomMcpFormSubmission({ ack: async (a) => acks.push(a), ...submission(userView, formValues({ name: "evil", url: "https://127.0.0.1:4747/api", token: "abcdefgh1234" }), "U_OWNER", updates) }, { context: ctxFor(), rootView });
  assert.equal(acks[0].response_action, "update", "acknowledge before asynchronous address validation");
  assert.match(JSON.stringify(updates.at(-1).view), /URL refused/);

  acks = [];
  await handleCustomMcpFormSubmission({ ack: async (a) => acks.push(a), ...submission(userView, formValues({ name: "fresh", url: PUBLIC_URL })) }, { context: ctxFor(), rootView });
  assert.match(acks[0].errors[CUSTOM_MCP_TOKEN_BLOCK_ID], /token is required/);

  const channelView = buildCustomMcpEditorView(state, { scope: "channel" });
  acks = [];
  await handleCustomMcpFormSubmission({ ack: async (a) => acks.push(a), ...submission(channelView, formValues({ name: "linear", url: PUBLIC_URL, token: "chan-token-9999" })) }, { context: ctxFor({ meta: { manageAccess: "admins" } }), rootView });
  assert.equal(acks[0].response_action, "errors");
  assert.match(acks[0].errors[CUSTOM_MCP_NAME_BLOCK_ID], /managers or an admin/);
  assert.equal((await store.getChannelMeta(entry.slug)).customMcps, undefined, "nothing was written");

  acks = [];
  await handleCustomMcpFormSubmission({ ack: async (a) => acks.push(a), ...submission(channelView, formValues({ name: "linear", url: PUBLIC_URL, token: "chan-token-9999" }), "U_SOMEONE_ELSE") }, { context: ctxFor({ userIsAdmin: true }), rootView });
  assert.match(acks[0].errors[CUSTOM_MCP_NAME_BLOCK_ID], /expired/, "a form owned by someone else is refused");
});

test("an admin saves a conversation server; Remove takes it out again; members cannot touch it", async () => {
  const acks = [];
  const channelView = buildCustomMcpEditorView(state, { scope: "channel" });
  await handleCustomMcpFormSubmission({ ack: async (a) => acks.push(a), ...submission(channelView, formValues({ name: "linear", url: PUBLIC_URL, token: "chan-token-9999" })) }, { context: ctxFor({ userIsAdmin: true }), rootView });
  assert.equal(acks[0].response_action, "update");
  const meta = await store.getChannelMeta(entry.slug);
  assert.equal(meta.customMcps[0].setBy, "<@U_OWNER>");

  const added = await applyCustomMcpAction({ actionId: CHANNEL_SETTINGS_CUSTOM_MCP_ADD_ACTION_ID, command: { s: "c" }, entry, meta, state, clicker: "U_OWNER", userIsAdmin: true });
  assert.equal(added.view.callback_id, CHANNEL_SETTINGS_CUSTOM_MCP_CALLBACK_ID);

  await assert.rejects(
    applyCustomMcpAction({ actionId: CHANNEL_SETTINGS_CUSTOM_MCP_REMOVE_ACTION_ID, command: { s: "c", n: "linear" }, entry, meta: { ...meta, manageAccess: "admins" }, state, clicker: "U_MEMBER", userIsApproved: true }),
    /managers or an admin/,
  );
  const removed = await applyCustomMcpAction({ actionId: CHANNEL_SETTINGS_CUSTOM_MCP_REMOVE_ACTION_ID, command: { s: "c", n: "linear" }, entry, meta, state, clicker: "U_OWNER", userIsAdmin: true });
  assert.match(removed.notice, /custom-linear/);
  assert.deepEqual(removed.meta.customMcps, []);

  const mine = await applyCustomMcpAction({ actionId: CHANNEL_SETTINGS_CUSTOM_MCP_REMOVE_ACTION_ID, command: { s: "p", n: "notes" }, entry, meta, state, clicker: "U_OWNER", userIsApproved: true });
  assert.match(mine.notice, /my-notes/);
  assert.deepEqual((await store.getUser("U_OWNER")).customMcps, []);
  await assert.rejects(applyCustomMcpAction({ actionId: CHANNEL_SETTINGS_CUSTOM_MCP_ADD_ACTION_ID, command: { s: "x" }, entry, meta, state, clicker: "U_OWNER" }), /expired/);
});


test("repeated custom MCP saves pop the temporary form and reuse its Settings parent", async () => {
  const updates = [], acks = [];
  const client = { views: { update: async (payload) => updates.push(payload) } };
  const form = buildCustomMcpEditorView(state, { scope: "user" });
  for (let i = 0; i < 4; i++) {
    await handleCustomMcpFormSubmission({
      client, ack: async (payload) => acks.push(payload), body: { user: { id: state.ownerId } },
      view: { ...form, id: `V_FORM_${i}`, previous_view_id: "V_SETTINGS", state: { values: formValues({
        name: "repeat", url: `${PUBLIC_URL}/${i}`, token: i === 0 ? "repeat-token-1234" : "",
      }) } },
    }, { context: ctxFor(), rootView });
    assert.equal(acks.at(-1), undefined, "a successful save pops the form instead of retaining a Settings duplicate");
    assert.equal(updates.at(-1).view_id, "V_SETTINGS");
    assert.match(updates.at(-1).view.notice, /my-repeat/);
    const stored = (await store.getUser(state.ownerId)).customMcps.find((server) => server.name === "repeat");
    assert.equal(stored.url, `${PUBLIC_URL}/${i}`);
    assert.equal(stored.token, "repeat-token-1234", "blank-token edits preserve the original credential");
    assert.ok(!JSON.stringify(updates).includes("repeat-token"));
  }
  assert.equal(acks.length, 4);
  assert.equal(updates.length, 8);
});

test("submission checks current membership, admission, slug and manager authority before writing", async () => {
  const original = await store.getChannelMeta(entry.slug);
  const form = buildCustomMcpEditorView(state, { scope: "user" });
  const values = formValues({ name: "denied", url: PUBLIC_URL, token: "never-save-this-token" });
  for (const variant of ["membership", "admission", "slug", "manager"]) {
    await store.setUser(state.ownerId, { approved: variant !== "admission", isAdmin: false });
    await store.saveChannelMeta(entry.slug, { ...original, manageAccess: "admins" });
    const deniedForm = variant === "manager" ? buildCustomMcpEditorView(state, { scope: "channel" })
      : variant === "slug" ? buildCustomMcpEditorView({ ...state, slug: "wrong-channel" }, { scope: "user" }) : form;
    const acks = [];
    const beforeUser = await store.getUser(state.ownerId);
    const beforeChannel = await store.getChannelMeta(entry.slug);
    const updates = [];
    const client = {
      conversations: { members: async () => ({ members: variant === "membership" ? [] : [state.ownerId], response_metadata: {} }) },
      views: { update: async (payload) => updates.push(payload) },
    };
    await handleCustomMcpFormSubmission({ ...submission(deniedForm, values), client, ack: async (payload) => acks.push(payload) }, { rootView });
    if (variant === "membership") {
      assert.equal(acks[0].response_action, "update", variant);
      assert.match(JSON.stringify(updates.at(-1).view), /member/, variant);
    } else {
      assert.equal(acks[0].response_action, "errors", variant);
      assert.match(acks[0].errors[CUSTOM_MCP_NAME_BLOCK_ID], /authorized|expired|managers/, variant);
    }
    assert.deepEqual((await store.getUser(state.ownerId)).customMcps, beforeUser.customMcps, variant);
    assert.deepEqual((await store.getChannelMeta(entry.slug)).customMcps, beforeChannel.customMcps, variant);
  }
  await store.setUser(state.ownerId, { approved: true });
  await store.saveChannelMeta(entry.slug, original);
});

test("a parent refresh failure never acknowledges an already-saved submission twice", async () => {
  const acks = [], updates = [];
  const client = { views: { update: async (payload) => {
    updates.push(payload);
    if (updates.length === 2) throw new Error("temporary Slack update failure");
  } } };
  const form = buildCustomMcpEditorView(state, { scope: "user" });
  await handleCustomMcpFormSubmission({
    client, ack: async (payload) => acks.push(payload), body: { user: { id: state.ownerId } },
    view: { ...form, id: "V_FORM", previous_view_id: "V_SETTINGS", state: { values: formValues({
      name: "repeat", url: PUBLIC_URL, token: "rotated-test-token-7777",
    }) } },
  }, { context: ctxFor(), rootView });
  assert.deepEqual(acks, [undefined]);
  assert.equal(updates.length, 3);
  assert.equal(updates[2].view_id, "V_SETTINGS");
  assert.match(JSON.stringify(updates[2].view), /server was saved/);
  assert.ok(!JSON.stringify(updates).includes("rotated-test-token"));
  assert.equal((await store.getUser(state.ownerId)).customMcps.find((server) => server.name === "repeat").token, "rotated-test-token-7777");
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

for (const delayedStage of ["dns", "membership"]) {
  test(`slow ${delayedStage} is acknowledged first; revocation before completion refuses the write`, async () => {
    const original = await store.getChannelMeta(entry.slug);
    await store.saveChannelMeta(entry.slug, { ...original, manageAccess: "admins" });
    await store.setUser(state.ownerId, { approved: true, isAdmin: true });
    const entered = deferred(), release = deferred();
    const acks = [], updates = [];
    const client = {
      conversations: { members: async () => {
        if (delayedStage === "membership") { entered.resolve(); await release.promise; }
        return { members: [state.ownerId], response_metadata: {} };
      } },
      views: { update: async (payload) => updates.push(payload) },
    };
    const lookup = async () => {
      if (delayedStage === "dns") { entered.resolve(); await release.promise; }
      return [{ address: "93.184.215.14", family: 4 }];
    };
    const form = buildCustomMcpEditorView(state, { scope: "channel" });
    const pending = handleCustomMcpFormSubmission({
      ...submission(form, formValues({ name: "revoked", url: "https://fixture.example.com/mcp", token: "revoked-test-token" })),
      client, ack: async (payload) => acks.push(payload),
    }, { rootView, lookup });
    await entered.promise;
    assert.equal(acks.length, 1, "Slack receives its acknowledgement before remote work completes");
    assert.match(JSON.stringify(acks[0].view), /Checking access/);
    await store.setUser(state.ownerId, { isAdmin: false });
    release.resolve();
    await pending;
    assert.equal(acks.length, 1);
    assert.match(JSON.stringify(updates.at(-1).view), /managers or an admin/);
    assert.deepEqual((await store.getChannelMeta(entry.slug)).customMcps, original.customMcps);
    assert.ok(!JSON.stringify([...acks, ...updates]).includes("revoked-test-token"));
    await store.saveChannelMeta(entry.slug, original);
  });
}

for (const delayedStage of ["dns", "membership"]) {
  test(`a timed-out ${delayedStage} check clears the draft and cannot write when it resolves later`, async () => {
    const release = deferred(), finished = deferred();
    const acks = [], updates = [];
    const before = (await store.getUser(state.ownerId)).customMcps;
    const client = { views: { update: async (payload) => updates.push(payload) } };
    const lookup = async () => {
      if (delayedStage === "dns") await release.promise;
      return [{ address: "93.184.215.14", family: 4 }];
    };
    const context = async (_client, request) => {
      if (delayedStage === "membership" && request.verifyMembership) await release.promise;
      return ctxFor()();
    };
    const form = buildCustomMcpEditorView(state, { scope: "user" });
    await handleCustomMcpFormSubmission({
      ...submission(form, formValues({ name: "timeout", url: "https://fixture.example.com/mcp", token: "timeout-test-token" })),
      client, ack: async (payload) => acks.push(payload),
    }, { context, rootView, lookup, timeoutMs: 15 });
    assert.equal(acks.length, 1);
    const errorView = updates.at(-1).view;
    assert.match(JSON.stringify(errorView), /timed out/);
    assert.equal(buttons(errorView, CHANNEL_SETTINGS_CUSTOM_MCP_ADD_ACTION_ID).length, 1, "retry opens a fresh form");
    assert.ok(!JSON.stringify([...acks, ...updates]).includes("timeout-test-token"));
    release.resolve();
    // Drain the settled DNS/authorization continuation, including its store promise.
    setImmediate(finished.resolve);
    await finished.promise;
    assert.deepEqual((await store.getUser(state.ownerId)).customMcps, before, "no late write after timeout");
    assert.equal(acks.length, 1);
  });
}

for (const operation of ["add", "remove"]) {
  test(`native ${operation} rechecks local authority after a delayed roster; Add consumes its trigger first`, async () => {
    const original = await store.getChannelMeta(entry.slug);
    const customMcps = [{ name: "retained", url: PUBLIC_URL, token: "retained-test-token-8888" }];
    await store.saveChannelMeta(entry.slug, { ...original, manageAccess: "admins", customMcps });
    await store.setUser(state.ownerId, { approved: true, isAdmin: true });
    const parent = buildChannelSettingsView({ customMcps: { channel: [{ name: "retained", serverName: "custom-retained", url: PUBLIC_URL, tokenLast4: "8888" }] } }, state, { tab: "mcp", canManageCustomMcp: true });
    const actionId = operation === "add" ? CHANNEL_SETTINGS_CUSTOM_MCP_ADD_ACTION_ID : CHANNEL_SETTINGS_CUSTOM_MCP_REMOVE_ACTION_ID;
    const action = buttons(parent, actionId)[0];
    const entered = deferred(), release = deferred();
    const acks = [], pushes = [], updates = [];
    const client = {
      conversations: { members: async () => {
        entered.resolve(); await release.promise;
        return { members: [state.ownerId], response_metadata: {} };
      } },
      views: {
        push: async (payload) => { pushes.push(payload); return { view: { id: "V_LOADING", hash: "loading-hash" } }; },
        update: async (payload) => updates.push(payload),
      },
    };
    const pending = handleCustomMcpSettingsAction({
      client, action, ack: async (payload) => acks.push(payload),
      body: { user: { id: state.ownerId }, trigger_id: "short-lived-trigger", view: { ...parent, id: "V_SETTINGS" } },
    }, { rootView });
    await entered.promise;
    assert.deepEqual(acks, [undefined]);
    if (operation === "add") {
      assert.equal(pushes.length, 1, "consume trigger before the remote roster wait");
      assert.equal(pushes[0].trigger_id, "short-lived-trigger");
      assert.equal(pushes[0].view.blocks.some((b) => b.type === "input"), false, "no secret form until admitted");
    }
    await store.setUser(state.ownerId, { isAdmin: false });
    release.resolve();
    await pending;
    assert.match(JSON.stringify(updates.at(-1).view), /managers or an admin/);
    assert.equal(updates.at(-1).view_id, operation === "add" ? "V_LOADING" : "V_SETTINGS");
    assert.deepEqual((await store.getChannelMeta(entry.slug)).customMcps, customMcps, "revoked manager cannot remove");
    assert.ok(!JSON.stringify([...pushes, ...updates]).includes("retained-test-token"));
    await store.saveChannelMeta(entry.slug, original);
  });
}

test("native Add hydrates the pushed placeholder and refuses another person's view", async () => {
  const parent = buildChannelSettingsView({}, state, { tab: "mcp" });
  const action = buttons(parent, CHANNEL_SETTINGS_CUSTOM_MCP_ADD_ACTION_ID)[0];
  const acks = [], pushes = [], updates = [];
  const client = {
    conversations: { members: async () => ({ members: [state.ownerId], response_metadata: {} }) },
    views: {
      push: async (payload) => { pushes.push(payload); return { view: { id: "V_LOADING", hash: "loading-hash" } }; },
      update: async (payload) => updates.push(payload),
    },
  };
  const args = { client, action, ack: async (payload) => acks.push(payload), body: { user: { id: state.ownerId }, trigger_id: "trigger", view: { ...parent, id: "V_SETTINGS" } } };
  await handleCustomMcpSettingsAction(args, { rootView });
  assert.equal(updates.at(-1).view_id, "V_LOADING");
  assert.equal(updates.at(-1).hash, "loading-hash");
  assert.equal(updates.at(-1).view.callback_id, CHANNEL_SETTINGS_CUSTOM_MCP_CALLBACK_ID);
  assert.ok(updates.at(-1).view.blocks.every((b) => !b.element?.initial_value));
  await handleCustomMcpSettingsAction({ ...args, body: { ...args.body, user: { id: "U_OTHER" } } }, { rootView });
  assert.equal(pushes.length, 1, "an owner mismatch opens nothing");
  assert.match(JSON.stringify(updates.at(-1).view), /isn't yours/);
});
