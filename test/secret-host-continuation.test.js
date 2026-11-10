import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { createSecretHostContinuation } = await import("../src/gateway/secret-host-continuation.js");
const { runQueue } = await import("../src/slack/message-lifecycle.js");
const store = await import("../src/config/store.js");
const { getDb } = await import("../src/db/index.js");
let sequence = 0;
async function fixture() {
  const channelId = `C_WAKE_${++sequence}`;
  const authorId = `U_WAKE_${sequence}`;
  await store.setUser(authorId, { approved: true });
  const entry = await store.upsertChannelEntry(channelId, { name: `wake-${sequence}`, type: "channel", platform: "slack" });
  await store.saveChannelMeta(entry.slug, { ...store.defaultChannelMeta({ channelId, name: entry.name }), access: "open" });
  const action = { kind: "secret_host", channelId, slug: entry.slug, authorId, threadKey: `7000.${sequence}`, secretName: "TEST_TOKEN", host: "api.example.com" };
  return { id: `approval-${sequence}`, action };
}
async function until(predicate) {
  for (let i = 0; i < 200 && !predicate(); i++) await delay(5);
  assert.ok(predicate(), "expected asynchronous state");
}
function status(record) {
  return getDb().prepare("SELECT status FROM inbound_events WHERE namespace = 'secret-host-continuation' AND event_id = ?").get(record.id)?.status;
}

test("approval wakes once, queues behind the source turn, keeps requester and thread, banks every run", async () => {
  const record = await fixture();
  const key = `${record.action.slug}::${record.action.threadKey}`;
  const source = {};
  await runQueue.acquire(key, source);
  const calls = [], delivered = [], banked = [];
  const inbox = createSecretHostContinuation({ target: () => ({}), runner: async (args) => { calls.push(args); return { engine: "codex", content: "Retried" }; },
    deliver: async (_, args) => delivered.push(args), bank: async (args) => banked.push(args) });
  inbox.start();
  try {
    inbox.enqueue(record);
    inbox.enqueue(record);
    await until(() => runQueue.count(key) === 2);
    assert.equal(calls.length, 0);
    runQueue.release(key, source);
    await until(() => status(record) === "done");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].authorId, record.action.authorId);
    assert.equal(calls[0].threadKey, record.action.threadKey);
    assert.equal(calls[0].origin, "continuation");
    assert.match(calls[0].text, /retry the request/);
    assert.equal(delivered[0].threadKey, record.action.threadKey);
    const second = { ...record, id: `${record.id}-second` };
    inbox.enqueue(second);
    await until(() => status(second) === "done");
    assert.equal(banked.length, 2);
    assert.equal(calls.length, 2);
  } finally { runQueue.release(key, source); inbox.stop(); }
});

test("stop while queued cancels the wakeup", async () => {
  const record = await fixture();
  const key = `${record.action.slug}::${record.action.threadKey}`;
  const source = {};
  await runQueue.acquire(key, source);
  let calls = 0;
  const inbox = createSecretHostContinuation({ target: () => ({}), runner: async () => { calls++; } });
  inbox.start();
  try {
    inbox.enqueue(record);
    await until(() => runQueue.count(key) === 2);
    runQueue.abort(key);
    runQueue.release(key, source);
    await until(() => status(record) === "done");
    assert.equal(calls, 0);
  } finally { runQueue.release(key, source); inbox.stop(); }
});

test("revoked requester cannot inherit approver access", async () => {
  const record = await fixture();
  await store.setUser(record.action.authorId, { approved: false });
  let calls = 0;
  const inbox = createSecretHostContinuation({ target: () => ({}), runner: async () => { calls++; } });
  inbox.start();
  try {
    inbox.enqueue(record);
    await until(() => status(record) === "done");
    assert.equal(calls, 0);
  } finally { inbox.stop(); }
});

test("queued approval wakeup survives inbox restart", async () => {
  const record = await fixture();
  let calls = 0;
  const options = { target: () => ({}), runner: async () => { calls++; return { content: "OK" }; }, deliver: async () => {}, bank: async () => {} };
  const first = createSecretHostContinuation(options);
  first.start();
  first.enqueue(record);
  first.stop(); // stop before the queued pump runs
  const recovered = createSecretHostContinuation(options);
  recovered.start();
  try {
    await until(() => status(record) === "done");
    assert.equal(calls, 1);
    recovered.enqueue(record);
    await delay(20);
    assert.equal(calls, 1);
  } finally { recovered.stop(); }
});

test("disconnected destination retains queued wakeup until reconnect", async () => {
  const record = await fixture();
  let ready = false, calls = 0;
  const inbox = createSecretHostContinuation({ target: () => ready ? {} : null,
    runner: async () => { calls++; return { content: "OK" }; }, deliver: async () => {}, bank: async () => {} });
  inbox.start();
  try {
    inbox.enqueue(record);
    await delay(20);
    assert.equal(status(record), "queued");
    assert.equal(calls, 0);
    ready = true;
    inbox.start();
    await until(() => status(record) === "done");
    assert.equal(calls, 1);
  } finally { inbox.stop(); }
});

test("interrupted running wakeup posts a notice without replay", async () => {
  const record = await fixture();
  getDb().prepare("INSERT INTO inbound_events(namespace, event_id, conversation_id, status, created_ms, owner, data) VALUES ('secret-host-continuation', ?, ?, 'running', ?, 'previous-daemon', ?)")
    .run(record.id, record.action.channelId, Date.now(), JSON.stringify(record.action));
  let calls = 0;
  const notices = [];
  const target = { platform: "slack", post: async (args) => { notices.push(args); return { messageId: "notice" }; } };
  const inbox = createSecretHostContinuation({ target: () => target, runner: async () => { calls++; } });
  inbox.start();
  try {
    await until(() => status(record) === "done");
    assert.equal(calls, 0);
    assert.match(notices[0].text, /not run again/);
  } finally { inbox.stop(); }
});

test("foreign platform and legacy approvals do not enter Slack coordination", async () => {
  const record = await fixture();
  const inbox = createSecretHostContinuation();
  inbox.start();
  try {
    assert.equal(inbox.enqueue({ ...record, action: { ...record.action, channelId: "teams:foreign" } }), false);
    assert.equal(inbox.enqueue({ ...record, action: { ...record.action, authorId: "" } }), false);
    assert.equal(status(record), undefined);
  } finally { inbox.stop(); }
});

test("stop or clear terminalizes offline accepted wakeups before acknowledging", async () => {
  const record = await fixture();
  const other = { ...record, id: `${record.id}-other`, action: { ...record.action, threadKey: "other-thread" } };
  const { abortRunsInChannel } = await import("../src/slack/message-pipeline.js");
  let ready = false, calls = 0;
  const inbox = createSecretHostContinuation({ target: () => ready ? {} : null, runner: async () => { calls++; return {}; }, deliver: async () => {}, bank: async () => {} });
  inbox.start();
  try {
    inbox.enqueue(record);
    inbox.enqueue(other);
    const stopped = abortRunsInChannel(record.action.channelId, record.action.slug, record.action.authorId, record.action.threadKey);
    assert.deepEqual(stopped.stoppedRuns, [record.action.threadKey]);
    assert.equal(status(record), "done");
    assert.equal(status(other), "queued", "thread stop preserves other threads");
    abortRunsInChannel(record.action.channelId, record.action.slug, record.action.authorId);
    assert.equal(status(other), "done");
    ready = true;
    inbox.start();
    await delay(20);
    assert.equal(calls, 0);
  } finally { inbox.stop(); }
});

test("stop during execution cannot resurrect the wakeup or post a late answer", async () => {
  const record = await fixture();
  const { abortRunsInChannel } = await import("../src/slack/message-pipeline.js");
  let started = false, finish;
  const waiting = new Promise((resolve) => { finish = resolve; });
  let deliveries = 0;
  const inbox = createSecretHostContinuation({ target: () => ({}), runner: async () => { started = true; await waiting; throw new Error("aborted"); },
    deliver: async () => { deliveries++; }, bank: async () => {} });
  inbox.start();
  try {
    inbox.enqueue(record);
    await until(() => started);
    abortRunsInChannel(record.action.channelId, record.action.slug, record.action.authorId, record.action.threadKey);
    finish();
    await until(() => runQueue.count(`${record.action.slug}::${record.action.threadKey}`) === 0);
    await delay(10);
    assert.equal(status(record), "done");
    assert.equal(deliveries, 0);
  } finally { finish(); inbox.stop(); }
});
