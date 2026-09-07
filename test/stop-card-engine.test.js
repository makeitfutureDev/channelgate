// The "🛑 Stopped." card names the harness the STOPPED THREAD was running on, not the gateway
// default. A session id is engine-specific — `claude -r <id>` cannot open a Codex rollout and
// `codex exec resume <id>` cannot open a Claude session — so a card that reads the global default
// hands the user a command that is guaranteed to fail. The precedence must match what actually
// served the turn (run.js + decideThreadEngine): per-thread override → the engine that minted the
// thread's live session → the channel's own engine → the gateway default.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { useFakeRuntime } = await import("./runtime-fake.js");
await useFakeRuntime();

const { upsertChannelEntry, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { saveSession, clearSession } = await import("../src/gateway/sessions.js");
const { setThreadEngine } = await import("../src/gateway/thread-engine.js");
const { resolveThreadEngine } = await import("../src/gateway/thread-engine.js");
const { stopRunsInChannel, runQueue } = await import("../src/slack/message-pipeline.js");

const USER = "U_STOP_CARD";
const CHANNEL = "C_STOP_CARD";

function fakeSlack() {
  const posted = [];
  return {
    posted,
    chat: {
      postMessage: async (message) => {
        posted.push(message);
        return { ok: true, ts: `bot.${posted.length}` };
      },
    },
    apiCall: async () => ({ ok: true }),
  };
}

// The card is only posted for a run the queue actually holds, so park a bare handle in the slot
// instead of spawning an engine: stopRunsInChannel's card path only needs the key to be busy.
async function stopThread(client, slug, threadKey) {
  const handle = { authorId: USER };
  await runQueue.acquire(`${slug}::${threadKey}`, handle);
  try {
    return await stopRunsInChannel(client, CHANNEL, slug, USER, threadKey);
  } finally {
    runQueue.release(`${slug}::${threadKey}`, handle);
  }
}

const resumeValue = (client) => {
  const card = client.posted.find((m) => String(m.text || "") === "🛑 Stopped." && Array.isArray(m.blocks));
  assert.ok(card, `no stop card posted: ${JSON.stringify(client.posted)}`);
  const accessory = card.blocks[0]?.accessory;
  assert.ok(accessory, `stop card has no resume button: ${JSON.stringify(card)}`);
  return JSON.parse(accessory.value);
};

const entry = await upsertChannelEntry(CHANNEL, { name: "stop-card-engine", type: "channel", isDM: false });
const slug = entry.slug;

test("the stop card resumes with the engine that minted the thread's session, not the gateway default", async () => {
  saveSettings({ engine: "codex", engineEnabled: { claude: true, codex: true } });
  await saveChannelMeta(slug, { ...(await getChannelMeta(slug)), engine: "claude" });
  const threadKey = "9100.100";
  await clearSession(slug, threadKey);
  await setThreadEngine(slug, threadKey, "");
  await saveSession(slug, threadKey, "1f1a5a4e-0000-4000-8000-000000000001", "claude");

  const client = fakeSlack();
  assert.equal(await stopThread(client, slug, threadKey), 1);
  const value = resumeValue(client);
  assert.equal(value.sessionId, "1f1a5a4e-0000-4000-8000-000000000001");
  assert.equal(value.engine, "claude", "a Claude session must never be offered a Codex resume command");
});

test("the inverse holds: a Codex session in a Claude-default gateway resumes as Codex", async () => {
  saveSettings({ engine: "claude", engineEnabled: { claude: true, codex: true } });
  await saveChannelMeta(slug, { ...(await getChannelMeta(slug)), engine: "codex" });
  const threadKey = "9100.200";
  await clearSession(slug, threadKey);
  await setThreadEngine(slug, threadKey, "");
  await saveSession(slug, threadKey, "01999999-0000-4000-8000-0000000000c0", "codex");

  const client = fakeSlack();
  assert.equal(await stopThread(client, slug, threadKey), 1);
  assert.equal(resumeValue(client).engine, "codex");
});

test("a per-thread harness override outranks the session it was pinned onto", async () => {
  saveSettings({ engine: "codex", engineEnabled: { claude: true, codex: true } });
  await saveChannelMeta(slug, { ...(await getChannelMeta(slug)), engine: "codex" });
  const threadKey = "9100.300";
  await clearSession(slug, threadKey);
  await saveSession(slug, threadKey, "1f1a5a4e-0000-4000-8000-000000000003", "codex");
  await setThreadEngine(slug, threadKey, "claude");

  const client = fakeSlack();
  assert.equal(await stopThread(client, slug, threadKey), 1);
  assert.equal(resumeValue(client).engine, "claude");
  await setThreadEngine(slug, threadKey, "");
});

test("with no session and no override the channel's engine beats the gateway default", async () => {
  saveSettings({ engine: "codex", engineEnabled: { claude: true, codex: true } });
  await saveChannelMeta(slug, { ...(await getChannelMeta(slug)), engine: "claude" });
  assert.equal(await resolveThreadEngine(slug, "9100.400", await getChannelMeta(slug)), "claude");
  // …and with neither, the gateway default is the last word.
  await saveChannelMeta(slug, { ...(await getChannelMeta(slug)), engine: "" });
  assert.equal(await resolveThreadEngine(slug, "9100.400", await getChannelMeta(slug)), "codex");
});

test("Stop cancels loops and accounts every active/queued turn before throttled Slack clears", async () => {
  const { armLoop, threadLoops } = await import("../src/gateway/loops.js");
  const { readEvents } = await import("../src/util/logger.js");
  const threads = ["9100.501", "9100.502"];
  const handles = threads.map((thread) => ({ runId: `stop-account-${thread}`, controller: new AbortController() }));
  for (let i = 0; i < threads.length; i++) await runQueue.acquire(`${slug}::${threads[i]}`, handles[i]);
  const queued = { runId: "stop-account-queued" };
  const queuedReady = runQueue.acquire(`${slug}::${threads[0]}`, queued);
  armLoop({ channelId: CHANNEL, slug, threadTs: threads[0], authorId: USER,
    wakeup: { kind: "loop_wakeup", mode: "interval", cron: "*/5 * * * *", prompt: "Check fixture" } });
  assert.equal(threadLoops(CHANNEL, threads[0]).length, 1);
  const client = fakeSlack();
  let releaseStatus;
  client.apiCall = () => new Promise((r) => { releaseStatus = r; });
  try {
    const stopped = stopRunsInChannel(client, CHANNEL, slug, USER);
    assert.equal(threadLoops(CHANNEL, threads[0]).length, 0, "loop deleted synchronously before Slack");
    assert.ok(handles.every((h) => h.controller.signal.aborted));
    await stopped;
    await queuedReady;
    assert.equal(client.posted.filter((m) => m.text === "🛑 Stopped.").length, 2, "both notices bypass a stuck status clear");
    const events = readEvents({ limit: 100 }).filter((e) => e.event === "run_stopped" && e.runId?.startsWith("stop-account-"));
    assert.equal(events.length, 3);
    assert.equal(events.filter((e) => e.state === "queued").length, 1);
    await stopRunsInChannel(client, CHANNEL, slug, USER);
    assert.equal(readEvents({ limit: 100 }).filter((e) => e.event === "run_stopped" && e.runId?.startsWith("stop-account-")).length, 3, "duplicate Stop never double-counts a handle");
  } finally {
    releaseStatus?.({ ok: true });
    for (let i = 0; i < threads.length; i++) runQueue.release(`${slug}::${threads[i]}`, handles[i]);
  }
});
