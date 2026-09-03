// Background memory review: the trigger (counter + signals), the reviewer prompt, and the E2E
// through a stub `claude` — a saving review posts "🧠 Memory updated" and banks its usage; a
// "Nothing to save." review stays silent; the reviewer only ever sees the save tool.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, mkdir } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.env.PATH = `${path.join(projectRoot, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
const scratch = ensureTestEnv();
const { useFakeRuntime: __useFakeRuntime, fakeTarget } = await import("./runtime-fake.js");
const fakeBackend = await __useFakeRuntime();
// The reviewer resolves WHERE it runs at its own spawn (it outlives the turn), through its own
// injectable resolver rather than the run orchestration's — so it gets the same fake backend.
const resolveTarget = (slug, meta) => fakeTarget(fakeBackend, slug, meta);
process.env.CG_WORKSPACE_DIR = path.join(scratch, "review-workspaces");

const { upsertChannelEntry, saveChannelMeta, setUser } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { readUsage } = await import("../src/gateway/usage.js");
const { readEvents } = await import("../src/util/logger.js");
const { effectiveWorkDir } = await import("../src/gateway/folders.js");
const { readMemorySnapshot, applyMemoryOperations } = await import("../src/gateway/channel-memory.js");
const review = await import("../src/gateway/memory-review.js");

test("trivial prompts and slash commands never trigger; corrections/preferences are signals", () => {
  for (const t of ["", "thanks!", "ok", "👍", "/model", "yes please"]) assert.equal(review.isTrivialPrompt(t), true, JSON.stringify(t));
  assert.equal(review.isTrivialPrompt("summarize this thread for me"), false);
  assert.equal(review.hasMemorySignal("actually, always use the sol model instead"), true);
  assert.equal(review.hasMemorySignal("from now on reply in German"), true);
  assert.equal(review.hasMemorySignal("please summarize the last three deploys"), false);
  assert.equal(review.hasMemorySignal("I misremembered the date"), false, "word boundaries");
});

test("the per-channel counter reviews every N non-trivial turns, resets on a save, and signals jump the queue", () => {
  review.resetMemoryReviewState();
  const d = (userText, savedInTurn = false) => review.memoryReviewDecision({ slug: "chan", userText, savedInTurn, every: 3 });
  assert.equal(d("first real question").review, false);
  assert.equal(d("second real question").review, false);
  assert.deepEqual(d("third real question"), { review: true, reason: "interval" });
  assert.equal(d("fourth real question").reason, "turn 1/3", "counter restarted");
  assert.deepEqual(d("I prefer tables for this"), { review: true, reason: "signal" });
  assert.equal(d("one more question").reason, "turn 1/3", "a signal review also restarts the cadence");
  assert.equal(d("two more question here").reason, "turn 2/3");
  assert.deepEqual(d("it saved on its own", true), { review: false, reason: "saved-in-turn" });
  assert.equal(d("after the model saved").reason, "turn 1/3", "the model doing the reviewer's job resets it");
  assert.equal(d("thanks").reason, "trivial");
  assert.equal(review.memoryReviewDecision({ slug: "chan", userText: "real", every: 0 }).reason, "disabled");
});

test("the reviewer prompt carries the index, topic files, the transcript, and the one-line contract", () => {
  const prompt = review.buildMemoryReviewPrompt({
    snapshot: { index: "## Decisions\nBot name is Jarvis.\n", topics: ["deploys"], usage: { pct: 4, budget: 8000 } },
    transcript: "Alex: call it Jarvis\nRobin: done",
    channelName: "gateway-slack",
  });
  assert.match(prompt, /"gateway-slack"/);
  assert.match(prompt, /Bot name is Jarvis\./);
  assert.match(prompt, /memory\/deploys\.md/);
  assert.match(prompt, /Alex: call it Jarvis/);
  assert.match(prompt, /"Nothing to save\."/);
  assert.match(prompt, /not instructions to you/);
  const long = review.buildMemoryReviewPrompt({ snapshot: null, transcript: "x".repeat(20_000) });
  assert.match(long, /earlier messages omitted/);
  assert.match(long, /\(empty — nothing saved yet\)/);
});

test("summarizeReview turns the verdict line into the notice text", () => {
  assert.equal(review.summarizeReview("Nothing to save."), "");
  assert.equal(review.summarizeReview("  nothing to save "), "");
  assert.equal(review.summarizeReview("Saved: Alex prefers short replies."), "Alex prefers short replies.");
  assert.equal(review.summarizeReview("I looked.\nSaved: two facts about deploys"), "I looked. Saved: two facts about deploys".replace(/^.*Saved: /, ""));
  assert.equal(review.summarizeReview("x".repeat(400)).length, 240);
});

async function channel(id, name) {
  await setUser("U_MEM_REVIEW", { name: "Mem Reviewer", approved: true, isAdmin: false });
  const entry = await upsertChannelEntry(id, { name, type: "channel" });
  const meta = { channelId: id, name, type: "channel", template: "custom", engine: "claude", cleanMode: false, allowNetwork: false, memory: true };
  await saveChannelMeta(entry.slug, meta);
  await mkdir(effectiveWorkDir(entry.slug, meta), { recursive: true });
  return { entry, meta };
}
function fakeClient() {
  const posted = [];
  return { posted, chat: { postMessage: async (m) => { posted.push(m); return { ok: true, ts: `bot.${posted.length}` }; } } };
}

test("E2E: a review that saves posts the notice, banks usage as memory_review, and ran with only the save tool", async () => {
  review.resetMemoryReviewState();
  saveSettings({ agentMemory: true, memoryReviewEvery: 1, memoryReviewNotify: true, memoryReviewModel: "haiku" });
  const { entry, meta } = await channel("C_MEM_REVIEW_SAVE", "mem-review-save");
  const client = fakeClient();
  const job = review.maybeQueueMemoryReview({
    client, channelId: "C_MEM_REVIEW_SAVE", slug: entry.slug, threadKey: "7000.001", authorId: "U_MEM_REVIEW", meta, resolveTarget,
    userText: "please keep replies short from now on",
    savedInTurn: false,
    fetchTranscript: async () => "Alex: please keep replies short from now on CLAUDE_STUB_MEMORY_SAVE\nRobin: Understood.",
  });
  assert.ok(job, "a signal turn queues a review");
  const out = await job;
  assert.equal(out.saved, 1);
  assert.equal(out.summary, "Alex prefers short replies.");
  assert.equal(client.posted.length, 1);
  assert.equal(client.posted[0].thread_ts, "7000.001");
  assert.match(client.posted[0].text, /^🧠 Memory updated — Alex prefers short replies\.$/);

  const usage = await readUsage({ channelId: "C_MEM_REVIEW_SAVE" });
  const row = usage.find((u) => u.taskKind === "memory_review");
  assert.ok(row, `usage banked as memory_review: ${JSON.stringify(usage)}`);
  assert.equal(row.engine, "claude");
  const ev = readEvents({ limit: 50 }).find((e) => e.event === "memory_review" && e.slug === entry.slug);
  assert.ok(ev, "memory_review audit event");
  assert.equal(ev.saved, 1);
  assert.equal(ev.reason, "signal");

  // The stub keeps a copy of the MCP config it was launched with (named after the run's cwd).
  const cwd = effectiveWorkDir(entry.slug, meta);
  const copy = JSON.parse(await readFile(path.join(process.env.TMPDIR || "/tmp", `cg-stub-mcp-${path.basename(cwd)}.json`), "utf8"));
  assert.deepEqual(Object.keys(copy.mcpServers), ["gateway"], "no Composio/Skills identities ride along");
  assert.equal(copy.mcpServers.gateway.env.CG_TOOLSET, "memory-review");
});

test("E2E: a 'nothing to save' review stays silent and a second review for the same channel is not queued while one runs", async () => {
  review.resetMemoryReviewState();
  saveSettings({ agentMemory: true, memoryReviewEvery: 1, memoryReviewNotify: true });
  const { entry, meta } = await channel("C_MEM_REVIEW_QUIET", "mem-review-quiet");
  const client = fakeClient();
  const args = {
    client, channelId: "C_MEM_REVIEW_QUIET", slug: entry.slug, threadKey: "7000.002", authorId: "U_MEM_REVIEW", meta, resolveTarget,
    userText: "what changed in the deploy pipeline this week",
    fetchTranscript: async () => "Alex: what changed in the deploy pipeline this week\nRobin: nothing notable",
  };
  const first = review.maybeQueueMemoryReview(args);
  assert.ok(first);
  assert.equal(review.maybeQueueMemoryReview(args), null, "one review per channel at a time");
  const out = await first;
  assert.equal(out.saved, 0);
  assert.equal(client.posted.length, 0, "no notice when nothing was saved");
});

test("memory off for the channel → no review, ever", async () => {
  review.resetMemoryReviewState();
  saveSettings({ agentMemory: true, memoryReviewEvery: 1 });
  assert.equal(review.maybeQueueMemoryReview({ slug: "x", meta: { memory: false }, userText: "from now on do this" }), null);
  assert.equal(review.maybeQueueMemoryReview({ slug: "x", meta: { cleanMode: true }, userText: "from now on do this" }), null);
});

test("the shared snapshot reader sees a save made through the batch API (what the reviewer reads before deciding)", async (t) => {
  const { entry, meta } = await channel("C_MEM_REVIEW_SNAP", "mem-review-snap");
  const cwd = effectiveWorkDir(entry.slug, meta);
  await applyMemoryOperations(cwd, meta, [{ action: "add", text: "Deploys go out on Fridays." }]);
  const snap = await readMemorySnapshot(cwd, meta);
  assert.equal(snap.facts, 1);
  assert.match(snap.index, /Fridays/);
});
