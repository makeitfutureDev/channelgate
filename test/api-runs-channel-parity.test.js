// An HTTP run API turn is one more turn in its channel: the SAME per-thread queue a Slack message
// joins (so a Slack stop or steer reaches it and a follow-up never races it onto the same session),
// the same container resume command, and the same post-reply memory review. Driven through the
// REAL driver (runInBackground → runMessage) with the stub engine and a fake container backend, so
// no container CLI or real engine is needed.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.env.PATH = `${path.join(projectRoot, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
const scratch = ensureTestEnv();
// A container turn authenticates with a relay of the operator's Claude login (claude-login.js).
{
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { operatorClaudeConfigDir } = await import("../src/gateway/claude-login.js");
  const file = path.join(operatorClaudeConfigDir(), ".credentials.json");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-api-parity", expiresAt: Date.now() + 4 * 3600_000, refreshTokenExpiresAt: Date.now() + 20 * 24 * 3600_000 } }), { mode: 0o600 });
}
process.env.CG_WORKSPACE_DIR = path.join(scratch, "api-parity-workspaces");

const { upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { setRuntimeResolver } = await import("../src/gateway/run.js");
const { resolveRuntime } = await import("../src/runtimes/resolve.js");
const { startApiRun, getApiJob } = await import("../src/gateway/api-runs.js");
const { runQueue } = await import("../src/slack/message-lifecycle.js");
const { createFakeRuntimeBackend, fakeTarget } = await import("./runtime-fake.js");

async function channel(id, name, meta = {}) {
  const entry = await upsertChannelEntry(id, { name, type: "channel" });
  const full = { channelId: id, name, type: "channel", template: "custom", engine: "claude", allowedMcps: [], platform: "slack", ...meta };
  await saveChannelMeta(entry.slug, full);
  await mkdir(resolveRuntime(entry.slug, full).cwd, { recursive: true });
  return entry;
}

async function settled(jobId, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const job = getApiJob(jobId);
    if (job && !["running", "queued"].includes(job.status)) return job;
    if (Date.now() > until) throw new Error(`job ${jobId} never settled (status ${job?.status})`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test.afterEach(() => setRuntimeResolver(null));

test("an API run holds its thread's run slot, so a Slack stop in that thread stops it", async () => {
  saveSettings({ engine: "claude", memoryReviewEvery: 0, composioMode: "personal" });
  const entry = await channel("C_API_PAR_STOP", "api-par-stop");
  // A slow container start keeps the turn in flight long enough to observe and stop it.
  const backend = createFakeRuntimeBackend({ ensureUpDelayMs: 3_000 });
  setRuntimeResolver((slug, meta) => fakeTarget(backend, slug, meta));

  const started = await startApiRun({ message: "summarize the backlog", channel: "C_API_PAR_STOP" });
  assert.equal(started.ok, true);
  const key = `${entry.slug}::api:${started.jobId}`;
  const until = Date.now() + 5_000;
  while (!runQueue.activeHandle(key) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  const active = runQueue.activeHandle(key);
  assert.ok(active?.api, "the API run is the active turn on its thread key — a Slack message there sees it busy");

  // Exactly what the Slack stop path does with the active handle (message-pipeline.js).
  const res = runQueue.abort(key);
  res.active.controller?.abort();

  const job = await settled(started.jobId);
  assert.equal(job.status, "stopped");
  assert.equal(backend.calls.spawn.length, 0, "a stopped API run never reaches the engine");
  assert.equal(runQueue.activeHandle(key), null, "the slot is released for the next turn");
});

test("a Slack steer on an API run's thread supersedes it and says so", async () => {
  saveSettings({ engine: "claude", memoryReviewEvery: 0, composioMode: "personal" });
  const entry = await channel("C_API_PAR_STEER", "api-par-steer");
  const backend = createFakeRuntimeBackend({ ensureUpDelayMs: 3_000 });
  setRuntimeResolver((slug, meta) => fakeTarget(backend, slug, meta));
  const { steerActiveRun } = await import("../src/slack/busy-thread-choice.js");

  const started = await startApiRun({ message: "draft the report", channel: "C_API_PAR_STEER" });
  const key = `${entry.slug}::api:${started.jobId}`;
  const until = Date.now() + 5_000;
  while (!runQueue.activeHandle(key) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(steerActiveRun(runQueue, key), "aborted");

  const job = await settled(started.jobId);
  assert.equal(job.status, "stopped");
  assert.match(job.error || "", /steered/i);
});

test("a completed API run reports the container resume command and queues the channel's memory review", async () => {
  saveSettings({ engine: "claude", memoryReviewEvery: 1, composioMode: "personal" });
  const entry = await channel("C_API_PAR_DONE", "api-par-done");
  const backend = createFakeRuntimeBackend();
  setRuntimeResolver((slug, meta) => fakeTarget(backend, slug, meta));
  const reviews = [];

  const started = await startApiRun({
    message: "remember that invoices are due on the 5th",
    channel: "C_API_PAR_DONE",
    queueMemoryReview: (args) => { reviews.push(args); return null; },
  });
  // The command handed back at start already enters the channel's container: its engine sessions
  // live in the container's HOME volume, so a host `cd … && claude -r …` would find nothing.
  assert.match(started.resumeCommand, / exec -it -w /);
  assert.doesNotMatch(started.resumeCommand, /^cd /);

  const job = await settled(started.jobId);
  assert.equal(job.status, "completed", job.error || "");
  assert.match(job.resumeCommand, / exec -it -w /);
  assert.ok(job.resumeCommand.includes(job.sessionId), "the resume command names the run's session");
  assert.equal(backend.calls.spawn.length, 1);

  assert.equal(reviews.length, 1, "the post-reply memory review is offered exactly like a Slack turn's");
  assert.equal(reviews[0].slug, entry.slug);
  assert.equal(reviews[0].threadKey, `api:${started.jobId}`);
  assert.equal(reviews[0].authorId, "api", "the reviewer acts as the API principal, never a caller-named author");
  assert.match(await reviews[0].fetchTranscript(), /invoices are due on the 5th[\s\S]*Assistant:/);
});
