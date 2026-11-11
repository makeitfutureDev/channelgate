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
const { recordActiveRun, takeStaleRuns, reserveRecoveryRuns, recoverRuns } = await import("../src/gateway/active-runs.js");
const { getDb } = await import("../src/db/index.js");
const { runQueue } = await import("../src/slack/message-lifecycle.js");

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
const roots = (client) => client.posted.filter((m) => !m.thread_ts && /Fork of/.test(m.text || ""));

test("redelivered fork cannot duplicate a reserved recovery command", async () => {
  const f = await fixture("redelivery");
  const blocker = { aborted: false, controller: new AbortController(), runId: "source-blocker" };
  await runQueue.acquire(f.key, blocker);
  recordActiveRun(f.row.id, f.row);
  const reservations = reserveRecoveryRuns(takeStaleRuns());
  let replay;
  try {
    await processMessageEvent(f.row.queuedFork.event, f.client, { botUserId: "UBOT", dedupeTrigger: true });
    assert.equal(runQueue.count(f.key), 2, "redelivery must not add another fork reservation");
    replay = recoverRuns([], options(f.client, { reservations }));
  } finally { runQueue.release(f.key, blocker); }
  await replay;
  assert.equal(roots(f.client).length, 1);
  assert.equal(stored(f.row.id), undefined);
});

for (const native of [true, false]) {
  test(`${native ? "native" : "cross-engine"} queued fork persists its context before child preflight`, async () => {
    const f = await fixture(native ? "native-handoff" : "cross-handoff");
    if (!native) {
      saveSettings({ engineEnabled: { claude: true, codex: true }, modelShortcuts: { other: { engine: "claude", model: "claude-opus-5-5" } } });
      f.row.queuedFork.event.text = "/fork :other Explore recovered branch";
      f.client.conversations.replies = async () => ({ messages: [
        { user: f.event.user, ts: f.event.ts, text: "Original context" },
        f.row.queuedFork.event,
        { user: "UBOT", ts: "1000.004", text: "LATE-SOURCE-ANSWER-42" },
        { user: f.event.user, ts: "1000.005", text: "LATER-HUMAN-REQUEST-MUST-NOT-TRANSFER" },
      ], response_metadata: {} });
    }
    let childBeforePreflight;
    let commandBeforePreflight;
    const originalInfo = f.client.users.info;
    f.client.users.info = async (args) => {
      const child = getDb().prepare("SELECT data FROM active_runs").all()
        .map((row) => JSON.parse(row.data))
        .find((row) => row.slug === f.row.slug && row.threadKey !== f.row.threadKey);
      if (child && !childBeforePreflight) {
        childBeforePreflight = child;
        commandBeforePreflight = stored(f.row.id);
      }
      return originalInfo(args);
    };
    recordActiveRun(f.row.id, f.row);
    const before = runtime.calls.spawn.length;
    await recoverRuns(takeStaleRuns(), options(f.client));
    assert.ok(childBeforePreflight, "inspect the durable child at recipient lookup before promotion");
    assert.equal(commandBeforePreflight, undefined, "child owns recovery by this boundary");
    if (native) assert.equal(childBeforePreflight.forkSourceSessionId, f.sourceId);
    else {
      assert.match(childBeforePreflight.text, /LATE-SOURCE-ANSWER-42/);
      assert.doesNotMatch(childBeforePreflight.text, /\/fork :other|LATER-HUMAN-REQUEST-MUST-NOT-TRANSFER/);
      const prompt = runtime.calls.spawn.slice(before).flatMap((call) => call.args)
        .find((arg) => arg.includes("Explore recovered branch"));
      assert.match(prompt, /LATE-SOURCE-ANSWER-42/);
      assert.doesNotMatch(prompt, /\/fork :other|LATER-HUMAN-REQUEST-MUST-NOT-TRANSFER/);
    }
    assert.equal(roots(f.client).length, 1);
  });
}
