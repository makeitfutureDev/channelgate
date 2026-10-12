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
const { applyCustomMcpAction, channelSettingsEditOptions, customMcpErrorBlock, handleCustomMcpFormSubmission } = await import("../src/slack/app.js");
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

function submission(view, values, clicker = "U_OWNER") {
  return { body: { user: { id: clicker } }, view: { private_metadata: view.private_metadata, state: { values } } };
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
  assert.match(acks[0].view.notice, /my-notes/);
  assert.equal((await store.getUser("U_OWNER")).customMcps[0].token, "slack-user-token-4242");
  assert.ok(!JSON.stringify(acks).includes("slack-user-token"), "the reply never echoes the token");
});

test("the form refuses internal URLs, a missing token, and a non-manager's conversation write", async () => {
  const userView = buildCustomMcpEditorView(state, { scope: "user" });
  let acks = [];
  await handleCustomMcpFormSubmission({ ack: async (a) => acks.push(a), ...submission(userView, formValues({ name: "evil", url: "https://127.0.0.1:4747/api", token: "abcdefgh1234" })) }, { context: ctxFor(), rootView });
  assert.equal(acks[0].response_action, "errors");
  assert.match(acks[0].errors[CUSTOM_MCP_URL_BLOCK_ID], /refused/);

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
