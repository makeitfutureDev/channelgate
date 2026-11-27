import assert from "node:assert/strict";
import test from "node:test";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { runQueue, turnReceipt, reconcileTurnReceipts } = await import("../src/gateway/thread-turn-owner.ts");
const { reserveRecoveryRuns, finishActiveRun } = await import("../src/gateway/active-runs.js");
const { createConversationControls } = await import("../src/platforms/conversation-controls.js");

test("a stable request can acquire a session once across producers and reconnects", async () => {
  const key = "receipt-test::thread";
  const handle = { runId: "native:17", channelId: "C_TEST", threadKey: "1.5", authorId: "U", durable: true, origin: "slack_foreground" };
  const notices: string[] = [];
  const unsub = runQueue.subscribe((k, view) => { if (k === key) notices.push(view.active?.requestId || "idle"); });
  const copy = { ...handle };
  try {
    const first = runQueue.acquire(key, handle);
    await assert.rejects(runQueue.acquire(key, copy), { name: "DuplicateTurnRequest" });
    assert.equal(await first, false);
    runQueue.release(key, copy);
    assert.equal(runQueue.snapshot(key).active?.requestId, handle.runId);
    runQueue.release(key, handle);
    await assert.rejects(runQueue.acquire(key, copy), { name: "DuplicateTurnRequest" });
    assert.deepEqual(notices, [handle.runId, "idle"]);
    assert.equal(turnReceipt(key, handle.runId)?.state, "finished");
  } finally { unsub(); runQueue.release(key, handle); }
});

test("stop pins the native event and preserves the next owner's authorization", async () => {
  const db = getDb();
  const namespace = "msteams-bot:test", eventId = "thread-event", channel = "teams:stable", session = "t";
  db.prepare("INSERT INTO inbound_events(namespace,event_id,conversation_id,status,created_ms,data) VALUES(?,?,?,'running',?,'{}')")
    .run(namespace, eventId, channel, Date.now());
  const key = channel + "::" + session;
  const requestId = JSON.stringify(["inbox", namespace, eventId]);
  db.prepare("INSERT INTO turn_answers(id,platform,state,due_ms,created_ms,payload) VALUES(?,?,'pending',?,?,'{}')")
    .run(requestId, "msteams", Date.now(), Date.now());
  const controller = new AbortController();
  const native = { runId: requestId, channelId: channel, threadKey: session, authorId: "member", origin: "msteams_foreground", controller, durable: true };
  await runQueue.acquire(key, native);
  const other = createConversationControls();
  let successorRan = false;
  const pending = other.execute({ message: { conversationId: channel, userId: "other" }, sessionKey: session,
    queued: async () => {}, work: async () => { successorRan = true; } });
  try {
    assert.equal(other.steerState(channel, session, "member"), "other-author");
    assert.equal(runQueue.snapshot(key).queued.length, 1);
    assert.equal(runQueue.stopActive(key, "stale"), false);
    assert.equal(runQueue.stopActive(key, requestId), true);
    assert.equal(controller.signal.aborted, true);
    assert.equal(turnReceipt(key, requestId)?.state, "cancelled");
    assert.equal(db.prepare("SELECT state FROM turn_answers WHERE id=?").get(requestId)?.state, "cancelled");
    assert.equal(db.prepare("SELECT status FROM inbound_events WHERE namespace=? AND event_id=?").get(namespace, eventId)?.status, "done");
    runQueue.release(key, native);
    assert.equal(runQueue.stopActive(key, requestId), false);
    await pending;
    assert.equal(successorRan, true);
    await assert.rejects(runQueue.acquire(key, { ...native, recovery: true }), { name: "DuplicateTurnRequest" });
  } finally { runQueue.release(key, native); await pending; }
});

test("restart keeps the durable active turn followed by prioritized and FIFO survivors", async () => {
  const db = getDb(), key = "thread-owner-recovery::root";
  const ids = ["running", "ordinary", "steered", "last"];
  for (const [i, id] of ids.entries()) {
    db.prepare("INSERT INTO thread_turn_receipts(owner_key,request_id,origin,state,updated_ms) VALUES(?,?,?,?,?)")
      .run(key, id, "slack_foreground", i ? "queued" : "active", Date.now());
  }
  const stale = [...ids].reverse().map(id => ({ id, slug: "thread-owner-recovery", threadKey: "root", channelId: "C_TEST",
    authorId: "U", queuePriorityAt: id === "steered" ? 1 : 0 }));
  // The producer's recovery list can enumerate a different order from admission.
  const batch = reserveRecoveryRuns(stale);
  try {
    assert.deepEqual(batch.map(r => r.id), ["running", "steered", "ordinary", "last"]);
    for (const item of batch) {
      assert.equal(await item.acquired, null);
      assert.equal(runQueue.snapshot(key).active?.requestId, item.id);
      runQueue.release(key, item.handle);
    }
  } finally { for (const item of batch) { runQueue.release(key, item.handle); finishActiveRun(item.id); } }
  db.prepare("INSERT INTO thread_turn_receipts(owner_key,request_id,origin,state,updated_ms) VALUES(?,?,?,'active',?)")
    .run(key, "gone", "api_foreground", Date.now());
  reconcileTurnReceipts();
  assert.equal(turnReceipt(key, "gone")?.state, "interrupted");
});
