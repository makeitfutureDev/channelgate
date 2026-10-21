import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const {
  AGENT_DIRECTORY_METADATA_KEY, readAgentDirectoryMetadata, reconcileAgentDirectory,
  prepareDirectoryVerifier, verifyDirectoryChannel, nextAgentDirectoryRefreshDelay,
  startAgentDirectoryRefresh,
} = await import("../src/gateway/agent-directory-refresh.js");
const { createSlackAgentDirectory } = await import("../src/slack/agent-directory.js");

const at = Date.parse("2026-10-21T12:00:00Z");
const info = (type = "group", extra = {}) => ({ type, name: "presentations", purpose: "Build decks", topic: "Sales and workshops", url: "slack://channel?id=CTARGET", ...extra });

function verifierFixture({ source = info(), target = info(), sourceMembers = ["U1", "U2"], targetMembers = ["U1", "U2", "UBOT"] } = {}) {
  const calls = [];
  const directory = {
    async describeConversation({ conversationId }) { calls.push(["info", conversationId]); return conversationId === "CSOURCE" ? source : target; },
    async conversationMembers({ conversationId }) { calls.push(["members", conversationId]); return conversationId === "CSOURCE" ? sourceMembers : targetMembers; },
  };
  return { calls, directory, deps: { now: () => at, connectorFor: () => ({ agentDirectory: directory }) } };
}

test("reconciliation persists only bounded metadata, prunes removed channels and keeps failed descriptors", async () => {
  let stored = JSON.stringify({ channels: { CREMOVED: info(), CFAIL: info("channel", { name: "last-known" }) } });
  const args = {
    now: () => at, read: () => stored,
    write: (key, value) => { assert.equal(key, AGENT_DIRECTORY_METADATA_KEY); stored = value; },
    listChannels: async () => ({ CNEW: {}, CFAIL: {}, DDM: {}, "teams:unsupported": {} }),
    connectorFor: (platform) => platform === "slack" ? { agentDirectory: {
      async describeConversation({ conversationId }) {
        if (conversationId === "CFAIL") throw new Error("network unavailable");
        return info(conversationId === "DDM" ? "im" : "channel", { purpose: "a".repeat(4000), members: ["PRIVATE"], instructions: "NEVER STORE" });
      },
    } } : null,
  };
  assert.deepEqual(await reconcileAgentDirectory(args), { updated: 1, failed: 1, unsupported: 1, removed: 1 });
  const saved = readAgentDirectoryMetadata({ read: () => stored });
  assert.deepEqual(Object.keys(saved).sort(), ["CFAIL", "CNEW"]);
  assert.equal(saved.CNEW.purpose.length, 1000);
  assert.equal(saved.CNEW.verifiedAt, new Date(at).toISOString());
  assert.equal(saved.CFAIL.name, "last-known");
  assert.equal(stored.includes("PRIVATE"), false);
  assert.equal(stored.includes("NEVER STORE"), false);
  const disconnected = await reconcileAgentDirectory({ ...args, connectorFor: () => null });
  assert.equal(disconnected.updated, 0);
  assert.equal(readAgentDirectoryMetadata({ read: () => stored }).CNEW.name, "presentations");
  assert.deepEqual(readAgentDirectoryMetadata({ read: () => "invalid" }), {});
});

test("reconciliation cancellation does not replace the stored cache", async () => {
  let stopped = false;
  let written = false;
  const result = await reconcileAgentDirectory({
    read: () => null, write: () => { written = true; }, now: () => at,
    listChannels: async () => ({ C1: {}, C2: {} }), shouldStop: () => stopped,
    connectorFor: () => ({ agentDirectory: { describeConversation: async () => { stopped = true; return info(); } } }),
  });
  assert.equal(result.cancelled, true);
  assert.equal(written, false);
});

test("live verifier proves entire private source audience, rechecks each search and returns fresh metadata", async () => {
  const f = verifierFixture();
  const verify = await prepareDirectoryVerifier({ createdBy: "U1", channelId: "CSOURCE" }, f.deps);
  const result = await verify({ channelId: "CTARGET" });
  assert.equal(result.visible, true);
  assert.equal(result.name, "presentations");
  assert.equal(result.description, "Build decks — Sales and workshops");
  assert.equal(result.verifiedAt, new Date(at).toISOString());
  f.directory.conversationMembers = async ({ conversationId }) => conversationId === "CSOURCE" ? ["U1", "U2", "U3"] : ["U1", "U2"];
  assert.equal(await verifyDirectoryChannel({ createdBy: "U1", channelId: "CSOURCE", entry: { channelId: "CTARGET" } }, f.deps), null);
});

test("private recommendations fail closed for public/shared sources, removed members, unknown types and DMs", async () => {
  for (const options of [
    { source: info("channel") }, { source: info("group", { shared: true }) },
    { targetMembers: ["U1"] }, { sourceMembers: ["U2"] }, { source: info("mpim") },
    { source: info("") }, { source: info("im"), sourceMembers: ["U1", "U2", "U3"] },
    { target: info("im") }, { target: info("mpim") }, { target: info("group", { archived: true }) },
  ]) {
    const f = verifierFixture(options);
    assert.equal(await verifyDirectoryChannel({ createdBy: "U1", channelId: "CSOURCE", entry: { channelId: "CTARGET" } }, f.deps), null, JSON.stringify(options));
  }
  const f = verifierFixture({ source: info("im"), sourceMembers: ["U1", "UBOT"] });
  assert.equal((await verifyDirectoryChannel({ createdBy: "U1", channelId: "CSOURCE", entry: { channelId: "CTARGET" } }, f.deps)).visible, true);
  assert.equal(await verifyDirectoryChannel({ createdBy: "U1", channelId: "CSOURCE", entry: { channelId: "teams:other" } }, f.deps), null);
  assert.equal(await verifyDirectoryChannel({ createdBy: "U1", channelId: "CSOURCE", entry: { channelId: "CSOURCE" } }, f.deps), null, "DMs cannot list themselves");
  assert.equal((await verifyDirectoryChannel({ createdBy: "U1", channelId: "CSOURCE", entry: { channelId: "CSOURCE" } }, verifierFixture().deps)).visible, true, "channel directory includes its own agent");
});

test("unsupported or unavailable live membership never uses cached metadata as authority", async () => {
  const ctx = { createdBy: "U1", channelId: "CSOURCE", entry: { channelId: "CTARGET" } };
  assert.equal(await verifyDirectoryChannel(ctx, { connectorFor: () => null }), null);
  const f = verifierFixture();
  f.directory.conversationMembers = async () => { throw new Error("missing_scope"); };
  assert.equal(await verifyDirectoryChannel(ctx, f.deps), null);
  f.directory.conversationMembers = async () => [];
  assert.equal(await verifyDirectoryChannel(ctx, f.deps), null);
});

test("Slack adapter paginates rosters, validates info and fails closed for malformed/cyclic/truncated responses", async () => {
  const calls = [];
  const adapter = createSlackAgentDirectory({ conversations: {
    info: async () => ({ channel: { id: "C1", name: "decks", is_channel: true, is_private: true, is_shared: true, purpose: { value: "Slides" } } }),
    members: async (args) => { calls.push(args); return args.cursor ? { members: ["U2"], response_metadata: {} } : { members: ["U1"], response_metadata: { next_cursor: "page2" } }; },
  } });
  assert.deepEqual(await adapter.conversationMembers({ conversationId: "C1" }), ["U1", "U2"]);
  assert.equal(calls[1].cursor, "page2");
  const result = await adapter.describeConversation({ conversationId: "C1" });
  assert.equal(result.type, "group");
  assert.equal(result.shared, true);
  assert.equal(result.purpose, "Slides");
  assert.equal(result.url, "https://slack.com/app_redirect?channel=C1");
  assert.equal(await adapter.describeConversation({ conversationId: "OTHER" }), null);
  for (const members of [
    async () => ({ members: [], response_metadata: { next_cursor: "again" } }),
    async () => ({ members: ["U1"], ok: false }),
    async () => ({ members: [42] }),
    async () => ({ members: ["U1"], response_metadata: { next_cursor: Math.random().toString() } }),
  ]) assert.equal(await createSlackAgentDirectory({ conversations: { members } }).conversationMembers({ conversationId: "C1" }), null);
  assert.equal(await createSlackAgentDirectory({ conversations: { info: async () => ({ channel: { id: "C1", is_channel: true } }) } }).describeConversation({ conversationId: "C1" }), null);
});

test("daemon timer refreshes immediately, deduplicates overlap, rearms at 03:00 and cancels on stop", async () => {
  const timers = [];
  const cleared = [];
  let release;
  let calls = 0;
  let cancelProbe;
  const controller = startAgentDirectoryRefresh({
    now: () => at,
    reconcile: ({ shouldStop }) => { calls += 1; cancelProbe = shouldStop; return new Promise((resolve) => { release = resolve; }); },
    setTimer: (callback, delay) => { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; },
    clearTimer: (timer) => cleared.push(timer),
  });
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(timers[0].delay, nextAgentDirectoryRefreshDelay(at));
  const overlapping = controller.refresh();
  assert.equal(calls, 1);
  release();
  await overlapping;
  timers[0].callback();
  await Promise.resolve();
  assert.equal(calls, 2);
  controller.stop();
  assert.equal(cancelProbe(), true);
  release();
  await controller.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 1);
  assert.equal(cleared.length, 1);
});

test("local-calendar 03:00 deadline is strictly future, including at the boundary", () => {
  const before = new Date(2026, 9, 21, 2, 59, 59).getTime();
  assert.equal(nextAgentDirectoryRefreshDelay(before), 1000);
  const boundary = new Date(2026, 9, 21, 3).getTime();
  const tomorrow = new Date(2026, 9, 22, 3).getTime();
  assert.equal(nextAgentDirectoryRefreshDelay(boundary), tomorrow - boundary);
});
