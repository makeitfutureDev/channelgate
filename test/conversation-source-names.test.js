import test from "node:test";
import assert from "node:assert/strict";
import { conversationChannelName, conversationSource, matchesConversationSource } from "../public/admin-state.js";
import { createTeamsConversationNameResolver, activityConversationName } from "../src/platforms/msteams/conversation-name.js";
import { normalizeActivity } from "../src/platforms/msteams/activity.js";
import { createTeamsApi } from "../src/platforms/msteams/api.js";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { ensureConversation } = await import("../src/platforms/ingest.js");
const { getChannelMeta } = await import("../src/config/store.js");
const { makeInbound } = await import("../src/platforms/inbound.js");

const activity = (data = {}) => ({
  type: "message", id: "101", text: "hello", from: { id: "29:user", name: "User" },
  serviceUrl: "https://smba.trafficmanager.net/emea/",
  conversation: { id: "19:channel@thread.tacv2;messageid=100", conversationType: "channel" },
  channelData: { team: { id: "19:team@thread.tacv2" }, channel: { id: "19:channel@thread.tacv2" }, ...data },
});

test("source filtering classifies channel and DM payloads, including legacy Slack and namespaced rows", () => {
  const rows = [{ channelId: "C123" }, { channelId: "D123", meta: {} }, { channelId: "teams:19:a", platform: "msteams" }, { channelId: "gchat:spaces/A" }, { channelId: "x", meta: { platform: "googlechat" } }];
  assert.deepEqual(rows.map(conversationSource), ["slack", "slack", "msteams", "googlechat", "googlechat"]);
  assert.equal(rows.filter(row => matchesConversationSource(row, "all")).length, 5);
  assert.equal(rows.filter(row => matchesConversationSource(row, "slack")).length, 2);
  assert.equal(rows.filter(row => matchesConversationSource(row, "googlechat")).length, 2);
  assert.equal(conversationChannelName({ platform: "msteams", name: "delivery-general" }), "#delivery-general");
  assert.equal(conversationChannelName({ platform: "msteams", name: "teams:19:opaque@thread.tacv2" }), "#teams-channel");
  assert.equal(conversationChannelName({ name: "#engineering" }), "#engineering");
});

test("Teams payload names normalize team and channel without changing native routing", () => {
  const input = activity({ team: { id: "19:team", name: "Delivery Team" }, channel: { id: "19:channel", name: "Client Support" } });
  const message = normalizeActivity(input);
  assert.equal(message.conversationName, "delivery-team-client-support");
  assert.equal(message.conversationId, "teams:19:channel@thread.tacv2");
  assert.equal(message.threadKey, "100");
  assert.equal(activityConversationName({ conversation: { conversationType: "groupChat", name: "Planning Chat" } }), "Planning Chat");
});

test("missing Teams names resolve on the verified regional endpoint and concurrent reads share a cache", async () => {
  const calls = [];
  const resolver = createTeamsConversationNameResolver({ apiForServiceUrl: url => {
    calls.push(url);
    return { teamInfo: async id => { calls.push(id); return { name: "Delivery" }; }, listChannels: async () => [{ id: "19:channel@thread.tacv2", name: "General" }] };
  } });
  const message = normalizeActivity(activity());
  assert.deepEqual(await Promise.all([resolver(message), resolver(message)]), ["delivery-general", "delivery-general"]);
  assert.equal(calls.length, 2);
  const named = normalizeActivity(activity({ team: { name: "Renamed Team" }, channel: { name: "Support" } }));
  assert.equal(await resolver(named), "renamed-team-support");
  assert.equal(calls.length, 2, "complete payloads avoid a directory read");
});

test("directory errors degrade safely and retry; default General null is recognized only for the team ID", async () => {
  let clock = 0;
  let attempts = 0;
  const resolver = createTeamsConversationNameResolver({ now: () => clock, apiForServiceUrl: () => ({
    teamInfo: async () => { attempts++; if (attempts === 1) throw new Error("403"); return { name: "Delivery" }; },
    listChannels: async () => [{ id: "19:team@thread.tacv2", name: null }],
  }) });
  const message = normalizeActivity(activity({ channel: { id: "19:team@thread.tacv2" } }));
  assert.equal(await resolver(message), "");
  assert.equal(await resolver(message), "");
  assert.equal(attempts, 1);
  clock = 30_001;
  assert.equal(await resolver(message), "delivery-general");
  assert.equal(await resolver(normalizeActivity(activity())), "", "unknown channel is not guessed to be General");
  const unsafe = normalizeActivity({ ...activity(), serviceUrl: "https://evil.example/" });
  assert.equal(await resolver(unsafe), "");
  assert.equal(attempts, 2);
});

test("Bot Framework channel directory validates IDs and encodes the team path", async () => {
  let request;
  const api = createTeamsApi({ auth: { token: async () => "test-token" }, fetchImpl: async (url, init) => {
    request = { url, method: init.method };
    return { ok: true, json: async () => ({ conversations: [{ id: "19:a", name: "Support" }] }) };
  } });
  assert.equal((await api.listChannels("19:team@thread.tacv2"))[0].name, "Support");
  assert.match(request.url, /v3\/teams\/19%3Ateam%40thread.tacv2\/conversations$/);
  assert.equal(request.method, "GET");
  await assert.rejects(api.listChannels("../users"), /invalid/);
});

test("name refresh preserves stored slug/settings and failed or unnamed events preserve a good name", async () => {
  const message = makeInbound({ platform: "msteams", conversationId: "19:names-fixture@thread.tacv2", kind: "channel" });
  const initial = await ensureConversation(message);
  const resolved = await ensureConversation(message, { conversationName: async () => "delivery-general" });
  assert.equal(resolved.entry.slug, initial.entry.slug);
  assert.equal(resolved.entry.name, "delivery-general");
  assert.equal((await getChannelMeta(initial.entry.slug)).name, "delivery-general");
  assert.deepEqual(resolved.meta.allowedUsers, initial.meta.allowedUsers);
  const failed = await ensureConversation(message, { conversationName: async () => { throw new Error("403"); } });
  assert.equal(failed.entry.name, "delivery-general");
  assert.equal((await ensureConversation(message)).entry.name, "delivery-general");
});
