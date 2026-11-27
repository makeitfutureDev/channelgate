import assert from "node:assert/strict";
import { runQueue } from "../../src/gateway/thread-turn-owner.ts";

interface Row {
  threadTs: string;
  status: string;
  turnState?: { active: { mine: boolean; origin: string } | null; queued: { mine: boolean; origin: string }[] };
}

export async function verifyTurnStream(request: (suffix: string) => Promise<Response>,
  nextEvent: (reader: ReadableStreamDefaultReader<Uint8Array>) => Promise<{ rows: Row[] }>) {
  const open = async () => {
    const stream = await request("/stream");
    assert.equal(stream.status, 200);
    return stream.body!.getReader();
  };
  const key = "activity-stream::100.000001";
  const voice = { origin: "voice_call", channelId: "C_WORK", threadKey: "100.000001", authorId: "U_MINE" };
  const queued = { ...voice, origin: "slack_foreground", authorId: "U_OTHER" };
  const privateTurn = { ...voice, threadKey: "900.000001" };
  let reader = await open();
  try {
    assert.equal((await nextEvent(reader)).rows[0].status, "idle");
    await runQueue.acquire("other-thread", privateTurn);
    await runQueue.acquire(key, voice);
    const pending = runQueue.acquire(key, queued);
    const { rows } = await nextEvent(reader);
    assert.deepEqual(rows.map(row => row.threadTs), [voice.threadKey]);
    assert.deepEqual(rows[0].turnState?.active, { origin: "voice_call", mine: true });
    assert.deepEqual(rows[0].turnState?.queued, [{ origin: "slack_foreground", mine: false }]);
    assert.equal(rows[0].status, "working");
    await reader.cancel();

    // The browser misses the handoff while disconnected. REST and the first full frame
    // on reconnect must reconstruct the new owner even with polling disabled for the test.
    runQueue.release(key, voice);
    await pending;
    const expected = { origin: "slack_foreground", mine: false };
    const rest = await request("/api/threads");
    assert.equal(rest.status, 200);
    const snapshot = await rest.json() as { rows: Row[] };
    assert.deepEqual(snapshot.rows[0].turnState?.active, expected);
    reader = await open();
    const fresh = await nextEvent(reader);
    assert.deepEqual(fresh.rows[0].turnState, snapshot.rows[0].turnState);
    assert.deepEqual(fresh.rows[0].turnState?.queued, []);
    runQueue.release(key, queued);
    const idle = (await nextEvent(reader)).rows[0];
    assert.equal(idle.turnState, undefined);
    assert.equal(idle.status, "idle");
  } finally {
    await reader.cancel();
    runQueue.release(key, voice);
    runQueue.release(key, queued);
    runQueue.release("other-thread", privateTurn);
  }
}

export async function verifyPendingActivityStream(
  f: { channel: string; thread: string; starter: string; participant: string; members: unknown[] },
  request: (suffix: string) => Promise<Response>,
  nextEvent: (reader: ReadableStreamDefaultReader<Uint8Array>) => Promise<{ rows: Row[] }>,
) {
  const { createDurableInbox } = await import("../../src/platforms/durable-inbox.js");
  const { pendingActivityReader } = await import("../../src/platforms/pending-activity.ts");
  const { registerTransport } = await import("../../src/platforms/live.js");
  const { attachQueuedEventControls } = await import("../../src/platforms/queued-events.js");
  const namespace = "pending-activity-live";
  const heldInbox = { namespace, handle: async () => assert.fail("held inbox dispatched"), isReady: () => false };
  const inbox = createDurableInbox(heldInbox);
  const connector = { api: { listMembers: async () => f.members },
    pendingForActivity: pendingActivityReader([namespace], row => JSON.parse(row.data)) };
  registerTransport("googlechat", { getConnector: () => connector });
  const controls = attachQueuedEventControls(connector, { namespaces: { native: namespace }, authorOf: () => "" });
  inbox.start();
  const add = (id: string, author: string, mentionsBot = true) => inbox.accept({ id, conversationId: JSON.stringify([f.channel, f.thread]),
    payload: { userId: author, conversationId: f.channel, isDM: false, mentionsBot, text: "private inbox payload" } });
  const open = async () => (await request("/stream")).body!.getReader();
  let reader = await open();
  try {
    assert.equal((await nextEvent(reader)).rows[0].turnState, undefined);
    add("first", f.participant);
    add("ignored-author", "users/NOT_APPROVED");
    add("ignored-mention", f.starter, false);
    add("last", f.starter);
    const frame = (await nextEvent(reader)).rows[0];
    assert.deepEqual(frame.turnState?.queued, [
      { origin: "googlechat_foreground", mine: false }, { origin: "googlechat_foreground", mine: true },
    ]);
    assert.doesNotMatch(JSON.stringify(frame.turnState), /private inbox payload|NOT_APPROVED|ignored-mention|participant/i);
    await reader.cancel();
    assert.ok(controls.prioritizeQueuedEvent({ kind: "native", eventId: "last" }));
    reader = await open();
    assert.deepEqual((await nextEvent(reader)).rows[0].turnState?.queued.map(q => q.mine), [true, false]);
    assert.ok(controls.cancelQueuedEvent({ kind: "native", eventId: "first" }));
    const remaining = (await nextEvent(reader)).rows[0].turnState;
    assert.deepEqual(remaining?.queued, [{ origin: "googlechat_foreground", mine: true }]);
    const rest = await request("/api/threads");
    assert.deepEqual((await rest.json()).rows[0].turnState, remaining);
  } finally {
    await reader.cancel();
    inbox.stop();
  }
}
