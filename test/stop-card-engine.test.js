// The "🛑 Stopped." card ends the turn with the reply menu, and the thread's engine resolves with
// the precedence that actually served the turn (run.js + decideThreadEngine): per-thread override
// → the engine that minted the thread's live session → the channel's own engine → the gateway
// default.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { useFakeRuntime } = await import("./runtime-fake.js");
await useFakeRuntime();

const { upsertChannelEntry, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { saveSession, clearSession } = await import("../src/gateway/sessions.js");
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

const stopCard = (client) => {
  const card = client.posted.find((m) => String(m.text || "") === "🛑 Stopped." && Array.isArray(m.blocks));
  assert.ok(card, `no stop card posted: ${JSON.stringify(client.posted)}`);
  return card;
};

const entry = await upsertChannelEntry(CHANNEL, { name: "stop-card-engine", type: "channel", isDM: false });
const slug = entry.slug;

// A stop ends the turn, so the card carries the same reply menu every answer ends with — and no
// longer a 💻 resume button (the command lives in Settings → Resume Session and `/resume`).
for (const engine of ["claude", "codex"]) test(`the stop card ends a ${engine} thread with the reply menu and no resume button`, async () => {
  saveSettings({ engine, engineEnabled: { claude: true, codex: true } });
  const threadKey = engine === "claude" ? "9100.100" : "9100.200";
  await clearSession(slug, threadKey);
  await saveSession(slug, threadKey, `1f1a5a4e-0000-4000-8000-00000000000${engine === "claude" ? 1 : 2}`, engine);

  const client = fakeSlack();
  assert.equal(await stopThread(client, slug, threadKey), 1);
  const card = stopCard(client);
  assert.equal(card.thread_ts, threadKey);
  assert.deepEqual(card.blocks.map((block) => block.type), ["section", "actions"]);
  assert.deepEqual(card.blocks[1].elements.map((button) => button.text.text), ["📂 Files", "🔑 Variables", "⚙️ Settings"]);
  for (const button of card.blocks[1].elements) assert.deepEqual(JSON.parse(button.value), { o: "open", c: CHANNEL, t: threadKey, u: USER });
  assert.doesNotMatch(JSON.stringify(card), /resume_cmd_modal/);
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
