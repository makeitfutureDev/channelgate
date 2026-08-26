// M3 (remainder): the App Home channel list. Authorization decides who may USE a channel, but a
// PRIVATE channel's name is itself confidential — it must appear only to actual Slack members
// (and the header count comes from this same filtered list). Failures fail closed, and membership
// lookups are briefly cached so one Home open doesn't re-page conversations.members per channel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { homeVisibleChannels } = await import("../src/slack/app.js");
const { upsertChannelEntry, getChannelEntry } = await import("../src/config/store.js");
const { resolveConversation } = await import("../src/slack/message-pipeline.js");

// Fake Slack client backed by a channelId -> members map; counts API calls for the cache test.
function makeClient(membersByChannel) {
  const calls = [];
  return {
    calls,
    conversations: {
      members: async ({ channel }) => {
        calls.push(channel);
        const members = membersByChannel[channel];
        if (!members) throw new Error("channel_not_found");
        return { members, response_metadata: {} };
      },
    },
  };
}

// `type` carries whichever spelling the event that registered the channel used: message events say
// channel/group/mpim, member_joined_channel says C/G.
const channels = [
  { channelId: "C_PUB", name: "general", type: "channel", meta: {} },
  { channelId: "G_PRIV_IN", name: "secret-in", type: "group", meta: {} },
  { channelId: "G_PRIV_OUT", name: "secret-out", type: "group", meta: {} },
  { channelId: "G_MPIM", name: "mpdm-trio", type: "mpim", meta: {} },
];

test("private channels appear only to their actual members; public ones need no lookup", async () => {
  const client = makeClient({
    G_PRIV_IN: ["U1", "U2"],
    G_PRIV_OUT: ["U2"],
    G_MPIM: ["U1", "U3"],
  });
  const visible = await homeVisibleChannels(client, channels, "U1", { cache: new Map() });
  assert.deepEqual(visible.map((c) => c.name), ["general", "secret-in", "mpdm-trio"]);
  assert.ok(!client.calls.includes("C_PUB"), "public channels skip the membership call");
});

test("the letter channel_type spelling (C/G) is honoured, and an unknown type fails closed", async () => {
  const letters = [
    { channelId: "C_LETTER", name: "public-letter", type: "C", meta: {} },
    { channelId: "G_LETTER", name: "private-letter", type: "G", meta: {} },
    { channelId: "X_LEGACY", name: "legacy-unknown", type: "", meta: {} },
  ];
  const client = makeClient({ G_LETTER: ["U2"], X_LEGACY: ["U2"] });
  const visible = await homeVisibleChannels(client, letters, "U1", { cache: new Map() });
  assert.deepEqual(visible.map((c) => c.name), ["public-letter"]);
  assert.ok(!client.calls.includes("C_LETTER"), "the letter spelling for public skips the lookup");
});

test("a failed membership lookup fails closed (the private name is not leaked)", async () => {
  const client = makeClient({ G_PRIV_IN: ["U1"] }); // the others throw channel_not_found
  const visible = await homeVisibleChannels(client, channels, "U1", { cache: new Map() });
  assert.deepEqual(visible.map((c) => c.name), ["general", "secret-in"]);
});

test("membership is cached within the TTL and refetched after it expires", async () => {
  const client = makeClient({ G_PRIV_IN: ["U1"], G_PRIV_OUT: [], G_MPIM: [] });
  const cache = new Map();
  let clock = 1_000_000;
  const now = () => clock;

  await homeVisibleChannels(client, channels, "U1", { cache, now });
  const coldCalls = client.calls.length;
  await homeVisibleChannels(client, channels, "U1", { cache, now });
  assert.equal(client.calls.length, coldCalls, "second open within the TTL hits the cache");

  clock += 10 * 60 * 1000; // well past the TTL
  await homeVisibleChannels(client, channels, "U1", { cache, now });
  assert.equal(client.calls.length, coldCalls * 2, "stale entries are refetched");
});

test("the visible list drives the header count (filtered, not the full roster)", async () => {
  const client = makeClient({ G_PRIV_IN: ["U9"], G_PRIV_OUT: ["U9"], G_MPIM: ["U9"] });
  const visible = await homeVisibleChannels(client, channels, "U1", { cache: new Map() });
  assert.equal(visible.length, 1, "a non-member sees only the public channel");
  assert.equal(channels.length, 4, "…even though the gateway manages more");
});

// ── The stored `type` is what the filter above reads, so it is a security value ──────────────
// A synthetic event (a /model slash command, a 🤖 reaction, an App Home open) is built by the
// gateway and carries no real channel_type. The old code guessed "channel" for anything whose id
// doesn't start with "D", and upsertChannelEntry then OVERWROTE the stored "group" with it — one
// slash command in a private channel relabelled it public and its name started appearing in the
// App Home of every authorized non-member.

test("a synthetic re-registration cannot downgrade a stored private type to public", async () => {
  const id = "G_TYPE_KEEP";
  await upsertChannelEntry(id, { name: "#secret", type: "group", isDM: false });
  assert.equal((await getChannelEntry(id)).type, "group");

  // What a slash command / reaction path used to pass in.
  await upsertChannelEntry(id, { name: "#secret", type: "channel", isDM: false });
  assert.equal((await getChannelEntry(id)).type, "group", "the known private type survives");
  assert.equal(PUBLIC_FILTER(await getChannelEntry(id)), false, "so it is still treated as private");
});

test("an unknown type is stored as unknown, never manufactured into the public value", async () => {
  const id = "C_TYPE_UNKNOWN";
  await upsertChannelEntry(id, { name: "#mystery", isDM: false });
  assert.equal((await getChannelEntry(id)).type, "", "no guess is invented");
  assert.equal(PUBLIC_FILTER(await getChannelEntry(id)), false, "unknown fails closed to private");

  // A later REAL message event is what finally establishes the kind.
  await upsertChannelEntry(id, { name: "#mystery", type: "channel", isDM: false });
  assert.equal((await getChannelEntry(id)).type, "channel");
});

// Mirrors PUBLIC_CHANNEL_TYPES in src/slack/app.js — asserted through homeVisibleChannels below.
function PUBLIC_FILTER(entry) {
  return ["channel", "C"].includes(entry.type);
}

test("resolveConversation reads the real kind from conversations.info when the event has none", async () => {
  const client = {
    conversations: {
      info: async ({ channel }) =>
        channel === "G_PRIVATE"
          ? { channel: { name: "secret", is_private: true } }
          : { channel: { name: "general", is_private: false } },
    },
  };
  // No channel_type at all — the synthetic-event case.
  assert.deepEqual(await resolveConversation(client, { channel: "G_PRIVATE" }), {
    name: "#secret",
    type: "group",
    isDM: false,
  });
  assert.deepEqual(await resolveConversation(client, { channel: "C_PUBLIC" }), {
    name: "#general",
    type: "channel",
    isDM: false,
  });
  // Lookup fails and the event says nothing: the kind is unknown, not "channel".
  const blind = { conversations: { info: async () => { throw new Error("channel_not_found"); } } };
  assert.equal((await resolveConversation(blind, { channel: "C_UNKNOWN" })).type, "");
});

test("the membership probe stops at the display limit instead of paging every private channel", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ channelId: `G_${i}`, name: `p${i}`, type: "group", meta: {} }));
  const client = makeClient(Object.fromEntries(many.map((c) => [c.channelId, ["U1"]])));

  const visible = await homeVisibleChannels(client, many, "U1", { cache: new Map(), limit: 26 });

  assert.equal(visible.length, 26, "one past the 25 rendered lines — enough to label the count 25+");
  assert.equal(client.calls.length, 26, "and exactly that many conversations.members calls, not 40");
});
