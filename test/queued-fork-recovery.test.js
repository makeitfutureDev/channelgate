import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.env.PATH = `${path.join(projectRoot, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
process.env.PROGRESS_VIEW = "shimmer";
const { useFakeRuntime } = await import("./runtime-fake.js");
const runtime = await useFakeRuntime();
const { saveSettings } = await import("../src/config/settings.js");
const { setUser, getChannelEntry } = await import("../src/config/store.js");
const { getSession } = await import("../src/gateway/sessions.js");
const { processMessageEvent } = await import("../src/slack/message-pipeline.js");
const { recordActiveRun, clearActiveRun, takeStaleRuns, reserveRecoveryRuns, recoverRuns } = await import("../src/gateway/active-runs.js");
const { getDb } = await import("../src/db/index.js");
const { runQueue } = await import("../src/slack/message-lifecycle.js");
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const answer = { content: "source finished", engine: "codex", usage: { output_tokens: 1 } };

function slack() {
  const posted = [];
  let nextTs = 2000;
  const ok = async () => ({ ok: true });
  return {
    posted,
    chat: {
      postMessage: async (message) => { posted.push(message); return { ok: true, ts: `${++nextTs}.001` }; },
      getPermalink: async ({ channel, message_ts }) => ({ permalink: `https://slack.test/archives/${channel}/p${String(message_ts).replace(".", "")}` }),
      update: ok, postEphemeral: ok,
    },
    users: { info: async ({ user }) => ({ user: { id: user, real_name: "Recovery User" } }), list: async () => ({ members: [], response_metadata: {} }) },
    conversations: { history: async () => ({ messages: [] }), replies: async () => ({ messages: [], response_metadata: {} }) },
    apiCall: ok,
  };
}

async function fixture(name, engine = "codex") {
  saveSettings({ engine, composioMode: "personal", userAutoApprovalEnabled: false });
  const client = slack();
  const event = { type: "message", channel: `D_RECOVER_FORK_${name}`, channel_type: "im", user: `U_RECOVER_FORK_${name}`, ts: "1000.001", text: "Source task" };
  await setUser(event.user, { name: "Recovery User", approved: true });
  await processMessageEvent(event, client, { botUserId: "UBOT", teamId: "T_RECOVER_FORK" });
  const { slug } = await getChannelEntry(event.channel);
  const sourceId = await getSession(slug, event.ts);
  assert.ok(sourceId);
  const forkEvent = { ...event, thread_ts: event.ts, ts: "1000.003", text: "/fork Explore recovered branch" };
  const key = `${slug}::${event.ts}`;
  const row = {
    id: `${key}::${forkEvent.ts}`, slug, channelId: event.channel, threadKey: event.ts, authorId: event.user,
    queuedFork: { event: forkEvent, botUserId: "UBOT", teamId: "T_RECOVER_FORK" },
  };
  return { client, event, row, key, sourceId };
}

function options(client, extra = {}) {
  return {
    slack: { snapshot: () => ({ connected: true }), getClient: () => client },
    runner: async () => { assert.fail("a queued fork must never be sent to the recovery engine runner"); },
    usageRecorder: async () => {}, deliver: async () => {}, ...extra,
  };
}
const stored = (id) => getDb().prepare("SELECT data FROM active_runs WHERE id=?").get(id);
const roots = (client) => client.posted.filter((m) => !m.thread_ts && /Fork:/.test(m.text || ""));

for (const engine of ["claude", "codex"]) {
  test(`${engine} restart replays queued fork after source recovery, with a new child session`, async () => {
    const f = await fixture(engine, engine);
    const sourceRow = { ...f.row, id: `${f.key}::1000.002`, queuedFork: undefined, text: "finish source" };
    recordActiveRun(sourceRow.id, sourceRow);
    recordActiveRun(f.row.id, f.row);
    const reservations = reserveRecoveryRuns(takeStaleRuns());
    const entered = deferred(); const release = deferred();
    const before = runtime.calls.spawn.length;
    const replay = recoverRuns([], options(f.client, { reservations,
      runner: async ({ text }) => { assert.equal(text, "finish source"); entered.resolve(); await release.promise; return answer; },
    }));
    await entered.promise;
    assert.equal(roots(f.client).length, 0, "fork cannot read or copy the still-running source");
    assert.equal(runQueue.count(f.key), 2);
    release.resolve();
    await replay;
    assert.equal(roots(f.client).length, 1);
    const spawn = runtime.calls.spawn.slice(before).find((call) => call.args.includes(engine === "claude" ? "--fork-session" : "fork"));
    assert.ok(spawn, "recovery uses the real native fork command");
    assert.ok(spawn.args.includes(f.sourceId));
    const child = f.client.posted.find((m) => /↪️ Fork of/.test(m.text || ""));
    const childId = await getSession(f.row.slug, child.thread_ts);
    assert.ok(childId);
    assert.notEqual(childId, f.sourceId);
    assert.equal(await getSession(f.row.slug, f.row.threadKey), f.sourceId);
    assert.equal(stored(f.row.id), undefined);
    assert.equal(stored(sourceRow.id), undefined);
    assert.equal(runQueue.count(f.key), 0);
  });
}

test("queued fork recovery rechecks revoked author access before creating a child", async () => {
  const f = await fixture("revoked");
  recordActiveRun(f.row.id, f.row);
  const reservations = reserveRecoveryRuns(takeStaleRuns());
  await setUser(f.event.user, { approved: false });
  const before = runtime.calls.spawn.length;
  await recoverRuns([], options(f.client, { reservations }));
  assert.equal(roots(f.client).length, 0);
  assert.equal(runtime.calls.spawn.length, before);
  assert.ok(f.client.posted.some((m) => /Sorry/.test(m.text || "")));
  assert.equal(stored(f.row.id), undefined);
  assert.equal(runQueue.count(f.key), 0);
});

test("queued fork recovery preserves its accepted command when the Slack message was edited", async () => {
  const f = await fixture("edited");
  let requestHydrations = 0;
  f.client.conversations.replies = async () => {
    requestHydrations++;
    return { messages: [{ ...f.row.queuedFork.event, text: "Edited into an ordinary message" }], response_metadata: {} };
  };
  recordActiveRun(f.row.id, f.row);
  await recoverRuns(takeStaleRuns(), options(f.client));
  assert.equal(requestHydrations, 0, "accepted fork events must not become ordinary source turns through rehydration");
  assert.equal(roots(f.client).length, 1);
  assert.match(roots(f.client)[0].text, /^↪️ <@U_RECOVER_FORK_edited> Fork: Explore recovered branch$/);
  assert.equal(stored(f.row.id), undefined);
  assert.equal(runQueue.count(f.key), 0);
});

test("Slack redelivery cannot duplicate a fork already reserved for restart recovery", async () => {
  const f = await fixture("redelivered");
  recordActiveRun(f.row.id, f.row);
  const reservations = reserveRecoveryRuns(takeStaleRuns());
  await processMessageEvent(f.row.queuedFork.event, f.client, { botUserId: "UBOT", teamId: "T_RECOVER_FORK" });
  assert.equal(runQueue.count(f.key), 1, "the recovered command keeps its sole source reservation");
  assert.equal(JSON.parse(stored(f.row.id).data).recoveryPending, true);
  await recoverRuns([], options(f.client, { reservations }));
  assert.equal(roots(f.client).length, 1);
  assert.equal(stored(f.row.id), undefined);
  assert.equal(runQueue.count(f.key), 0);
});

test("a real Stop message cancels recovered fork preparation before its child root is posted", async () => {
  const f = await fixture("preparing");
  const reading = deferred(); const release = deferred();
  const originalPermalink = f.client.chat.getPermalink;
  f.client.chat.getPermalink = async (args) => {
    reading.resolve();
    await release.promise;
    return originalPermalink(args);
  };
  recordActiveRun(f.row.id, f.row);
  const replay = recoverRuns(takeStaleRuns(), options(f.client));
  await reading.promise;
  assert.equal(JSON.parse(stored(f.row.id).data).attempts, 1, "claim the bounded attempt before command side effects");
  await processMessageEvent({ ...f.event, thread_ts: f.event.ts, ts: "1000.004", text: "stop" }, f.client, { botUserId: "UBOT" });
  release.resolve();
  await replay;
  assert.equal(roots(f.client).length, 0);
  assert.ok(f.client.posted.some((m) => /Stopped/.test(m.text || "")));
  assert.equal(stored(f.row.id), undefined);
  assert.equal(runQueue.count(f.key), 0);
});

test("Stop while a recovered fork waits cancels it without creating a child", async () => {
  const f = await fixture("stopped");
  const blocker = { aborted: false, controller: new AbortController(), runId: "live-source" };
  await runQueue.acquire(f.key, blocker);
  recordActiveRun(f.row.id, f.row);
  const reservations = reserveRecoveryRuns(takeStaleRuns());
  const replay = recoverRuns([], options(f.client, { reservations }));
  runQueue.abort(f.key);
  runQueue.release(f.key, blocker);
  await replay;
  assert.equal(roots(f.client).length, 0);
  assert.equal(stored(f.row.id), undefined);
  assert.equal(runQueue.count(f.key), 0);
});

test("forced shutdown preserves a queued fork for the next boot without consuming an attempt", async () => {
  const f = await fixture("shutdown");
  recordActiveRun(f.row.id, f.row);
  await recoverRuns(takeStaleRuns(), options(f.client, { forceStopping: () => true }));
  assert.equal(roots(f.client).length, 0);
  assert.ok(stored(f.row.id));
  assert.equal(JSON.parse(stored(f.row.id).data).attempts, undefined);
  assert.equal(runQueue.count(f.key), 0);
  clearActiveRun(f.row.id);
});

test("a repeatedly interrupted queued fork obeys the recovery attempt cap", async () => {
  const f = await fixture("capped");
  recordActiveRun(f.row.id, { ...f.row, attempts: 2 });
  await recoverRuns(takeStaleRuns(), options(f.client));
  assert.equal(roots(f.client).length, 0);
  assert.ok(f.client.posted.some((m) => /stopped retrying/.test(m.text || "")));
  assert.equal(stored(f.row.id), undefined);
  assert.equal(runQueue.count(f.key), 0);
});

