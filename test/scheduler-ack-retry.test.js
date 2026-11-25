import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { addAck, getAcks } = await import("../src/config/acks.js");
const { getDb } = await import("../src/db/index.js");
const { startScheduler, tick } = await import("../src/gateway/scheduler.js");

test("reminder escalation retains failed deliveries and closes once after recovery", async (t) => {
  let failure = "empty-notice";
  const delivered = [];
  const client = {
    conversations: { open: async () => failure === "missing-dm" ? {} : { channel: { id: "D_CREATOR" } } },
    chat: { postMessage: async ({ channel }) => {
      if (failure === "throw-dm") throw new Error("Transport temporarily offline");
      if (failure === "empty-notice" || failure === "empty-dm") return {};
      delivered.push(channel);
      return { ts: "1000000000.00000" + delivered.length };
    } },
  };
  const timer = startScheduler({ slack: { snapshot: () => ({ connected: true }), getClient: () => client }, immediate: false });
  t.after(() => clearInterval(timer));
  const now = Date.now();
  const row = addAck({ channelId: "C_REMINDER", messageTs: "1000000000.000000", createdBy: "U_CREATOR",
    nextAt: new Date(now).toISOString(), dmAfterMin: 1 });
  const saved = () => getAcks().find(a => a.id === row.id);
  const stages = () => getDb().prepare("SELECT data FROM events WHERE event = 'ack_escalate' ORDER BY id").all()
    .map(event => JSON.parse(event.data)).filter(event => event.id === row.id).map(event => event.stage);
  async function advance(minute) {
    await tick(now + minute * 60_000);
    // The ack pass is independent of scheduled runs. Drain the fixture transport's microtasks.
    await setImmediate();
  }

  await advance(0);
  assert.equal(saved()?.stage, "sent1");
  assert.deepEqual(stages(), []);
  failure = "";
  await advance(1);
  assert.equal(saved()?.stage, "sent2");
  for (const [index, fault] of ["throw-dm", "missing-dm", "empty-dm"].entries()) {
    failure = fault;
    await advance(index + 2);
    assert.equal(saved()?.stage, "sent2", fault);
    assert.deepEqual(stages(), ["sent2"], fault);
  }
  failure = "";
  await advance(5);
  await advance(6);
  assert.equal(saved(), undefined);
  assert.deepEqual(stages(), ["sent2", "dm_done"]);
  assert.deepEqual(delivered, ["C_REMINDER", "D_CREATOR"]);
});
