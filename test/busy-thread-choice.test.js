import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.env.PATH = `${path.join(projectRoot, "test", "fixtures", "prompt-echo")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
process.env.PROGRESS_VIEW = "shimmer";
ensureTestEnv();
const { useFakeRuntime: __useFakeRuntime } = await import("./runtime-fake.js");
await __useFakeRuntime();

const { setUser } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { processMessageEvent, runQueue, stopRunsInChannel } = await import("../src/slack/message-pipeline.js");
const { clearActiveRun, listActiveRuns, recordActiveRun, takeStaleRuns } = await import("../src/gateway/active-runs.js");
const {
  BUSY_THREAD_CANCEL_ACTION,
  BUSY_THREAD_QUEUE_ACTION,
  BUSY_THREAD_STEER_ACTION,
  busyThreadChoices,
  createBusyThreadChoiceStore,
  handleBusyThreadChoice,
  registerBusyThreadChoiceActions,
  steerActiveRun,
} = await import("../src/slack/busy-thread-choice.js");

const USER = "U_BUSY_CHOICE";
const CHANNEL = "D_BUSY_CHOICE";
const THREAD = "3000.001";

function fakeSlack() {
  const posted = [];
  const ephemeral = [];
  const updated = [];
  const deleted = [];
  let seq = 0;
  const ok = async () => ({ ok: true });
  const client = {
    posted,
    chat: {
      postMessage: async (message) => {
        posted.push(message);
        return { ok: true, ts: `bot.${++seq}` };
      },
      update: async (message) => { updated.push(message); return { ok: true }; },
      delete: async (message) => { deleted.push(message); return { ok: true }; },
      postEphemeral: async (message) => { ephemeral.push(message); return { ok: true }; },
    },
    users: {
      info: async ({ user }) => ({ user: { id: user, real_name: "Busy User" } }),
      list: async () => ({ members: [{ id: USER, real_name: "Busy User" }], response_metadata: {} }),
    },
    conversations: {
      history: async () => ({ messages: [] }),
      replies: async () => ({ messages: [] }),
      info: async ({ channel }) => ({ channel: { id: channel } }),
      members: async () => ({ members: [USER], response_metadata: {} }),
    },
    apiCall: ok,
  };
  client.ephemeral = ephemeral;
  client.updated = updated;
  client.deleted = deleted;
  client.chatStream = ({ channel, thread_ts }) => ({
    ts: `stream.${++seq}`,
    append: ok,
    stop: async ({ markdown_text = "" } = {}) => {
      posted.push({ channel, thread_ts, text: markdown_text });
      return { ok: true };
    },
  });
  return client;
}

async function waitForCard(client, thread = THREAD) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const card = client.posted.find((m) => m.thread_ts === thread && m.blocks?.some((b) => b.elements?.some((el) => el.action_id === BUSY_THREAD_STEER_ACTION)));
    if (card) return card;
    await delay(10);
  }
  assert.fail("Queued message controls did not arrive");
}

test("a busy-thread follow-up queues automatically, then Steer interrupts without dispatching it twice", async () => {
  await setUser(USER, { name: "Busy User", approved: true });
  const client = fakeSlack();
  const active = { aborted: false, controller: new AbortController(), authorId: USER };
  const runKey = `dm-u_busy_choice::${THREAD}`;
  await runQueue.acquire(runKey, active);
  const event = {
    type: "message",
    channel: CHANNEL,
    channel_type: "im",
    user: USER,
    text: "change the current task",
    thread_ts: THREAD,
    ts: "3000.002",
  };

  const followup = processMessageEvent(event, client, { botUserId: "U_BOT", teamId: "T_BUSY" });
  const card = await waitForCard(client);
  const steer = card?.blocks.flatMap((block) => block.elements || []).find((button) => button.action_id === BUSY_THREAD_STEER_ACTION);
  assert.ok(steer, `expected a steering card, got ${JSON.stringify(client.posted)}`);

  const selected = handleBusyThreadChoice({
    ack: async () => {},
    body: { user: { id: USER }, channel: { id: CHANNEL }, message: { ts: "bot.choice", thread_ts: THREAD } },
    action: steer,
    client,
  }, { processMessage: processMessageEvent });
  try {
    for (let attempt = 0; attempt < 100 && !active.steered; attempt++) await delay(10);
    assert.equal(active.steered, true);
    assert.equal(active.controller.signal.aborted, true);
    assert.equal(client.updated.some((m) => /Steering/.test(m.text)), true);
    assert.equal(client.updated.some((message) => /Steer selected/.test(String(message.text || ""))), false);
  } finally {
    runQueue.release(runKey, active);
    await selected;
    await followup;
  }
});

test("the queue button consumes its pending message once and re-enters the pipeline", async () => {
  const client = fakeSlack();
  const event = {
    type: "message",
    channel: CHANNEL,
    channel_type: "im",
    user: USER,
    text: "queue this",
    thread_ts: THREAD,
    ts: "3000.003",
  };
  const id = busyThreadChoices.create({ event, options: { botUserId: "U_BOT", teamId: "T_BUSY" } });
  let acked = 0;
  const calls = [];

  await handleBusyThreadChoice({
    ack: async () => { acked += 1; },
    body: { user: { id: USER }, channel: { id: CHANNEL }, message: { ts: "bot.choice", thread_ts: THREAD } },
    action: { action_id: BUSY_THREAD_QUEUE_ACTION, value: id },
    client,
  }, {
    processMessage: async (...args) => {
      calls.push(args);
      args[2].onBusyChoiceAccepted({ runId: "accepted-run", rec: {} });
    },
  });

  assert.equal(acked, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], event);
  assert.equal(calls[0][2].busyChoice, "queue");
  assert.deepEqual(client.deleted, [{ channel: CHANNEL, ts: "bot.choice" }]);
  assert.equal(client.updated.length, 0, "a resolved card must not remain as a second message");
  busyThreadChoices.discard?.(id);
});

test("Slack registers both busy-thread choice actions", () => {
  const registered = [];
  const app = { action: (id, handler) => registered.push({ id, handler }) };
  const processMessage = async () => {};

  registerBusyThreadChoiceActions(app, processMessage);

  assert.deepEqual(registered.map(({ id }) => id), [BUSY_THREAD_STEER_ACTION, BUSY_THREAD_QUEUE_ACTION, BUSY_THREAD_CANCEL_ACTION]);
  assert.ok(registered.every(({ handler }) => typeof handler === "function"));
});

test("steering falls back to aborting a cold Claude or Codex process", async () => {
  const queue = runQueue;
  const key = "busy-choice-cold::thread";
  const active = { aborted: false, steered: false, controller: new AbortController(), authorId: USER };
  await queue.acquire(key, active);
  try {
    assert.equal(steerActiveRun(queue, key, { interruptWarm: () => false }), "aborted");
    assert.equal(active.steered, true);
    assert.equal(active.controller.signal.aborted, true);
    assert.equal(active.aborted, false, "steering is a handoff, not an explicit stop");
  } finally {
    queue.release(key, active);
  }
});

test("warm Claude steering uses the protocol interrupt without aborting its process", async () => {
  const key = "busy-choice-warm::thread";
  const active = { aborted: false, steered: false, controller: new AbortController(), authorId: USER };
  await runQueue.acquire(key, active);
  let interrupts = 0;
  try {
    assert.equal(steerActiveRun(runQueue, key, { interruptWarm: () => { interrupts += 1; return true; } }), "interrupted");
    assert.equal(interrupts, 1);
    assert.equal(active.steered, true);
    assert.equal(active.controller.signal.aborted, false);
  } finally {
    runQueue.release(key, active);
  }
});

test("steering terminalizes the abandoned run before a restart can replay it", async () => {
  const key = "busy-choice-durable-steer::thread";
  const runId = `${key}::message`;
  const active = { runId, aborted: false, steered: false, controller: new AbortController(), authorId: USER };
  recordActiveRun(runId, { channelId: CHANNEL, slug: "busy-choice-durable-steer", authorId: USER, threadKey: "thread", text: "old work" });
  await runQueue.acquire(key, active);
  try {
    assert.equal(steerActiveRun(runQueue, key, { expectedRunId: runId, requesterAuthorId: USER }), "aborted");
    assert.equal(listActiveRuns().some((row) => row.id === runId), false);
    assert.equal(takeStaleRuns().some((row) => row.id === runId), false);
  } finally {
    clearActiveRun(runId);
    runQueue.release(key, active);
  }
});

test("a stale steer choice never interrupts a newer active run", async () => {
  const key = "busy-choice-stale::thread";
  const active = { runId: "newer-run", aborted: false, steered: false, controller: new AbortController(), authorId: USER };
  await runQueue.acquire(key, active);
  try {
    assert.equal(steerActiveRun(runQueue, key, { expectedRunId: "original-run", interruptWarm: () => true }), "changed");
    assert.equal(active.steered, false);
    assert.equal(active.controller.signal.aborted, false);
  } finally {
    runQueue.release(key, active);
  }
});

test("a different author cannot steer the active owner's run", async () => {
  const key = "busy-choice-other-author::thread";
  const active = { runId: "owned-run", aborted: false, steered: false, controller: new AbortController(), authorId: "U_ORIGINAL" };
  await runQueue.acquire(key, active);
  try {
    assert.equal(steerActiveRun(runQueue, key, { expectedRunId: active.runId, requesterAuthorId: USER, interruptWarm: () => true }), "other-author");
    assert.equal(active.steered, false);
    assert.equal(active.controller.signal.aborted, false);
  } finally {
    runQueue.release(key, active);
  }
});

test("only the original author can use a choice and a consumed choice cannot run twice", async () => {
  const client = fakeSlack();
  const event = { type: "message", channel: CHANNEL, channel_type: "im", user: USER, text: "once", thread_ts: THREAD, ts: "3000.004" };
  const id = busyThreadChoices.create({ event, options: {} });
  const calls = [];
  const click = (user) => handleBusyThreadChoice({
    ack: async () => {},
    body: { user: { id: user }, channel: { id: CHANNEL }, message: { ts: "bot.choice", thread_ts: THREAD } },
    action: { action_id: BUSY_THREAD_QUEUE_ACTION, value: id },
    client,
  }, { processMessage: async (...args) => {
    calls.push(args);
    const options = args[2];
    const runId = `accepted::${event.ts}`;
    const accepted = await options.onBusyChoiceAccepted?.({
      runId,
      rec: { channelId: CHANNEL, slug: "dm-u_busy_choice", authorId: USER, threadKey: THREAD, text: event.text },
    });
    if (accepted) clearActiveRun(runId);
  } });

  assert.equal((await click("U_SOMEONE_ELSE")).reason, "owner");
  assert.equal(calls.length, 0);
  assert.equal((await click(USER)).ok, true);
  assert.equal(calls.length, 1);
  assert.equal((await click(USER)).reason, "expired");
  assert.equal(calls.length, 1);
  assert.equal(client.ephemeral.length, 2);
});

test("pending choices expire and the store stays bounded", () => {
  let clock = 1000;
  const store = createBusyThreadChoiceStore({ ttlMs: 100, maxEntries: 2, now: () => clock });
  const record = (ts) => ({ event: { user: USER, ts } });
  const first = store.create(record("1"));
  store.create(record("2"));
  store.create(record("3"));
  assert.equal(store.size(), 2);
  assert.equal(store.take(first, USER).reason, "expired", "the oldest choice is evicted at the cap");
  clock += 101;
  assert.equal(store.size(), 0);
});

test("an outstanding choice survives a fresh store instance like a daemon restart", () => {
  const beforeRestart = createBusyThreadChoiceStore();
  const event = { type: "message", channel: CHANNEL, channel_type: "im", user: USER, text: "survive restart", thread_ts: THREAD, ts: "3000.005" };
  const id = beforeRestart.create({ event, options: { botUserId: "U_BOT" } });
  assert.equal(beforeRestart.take(id, USER).ok, true, "the pre-restart daemon may have ACKed the click");
  const stale = takeStaleRuns();
  assert.equal(stale.some((rec) => rec.id === id), false, "boot recovery must retain, not auto-run, pending choices");
  const afterRestart = createBusyThreadChoiceStore();
  const outcome = afterRestart.take(id, USER);
  try {
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.record.event, event);
  } finally {
    afterRestart.release?.(id);
    afterRestart.discard?.(id);
  }
});

test("acceptance atomically replaces the pending choice with a recoverable active run", () => {
  const store = createBusyThreadChoiceStore();
  const event = { type: "message", channel: CHANNEL, channel_type: "im", user: USER, text: "accept durably", thread_ts: THREAD, ts: "3000.0055" };
  const id = store.create({ event, options: {} });
  const runId = "dm-u_busy_choice::3000.001::3000.0055";
  assert.equal(store.take(id, USER).ok, true);
  assert.equal(store.accept(id, runId, { channelId: CHANNEL, slug: "dm-u_busy_choice", authorId: USER, threadKey: THREAD, text: event.text }), true);
  assert.equal(createBusyThreadChoiceStore().take(id, USER).ok, false);
  const stale = takeStaleRuns();
  assert.equal(stale.some((rec) => rec.id === runId && rec.text === event.text), true);
});

test("stop invalidates unresolved choice cards before they can launch", async () => {
  const client = fakeSlack();
  const event = { type: "message", channel: CHANNEL, channel_type: "im", user: USER, text: "discard me", thread_ts: THREAD, ts: "3000.006" };
  const id = busyThreadChoices.create({ event, options: {} });
  const stopped = await stopRunsInChannel(client, CHANNEL, "dm-u_busy_choice", USER, THREAD);
  assert.equal(stopped, 1);
  assert.equal(busyThreadChoices.take(id, USER).ok, false);
  assert.equal(client.posted.some((message) => /discarded.*pending/i.test(String(message.text || ""))), true);
});

test("stop aborts the active engine before waiting on Slack notices", async () => {
  const client = fakeSlack();
  let releasePosts;
  const postsReleased = new Promise((resolve) => { releasePosts = resolve; });
  client.chat.postMessage = async (message) => {
    client.posted.push(message);
    await postsReleased;
    return { ok: true, ts: "bot.stop" };
  };
  const thread = "3000.007";
  const runKey = `dm-u_busy_choice::${thread}`;
  const active = { runId: `${runKey}::message`, aborted: false, controller: new AbortController(), authorId: USER };
  await runQueue.acquire(runKey, active);
  const id = busyThreadChoices.create({
    event: { type: "message", channel: CHANNEL, channel_type: "im", user: USER, text: "pending stop", thread_ts: thread, ts: "3000.008" },
    options: {},
  });

  const stopping = stopRunsInChannel(client, CHANNEL, "dm-u_busy_choice", USER, thread);
  try {
    assert.equal(active.controller.signal.aborted, true, "engine abort must not wait for a Slack API call");
    assert.equal(active.aborted, true);
  } finally {
    releasePosts();
    await stopping;
    busyThreadChoices.discard(id);
    runQueue.release(runKey, active);
  }
});

test("Add to Queue leaves the active run untouched and executes after it releases", async () => {
  process.env.PATH = `${path.join(projectRoot, "test", "fixtures", "prompt-echo")}${path.delimiter}${process.env.PATH || ""}`;
  saveSettings({ engine: "claude", composioMode: "personal" });
  await setUser(USER, { name: "Busy User", approved: true });
  const client = fakeSlack();
  const thread = "3050.001";
  const runKey = `dm-u_busy_choice::${thread}`;
  const active = { aborted: false, steered: false, controller: new AbortController(), authorId: USER };
  await runQueue.acquire(runKey, active);
  const event = { type: "message", channel: CHANNEL, channel_type: "im", user: USER, text: "queued task", thread_ts: thread, ts: "3050.002" };
  const choiceId = busyThreadChoices.create({ event, options: { botUserId: "U_BOT", teamId: "T_BUSY" } });
  const queue = { action_id: BUSY_THREAD_QUEUE_ACTION, value: choiceId };

  const selected = handleBusyThreadChoice({
    ack: async () => {},
    body: { user: { id: USER }, channel: { id: CHANNEL }, message: { ts: "bot.choice", thread_ts: thread } },
    action: queue,
    client,
  }, { processMessage: processMessageEvent });
  for (let attempt = 0; attempt < 100 && runQueue.count(runKey) !== 2; attempt++) await delay(10);
  assert.equal(runQueue.count(runKey), 2);
  assert.equal(active.steered, false);
  assert.equal(active.controller.signal.aborted, false);
  runQueue.release(runKey, active);
  await selected;
  assert.equal(client.posted.some((message) => /queued task/.test(String(message.text || ""))), true);
  assert.deepEqual(client.deleted, [{ channel: CHANNEL, ts: "bot.choice" }]);
});

test("Cancel Request drops the pending message without touching the active run", async () => {
  const client = fakeSlack();
  const thread = "3125.001";
  const runKey = `dm-u_busy_choice::${thread}`;
  const active = { aborted: false, steered: false, controller: new AbortController(), authorId: USER };
  await runQueue.acquire(runKey, active);
  const event = { type: "message", channel: CHANNEL, channel_type: "im", user: USER, text: "never mind", thread_ts: thread, ts: "3125.002" };
  const id = busyThreadChoices.create({ event, options: {} });
  const calls = [];
  try {
    const outcome = await handleBusyThreadChoice({
      ack: async () => {},
      body: { user: { id: USER }, channel: { id: CHANNEL }, message: { ts: "bot.cancel", thread_ts: thread } },
      action: { action_id: BUSY_THREAD_CANCEL_ACTION, value: id },
      client,
    }, { processMessage: async (...args) => { calls.push(args); } });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.choice, "cancel");
    assert.equal(calls.length, 0, "a cancelled message must never re-enter the pipeline");
    assert.equal(active.steered, false);
    assert.equal(active.aborted, false);
    assert.equal(active.controller.signal.aborted, false, "cancel drops the new message, not the running turn");
    assert.equal(runQueue.count(runKey), 1);
    const card = client.updated.find((message) => message.ts === "bot.cancel");
    assert.ok(card, `expected the card to be replaced, got ${JSON.stringify(client.updated)}`);
    assert.match(String(card.text), /cancelled/i);
    assert.deepEqual(card.blocks, []);
  } finally {
    runQueue.release(runKey, active);
  }
});

test("a cancelled choice is durably gone and cannot be replayed after a restart", async () => {
  const client = fakeSlack();
  const event = { type: "message", channel: CHANNEL, channel_type: "im", user: USER, text: "cancel durably", thread_ts: THREAD, ts: "3125.003" };
  const id = busyThreadChoices.create({ event, options: {} });
  await handleBusyThreadChoice({
    ack: async () => {},
    body: { user: { id: USER }, channel: { id: CHANNEL }, message: { ts: "bot.cancel2", thread_ts: THREAD } },
    action: { action_id: BUSY_THREAD_CANCEL_ACTION, value: id },
    client,
  }, { processMessage: async () => { throw new Error("cancelled messages must not run"); } });

  assert.equal(createBusyThreadChoiceStore().take(id, USER).ok, false, "the pending row is deleted, not merely claimed");
  assert.equal(takeStaleRuns().some((rec) => rec.id === id), false, "boot recovery must not resurrect a cancelled message");
  const second = await handleBusyThreadChoice({
    ack: async () => {},
    body: { user: { id: USER }, channel: { id: CHANNEL }, message: { ts: "bot.cancel2", thread_ts: THREAD } },
    action: { action_id: BUSY_THREAD_CANCEL_ACTION, value: id },
    client,
  }, { processMessage: async () => { throw new Error("cancelled messages must not run"); } });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "expired");
});

test("only the pending message's author can cancel it", async () => {
  const client = fakeSlack();
  const event = { type: "message", channel: CHANNEL, channel_type: "im", user: USER, text: "mine to cancel", thread_ts: THREAD, ts: "3125.004" };
  const id = busyThreadChoices.create({ event, options: {} });
  try {
    const outcome = await handleBusyThreadChoice({
      ack: async () => {},
      body: { user: { id: "U_SOMEONE_ELSE" }, channel: { id: CHANNEL }, message: { ts: "bot.cancel3", thread_ts: THREAD } },
      action: { action_id: BUSY_THREAD_CANCEL_ACTION, value: id },
      client,
    }, { processMessage: async () => { throw new Error("must not run"); } });
    assert.equal(outcome.reason, "owner");
    assert.equal(busyThreadChoices.take(id, USER).ok, true, "the owner's choice survives someone else's click");
  } finally {
    busyThreadChoices.release(id);
    busyThreadChoices.discard(id);
  }
});

test("an idle thread runs immediately without a choice card", async () => {
  process.env.PATH = `${path.join(projectRoot, "test", "fixtures", "prompt-echo")}${path.delimiter}${process.env.PATH || ""}`;
  saveSettings({ engine: "claude", composioMode: "personal" });
  await setUser(USER, { name: "Busy User", approved: true });
  const client = fakeSlack();
  await processMessageEvent({ type: "message", channel: CHANNEL, channel_type: "im", user: USER, text: "idle task", ts: "3075.001" }, client, { botUserId: "U_BOT", teamId: "T_BUSY" });
  assert.equal(client.posted.some((message) => Array.isArray(message.blocks)), false);
  assert.equal(client.posted.some((message) => /idle task/.test(String(message.text || ""))), true);
});

test("Steer Conversation interrupts a cold Claude child quietly and runs the selected message next", async () => {
  process.env.PATH = `${path.join(projectRoot, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
  saveSettings({ engine: "claude", composioMode: "personal" });
  await setUser(USER, { name: "Busy User", approved: true });
  const client = fakeSlack();
  const root = {
    type: "message",
    channel: CHANNEL,
    channel_type: "im",
    user: USER,
    text: "CLAUDE_STUB_WAIT_FOR_CANCEL",
    ts: "3085.001",
  };
  const first = processMessageEvent(root, client, { botUserId: "U_BOT", teamId: "T_BUSY" });
  const runKey = "dm-u_busy_choice::3085.001";
  for (let attempt = 0; attempt < 200 && !runQueue.isActive(runKey); attempt++) await delay(10);
  assert.equal(runQueue.isActive(runKey), true);

  const followUp = { ...root, text: "replacement Claude task", thread_ts: root.ts, ts: "3085.002" };
  const successor = processMessageEvent(followUp, client, { botUserId: "U_BOT", teamId: "T_BUSY" });
  const card = await waitForCard(client, root.ts);
  const steer = card?.blocks.flatMap((block) => block.elements || []).find((button) => button.action_id === BUSY_THREAD_STEER_ACTION);
  assert.ok(steer);
  await handleBusyThreadChoice({
    ack: async () => {},
    body: { user: { id: USER }, channel: { id: CHANNEL }, message: { ts: "bot.choice", thread_ts: root.ts } },
    action: steer,
    client,
  }, { processMessage: processMessageEvent });
  await Promise.all([first, successor]);

  assert.equal(client.updated.some((m) => /Steering/.test(m.text)), true);
  assert.equal(client.posted.some((message) => /Something went wrong/.test(String(message.text || ""))), false);
  assert.equal(client.posted.filter((message) => /Stub engine reply/.test(String(message.text || ""))).length, 1);
  assert.equal(runQueue.isActive(runKey), false);
});

test("Steer Conversation interrupts Codex quietly and runs the selected message next", async () => {
  process.env.PATH = `${path.join(projectRoot, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
  saveSettings({ engine: "codex", composioMode: "personal" });
  await setUser(USER, { name: "Busy User", approved: true });
  const client = fakeSlack();
  const root = {
    type: "message",
    channel: CHANNEL,
    channel_type: "im",
    user: USER,
    text: "CODEX_STUB_WAIT_FOR_CANCEL",
    ts: "3100.001",
  };
  const first = processMessageEvent(root, client, { botUserId: "U_BOT", teamId: "T_BUSY" });
  const runKey = "dm-u_busy_choice::3100.001";
  for (let attempt = 0; attempt < 200 && !runQueue.isActive(runKey); attempt++) await delay(10);
  assert.equal(runQueue.isActive(runKey), true, "Codex turn should be running before the follow-up arrives");

  const followUp = { ...root, text: "replacement task", thread_ts: root.ts, ts: "3100.002" };
  const successor = processMessageEvent(followUp, client, { botUserId: "U_BOT", teamId: "T_BUSY" });
  const card = await waitForCard(client, root.ts);
  const steer = card?.blocks.flatMap((block) => block.elements || []).find((button) => button.action_id === BUSY_THREAD_STEER_ACTION);
  assert.ok(steer, `expected steer button, got ${JSON.stringify(client.posted)}`);
  await handleBusyThreadChoice({
    ack: async () => {},
    body: { user: { id: USER }, channel: { id: CHANNEL }, message: { ts: "bot.choice", thread_ts: root.ts } },
    action: steer,
    client,
  }, { processMessage: processMessageEvent });
  await Promise.all([first, successor]);

  assert.equal(client.updated.some((m) => /Steering/.test(m.text)), true);
  assert.equal(client.posted.some((message) => /Something went wrong/.test(String(message.text || ""))), false);
  assert.equal(client.posted.filter((message) => /Codex stub reply/.test(String(message.text || ""))).length, 1);
  assert.equal(runQueue.isActive(runKey), false);
});

for (const choice of ["automatic", "cancel", "stale"]) {
  test(`auto-queued message: ${choice} preserves the active run and cannot replay`, async () => {
    process.env.PATH = `${path.join(projectRoot, "test", "fixtures", "prompt-echo")}${path.delimiter}${process.env.PATH || ""}`;
    saveSettings({ engine: "claude", composioMode: "personal" });
    await setUser(USER, { name: "Busy User", approved: true });
    const client = fakeSlack();
    const thread = `auto-${choice}`;
    const runKey = `dm-u_busy_choice::${thread}`;
    const active = { runId: `${runKey}::original`, aborted: false, controller: new AbortController(), authorId: USER };
    await runQueue.acquire(runKey, active);
    const event = { type: "message", channel: CHANNEL, channel_type: "im", user: USER, text: `AUTO-QUEUE-${choice}`, thread_ts: thread, ts: `${thread}.2` };
    const successor = processMessageEvent(event, client, { botUserId: "U_BOT", teamId: "T_BUSY" });
    const card = await waitForCard(client, thread);
    const buttons = card.blocks.flatMap((b) => b.elements || []);
    assert.deepEqual(buttons.map((b) => b.action_id), [BUSY_THREAD_STEER_ACTION, BUSY_THREAD_CANCEL_ACTION]);
    assert.equal(runQueue.count(runKey), 2);
    assert.equal(active.controller.signal.aborted, false);
    const runId = `${runKey}::${event.ts}`;
    assert.equal(listActiveRuns().some((r) => r.id === runId), true);
    await processMessageEvent(event, client, { botUserId: "U_BOT", teamId: "T_BUSY" });
    assert.equal(runQueue.count(runKey), 2, "redelivery must not enqueue twice");
    const click = (action) => handleBusyThreadChoice({ ack: async () => {},
      body: { user: { id: USER }, channel: { id: CHANNEL }, message: { ts: "bot.control", thread_ts: thread } },
      action, client }, { processMessage: processMessageEvent });
    if (choice === "cancel") {
      const cancelled = await click(buttons[1]);
      assert.equal(cancelled.cancelled, true);
      assert.equal(runQueue.count(runKey), 1);
      assert.equal(listActiveRuns().some((r) => r.id === runId), false);
      assert.equal(active.controller.signal.aborted, false);
      await successor;
    }
    runQueue.release(runKey, active);
    await successor;
    const answer = client.posted.filter((m) => String(m.text).includes(`AUTO-QUEUE-${choice}`));
    assert.equal(answer.length, choice === "cancel" ? 0 : 1);
    const stale = await click(buttons[1]);
    assert.equal(stale.ok, false);
    assert.equal(runQueue.count(runKey), 0);
    assert.equal(busyThreadChoices.list().some((r) => r.queuedRunId === runId), false);
  });
}

test("queue controls remain available after ten minutes", () => {
  let time = 1000;
  const store = createBusyThreadChoiceStore({ now: () => time });
  const event = { channel: CHANNEL, user: USER, ts: "queue-long", thread_ts: "queue-long" };
  const id = store.create({ event, queuedRunId: "long-queue-run" });
  time += 11 * 60 * 1000;
  assert.equal(store.take(id, USER).ok, true);
  store.discard(id);
});

for (const changedOwner of [false, true]) {
  test(`rejected queued Steer keeps Cancel usable (${changedOwner ? "new run" : "other author"})`, async () => {
    const client = fakeSlack();
    const thread = `reject-${changedOwner}`;
    const key = `dm-u_busy_choice::${thread}`;
    const active = { runId: "active-new", authorId: changedOwner ? USER : "OTHER", controller: new AbortController() };
    const queued = { runId: `${key}::queued`, authorId: USER };
    await runQueue.acquire(key, active);
    const waiting = runQueue.acquire(key, queued);
    recordActiveRun(queued.runId, { channelId: CHANNEL, slug: "dm-u_busy_choice", threadKey: thread, authorId: USER, text: "queued" });
    const id = busyThreadChoices.create({ event: { channel: CHANNEL, user: USER, thread_ts: thread, ts: `${thread}.2` },
      runKey: key, queuedRunId: queued.runId, targetRunId: changedOwner ? "old-run" : active.runId });
    const click = (action_id, user = USER) => handleBusyThreadChoice({ ack: async () => {}, client,
      body: { user: { id: user }, channel: { id: CHANNEL }, message: { ts: "bot.card", thread_ts: thread } },
      action: { action_id, value: id } }, { processMessage: () => assert.fail("must not re-enter pipeline") });
    try {
      assert.equal((await click(BUSY_THREAD_CANCEL_ACTION, "OUTSIDER")).ok, false);
      assert.equal((await click(BUSY_THREAD_STEER_ACTION)).accepted, false);
      assert.equal(active.controller.signal.aborted, false);
      assert.equal(busyThreadChoices.list().some((r) => r.id === id), true);
      assert.equal(client.updated.at(-1).blocks[1].elements.length, 2);
      assert.equal((await click(BUSY_THREAD_CANCEL_ACTION)).cancelled, true);
      assert.equal(queued.aborted, true);
      assert.equal(listActiveRuns().some((r) => r.id === queued.runId), false);
      assert.equal(active.controller.signal.aborted, false);
    } finally {
      runQueue.release(key, active);
      await waiting;
      busyThreadChoices.discard(id);
      clearActiveRun(queued.runId);
    }
  });
}

test("failed queued-card delivery still runs the accepted message automatically", async () => {
  const client = fakeSlack();
  const post = client.chat.postMessage;
  client.chat.postMessage = async (m) => {
    if (m.blocks?.some((b) => b.elements?.some((el) => el.action_id === BUSY_THREAD_STEER_ACTION))) throw new Error("Slack unavailable");
    return post(m);
  };
  const thread = "no-card";
  const key = `dm-u_busy_choice::${thread}`;
  const active = { runId: `${key}::first`, authorId: USER };
  await runQueue.acquire(key, active);
  const successor = processMessageEvent({ type: "message", channel: CHANNEL, channel_type: "im", user: USER,
    text: "CARD-FAILED-PICKUP", thread_ts: thread, ts: `${thread}.2` }, client, { botUserId: "U_BOT", teamId: "T_BUSY" });
  for (let attempt = 0; attempt < 200 && runQueue.count(key) < 2; attempt++) await delay(10);
  assert.equal(runQueue.count(key), 2);
  runQueue.release(key, active);
  await successor;
  assert.equal(client.posted.filter((m) => String(m.text).includes("CARD-FAILED-PICKUP")).length, 1);
});


test("a queued Cancel racing promotion reports already started without stopping executing work", async () => {
  const client = fakeSlack();
  const key = "stale-promoted::thread";
  const active = { runId: "promoted", authorId: USER, controller: new AbortController() };
  await runQueue.acquire(key, active);
  const id = busyThreadChoices.create({ event: { channel: CHANNEL, user: USER, ts: "promoted", thread_ts: "thread" },
    runKey: key, queuedRunId: active.runId, targetRunId: "predecessor" });
  try {
    const result = await handleBusyThreadChoice({ ack: async () => {}, client,
      body: { user: { id: USER }, channel: { id: CHANNEL }, message: { ts: "bot.promoted", thread_ts: "thread" } },
      action: { action_id: BUSY_THREAD_CANCEL_ACTION, value: id } }, { processMessage: () => assert.fail("no replay") });
    assert.equal(result.cancelled, false);
    assert.match(client.updated.at(-1).text, /already started/);
    assert.equal(active.controller.signal.aborted, false);
  } finally {
    runQueue.release(key, active);
    busyThreadChoices.discard(id);
  }
});
