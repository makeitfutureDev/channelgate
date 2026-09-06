import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const [{ getDb, toJson }, { createDurableInbox }] = await Promise.all([
  import("../src/db/index.js"), import("../src/platforms/durable-inbox.js"),
]);
const waitFor = async (predicate) => {
  for (let n = 0; n < 100 && !predicate(); n++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate());
};

function insert(namespace, id, status, stamp, conversation = id) {
  getDb().prepare("INSERT INTO inbound_events(namespace,event_id,conversation_id,status,created_ms,data) VALUES(?,?,?,?,?,?)")
    .run(namespace, id, conversation, status, stamp, toJson({ id }));
}

test("completed history is pruned in bounded sweeps while a transport remains connected", async () => {
  const namespace = "test-periodic-retention";
  let now = Date.now();
  const expiryAge = 8 * 24 * 60 * 60 * 1000;
  for (let n = 0; n < 1200; n++) insert(namespace, `old-${n}`, "done", now - expiryAge);
  insert(namespace, "recent", "done", now);
  const doneCount = () => getDb().prepare("SELECT count(*) AS n FROM inbound_events WHERE namespace=? AND status='done'").get(namespace).n;
  const inbox = createDurableInbox({ namespace, now: () => now, handle: async () => {} });
  try {
    inbox.start();
    assert.equal(doneCount(), 701, "startup removes only one bounded 500-row batch");
    inbox.accept({ id: "work-1", conversationId: "A", payload: {} });
    assert.equal(doneCount(), 201, "the next intake drains another bounded batch");
    inbox.accept({ id: "work-2", conversationId: "B", payload: {} });
    assert.equal(doneCount(), 1, "the recent dedupe record survives");
    now += expiryAge;
    inbox.accept({ id: "work-3", conversationId: "C", payload: {} });
    assert.equal(doneCount(), 0, "expiry is applied without disconnecting or restarting");
  } finally { inbox.stop(); }
});

test("only the first pending event per conversation runs despite a large completed history", async () => {
  const namespace = "test-pending-heads";
  const now = Date.now();
  for (let n = 0; n < 2000; n++) insert(namespace, `done-${n}`, "done", now, "A");
  insert(namespace, "a1", "queued", now, "A");
  insert(namespace, "a2", "queued", now, "A");
  insert(namespace, "b1", "queued", now, "B");
  const seen = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const inbox = createDurableInbox({ namespace, handle: async ({ id }) => { seen.push(id); if (id === "a1") await blocked; } });
  try {
    inbox.start();
    await waitFor(() => seen.includes("b1"));
    assert.deepEqual(seen, ["a1", "b1"]);
    release();
    await waitFor(() => seen.includes("a2"));
    assert.equal(getDb().prepare("SELECT count(*) AS n FROM inbound_events WHERE namespace=? AND status='done'").get(namespace).n >= 2000, true);
  } finally { release(); inbox.stop(); }
});
