import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { buildChannelSettingsView, assertVpnActionBinding, parseActionValue, settingsMetadata,
  CHANNEL_SETTINGS_VPN_TOGGLE_ACTION_ID: TOGGLE, CHANNEL_SETTINGS_VPN_REFRESH_ACTION_ID: REFRESH } = await import("../src/slack/channel-settings.js");
const { handleChannelVpnSettingsAction, channelVpnSettingsContext, hydrateChannelVpnSettings } = await import("../src/slack/app.js");
const store = await import("../src/config/store.js");
const state = { channelId: "CVPNSETTINGS", slug: "vpn-settings", ownerId: "UVPNMANAGER", tab: "network" };
const off = { configured: true, enabled: false, state: "off", message: "VPN is off.", missingSecrets: [], busy: false, allowNetwork: true };
const buttons = (view) => view.blocks.flatMap((b) => b.elements || []).filter((el) => el.type === "button");
const render = (vpn, canManageVpn = true, actorState = state) => buildChannelSettingsView({ mode: { allowNetwork: true }, vpn }, actorState, { tab: "network", canManageVpn });
const actionFor = (vpn, actorState = state) => buttons(render(vpn, true, actorState)).find((b) => b.action_id === TOGGLE);

// User-visible states must distinguish starting a service from an established VPN, including
// failures with autostart still enabled. No button may silently change the channel network policy.
test("Network shows honest state, missing credentials and scoped manager controls", () => {
  for (const [status, label] of [["off", "Off"], ["starting", "Starting — not connected yet"], ["on", "On — connected"], ["failed", "Failed — not connected"], ["unconfigured", "Not configured"], ["unavailable", "Unavailable"]]) {
    const vpn = { ...off, state: status, enabled: ["starting", "on", "failed"].includes(status), configured: status !== "unconfigured" };
    const view = render(vpn);
    assert.match(JSON.stringify(view), new RegExp(label));
    assert.ok(buttons(view).some((b) => b.action_id === REFRESH));
    assert.equal(buttons(view).some((b) => b.action_id === TOGGLE), !["unconfigured", "unavailable"].includes(status));
    if (status === "starting") assert.equal(parseActionValue(actionFor(vpn).value).enabled, false);
    assert.equal(buttons(render(vpn, false)).some((b) => b.action_id === TOGGLE), false);
  }
  for (const vpn of [{ ...off, allowNetwork: false }, { ...off, busy: true }, { ...off, missingSecrets: ["VPN_PASSWORD"] }]) {
    assert.equal(buttons(render(vpn)).some((b) => b.action_id === TOGGLE), false);
  }
  assert.match(JSON.stringify(render({ ...off, missingSecrets: ["VPN_PASSWORD"] })), /VPN_PASSWORD/);
  assert.match(JSON.stringify(render(undefined)), /Checking status/);
  assert.equal(buttons(render({ ...off, state: "failed" })).filter((b) => b.action_id === TOGGLE).length, 1);
  const manuallyStarted = { ...off, enabled: false, state: "failed", running: true };
  assert.equal(parseActionValue(actionFor(manuallyStarted).value).enabled, false);
  assert.equal(parseActionValue(actionFor({ ...manuallyStarted, allowNetwork: false, missingSecrets: ["VPN_PASSWORD"] }).value).enabled, false);
  assert.match(JSON.stringify(render(off)), /does not route the ordinary agent container/);
});

test("VPN actions bind channel, slug, owner and requested operation", () => {
  const action = actionFor(off);
  const command = parseActionValue(action.value);
  assert.doesNotThrow(() => assertVpnActionBinding(state, command, TOGGLE));
  for (const forged of [{ ...state, channelId: "COTHER" }, { ...state, slug: "other" }, { ...state, ownerId: "UOTHER" }]) {
    assert.throws(() => assertVpnActionBinding(forged, { ...command, c: forged.channelId, u: forged.ownerId }, TOGGLE), /expired/);
  }
  for (const patch of [{ enabled: false }, { signature: "" }, { signature: "00" }, { o: "vpn_refresh" }, { enabled: "true" }]) {
    assert.throws(() => assertVpnActionBinding(state, { ...command, ...patch }, TOGGLE), /expired/);
  }
});

function request(vpn = off, actorState = state) {
  const updates = [];
  const events = [];
  return { updates, events, params: {
    ack: async () => events.push("ack"), action: actionFor(vpn, actorState),
    body: { user: { id: actorState.ownerId }, view: { ...render(vpn, true, actorState), id: "VVPN", hash: "view-hash" } },
    client: { views: { update: async (payload) => { updates.push(payload); return { view: payload.view }; } } },
  } };
}

const fixtureContext = async () => ({ entry: { name: "VPN test" }, meta: {}, userIsAdmin: true });
const fixtureRootView = async (_entry, _meta, actorState, _admin, { vpn }) => render(vpn, true, actorState);

test("VPN actions ACK before authority checks/service calls and show returned starting status", async () => {
  const { events, updates, params } = request();
  const starting = { ...off, enabled: true, state: "starting" };
  await handleChannelVpnSettingsAction(params, {
    context: async (...args) => { assert.equal(events[0], "ack"); events.push(args[3]?.manage ? "manage" : "read"); return fixtureContext(); },
    setEnabled: async (channel, enabled, options) => {
      assert.equal(channel, state.channelId); assert.equal(enabled, true);
      assert.equal(options.actor, state.ownerId); assert.equal(options.source, "slack_settings");
      assert.equal(await options.authorize(), true);
      return starting;
    }, rootView: fixtureRootView,
  });
  assert.deepEqual(events, ["ack", "manage", "manage", "read"]);
  assert.equal(updates[0].hash, "view-hash");
  assert.match(JSON.stringify(updates[0]), /Starting — not connected yet/);
});

test("forged owner or metadata cannot call the service; safe backend errors reach the view", async () => {
  for (const forge of [
    (p) => { p.body.user.id = "UOTHER"; },
    (p) => { p.body.view.private_metadata = settingsMetadata({ ...state, slug: "forged" }); },
    (p) => { p.action.value = JSON.stringify({ ...parseActionValue(p.action.value), enabled: false }); },
  ]) {
    const { params, updates } = request(); forge(params);
    await handleChannelVpnSettingsAction(params, { context: async () => assert.fail("must fail before context"), setEnabled: async () => assert.fail("must not mutate") });
    assert.match(JSON.stringify(updates), /expired|isn't yours/);
  }
  const { params, updates } = request();
  await handleChannelVpnSettingsAction(params, { context: fixtureContext, setEnabled: async () => { throw new Error("VPN server certificate validation failed."); } });
  assert.match(JSON.stringify(updates), /certificate validation failed/);
});

async function fixture() {
  await store.ensureRoot();
  const entry = await store.upsertChannelEntry(state.channelId, { name: state.slug, type: "channel", isDM: false });
  await store.setUser(state.ownerId, { approved: true, isAdmin: false });
  await store.saveChannelMeta(entry.slug, { ...store.defaultChannelMeta({ channelId: entry.channelId, name: entry.name }), access: "approved", manageAccess: "custom", managers: [state.ownerId] });
  const client = { conversations: { members: async () => ({ members: [state.ownerId] }) } };
  return { entry, client, actorState: { ...state, slug: entry.slug } };
}

test("fresh VPN authority rejects revocation during membership lookup and channel departure", async () => {
  const { entry, client, actorState } = await fixture();
  await channelVpnSettingsContext(client, actorState, state.ownerId, { manage: true });
  client.conversations.members = async () => {
    await store.patchChannelMeta(entry.slug, { managers: [] });
    return { members: [state.ownerId] };
  };
  await assert.rejects(() => channelVpnSettingsContext(client, actorState, state.ownerId, { manage: true }), /current channel managers/);
  // Reading remains allowed for an authorized member who cannot manage the channel.
  await channelVpnSettingsContext(client, actorState, state.ownerId);
  client.conversations.members = async () => ({ members: [] });
  await assert.rejects(() => channelVpnSettingsContext(client, actorState, state.ownerId), /no longer a member/);
});

test("a manager demoted after the initial check cannot authorize queued VPN changes", async () => {
  const { entry, client, actorState } = await fixture();
  const { params, updates } = request(off, actorState);
  params.client.conversations = client.conversations;
  let applied = false;
  await handleChannelVpnSettingsAction(params, { setEnabled: async (_channel, _enabled, { authorize }) => {
    await store.patchChannelMeta(entry.slug, { managers: [] });
    await authorize();
    applied = true;
    return off;
  } });
  assert.equal(applied, false);
  assert.match(JSON.stringify(updates), /current channel managers/);
});

test("status hydration targets the opened view hash and never overwrites newer navigation", async () => {
  const updates = [];
  await hydrateChannelVpnSettings({ views: { update: async (payload) => { updates.push(payload); throw Object.assign(new Error("stale view"), { data: { error: "hash_conflict" } }); } } },
    { id: "VALREADYOPEN", hash: "opened-hash" }, state,
    { context: fixtureContext, status: async () => off, rootView: fixtureRootView });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].view_id, "VALREADYOPEN");
  assert.equal(updates[0].hash, "opened-hash");
});


test("authorized members refresh VPN status without mutation authority", async () => {
  const { client, actorState, entry } = await fixture();
  await store.patchChannelMeta(entry.slug, { managers: [] });
  const { params, updates, events } = request(off, actorState);
  params.client.conversations = client.conversations;
  params.action = buttons(render(off, false, actorState)).find((b) => b.action_id === REFRESH);
  await handleChannelVpnSettingsAction(params, {
    status: async (channel) => { assert.equal(events[0], "ack"); assert.equal(channel, state.channelId); return off; },
    setEnabled: async () => assert.fail("refresh must not change VPN"),
  });
  assert.match(JSON.stringify(updates), /VPN is off/);
  assert.equal(buttons(updates[0].view).some((b) => b.action_id === TOGGLE), false);
});

test("global role revoked during Slack membership lookup blocks VPN read and write", async () => {
  const { client, actorState } = await fixture();
  client.conversations.members = async () => {
    await store.setUser(state.ownerId, { approved: false, isAdmin: false });
    return { members: [state.ownerId] };
  };
  await assert.rejects(() => channelVpnSettingsContext(client, actorState, state.ownerId, { manage: true }), /not authorized/);
});
