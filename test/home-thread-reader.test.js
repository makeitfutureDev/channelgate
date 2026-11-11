import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { indexSlackThread, recordSlackThreadMessage, setSlackThreadDone } = await import("../src/gateway/slack-threads.js");
const { createHomeThreadReader } = await import("../src/slack/home-thread-reader.js");
beforeEach(() => getDb().exec("DELETE FROM slack_threads"));
function fixture() {
  const calls = { replies: 0, links: 0 };
  const client = {
    conversations: { replies: async ({ ts }) => { calls.replies++; return { messages: [{ ts, user: "U_CACHE", text: "Task" }] }; } },
    chat: { getPermalink: async ({ message_ts }) => { calls.links++; return { permalink: `https://example.slack.com/${message_ts}` }; } },
  };
  return { client, calls };
}

test("inspection reuse expires, bypasses on Refresh, and invalidates on local message/completion changes", async () => {
  let now = 0; const reader = createHomeThreadReader({ now: () => now }); const { client, calls } = fixture();
  indexSlackThread({ channelId: "C_CACHE", slug: "cache", root: { ts: "100.000001", user: "U_CACHE", text: "Task" } });
  const inspect = (options) => reader.inspect(client, "C_CACHE", "100.000001", options);
  await inspect(); await inspect(); assert.equal(calls.replies, 1);
  now = 30001; await inspect(); assert.equal(calls.replies, 2);
  await inspect({ force: true }); assert.equal(calls.replies, 3);
  recordSlackThreadMessage("C_CACHE", "100.000001", "200.000001"); await inspect(); assert.equal(calls.replies, 4);
  setSlackThreadDone("C_CACHE", "100.000001", "U_CACHE", true); await inspect(); assert.equal(calls.replies, 5);
});

test("in-flight reads are shared, client credentials are isolated, and failed reads are retried", async () => {
  const reader = createHomeThreadReader(); const { client, calls } = fixture();
  await Promise.all(Array.from({ length: 12 }, () => reader.inspect(client, "C_CACHE", "100.000001")));
  assert.equal(calls.replies, 1);
  const other = fixture(); await reader.inspect(other.client, "C_CACHE", "100.000001"); assert.equal(other.calls.replies, 1);
  let attempts = 0;
  client.conversations.replies = async ({ ts }) => { if (++attempts === 1) throw new Error("temporary failure"); return { messages: [{ ts, user: "U_CACHE" }] }; };
  await assert.rejects(reader.inspect(client, "C_CACHE", "101.000001"));
  await reader.inspect(client, "C_CACHE", "101.000001"); assert.equal(attempts, 2);
  let links = 0;
  client.chat.getPermalink = async () => (++links === 1 ? {} : { permalink: "https://example.slack.com/recovered" });
  await assert.rejects(reader.permalink(client, "C_CACHE", "100.000001"));
  await reader.permalink(client, "C_CACHE", "100.000001"); assert.equal(links, 2);
});

test("cache storage is bounded and immutable permalinks are reused", async () => {
  const reader = createHomeThreadReader({ maxEntries: 2 }); const { client, calls } = fixture();
  for (const ts of ["100.000001", "101.000001", "102.000001"]) {
    await reader.inspect(client, "C_CACHE", ts); await reader.permalink(client, "C_CACHE", ts);
  }
  await reader.permalink(client, "C_CACHE", "102.000001"); assert.equal(calls.links, 3);
  await reader.inspect(client, "C_CACHE", "100.000001"); await reader.permalink(client, "C_CACHE", "100.000001");
  assert.equal(calls.replies, 4); assert.equal(calls.links, 4);
});

test("parallel inspections and links share a four-read concurrency budget", async () => {
  const reader = createHomeThreadReader(); let active = 0, peak = 0;
  const work = async (value) => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve)); active--; return value;
  };
  const client = {
    conversations: { replies: ({ ts }) => work({ messages: [{ ts, user: "U_CACHE" }] }) },
    chat: { getPermalink: () => work({ permalink: "https://example.slack.com/thread" }) },
  };
  await Promise.all(Array.from({ length: 20 }, (_, n) => Promise.all([
    reader.inspect(client, "C_CACHE", `${100+n}.000001`), reader.permalink(client, "C_CACHE", `${100+n}.000001`),
  ])));
  assert.equal(peak, 4); assert.equal(active, 0);
});
