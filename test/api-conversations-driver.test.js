// Cross the queue/session and HTTP seams with the real API driver and a fake container backend.
// A reused external conversation must resume the first turn after waiting in Slack's own queue.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
const root = fileURLToPath(new URL("..", import.meta.url));
process.env.PATH = `${path.join(root, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
process.env.CG_WORKSPACE_DIR = path.join(scratch, "conversation-driver-workspaces");

const { upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { setRuntimeResolver } = await import("../src/gateway/run.js");
const { resolveRuntime } = await import("../src/runtimes/resolve.js");
const { startApiRun, getApiJob } = await import("../src/gateway/api-runs.js");
const { createRunsRouter } = await import("../src/web/routes/runs.js");
const { runQueue } = await import("../src/slack/message-lifecycle.js");
const { createFakeRuntimeBackend, fakeTarget } = await import("./runtime-fake.js");

let sequence = 0;
async function fixture(engine = "claude") {
  saveSettings({ engine, engineEnabled: { claude: true, codex: true }, engineFallback: false, memoryReviewEvery: 0, composioMode: "personal" });
  const id = `C_API_CONV_DRIVER_${++sequence}`;
  const name = `api-conv-driver-${sequence}`;
  const entry = await upsertChannelEntry(id, { name, type: "channel" });
  const meta = { channelId: id, name, type: "channel", platform: "slack", template: "custom", engine, allowedMcps: [] };
  await saveChannelMeta(entry.slug, meta);
  await mkdir(resolveRuntime(entry.slug, meta).cwd, { recursive: true });
  const posts = [];
  const client = {
    chatStream: (input) => {
      const record = { channel: input.channel, thread_ts: input.thread_ts, text: "" };
      let posted = false;
      const append = async (payload = {}) => {
        record.text += payload.markdown_text || "";
        for (const chunk of payload.chunks || []) record.text += chunk.markdown_text || "";
        if (!posted) { posted = true; posts.push(record); }
        return { ok: true, ts: `1700000000.${String(posts.length + 100_000).padStart(6, "0")}` };
      };
      return { append, stop: append };
    },
    chat: {
      postMessage: async (input) => { posts.push(input); return { ok: true, ts: `1700000000.${String(posts.length).padStart(6, "0")}`, channel: input.channel }; },
      update: async () => ({ ok: true }),
      delete: async () => ({ ok: true }),
      getPermalink: async ({ channel, message_ts }) => ({ ok: true, permalink: `https://example.slack.com/archives/${channel}/p${message_ts.replace(".", "")}` }),
    },
    conversations: { history: async ({ oldest }) => ({ ok: true, messages: [{ ts: oldest }] }) },
    users: { list: async () => ({ members: [] }) },
    assistant: { threads: { setStatus: async () => ({ ok: true }), setTitle: async () => ({ ok: true }) } },
    agent: { sessions: { setStatus: async () => ({ ok: true }) } },
  };
  const slack = { snapshot: () => ({ connected: true, teamId: "T_CONV_DRIVER" }), getClient: () => client };
  return { id, entry, posts, slack };
}

async function waitFor(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail("Expected condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function settled(id) {
  await waitFor(() => !["running", "queued"].includes(getApiJob(id)?.status));
  return getApiJob(id);
}
test.afterEach(() => setRuntimeResolver(null));

test("simultaneous conversation events queue on one Slack thread and resume the first session", async () => {
  const f = await fixture();
  const backend = createFakeRuntimeBackend();
  const ensureUp = backend.ensureUp.bind(backend);
  let release;
  const firstStartGate = new Promise((resolve) => { release = resolve; });
  let warming = false;
  backend.ensureUp = async (...args) => {
    if (!warming) { warming = true; await firstStartGate; }
    return ensureUp(...args);
  };
  setRuntimeResolver((slug, meta, options) => fakeTarget(backend, slug, meta, options));

  let a;
  let b;
  let firstJobId;
  try {
    [a, b] = await Promise.all([
      startApiRun({ message: "First external event", channel: f.id, conversationKey: "gmail:driver", slack: f.slack, queueMemoryReview: () => null }),
      startApiRun({ message: "Second external event", channel: f.id, conversationKey: "gmail:driver", slack: f.slack, queueMemoryReview: () => null }),
    ]);
    assert.ok(a.ok && b.ok);
    assert.equal(a.threadTs, b.threadTs);
    assert.equal(a.sessionId, null);
    assert.equal(b.sessionId, null);
    const runKey = `${f.entry.slug}::${a.threadTs}`;
    await waitFor(() => warming);
    assert.equal(runQueue.activeHandle(runKey)?.api, true);
    firstJobId = runQueue.activeHandle(runKey).runId.endsWith(a.jobId) ? a.jobId : b.jobId;
    assert.equal(runQueue.hasRun(runKey, `${runKey}::api:${a.jobId}`), true);
    assert.equal(runQueue.hasRun(runKey, `${runKey}::api:${b.jobId}`), true, "the follow-up is waiting in the same queue");
    assert.deepEqual([getApiJob(a.jobId).status, getApiJob(b.jobId).status].sort(), ["queued", "running"], "the API distinguishes the waiting event from the active turn");
    assert.equal(backend.calls.spawn.length, 0, "queued follow-up cannot spawn while the first is blocked");
  } finally { release(); }

  const [first, second] = await Promise.all([settled(firstJobId), settled(firstJobId === a.jobId ? b.jobId : a.jobId)]);
  assert.equal(first.status, "completed", first.error || "");
  assert.equal(second.status, "completed", second.error || "");
  assert.equal(backend.calls.spawn.length, 2);
  assert.ok(backend.calls.spawn[0].args.includes("--session-id"), "the first event starts a fresh session");
  assert.ok(backend.calls.spawn[1].args.includes("-r"), "the queued event resumes the session at execution time");
  assert.equal(backend.calls.spawn[1].args[backend.calls.spawn[1].args.indexOf("-r") + 1], first.sessionId);
  assert.match(second.result.content, /resume=yes/);
  assert.equal(second.sessionId, first.sessionId);
  assert.ok(second.resumeCommand.includes(second.sessionId));
  assert.equal(runQueue.activeHandle(`${f.entry.slug}::${a.threadTs}`), null);
  assert.equal(f.posts.filter((p) => !p.thread_ts).length, 1);
  assert.ok(f.posts.filter((p) => p.thread_ts === a.threadTs && /Stub engine reply/.test(p.text)).length >= 2, "both answers land in the reused thread");
});

test("POST and GET routes expose the same persistent thread fields and distinguish event deduplication", async () => {
  const f = await fixture();
  const backend = createFakeRuntimeBackend();
  setRuntimeResolver((slug, meta, options) => fakeTarget(backend, slug, meta, options));
  const app = express();
  app.use("/api/runs", createRunsRouter({ slack: f.slack }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/runs`;
  const post = (body) => fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const input = { message: "A routed external event", channel: f.id, conversationKey: "gmail:http", idempotencyKey: `route-event-${f.id}` };
    const response = await post(input);
    assert.equal(response.status, 202);
    const first = await response.json();
    assert.equal(first.conversationKey, input.conversationKey);
    assert.equal(first.threadReused, false);
    assert.equal(first.slackThread, true);
    assert.ok(first.threadTs);
    assert.match(first.threadPermalink, /\/archives\//);
    await settled(first.jobId);
    const retry = await post(input);
    assert.equal(retry.status, 200);
    const duplicate = await retry.json();
    assert.equal(duplicate.jobId, first.jobId);
    assert.equal(duplicate.reused, true);
    assert.equal(duplicate.threadReused, false);

    const nextResponse = await post({ ...input, message: "Next routed event", idempotencyKey: `${input.idempotencyKey}-2` });
    assert.equal(nextResponse.status, 202);
    const next = await nextResponse.json();
    assert.equal(next.threadTs, first.threadTs);
    assert.equal(next.threadReused, true);
    assert.equal(next.reused, false);
    await settled(next.jobId);
    const detail = await (await fetch(`${base}/${next.jobId}`)).json();
    const listing = await (await fetch(base)).json();
    const listed = listing.jobs.find((job) => job.jobId === next.jobId);
    for (const job of [detail, listed]) {
      for (const field of ["conversationKey", "threadTs", "threadReused", "threadPermalink"]) assert.equal(job[field], next[field], field);
      assert.equal(job.status, "completed");
      assert.ok(job.sessionId);
      assert.ok(job.resumeCommand.includes(job.sessionId));
    }
    const invalid = await post({ ...input, conversationKey: "" });
    assert.equal(invalid.status, 400, "the HTTP route passes conversationKey validation through");
    assert.equal(backend.calls.spawn.length, 2, "the duplicate and invalid request spawn no engine");
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("a keyed Codex conversation resumes the provider-minted session on its next event", async () => {
  const f = await fixture("codex");
  const backend = createFakeRuntimeBackend();
  setRuntimeResolver((slug, meta, options) => fakeTarget(backend, slug, meta, options));
  const input = { channel: f.id, conversationKey: "gmail:codex-continuity", slack: f.slack, queueMemoryReview: () => null };

  const a = await startApiRun({ ...input, message: "First event for Codex" });
  assert.equal(a.ok, true);
  assert.equal(a.sessionId, null, "admission cannot guess the provider's native thread identity");
  const first = await settled(a.jobId);
  assert.equal(first.status, "completed", first.error || "");
  assert.equal(first.engine, "codex", "engine fallback is disabled so Claude cannot satisfy this test");
  assert.equal(first.sessionId, "codex-stub-session", "thread.started supplies the actual native session identity");
  assert.match(first.result.content, /Codex stub reply; resume=no/);

  const b = await startApiRun({ ...input, message: "Second event for Codex" });
  assert.equal(b.ok, true);
  assert.equal(b.threadTs, a.threadTs);
  assert.equal(b.threadReused, true);
  assert.equal(b.sessionId, null);
  const second = await settled(b.jobId);
  assert.equal(second.status, "completed", second.error || "");
  assert.equal(second.engine, "codex");
  assert.equal(second.sessionId, first.sessionId);
  assert.match(second.result.content, /Codex stub reply; resume=yes/);
  assert.ok(second.resumeCommand.includes(first.sessionId));
  assert.equal(backend.calls.spawn.length, 2);
  assert.equal(backend.calls.spawn[0].args.includes("resume"), false);
  const resumed = backend.calls.spawn[1].args;
  assert.ok(resumed.includes("exec") && resumed.includes("resume"));
  assert.equal(resumed[resumed.indexOf("resume") + 1], first.sessionId, "the second CLI receives exec resume with the first completed native session id");
  assert.equal(f.posts.filter((p) => !p.thread_ts).length, 1);
  const replies = f.posts.filter((p) => p.thread_ts === a.threadTs && /Codex stub reply/.test(p.text));
  assert.ok(replies.some((p) => /resume=no/.test(p.text)));
  assert.ok(replies.some((p) => /resume=yes/.test(p.text)), "both Codex results are delivered in the same Slack thread");
});
