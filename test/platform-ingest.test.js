// The platform-neutral ingest path: gate → authorize → register → run → answer, plus the neutral
// inbound record it is built on. The engine and the wire are both fakes; what is under test is the
// set of rules that decide whether a message becomes a turn at all, and where the answer lands.
import test from "node:test";
import assert from "node:assert/strict";

import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();

const { makeInbound } = await import("../src/platforms/inbound.js");
const { createIngest, ensureConversation } = await import("../src/platforms/ingest.js");
const { buildNameDirectory } = await import("../src/platforms/format/mentions.js");
const { normalizeName } = await import("../src/slack/directory.js");
const { setUser, getChannelEntry, getChannelMeta } = await import("../src/config/store.js");
const { googleChatAdapter } = await import("../src/platforms/googlechat.js");
const { registerTransport, resetTransports, liveConnector } = await import("../src/platforms/live.js");

// ── the neutral inbound record ────────────────────────────────────────────────

test("an inbound record keeps the stored id and the wire id apart", () => {
  const message = makeInbound({ platform: "googlechat", conversationId: "spaces/AAA", kind: "channel", userId: "ana@example.com", text: "hi" });
  assert.equal(message.conversationId, "gchat:spaces/AAA");
  assert.equal(message.rawConversationId, "spaces/AAA");
  // Slack's ids stay bare — every row written before the multi-platform seam is a Slack row.
  assert.equal(makeInbound({ platform: "slack", conversationId: "C123", kind: "channel" }).conversationId, "C123");
});

test("a malformed inbound record is a programming error, not a degraded message", () => {
  assert.throws(() => makeInbound({ platform: "googlechat", conversationId: "", kind: "dm" }), /no conversation id/);
  assert.throws(() => makeInbound({ platform: "googlechat", conversationId: "spaces/A", kind: "supergroup" }), /unknown kind/);
  assert.throws(() => makeInbound({ platform: "irc", conversationId: "#ops", kind: "channel" }), /Unknown or unavailable chat platform/);
});

// ── the mention directory's anti-mistagging rules ─────────────────────────────

test("a name two people answer to resolves to nobody, on every platform", () => {
  const directory = buildNameDirectory([
    { id: "1", names: ["Ana Pop", "ana@example.com"] },
    { id: "2", names: ["Ana Pop", "ana.pop@example.com"] },
    { id: "3", names: ["Bo Lee"] },
  ], normalizeName);
  assert.equal(directory.map.has("ana pop"), false, "an outright collision is dropped");
  assert.equal(directory.map.get("bo lee"), "3");
  assert.equal(directory.map.get("ana@example.com"), "1", "a distinct handle still resolves");
  assert.equal(directory.maxWords, 2);
});

test("a single-word key that is two people's first name is dropped, but the full name survives", () => {
  const directory = buildNameDirectory([
    { id: "1", names: ["Sam Rivera", "sam"] },
    { id: "2", names: ["Sam Lee"] },
  ], normalizeName);
  assert.equal(directory.map.has("sam"), false);
  assert.equal(directory.map.get("sam lee"), "2");
  assert.equal(directory.map.get("sam rivera"), "1");
});

// ── ingest ────────────────────────────────────────────────────────────────────

function fakeConnector({ platform = "googlechat" } = {}) {
  const posted = [];
  const edited = [];
  return {
    platform,
    posted,
    edited,
    capabilities: googleChatAdapter.capabilities,
    async post(payload) { posted.push(payload); return { messageId: `m${posted.length}`, conversationId: payload.conversationId, threadKey: payload.threadKey || "" }; },
    async edit(payload) { edited.push(payload); },
    async directory() { return { map: new Map(), maxWords: 1 }; },
  };
}

const chatMessage = (over = {}) => makeInbound({
  platform: "googlechat",
  conversationId: "spaces/INGEST1",
  conversationName: "Ops",
  kind: "channel",
  userId: "ana@example.com",
  userName: "Ana Pop",
  text: "status please",
  mentionsBot: true,
  ...over,
});

test("an empty message and an unmentioned channel message never become a turn", async () => {
  const connector = fakeConnector();
  let runs = 0;
  const ingest = createIngest({ connector, run: async () => { runs += 1; return { content: "x" }; }, log: { info: () => {} } });

  assert.deepEqual(await ingest(chatMessage({ text: "", mentionsBot: true })), { skipped: "empty" });
  assert.deepEqual(await ingest(chatMessage({ mentionsBot: false })), { skipped: "not-mentioned" });
  assert.equal(runs, 0);
  assert.equal(connector.posted.length, 0, "a message we ignore must not produce chatter");
});

test("an unapproved author is told why, and no turn runs", async () => {
  const connector = fakeConnector();
  let runs = 0;
  const ingest = createIngest({ connector, run: async () => { runs += 1; return { content: "x" }; }, log: { info: () => {} } });
  const result = await ingest(chatMessage({ conversationId: "spaces/INGEST_DENY", userId: "stranger@example.com", userName: "Stranger" }));
  assert.deepEqual(result, { skipped: "unauthorized" });
  assert.equal(runs, 0);
  assert.match(connector.posted[0].text, /not approved/);
});

test("an approved author's message registers the space, runs, and replaces the placeholder", async () => {
  await setUser("ana@example.com", { name: "Ana Pop", approved: true });
  const connector = fakeConnector();
  const seen = [];
  const ingest = createIngest({
    connector,
    run: async (args) => { seen.push(args); return { content: "All good.", engine: "claude" }; },
    log: { info: () => {}, warn: () => {} },
  });

  const message = chatMessage({ threadKey: "spaces/INGEST1/threads/T" });
  const result = await ingest(message);
  assert.equal(result.result.content, "All good.");

  // The run is addressed by the QUALIFIED id and the platform's own thread handle.
  assert.equal(seen[0].channelId, "gchat:spaces/INGEST1");
  assert.equal(seen[0].threadKey, "spaces/INGEST1/threads/T");
  assert.equal(seen[0].origin, "googlechat_foreground");
  assert.equal(seen[0].authorId, "ana@example.com");

  // One message, not two: the placeholder is edited into the answer.
  assert.equal(connector.posted.length, 1);
  assert.match(connector.posted[0].text, /Working on it/);
  assert.equal(connector.edited.length, 1);
  assert.match(connector.edited[0].text, /All good\./);

  // And the conversation is now a registered, platform-stamped channel.
  const entry = await getChannelEntry("gchat:spaces/INGEST1");
  assert.equal(entry.platform, "googlechat");
  const meta = await getChannelMeta(entry.slug);
  assert.equal(meta.platform, "googlechat");
  assert.equal(meta.channelId, "gchat:spaces/INGEST1");
});

test("a failed run is reported in the thread instead of leaving the placeholder hanging", async () => {
  await setUser("ana@example.com", { name: "Ana Pop", approved: true });
  const connector = fakeConnector();
  const ingest = createIngest({
    connector,
    run: async () => { throw new Error("engine exploded"); },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const result = await ingest(chatMessage({ conversationId: "spaces/INGEST_FAIL" }));
  assert.match(result.error.message, /engine exploded/);
  assert.match(connector.edited[0].text, /engine exploded/);
});

test("a DM needs no mention", async () => {
  await setUser("ana@example.com", { name: "Ana Pop", approved: true });
  const connector = fakeConnector();
  let ran = false;
  const ingest = createIngest({ connector, run: async () => { ran = true; return { content: "hi" }; }, log: { info: () => {}, warn: () => {} } });
  await ingest(chatMessage({ conversationId: "spaces/INGEST_DM", kind: "dm", mentionsBot: false, text: "hello" }));
  assert.equal(ran, true);
});

test("a message from the wrong platform is refused rather than silently mis-routed", async () => {
  const ingest = createIngest({ connector: fakeConnector(), run: async () => ({ text: "x" }) });
  await assert.rejects(ingest(makeInbound({ platform: "msteams", conversationId: "19:a@thread.tacv2", kind: "channel", userId: "29:1", text: "hi", mentionsBot: true })), /received a msteams message/);
});

test("registering a transport is what makes the adapter hand out a live connector", async () => {
  resetTransports();
  assert.equal(liveConnector("googlechat"), null);
  const connector = fakeConnector();
  registerTransport("googlechat", { getConnector: () => connector, snapshot: () => ({ connected: true }) });
  assert.equal(liveConnector("googlechat"), connector);
  assert.equal(googleChatAdapter.createConnector(), connector);
  resetTransports();
  // Back to the connector that throws rather than one that quietly swallows a delivery.
  await assert.rejects(googleChatAdapter.createConnector().post({ conversationId: "spaces/A", text: "x" }), /cannot post/);
});

test("ensureConversation is idempotent and keeps the platform stamp", async () => {
  const message = chatMessage({ conversationId: "spaces/INGEST_TWICE" });
  const first = await ensureConversation(message);
  const second = await ensureConversation(message);
  assert.equal(first.entry.slug, second.entry.slug);
  assert.equal(second.meta.platform, "googlechat");
});
