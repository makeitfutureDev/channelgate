import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { createRunRecovery, recordActiveRun, takeStaleRuns, clearActiveRun, listActiveRuns } = await import("../src/gateway/active-runs.js");
const { runQueue } = await import("../src/slack/message-lifecycle.js");
const { createSlackManager } = await import("../src/slack/manager.js");
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((r) => setImmediate(r));
const rec = (name, thread = name) => ({ id: `recovery-${name}`, slug: "recovery-tests", channelId: "C_RECOVERY", authorId: "U_RECOVERY", threadKey: thread, text: name });
const key = (r) => `${r.slug}::${r.threadKey}`;
function setup(records, runner) {
  let connected = false;
  const listeners = new Set(); const notices = []; const progress = []; const delivered = [];
  const client = { chat: { postMessage: async (p) => { notices.push(p); return { ok: true }; } }, chatStream() {}, apiCall() {} };
  const slack = { snapshot: () => ({ connected }), getClient: () => connected ? client : null, onConnected: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
  for (const r of records) recordActiveRun(r.id, r);
  const recovery = createRunRecovery(takeStaleRuns(), { slack, runner, usageRecorder: async () => {},
    progressFactory: (_mode, _client, _channel, thread) => { progress.push(thread); return { onEvent() {}, stop: async () => {} }; },
    directoryResolver: async () => ({ map: new Map(), maxWords: 1 }),
    deliver: async (_client, p) => delivered.push(p),
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
  const r = rec("reconnect"); let calls = 0; const release = deferred();
  const s = setup([r], async () => { calls++; await release.promise; return answer; });
  await s.recovery.start(); assert.equal(calls, 0);
  const first = s.connect(); const second = s.connect(); await tick();
  assert.equal(calls, 1);
  release.resolve(); await Promise.all([first, second]); await tick();
  await s.connect();
  assert.equal(calls, 1);
  assert.equal(s.delivered.length, 1);
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
