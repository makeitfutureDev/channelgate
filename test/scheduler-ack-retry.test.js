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
  const delivered = new Map();
  const attempts = [];
  const client = {
    conversations: { open: async () => failure === "missing-dm" ? {} : { channel: { id: "D_CREATOR" } } },
    chat: { postMessage: async ({ channel, client_msg_id }) => {
      assert.match(client_msg_id, /^[0-9a-f-]{36}$/);
      attempts.push({ channel, client_msg_id });
      if (failure === "throw-dm") throw new Error("Transport temporarily offline");
      if (failure === "empty-notice" || failure === "empty-dm") return {};
      if (!delivered.has(client_msg_id)) delivered.set(client_msg_id, { channel, ts: "1000000000.00000" + (delivered.size + 1) });
      if (failure === "lost-receipt") throw new Error("Slack accepted this request; its response was lost");
      return { ts: delivered.get(client_msg_id).ts };
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
  for (const [minute, fault] of [[2, "throw-dm"], [3, "missing-dm"], [5, "empty-dm"], [9, "lost-receipt"]]) {
    failure = fault;
    await advance(minute);
    assert.equal(saved()?.stage, "sent2", fault);
    assert.deepEqual(stages(), ["sent2"], fault);
  }
  failure = "";
  const attemptsBeforeBackoff = attempts.length;
  await advance(10);
  assert.equal(attempts.length, attemptsBeforeBackoff);
  await advance(17);
  await advance(18);
  assert.equal(saved(), undefined);
  assert.deepEqual(stages(), ["sent2", "dm_done"]);
  assert.deepEqual([...delivered.values()].map(post => post.channel), ["C_REMINDER", "D_CREATOR"]);
  for (const channel of ["C_REMINDER", "D_CREATOR"]) {
    assert.equal(new Set(attempts.filter(p => p.channel === channel).map(p => p.client_msg_id)).size, 1);
  }
  assert.notEqual(attempts[0].client_msg_id, attempts.at(-1).client_msg_id);
});
