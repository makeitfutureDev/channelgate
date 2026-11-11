// Slack redelivers an event envelope it never saw acked — most visibly across a daemon restart,
// where BOTH in-memory dedupes (the event-id TTL set and the message-trigger claim) die with the
// process. The redelivered copy then lands next to the same message's boot recovery, and the
// gateway asked the user to steer/queue a message they never re-sent ("why is it showing this
// steer card, I didn't type anything"). Run ids encode the triggering message ts, so identity is
// exact: a turn already live under that id IS this message, in both directions of the race.
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.env.PATH = `${path.join(projectRoot, "test", "fixtures", "prompt-echo")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
process.env.PROGRESS_VIEW = "shimmer";
const scratch = ensureTestEnv();
process.env.CG_WORKSPACE_DIR = path.join(scratch, "workspaces");

const { useFakeRuntime } = await import("./runtime-fake.js");
await useFakeRuntime();

const { setUser } = await import("../src/config/store.js");
const { processMessageEvent, runQueue } = await import("../src/slack/message-pipeline.js");
const { BUSY_THREAD_STEER_ACTION, BUSY_THREAD_CANCEL_ACTION, busyThreadChoices } = await import("../src/slack/busy-thread-choice.js");
const { listActiveRuns, recoverRuns } = await import("../src/gateway/active-runs.js");

const USER = "U_DUP_DELIVERY";
const CHANNEL = "D_DUP_DELIVERY";
const SLUG = "dm-u_dup_delivery";
const THREAD = "4000.001";

function fakeSlack() {
  const posted = [];
  let seq = 0;
  const ok = async () => ({ ok: true });
  const client = {
    posted,
    chat: {
      postMessage: async (message) => {
        posted.push(message);
        return { ok: true, ts: `bot.${++seq}` };
      },
      update: ok,
      delete: ok,
      postEphemeral: ok,
    },
    users: {
      info: async ({ user }) => ({ user: { id: user, real_name: "Dup User" } }),
      list: async () => ({ members: [{ id: USER, real_name: "Dup User" }], response_metadata: {} }),
    },
    conversations: {
      history: async () => ({ messages: [] }),
      replies: async () => ({ messages: [] }),
      info: async ({ channel }) => ({ channel: { id: channel } }),
      members: async () => ({ members: [USER], response_metadata: {} }),
    },
    apiCall: ok,
  };
  return client;
}

const message = (ts) => ({
  type: "message",
  channel: CHANNEL,
  channel_type: "im",
  user: USER,
  text: "is this done?",
  thread_ts: THREAD,
  ts,
});

test("a redelivered copy of the message already running never asks the user to steer", async () => {
  await setUser(USER, { name: "Dup User", approved: true });
  const client = fakeSlack();
  const event = message("4000.002");
  const runKey = `${SLUG}::${THREAD}`;
  // Exactly what boot recovery re-acquires: the same key, under the run id built from this message.
  const active = { aborted: false, controller: new AbortController(), authorId: USER, runId: `${runKey}::${event.ts}`, recovery: true };
  await runQueue.acquire(runKey, active);
  try {
    await processMessageEvent(event, client, { botUserId: "U_BOT", teamId: "T_DUP" });
    assert.deepEqual(client.posted, [], `the duplicate must be dropped silently, got ${JSON.stringify(client.posted)}`);
  } finally {
    runQueue.release(runKey, active);
  }
});

test("a different message in the same busy thread queues once with optional controls", async () => {
  await setUser(USER, { name: "Dup User", approved: true });
  const client = fakeSlack();
  const event = message("4000.003");
  const runKey = `${SLUG}::${THREAD}`;
  const runId = `${runKey}::${event.ts}`;
  const active = { aborted: false, controller: new AbortController(), authorId: USER, runId: `${runKey}::4000.002` };
  await runQueue.acquire(runKey, active);
  // Processing now stays pending until the automatic queue picks up the message. Awaiting it
  // before releasing this synthetic owner would deadlock the fixture, not test a choice card.
  const followup = processMessageEvent(event, client, { botUserId: "U_BOT", teamId: "T_DUP" });
  try {
    let card;
    for (let attempt = 0; attempt < 200 && !card; attempt++) {
      card = client.posted.find((m) => m.blocks?.some((b) => b.elements?.some((el) => el.action_id === BUSY_THREAD_STEER_ACTION)));
      if (!card) await delay(10);
    }
    assert.ok(card, `a new message must get queued controls, got ${JSON.stringify(client.posted)}`);
    assert.deepEqual(card.blocks.flatMap((b) => b.elements || []).map((b) => b.action_id),
      [BUSY_THREAD_STEER_ACTION, BUSY_THREAD_CANCEL_ACTION]);
    assert.equal(runQueue.isQueued(runKey, runId), true);
    assert.equal(listActiveRuns().filter((r) => r.id === runId).length, 1, "the successor is durable before any click");
    const postedBeforeRedelivery = client.posted.length;
    await processMessageEvent(event, client, { botUserId: "U_BOT", teamId: "T_DUP" });
    assert.equal(runQueue.count(runKey), 2, "redelivery must not enqueue a second copy");
    assert.equal(client.posted.length, postedBeforeRedelivery, "redelivery must not post another card");
    assert.equal(active.controller.signal.aborted, false, "automatic queuing leaves the current owner running");
  } finally {
    runQueue.release(runKey, active);
    await followup;
  }
  assert.equal(runQueue.count(runKey), 0, "the successor runs automatically after its owner releases");
  assert.equal(listActiveRuns().some((r) => r.id === runId), false);
  assert.equal(busyThreadChoices.pendingFor(CHANNEL, event.ts), null, "automatic pickup retires the controls");
  assert.equal(client.posted.filter((m) => String(m.text || "").includes(event.text)).length, 1, "one successor answer is delivered");
});

test("a message already awaiting a choice never gets a second card", async () => {
  const client = fakeSlack();
  const event = message("4000.004");
  const runKey = `${SLUG}::${THREAD}`;
  const active = { aborted: false, controller: new AbortController(), authorId: USER, runId: `${runKey}::4000.002` };
  const choiceId = busyThreadChoices.create({ event, options: { botUserId: "U_BOT", teamId: "T_DUP" } });
  await runQueue.acquire(runKey, active);
  try {
    assert.ok(busyThreadChoices.pendingFor(CHANNEL, event.ts), "the pending card is findable by its message");
    await processMessageEvent(event, client, { botUserId: "U_BOT", teamId: "T_DUP" });
    assert.deepEqual(client.posted, [], `the first card still stands, got ${JSON.stringify(client.posted)}`);
  } finally {
    busyThreadChoices.discard(choiceId);
    runQueue.release(runKey, active);
  }
});

test("boot recovery skips a turn a redelivered message already picked up", async () => {
  // The mirror image: Slack reconnects BEFORE recoverRuns (which needs a client to deliver), so
  // the redelivered copy can win the queue. Replaying it here would answer the same message twice.
  const runKey = `${SLUG}::${THREAD}`;
  const id = `${runKey}::4000.005`;
  const rec = { id, channelId: CHANNEL, slug: SLUG, authorId: USER, threadKey: THREAD, text: "is this done?", attachments: [] };
  const client = fakeSlack();
  const active = { aborted: false, controller: new AbortController(), authorId: USER, runId: id };
  await runQueue.acquire(runKey, active);
  let runs = 0;
  try {
    await recoverRuns([rec], {
      slack: { snapshot: () => ({ connected: true }), getClient: () => client },
      runner: async () => { runs += 1; return { content: "hi", usage: { output_tokens: 1 } }; },
      deliver: async () => {},
    });
    assert.equal(runs, 0, "the live turn owns this message — recovery must not replay it");
    assert.deepEqual(client.posted, [], "and must not announce a pickup that isn't happening");
  } finally {
    runQueue.release(runKey, active);
  }
});
