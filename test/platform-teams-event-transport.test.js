import test from "node:test";
import assert from "node:assert/strict";
import { createTeamsApi } from "../src/platforms/msteams/api.js";
import { startTeams } from "../src/platforms/msteams/transport.js";
import { createTeamsAuth, GRAPH_SCOPE } from "../src/platforms/msteams/auth.js";
import { createTeamsEventStore } from "../src/platforms/msteams/event-store.js";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "../src/db/migrations.js";

function fixture() {
  const subscriptions = [], accepted = [], dispatched = [];
  let options;
  const inbox = { start() { this.started = true; }, stop() { this.stopped = true; }, accept(item) { accepted.push(item); } };
  const dispatch = { start() { this.started = true; }, stop() { this.stopped = true; }, accept(item) { dispatched.push(item); } };
  const graph = { start() { this.started = true; }, async stop() { this.stopped = true; }, async ensure(row) { subscriptions.push(row); }, handle() {} };
  return { subscriptions, accepted, dispatched, inbox, dispatch, graph, get options() { return options; },
    deps: { auth: { token: async () => "bot-token" }, api: {}, connector: {}, jwks: {}, graphAuth: { token: async () => "graph-token" }, eventStore: { list: () => subscriptions },
      graphInbox: inbox, graphDispatchInbox: dispatch, graphNotificationInbox: { start() {}, stop() {}, accept() {} }, createGraphEvents: opts => { options = opts; return graph; } } };
}
const activity = { type: "message", conversation: { id: "19:chat@thread.v2", conversationType: "groupChat" },
  channelData: { tenant: { id: "tenant" } }, serviceUrl: "https://smba.trafficmanager.net/teams/" };

test("Teams events are opt-in and ordinary transport remains available", async () => {
  const f = fixture();
  const transport = await startTeams({ appId: "app", onMessage: async () => {}, deps: f.deps });
  assert.equal(transport.graphHandler, null);
  assert.equal(transport.graphEventsEnabled, false);
  await transport.onActivity(activity);
  assert.equal(f.subscriptions.length, 0);
  await transport.stop();
});

test("Teams events register only authenticated-context tenant/scoped resources", async () => {
  const f = fixture();
  const transport = await startTeams({ appId: "app", tenantId: "tenant", allMessageEvents: true, publicUrl: "https://gateway.example/", onMessage: async () => {}, deps: f.deps });
  assert.equal(f.options.notificationUrl, "https://gateway.example/api/teams/notifications");
  assert.equal(transport.graphHandler, f.graph.handle);
  await transport.onActivity(activity);
  assert.equal(f.subscriptions[0].resource, "/chats/19%3Achat%40thread.v2/messages");
  assert.equal(f.subscriptions[0].conversationId, "teams:19:chat@thread.v2");
  assert.equal(f.subscriptions[0].context.recipient.id, "28:app");
  await transport.onActivity({ ...activity, channelData: { tenant: { id: "wrong" } } });
  await transport.onActivity({ ...activity, serviceUrl: "https://evil.example/" });
  assert.equal(f.subscriptions.length, 1);
  await transport.onActivity({ ...activity, type: "conversationUpdate", conversation: { id: "19:channel", conversationType: "channel" },
    channelData: { tenant: { id: "tenant" }, channel: { id: "19:channel" }, team: { aadGroupId: "11111111-2222-3333-4444-555555555555" } } });
  assert.equal(f.subscriptions[1].resource, "/teams/11111111-2222-3333-4444-555555555555/channels/19%3Achannel/messages");
  assert.equal(f.graph.started, true);
  await transport.stop();
  assert.equal(f.graph.stopped, true);
  assert.equal(f.inbox.stopped, true);
  assert.equal(f.dispatch.stopped, true);
});

test("Graph callback persists snapshots before acknowledgement with stable identity", async () => {
  const f = fixture();
  const transport = await startTeams({ appId: "app", tenantId: "tenant", allMessageEvents: true, publicUrl: "https://gateway.example", onMessage: async () => {}, deps: f.deps });
  const row = { conversationId: "teams:chat", context: {} }, message = { id: "123", etag: "v1" };
  await f.options.onMessage(message, row);
  await f.options.onMessage(message, row);
  assert.equal(f.accepted.length, 2);
  assert.equal(f.accepted[0].id, f.accepted[1].id);
  assert.deepEqual(f.accepted[0].payload, { message, row });
  await f.options.onMessage({ ...message, etag: "v2" }, row);
  assert.notEqual(f.accepted[2].id, f.accepted[0].id);
  await transport.stop();
});

test("Graph auth requests its own audience and rejects arbitrary audiences", async () => {
  let request;
  const auth = createTeamsAuth({ clientId: "app", clientSecret: "secret", tenantId: "tenant", scope: GRAPH_SCOPE,
    fetchImpl: async (_url, init) => { request = init; return { ok: true, text: async () => JSON.stringify({ access_token: "graph-token", expires_in: 3600 }) }; } });
  assert.equal(await auth.token(), "graph-token");
  assert.equal(new URLSearchParams(request.body).get("scope"), GRAPH_SCOPE);
  assert.throws(() => createTeamsAuth({ clientId: "app", clientSecret: "secret", scope: "https://evil.example/.default" }), /scope/);
});

test("Graph subscription store survives recreation and isolates apps", () => {
  const db = new DatabaseSync(":memory:");
  migrations.find(m => m.version === 24).up(db);
  const one = createTeamsEventStore({ appId: "one", db });
  const two = createTeamsEventStore({ appId: "two", db });
  one.put({ conversationId: "teams:chat", clientState: "private", subscriptionId: "sub" });
  assert.deepEqual(two.list(), []);
  assert.equal(createTeamsEventStore({ appId: "one", db }).list()[0].subscriptionId, "sub");
  one.put({ conversationId: "teams:chat", subscriptionId: "renewed" });
  assert.equal(one.list().length, 1);
  one.remove("teams:chat");
  assert.deepEqual(one.list(), []);
  db.close();
});

test("Graph snapshot processing resolves the reactor in its conversation and deduplicates each event", async () => {
  const handlers = new Map(), queued = new Map(), delivered = [], memberReads = [];
  const f = fixture();
  delete f.deps.graphInbox; delete f.deps.graphDispatchInbox;
  f.deps.createInbox = options => {
    handlers.set(options.namespace, options.handle);
    return { start() {}, stop() {}, accept(item) { queued.set(`${options.namespace}:${item.id}`, item); } };
  };
  f.deps.apiForServiceUrl = url => ({ listMembers: async id => {
    memberReads.push([url, id]); return [{ id: "29:reactor", aadObjectId: "aad-reactor", name: "Reactor" }];
  } });
  f.deps.normalizeGraphEvents = async (_message, row, { resolveMember }) => {
    const member = await resolveMember("aad-reactor");
    assert.equal(member.id, "29:reactor");
    return [{ conversationId: row.conversationId, senderId: member.id, raw: { eventId: "reaction:123:reactor:time" } }];
  };
  const transport = await startTeams({ appId: "app", tenantId: "tenant", allMessageEvents: true, publicUrl: "https://gateway.example", onMessage: async message => delivered.push(message), deps: f.deps });
  const row = { conversationId: "teams:chat", startedAt: "start", context: { conversation: { id: "19:chat" }, serviceUrl: activity.serviceUrl } };
  f.subscriptions.push(row);
  await handlers.get("msteams-graph:app")({ message: { id: "123", etag: "1" }, row });
  await handlers.get("msteams-graph:app")({ message: { id: "123", etag: "2" }, row });
  assert.equal(queued.size, 1);
  assert.equal([...queued.values()][0].conversationId, "reaction:123:reactor:time");
  assert.deepEqual(memberReads[0], [activity.serviceUrl, "19:chat"]);
  await handlers.get("msteams-graph-dispatch:app")([...queued.values()][0].payload);
  assert.equal(delivered[0].senderId, "29:reactor");
  await transport.stop();
});

test("Graph skips personal chats, resolves missing team GUID, and revokes uninstall", async () => {
  const f = fixture(), removed = [];
  f.graph.remove = async id => removed.push(id);
  f.deps.apiForServiceUrl = () => ({ teamInfo: async id => {
    assert.equal(id, "19:team"); return { aadGroupId: "11111111-2222-3333-4444-555555555555" };
  } });
  const transport = await startTeams({ appId: "app", tenantId: "tenant", allMessageEvents: true, publicUrl: "https://gateway.example", onMessage: async () => {}, deps: f.deps });
  await transport.onActivity({ ...activity, conversation: { id: "a:personal", conversationType: "personal" } });
  assert.equal(f.subscriptions.length, 0);
  await transport.onActivity({ ...activity, conversation: { id: "19:channel", conversationType: "channel" },
    channelData: { tenant: { id: "tenant" }, team: { id: "19:team" } } });
  assert.equal(f.subscriptions.length, 1);
  assert.match(f.subscriptions[0].resource, /11111111-2222-3333-4444-555555555555/);
  await transport.onActivity({ ...activity, type: "installationUpdate", action: "remove" });
  await transport.onActivity({ ...activity, type: "conversationUpdate", membersRemoved: [{ id: "28:app" }] });
  assert.deepEqual(removed, ["teams:19:chat@thread.v2", "teams:19:chat@thread.v2"]);
  assert.equal(f.subscriptions.length, 1);
  await transport.stop();
});


test("Teams teamInfo requests only the scoped Bot Framework team endpoint", async () => {
  const requests = [];
  const api = createTeamsApi({ auth: { token: async () => "bot-token" }, fetchImpl: async (url, init) => {
    requests.push({ url, init }); return { ok: true, json: async () => ({ aadGroupId: "group-id" }) };
  } });
  assert.equal((await api.teamInfo("19:team")).aadGroupId, "group-id");
  assert.equal(requests[0].url, "https://smba.trafficmanager.net/teams/v3/teams/19%3Ateam");
  assert.equal(requests[0].init.method, "GET");
  await assert.rejects(api.teamInfo("../users"), /invalid/);
});

test("Team uninstall revokes every subscribed channel of that team only", async () => {
  const f = fixture(), removed = [];
  f.graph.remove = async id => removed.push(id);
  const saved = (conversationId, id, aadGroupId) => ({ conversationId, context: { channelData: { team: { id, aadGroupId } } } });
  f.subscriptions.push(saved("teams:channel-a", "19:team", "guid"), saved("teams:channel-b", "19:team", "guid"), saved("teams:other", "19:other", "different"));
  const transport = await startTeams({ appId: "app", tenantId: "tenant", allMessageEvents: true, publicUrl: "https://gateway.example", onMessage: async () => {}, deps: f.deps });
  await transport.onActivity({ ...activity, type: "installationUpdate", action: "remove", conversation: { id: "19:general", conversationType: "channel" }, channelData: { tenant: { id: "tenant" }, team: { id: "19:team" } } });
  assert.deepEqual(removed.sort(), ["teams:19:general", "teams:channel-a", "teams:channel-b"].sort());
  await transport.stop();
});

test("Graph identical unversioned notifications each enter durable intake for later snapshot dedup", async () => {
  const f = fixture(), notifications = [];
  f.deps.graphNotificationInbox = { start() {}, stop() {}, accept: item => notifications.push(item) };
  const transport = await startTeams({ appId: "app", tenantId: "tenant", allMessageEvents: true, publicUrl: "https://gateway.example", onMessage: async () => {}, deps: f.deps });
  const envelope = { event: { subscriptionId: "sub", resourceData: { id: "123" } }, row: { conversationId: "teams:chat" } };
  await f.options.enqueueNotifications([envelope]);
  await f.options.enqueueNotifications([envelope]);
  assert.equal(notifications.length, 2);
  assert.notEqual(notifications[0].id, notifications[1].id);
  assert.deepEqual(notifications[0].payload, { accepted: [envelope] });
  await transport.stop();
});
