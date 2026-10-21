import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { settingsComposioRequest, channelComposioSettingsContext, hydrateComposioSettings, handleComposioSettingsAction } = await import("../src/slack/app.js");
const { settingsMetadata } = await import("../src/slack/channel-settings.js");
const { COMPOSIO_INVENTORY_ACTION_ID } = await import("../src/slack/composio-inventory-view.js");
const { createSettingsComposioCache } = await import("../src/slack/composio-inventory-cache.js");
const { loadComposioInventory } = await import("../src/gateway/composio-inventory.js");
const store = await import("../src/config/store.js");
const state = { channelId: "CCOMPOSIOSETTINGS", slug: "composio-settings", ownerId: "UCOMPOSIOVIEWER", tab: "you" };
const publicResult = { state: "ready", source: "user", accounts: [{ app: "gmail", id: "account", account: "viewer@example.test" }] };
const fixtureContext = async () => ({ entry: { name: "Inventory test" }, meta: {}, userIsAdmin: false });
const fixtureRequest = async (_entry, _meta, current) => ({ kind: "user", id: current.ownerId, record: { composioToken: "private-credential" } });
function fixture(operation = "composio_refresh", current = state) {
  const updates = []; const events = [];
  const params = {
    ack: async () => { events.push("ack"); },
    action: { action_id: COMPOSIO_INVENTORY_ACTION_ID, value: JSON.stringify({ c: current.channelId, s: current.slug, u: current.ownerId, o: operation, page: 1 }) },
    body: { user: { id: current.ownerId }, view: { id: "VINVENTORY", hash: "opening-hash", callback_id: "cg_channel_settings_modal", private_metadata: settingsMetadata(current) } },
    client: { views: { update: async (payload) => { updates.push(payload); return { view: { ...payload.view, id: "VINVENTORY", hash: "updated-hash" } }; } } },
  };
  return { params, updates, events };
}
const safeCache = (options = {}) => createSettingsComposioCache({ config: () => ({ mode: "personal" }), load: async () => publicResult, ...options });
const render = (cache) => async (entry, meta, current) => ({ private_metadata: settingsMetadata(current), blocks: [{ type: "section", text: { type: "plain_text", text: JSON.stringify(cache.peek(await fixtureRequest(entry, meta, current)) || "Loading connections") } }] });

test("You resolves exactly the modal owner, while MCP resolves only the current channel", async () => {
  const seen = []; const user = async (id) => { seen.push(id); return { composioToken: "viewer-token" }; };
  const personal = await settingsComposioRequest({ channelId: "FORGED", composioToken: "channel-token" }, {}, { ...state, id: "FORGED" }, { user });
  assert.deepEqual(personal, { kind: "user", id: state.ownerId, record: { composioToken: "viewer-token" } });
  assert.deepEqual(seen, [state.ownerId]);
  const channel = await settingsComposioRequest({ type: "channel", composioToken: "old" }, { composioToken: "current" }, { ...state, tab: "mcp" }, { user: async () => assert.fail("must not fetch another personal identity") });
  assert.equal(channel.kind, "channel"); assert.equal(channel.id, state.channelId); assert.equal(channel.record.composioToken, "current");
  await assert.rejects(() => settingsComposioRequest({}, {}, { ...state, tab: "skills" }, { user }), /Open You or MCP/);
});

test("DM channel inventory suppresses shared connections even with configured fallback", async () => {
  for (const entry of [{ isDM: true }, { type: "im" }]) {
    const request = await settingsComposioRequest(entry, { composioToken: "channel-secret" }, { ...state, tab: "mcp" });
    const result = await loadComposioInventory(request, { config: { mode: "personal", defaultToken: "org-secret" }, connect: async () => assert.fail("DM must not discover shared accounts") });
    assert.equal(result.source, "none-dm"); assert.deepEqual(result.accounts, []);
  }
});

test("inventory actions ACK before slow authorization, repaint loading, then hydrate refreshed accounts", async () => {
  const { params, updates, events } = fixture(); const cache = safeCache(); await cache.load(await fixtureRequest({}, {}, state));
  await handleComposioSettingsAction(params, { cache, request: fixtureRequest, rootView: render(cache), context: async () => {
    assert.equal(events[0], "ack"); events.push("authorization"); return fixtureContext();
  } });
  assert.match(JSON.stringify(updates[0]), /Loading connections/);
  assert.equal(updates[0].hash, "opening-hash");
  assert.match(JSON.stringify(updates.at(-1)), /viewer@example.test/);
  assert.equal(updates.at(-1).hash, "updated-hash");
  assert.equal(JSON.parse(updates[0].view.private_metadata).cp, undefined, "refresh returns to page one");
});

test("page navigation uses the loaded cache without another provider read", async () => {
  const current = { ...state, composioPage: 0 }; const { params, updates } = fixture("composio_page", current);
  let reads = 0; const cache = safeCache({ load: async () => { reads++; return publicResult; } });
  await cache.load(await fixtureRequest({}, {}, current));
  await handleComposioSettingsAction(params, { context: fixtureContext, request: fixtureRequest, cache, rootView: render(cache) });
  assert.equal(reads, 1); assert.equal(updates.length, 1);
  const metadata = JSON.parse(updates[0].view.private_metadata);
  assert.equal(metadata.cp, 1);
});

test("stale inventory controls preserve an open inline form without replacing draft inputs", async () => {
  for (const operation of ["composio_page", "composio_refresh"]) {
    const { params, updates, events } = fixture(operation, { ...state, form: "composio" });
    await handleComposioSettingsAction(params, { context: async () => assert.fail("must leave the draft alone"), rootView: async () => assert.fail("must not replace draft inputs") });
    assert.deepEqual(events, ["ack"]); assert.deepEqual(updates, []);
  }
});

test("missing or forged owner/channel/slug/action bindings are rejected before discovery", async () => {
  for (const change of [
    (p) => { p.body.user.id = "UOTHER"; },
    (p) => { p.body.view.private_metadata = "{}"; },
    (p) => { p.body.view.callback_id = "different"; },
    (p) => { p.body.view.private_metadata = settingsMetadata({ ...state, tab: "skills" }); },
    (p) => { p.action.action_id = "different"; },
    ...[{ u: "UOTHER" }, { c: "COTHER" }, { s: "other" }, { o: "connect_account" }, { o: "composio_page", page: -1 }, { o: "composio_page", page: 1.5 }].map((patch) => (p) => { p.action.value = JSON.stringify({ ...JSON.parse(p.action.value), ...patch }); }),
  ]) {
    const { params, updates, events } = fixture(); change(params);
    await handleComposioSettingsAction(params, { context: fixtureContext, request: fixtureRequest, cache: { invalidate: () => {}, peek: () => assert.fail("must not read inventory"), load: () => assert.fail("must not load inventory") }, rootView: async () => assert.fail("must not render accounts") });
    assert.equal(events[0], "ack"); assert.match(JSON.stringify(updates), /expired/);
    assert.doesNotMatch(JSON.stringify(updates), /viewer@example.test|private-credential/);
  }
});

async function liveFixture() {
  await store.ensureRoot();
  const entry = await store.upsertChannelEntry(state.channelId, { name: state.slug, type: "channel", isDM: false });
  await store.setUser(state.ownerId, { approved: true, isAdmin: false });
  await store.saveChannelMeta(entry.slug, { ...store.defaultChannelMeta({ channelId: entry.channelId, name: entry.name }), access: "approved" });
  return { entry, current: { ...state, slug: entry.slug }, client: { conversations: { members: async () => ({ members: [state.ownerId] }) } } };
}

test("live inventory authority rejects foreign viewer, unrelated tab, departure, forged slug and revocation during membership read", async () => {
  const { current, client } = await liveFixture();
  await channelComposioSettingsContext(client, current, state.ownerId);
  await assert.rejects(() => channelComposioSettingsContext(client, current, "UOTHER"), /isn't yours/);
  await assert.rejects(() => channelComposioSettingsContext(client, { ...current, tab: "skills" }, state.ownerId), /Open You or MCP/);
  await assert.rejects(() => channelComposioSettingsContext(client, { ...current, slug: "forged" }, state.ownerId), /expired|match|changed|belongs/i);
  client.conversations.members = async () => ({ members: [] });
  await assert.rejects(() => channelComposioSettingsContext(client, current, state.ownerId), /no longer a member/);
  client.conversations.members = async () => {
    await store.setUser(state.ownerId, { approved: false, isAdmin: false }); return { members: [state.ownerId] };
  };
  await assert.rejects(() => channelComposioSettingsContext(client, current, state.ownerId), /not authorized/);
});

test("revocation before or after a slow account read never sends account data", async () => {
  for (const revokeAt of [1, 2, 3]) {
    const { params, updates } = fixture(); let calls = 0; let reads = 0;
    const cache = safeCache({ load: async () => { reads++; return publicResult; } });
    await hydrateComposioSettings(params.client, params.body.view, state, { cache, request: fixtureRequest, rootView: render(cache), context: async () => {
      if (++calls === revokeAt) throw new Error("access revoked"); return fixtureContext();
    } });
    assert.equal(reads, revokeAt === 1 ? 0 : 1);
    assert.doesNotMatch(JSON.stringify(updates), /viewer@example.test|private-credential/);
  }
});

test("credential rotation during discovery or rendering discards the previous account inventory", async () => {
  for (const rotateDuringRender of [false, true]) {
    const { params, updates } = fixture(); let token = "before";
    const request = async () => ({ kind: "user", id: state.ownerId, record: { composioToken: token } });
    const cache = safeCache({ load: async () => { if (!rotateDuringRender) token = "after"; return publicResult; } });
    await hydrateComposioSettings(params.client, params.body.view, state, { context: fixtureContext, request, cache, rootView: async () => {
      token = "after"; return { blocks: [{ text: { text: "viewer@example.test" } }] };
    } });
    assert.deepEqual(updates, []);
  }
});

test("cached page actions recheck live access and credentials after asynchronous rendering", async () => {
  for (const revoke of [true, false]) {
    const { params, updates } = fixture("composio_page"); let rendered = false; let token = "before";
    const request = async () => ({ kind: "user", id: state.ownerId, record: { composioToken: token } });
    const cache = safeCache(); await cache.load(await request());
    await handleComposioSettingsAction(params, { request, cache, context: async () => {
      if (rendered && revoke) throw new Error("revoked during render"); return fixtureContext();
    }, rootView: async () => { rendered = true; if (!revoke) token = "after"; return { blocks: [{ text: { text: "viewer@example.test" } }] }; } });
    assert.doesNotMatch(JSON.stringify(updates), /viewer@example.test/);
  }
});

test("live global revocation during provider discovery prevents account delivery", async () => {
  const { current, client } = await liveFixture(); const { params, updates } = fixture("composio_refresh", current);
  params.client.conversations = client.conversations;
  const cache = safeCache({ load: async () => { await store.setUser(state.ownerId, { approved: false, isAdmin: false }); return publicResult; } });
  await hydrateComposioSettings(params.client, params.body.view, current, { cache, request: fixtureRequest, rootView: render(cache) });
  assert.doesNotMatch(JSON.stringify(updates), /viewer@example.test/);
  assert.match(JSON.stringify(updates), /access changed/);
});

test("hydration preserves view hashes and stops after a conflict without overwriting newer navigation", async () => {
  const { params, updates } = fixture();
  params.client.views.update = async (payload) => { updates.push(payload); throw Object.assign(new Error("changed view"), { data: { error: "hash_conflict" } }); };
  const cache = safeCache();
  await hydrateComposioSettings(params.client, params.body.view, state, { context: fixtureContext, request: fixtureRequest, cache, rootView: render(cache) });
  assert.equal(updates.length, 1); assert.equal(updates[0].hash, "opening-hash");
});

test("hydration skips unrelated tabs and open forms without reading connections", async () => {
  for (const current of [{ ...state, tab: "skills" }, { ...state, form: "composio" }]) {
    const { params, updates } = fixture();
    await hydrateComposioSettings(params.client, params.body.view, current, { context: async () => assert.fail("no authority lookup for unrelated/open form") });
    assert.deepEqual(updates, []);
  }
});
