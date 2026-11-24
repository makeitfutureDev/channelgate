import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { createRunRecovery, membershipAdmitsRecovery, recordActiveRun, takeStaleRuns, clearActiveRun, listActiveRuns } = await import("../src/gateway/active-runs.js");
const { hasCompletedSlackMessage } = await import("../src/slack/message-receipts.js");
const { runQueue } = await import("../src/slack/message-lifecycle.js");
const { createSlackManager } = await import("../src/slack/manager.js");
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((r) => setImmediate(r));
const rec = (name, thread = name) => ({ id: `recovery-${name}`, slug: "recovery-tests", channelId: "C_RECOVERY", authorId: "U_RECOVERY", threadKey: thread, text: name });
const key = (r) => `${r.slug}::${r.threadKey}`;
function setup(records, runner, extra = {}) {
  let connected = false;
  const listeners = new Set(); const notices = []; const progress = []; const delivered = [];
  const client = { chat: { postMessage: async (p) => { notices.push(p); return { ok: true }; } }, chatStream() {}, apiCall() {} };
  const slack = { snapshot: () => ({ connected }), getClient: () => connected ? client : null, onConnected: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
  for (const r of records) recordActiveRun(r.id, r);
  const recovery = createRunRecovery(takeStaleRuns(), { slack, runner, usageRecorder: async () => {},
    progressFactory: (_mode, _client, _channel, thread) => { progress.push(thread); return { onEvent() {}, stop: async () => {} }; },
    directoryResolver: async () => ({ map: new Map(), maxWords: 1 }),
    deliver: async (_client, p) => delivered.push(p),
    ...extra,
  });
  return { recovery, notices, progress, delivered,
    async connect() { connected = true; await Promise.all([...listeners].map((fn) => fn())); },
  };
}
const answer = { content: "complete", engine: "codex", usage: { output_tokens: 1 } };

test("all restart survivors own their thread before connection; a manual continue stays behind recovery", async () => {
  const r = rec("order"); const entered = deferred(); const release = deferred(); const order = [];
  const s = setup([r], async () => { order.push("recovery"); entered.resolve(); await release.promise; return answer; });
  assert.equal(runQueue.activeHandle(key(r)).runId, r.id);
  const live = { runId: "new-continue", authorId: r.authorId };
  const later = runQueue.acquire(key(r), live).then(() => { order.push("continue"); runQueue.release(key(r), live); });
  await s.recovery.start(); // disconnected: no provider work or consumed retry
  assert.deepEqual(order, []);
  const connecting = s.connect(); await entered.promise;
  assert.deepEqual(order, ["recovery"]);
  release.resolve(); await connecting; await later;
  assert.deepEqual(order, ["recovery", "continue"]);
  assert.equal(runQueue.count(key(r)), 0);
  s.recovery.unsubscribe();
});

test("a slow recovery does not hide progress or prevent independent threads from reaching admission", async () => {
  const records = [rec("slow"), rec("second"), rec("third"), rec("fourth")];
  const release = deferred(); const started = [];
  const s = setup(records, async ({ text }) => { started.push(text); if (text === "slow") await release.promise; return answer; });
  const connecting = s.connect(); await tick(); await tick();
  assert.equal(s.notices.length, 4);
  assert.equal(s.progress.length, 4);
  assert.deepEqual(new Set(started), new Set(["slow", "second", "third", "fourth"]));
  assert.equal(s.delivered.length, 3);
  release.resolve(); await connecting;
  assert.equal(s.delivered.length, 4);
  s.recovery.unsubscribe();
});

test("multiple recovered turns in the same thread retain FIFO order", async () => {
  const records = [rec("fifo-first", "fifo"), rec("fifo-second", "fifo")];
  const release = deferred(); const started = [];
  const s = setup(records, async ({ text }) => { started.push(text); if (text === "fifo-first") await release.promise; return answer; });
  const connecting = s.connect(); await tick();
  assert.deepEqual(started, ["fifo-first"]);
  assert.equal(s.progress.length, 2, "the waiting turn also has visible progress");
  release.resolve(); await connecting;
  assert.deepEqual(started, ["fifo-first", "fifo-second"]);
  s.recovery.unsubscribe();
});

test("recovered shortcut tasks pass their saved model and effort to each runner", async () => {
  const records = ["low", "", "high"].map((effort, index) => ({ ...rec(`shortcut-${index}`, "shortcut"),
    runtimeOverrides: { engine: "codex", model: "gpt-6.1-sol", effort } }));
  const seen = [];
  const s = setup(records, async ({ overrides }) => { seen.push(overrides); return answer; });
  await s.connect();
  assert.deepEqual(seen, records.map(row => row.runtimeOverrides));
  assert.equal(runQueue.count(key(records[0])), 0);
  assert.equal(listActiveRuns().some(row => row.threadKey === "shortcut"), false);
  s.recovery.unsubscribe();
});

test("stop before reconnect cancels the reserved replay without resurrecting its durable row", async () => {
  const r = rec("stopped"); let calls = 0;
  const s = setup([r], async () => { calls++; return answer; });
  runQueue.abort(key(r)); clearActiveRun(r.id);
  await s.connect();
  assert.equal(calls, 0);
  assert.equal(runQueue.count(key(r)), 0);
  assert.equal(listActiveRuns().some((row) => row.id === r.id), false);
  assert.equal(s.notices.length, 0);
  s.recovery.unsubscribe();
});

test("reconnect resumes once without another boot, including concurrent connection notifications", async () => {
  const r = { ...rec("reconnect"), slackMessageTs: "4000.200" }; let calls = 0; const release = deferred();
  const s = setup([r], async () => { calls++; await release.promise; return answer; });
  await s.recovery.start(); assert.equal(calls, 0);
  const first = s.connect(); const second = s.connect(); await tick();
  assert.equal(calls, 1);
  assert.equal(hasCompletedSlackMessage(r.channelId, r.slackMessageTs), false);
  release.resolve(); await Promise.all([first, second]); await tick();
  await s.connect();
  assert.equal(calls, 1);
  assert.equal(s.delivered.length, 1);
  assert.equal(hasCompletedSlackMessage(r.channelId, r.slackMessageTs), true);
  s.recovery.unsubscribe();
});

test("Slack manager publishes successful connection and socket reconnection without blocking lifecycle", async () => {
  const socket = new EventEmitter(); const blocked = deferred(); let calls = 0;
  const manager = createSlackManager({ start: async () => ({ app: { receiver: { client: socket }, client: {}, stop: async () => {} } }) });
  const off = manager.onConnected(() => { calls++; return blocked.promise; });
  await manager.connect({}); assert.equal(calls, 1);
  socket.emit("connected"); assert.equal(calls, 2);
  await manager.disconnect(); socket.emit("connected"); assert.equal(calls, 2);
  blocked.resolve(); off();
});

test("Stop during recovered usage accounting prevents a late final answer", async () => {
  const { recoverRuns } = await import("../src/gateway/active-runs.js");
  const r = rec("stop-accounting"); let finalized = 0; let delivered = 0;
  await recoverRuns([r], {
    slack: { snapshot: () => ({ connected: true }), getClient: () => ({ chat: { postMessage: async () => {} }, chatStream() {}, apiCall() {} }) },
    runner: async () => answer,
    usageRecorder: async () => { runQueue.abort(key(r)); clearActiveRun(r.id); },
    progressFactory: () => ({ ownsFinal: true, onEvent() {}, stop: async () => {}, finalize: async () => { finalized++; } }),
    directoryResolver: async () => ({ map: new Map() }),
    deliver: async () => { delivered++; },
  });
  assert.equal(finalized, 0); assert.equal(delivered, 0);
  assert.equal(runQueue.count(key(r)), 0);
  assert.equal(listActiveRuns().some((row) => row.id === r.id), false);
});

test("a reconnect does not replay attempted work when both delivery and its error notice failed", async () => {
  let notify; let calls = 0;
  const r = rec("failed-delivery"); recordActiveRun(r.id, r);
  const slack = {
    snapshot: () => ({ connected: true }),
    getClient: () => ({ chat: { postMessage: async () => { throw new Error("offline"); } } }),
    onConnected: (fn) => { notify = fn; return () => {}; },
  };
  const recovery = createRunRecovery(takeStaleRuns(), { slack,
    runner: async () => { calls++; return answer; },
    usageRecorder: async () => {}, deliver: async () => { throw new Error("offline"); },
  });
  await recovery.start();
  await notify(); await notify();
  assert.equal(calls, 1, "connection flaps must not replay a tool that may already have written");
  assert.equal(runQueue.count(key(r)), 0);
  clearActiveRun(r.id);
});

test("restart preserves a steered successor ahead of earlier ordinary waiters", async () => {
  const records = [rec("normal-a", "steered"), { ...rec("steered-b", "steered"), queuePriorityAt: 12345 }, rec("normal-c", "steered")];
  const order = [];
  const s = setup(records, async ({ text }) => { order.push(text); return answer; });
  await s.connect();
  assert.deepEqual(order, ["steered-b", "normal-a", "normal-c"]);
  s.recovery.unsubscribe();
});

test("Cancel on recovered waiting work prevents replay while its active predecessor continues", async () => {
  const { busyThreadChoices, applyBusyThreadChoice } = await import("../src/slack/busy-thread-choice.js");
  const active = rec("recovered-active", "cancel-control");
  const queued = rec("recovered-waiting", "cancel-control");
  const release = deferred(); const entered = deferred(); const order = [];
  const s = setup([active, queued], async ({ text }) => {
    order.push(text); entered.resolve(); await release.promise; return answer;
  });
  const event = { channel: active.channelId, user: active.authorId, thread_ts: active.threadKey, ts: "recovered-waiting" };
  const id = busyThreadChoices.create({ event, runKey: key(active), queuedRunId: queued.id, targetRunId: active.id });
  const connecting = s.connect(); await entered.promise;
  const claimed = busyThreadChoices.take(id, active.authorId);
  const result = await applyBusyThreadChoice({ choiceId: id, record: claimed.record, choice: "cancel", client: null });
  assert.equal(result.cancelled, true);
  assert.equal(runQueue.activeHandle(key(active)).controller.signal.aborted, false);
  release.resolve(); await connecting;
  assert.deepEqual(order, ["recovered-active"]);
  assert.equal(listActiveRuns().some((r) => r.id === queued.id), false);
  s.recovery.unsubscribe();
});

test("a survivor whose channel is not verified yet waits in its queue place and is replayed once it is", async () => {
  const gated = rec("membership-gated"); const open = rec("membership-open");
  const verified = new Set([open.id]); const started = [];
  const s = setup([gated, open], async ({ text }) => { started.push(text); return answer; },
    { admit: async (r) => verified.has(r.id), maxHoldMs: 60_000 });
  await s.connect();
  // The open conversation is replayed at once; the gated one neither runs nor fails.
  assert.deepEqual(started, ["membership-open"]);
  const resumed = () => s.notices.filter((n) => /picking it back up/.test(n.text)).length;
  assert.equal(resumed(), 1, "only the open conversation announces a resume");
  assert.equal(s.notices.some((n) => /failed|send it again|resend/i.test(n.text)), false, "nobody is told to send the message again");
  assert.equal(runQueue.activeHandle(key(gated)).runId, gated.id, "it keeps its reserved place in the thread");
  const { getDb } = await import("../src/db/index.js");
  const durable = () => getDb().prepare("SELECT data FROM active_runs WHERE id = ?").get(gated.id);
  assert.equal(JSON.parse(durable().data).recoveryPending, true, "and its durable row, for another restart");
  // A message that arrives meanwhile still queues behind it.
  const order = []; const live = { runId: "membership-later", authorId: gated.authorId };
  const later = runQueue.acquire(key(gated), live).then(() => { order.push("later"); runQueue.release(key(gated), live); });
  await s.recovery.start(); await s.recovery.start();
  assert.deepEqual(started, ["membership-open"], "asking again before verification changes nothing");
  // Verification completes: the daemon calls start() and the survivor runs exactly once.
  verified.add(gated.id);
  await s.recovery.start(); await later;
  assert.deepEqual(started, ["membership-open", "membership-gated"]);
  assert.equal(resumed(), 2);
  assert.equal(s.notices.some((n) => /failed|send it again|resend/i.test(n.text)), false);
  assert.deepEqual(order, ["later"]);
  await s.recovery.start();
  assert.deepEqual(started, ["membership-open", "membership-gated"]);
  assert.equal(runQueue.count(key(gated)), 0);
  assert.equal(durable(), undefined);
  s.recovery.unsubscribe();
});

test("a survivor is not held forever: after the hold window it is replayed and reports its own outcome", async () => {
  const r = rec("membership-expired"); const started = [];
  const s = setup([r], async ({ text }) => { started.push(text); return answer; }, { admit: async () => false, maxHoldMs: 30 });
  await s.connect();
  assert.deepEqual(started, []);
  for (let attempt = 0; attempt < 200 && !started.length; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(started, ["membership-expired"], "the timer replays it without any further event");
  for (let attempt = 0; attempt < 200 && runQueue.count(key(r)); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runQueue.count(key(r)), 0);
  s.recovery.unsubscribe();
});

test("the default admission follows Slack membership and nothing else", async () => {
  const { saveChannelMeta, patchChannelMeta } = await import("../src/config/store.js");
  const { invalidateSlackMembership, confirmSlackMembership } = await import("../src/gateway/channel-membership.js");
  await saveChannelMeta("membership-admit", { channelId: "C_ADMIT", type: "channel" });
  await saveChannelMeta("membership-admit-dm", { channelId: "D_ADMIT", type: "im", isDM: true });
  const channelRun = { slug: "membership-admit", channelId: "C_ADMIT" };
  assert.equal(await membershipAdmitsRecovery(channelRun), true, "no verification in progress");
  assert.equal(await membershipAdmitsRecovery({ slug: "membership-admit-missing", channelId: "C_NONE" }), true, "a missing record is the replay's to report");
  await patchChannelMeta("membership-admit", { botMembership: "pending" });
  assert.equal(await membershipAdmitsRecovery(channelRun), false, "marked pending by the reconnect sweep");
  await patchChannelMeta("membership-admit", { botMembership: "member" });
  const epoch = invalidateSlackMembership();
  assert.equal(await membershipAdmitsRecovery(channelRun), false, "this process has not verified it yet");
  assert.equal(await membershipAdmitsRecovery({ slug: "membership-admit-dm", channelId: "D_ADMIT" }), true, "a DM has no membership to verify");
  await patchChannelMeta("membership-admit", { archived: true, archivedReason: "bot_removed" });
  assert.equal(await membershipAdmitsRecovery(channelRun), true, "an archived channel fails with its own reason, it does not wait");
  await patchChannelMeta("membership-admit", { archived: false, archivedReason: null });
  confirmSlackMembership("C_ADMIT", epoch);
  assert.equal(await membershipAdmitsRecovery(channelRun), true);
});

test("boot order: a Slack-channel survivor is replayed after the real membership pass, never during it", async (t) => {
  const { upsertChannelEntry, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");
  const { createBotMembershipRecovery } = await import("../src/slack/bot-membership.js");
  const { assertChannelMembership } = await import("../src/gateway/channel-membership.js");
  const entry = await upsertChannelEntry("C_RACE", { name: "membership-race", type: "channel", platform: "slack" });
  await saveChannelMeta(entry.slug, { channelId: "C_RACE", type: "channel" });
  const survivor = { id: "recovery-race", slug: entry.slug, channelId: "C_RACE", authorId: "U_RECOVERY", threadKey: "race", text: "race" };
  recordActiveRun(survivor.id, survivor);

  let connected = false;
  const listing = deferred(); const listeners = new Set(); const notices = []; const ran = [];
  const client = {
    chat: { postMessage: async (p) => { notices.push(p); return { ok: true }; } }, chatStream() {}, apiCall() {},
    users: { conversations: async () => { await listing.promise; return { ok: true, channels: [{ id: "C_RACE" }], response_metadata: { next_cursor: "" } }; } },
  };
  const slack = { snapshot: () => ({ connected }), getClient: () => connected ? client : null, onConnected: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
  // The daemon's wiring (src/server.js): the membership pass and the run recovery both listen for
  // the connection, and a completed verification starts whatever recovery was waiting for it.
  let recovery;
  const membership = createBotMembershipRecovery({ slack, onVerified: () => { void recovery.start(); }, log: () => {} });
  t.after(() => membership.stop());
  await membership.invalidate();
  recovery = createRunRecovery(takeStaleRuns(), { slack, usageRecorder: async () => {},
    // What the runtime resolver does first for every turn.
    runner: async () => { assertChannelMembership(await getChannelMeta(entry.slug)); ran.push("race"); return answer; },
    progressFactory: () => ({ onEvent() {}, stop: async () => {} }),
    directoryResolver: async () => ({ map: new Map(), maxWords: 1 }),
    deliver: async () => {},
  });
  slack.onConnected(() => membership.reconcile());
  connected = true;
  const connecting = Promise.all([...listeners].map((fn) => fn()));
  for (let n = 0; n < 20; n++) await tick();
  assert.deepEqual(ran, [], "membership is still being read from Slack");
  assert.equal(notices.some((n) => /failed|membership has not been verified/i.test(n.text)), false, JSON.stringify(notices));
  assert.equal(runQueue.activeHandle(key(survivor)).runId, survivor.id);
  listing.resolve();
  await connecting;
  for (let attempt = 0; attempt < 300 && (!ran.length || runQueue.count(key(survivor))); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(ran, ["race"]);
  assert.equal(notices.some((n) => /failed|membership has not been verified/i.test(n.text)), false, JSON.stringify(notices));
  assert.equal(runQueue.count(key(survivor)), 0);
  recovery.unsubscribe();
});
