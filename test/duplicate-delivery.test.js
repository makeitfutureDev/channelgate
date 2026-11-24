// Slack redelivers an event envelope it never saw acked — most visibly across a daemon restart,
// where BOTH in-memory dedupes (the event-id TTL set and the message-trigger claim) die with the
// process. The redelivered copy then lands next to the same message's boot recovery, and the
// gateway asked the user to steer/queue a message they never re-sent ("why is it showing this
// steer card, I didn't type anything"). Run ids encode the triggering message ts, so identity is
// exact: a turn already live under that id IS this message, in both directions of the race.
import path from "node:path";
import { execFileSync } from "node:child_process";
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
const { BUSY_THREAD_STEER_ACTION, BUSY_THREAD_QUEUE_ACTION, BUSY_THREAD_CANCEL_ACTION, busyThreadChoices } = await import("../src/slack/busy-thread-choice.js");
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
      [BUSY_THREAD_QUEUE_ACTION, BUSY_THREAD_STEER_ACTION, BUSY_THREAD_CANCEL_ACTION]);
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

test("a completed native Slack message survives a fresh receiver without blocking a distinct message or a deliberate retry", async () => {
  await setUser(USER, { name: "Dup User", approved: true });
  const client = fakeSlack();
  const event = message("4000.101");
  const options = { botUserId: "U_BOT", teamId: "T_DUP", dedupeTrigger: true };
  const { getDb } = await import("../src/db/index.js");
  const paidTurns = () => getDb().prepare("SELECT COUNT(*) AS count FROM usage WHERE channel_id = ?").get(CHANNEL).count;
  const before = paidTurns();
  await Promise.all([processMessageEvent(event, client, options), processMessageEvent({ ...event, type: "app_mention" }, client, options)]);
  assert.equal(paidTurns(), before + 1);
  const probe = `
    import { claimMessageTrigger } from "./src/slack/message-lifecycle.js";
    const event = JSON.parse(process.argv[1]);
    process.stdout.write(JSON.stringify([
      claimMessageTrigger(event),
      claimMessageTrigger({ ...event, channel: "D_ANOTHER" }),
      claimMessageTrigger({ ...event, ts: "4000.102" }),
    ]));`;
  const fresh = execFileSync(process.execPath, ["--input-type=module", "-e", probe, JSON.stringify(event)], { cwd: projectRoot, encoding: "utf8" });
  assert.deepEqual(JSON.parse(fresh), [false, true, true]);
  await processMessageEvent(event, client, { ...options, dedupeTrigger: false });
  assert.equal(paidTurns(), before + 2, "an explicit internal retry can intentionally run the original event again");
});

test("terminal receipts and recovery rows change atomically and stay bounded to the Slack namespace", async () => {
  const { getDb } = await import("../src/db/index.js");
  const { finishActiveRun, recordActiveRun } = await import("../src/gateway/active-runs.js");
  const { hasCompletedSlackMessage } = await import("../src/slack/message-receipts.js");
  const db = getDb();
  const ts = "4000.201";
  const id = "receipt-rollback";
  recordActiveRun(id, { channelId: CHANNEL, slackMessageTs: ts });
  db.exec(`CREATE TEMP TRIGGER reject_receipt BEFORE INSERT ON inbound_events
    WHEN NEW.namespace = 'slack-terminal-message' BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
  try {
    assert.equal(finishActiveRun(id), false);
    assert.equal(hasCompletedSlackMessage(CHANNEL, ts), false);
    assert.ok(listActiveRuns().some((row) => row.id === id));
  } finally {
    db.exec("DROP TRIGGER reject_receipt");
  }
  const now = Date.now();
  db.prepare(`INSERT INTO inbound_events(namespace, event_id, conversation_id, status, created_ms, data)
    VALUES ('other-fixture', 'untouched', 'another', 'done', 1, '{}'),
           ('slack-terminal-message', 'expired', 'another', 'done', 1, '{}')`).run();
  db.prepare(`WITH RECURSIVE series(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM series WHERE i < 10000)
    INSERT INTO inbound_events(namespace, event_id, conversation_id, status, created_ms, data)
    SELECT 'slack-terminal-message', 'capacity-' || i, 'another', 'done', ?, '{}' FROM series`).run(now - 1000);
  assert.equal(finishActiveRun(id), true);
  assert.equal(hasCompletedSlackMessage(CHANNEL, ts), true);
  assert.equal(listActiveRuns().some((row) => row.id === id), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inbound_events WHERE namespace = 'slack-terminal-message'").get().n, 10000);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inbound_events WHERE event_id = 'expired'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inbound_events WHERE namespace = 'other-fixture'").get().n, 1);
  db.prepare("UPDATE inbound_events SET created_ms = 1 WHERE namespace = 'slack-terminal-message' AND event_id = ?").run(CHANNEL + ":" + ts);
  assert.equal(hasCompletedSlackMessage(CHANNEL, ts), false);
  recordActiveRun(id, { channelId: CHANNEL, slackMessageTs: ts });
  finishActiveRun(id);
  assert.equal(hasCompletedSlackMessage(CHANNEL, ts), true, "a new completion renews an expired receipt");
});
