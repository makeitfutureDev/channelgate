// HTTP run API in a Google Chat space (and any non-Slack surface). The run used to resolve ONLY
// Slack's client, so a `gchat:spaces/…` conversation ran headless: no kickoff, no answer in the
// space. It now resolves the conversation's own live connector, the same way schedules and
// background jobs do: the kickoff opens a Chat thread and the answer posts into it. Driven through
// the REAL driver with the stub engine and a fake container backend, and a fake Chat transport.
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
{
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { operatorClaudeConfigDir } = await import("../src/gateway/claude-login.js");
  const file = path.join(operatorClaudeConfigDir(), ".credentials.json");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-api-gchat", expiresAt: Date.now() + 4 * 3600_000, refreshTokenExpiresAt: Date.now() + 20 * 24 * 3600_000 } }), { mode: 0o600 });
}
process.env.CG_WORKSPACE_DIR = path.join(scratch, "api-gchat-workspaces");

const { upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { setRuntimeResolver } = await import("../src/gateway/run.js");
const { resolveRuntime } = await import("../src/runtimes/resolve.js");
const { startApiRun, getApiJob, recoverApiRuns, apiRunTarget, apiKickoffText, apiThreadFacts, failureAlertText } = await import("../src/gateway/api-runs.js");
const { registerTransport, unregisterTransport } = await import("../src/platforms/live.js");
const { capabilitiesFor } = await import("../src/platforms/registry.js");
const { getDb, toJson } = await import("../src/db/index.js");
const { createFakeRuntimeBackend, fakeTarget } = await import("./runtime-fake.js");

const SPACE = "gchat:spaces/AAQAapiRun01";

function fakeChat() {
  const posts = [];
  let n = 0;
  const connector = {
    platform: "googlechat",
    capabilities: capabilitiesFor("googlechat"),
    ready: () => true,
    async post({ conversationId, threadKey = "", text }) {
      n += 1;
      const space = String(conversationId).replace(/^gchat:/, "");
      const thread = threadKey || `${space}/threads/T${n}`;
      posts.push({ conversationId, threadKey, text });
      return { messageId: `${space}/messages/M${n}`, conversationId: space, threadKey: thread };
    },
  };
  registerTransport("googlechat", { getConnector: () => connector, snapshot: () => ({ connected: true }) });
  return { connector, posts };
}

async function chatSpace(id, name) {
  const entry = await upsertChannelEntry(id, { name, type: "channel" });
  const meta = { channelId: id, name, type: "channel", template: "custom", engine: "claude", allowedMcps: [], platform: "googlechat" };
  await saveChannelMeta(entry.slug, meta);
  await mkdir(resolveRuntime(entry.slug, meta).cwd, { recursive: true });
  return entry;
}

async function settled(jobId, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const job = getApiJob(jobId);
    if (job && !["running", "queued"].includes(job.status) && !job.deliveryPending) return job;
    if (Date.now() > until) throw new Error(`job ${jobId} never settled (status ${job?.status})`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test.afterEach(() => { setRuntimeResolver(null); unregisterTransport("googlechat"); });

test("a run in a Google Chat space opens a thread there and posts its answer into it", async () => {
  saveSettings({ engine: "claude", memoryReviewEvery: 0, composioMode: "personal" });
  const { posts } = fakeChat();
  const entry = await chatSpace(SPACE, "api-gchat-space");
  const backend = createFakeRuntimeBackend();
  setRuntimeResolver((slug, meta) => fakeTarget(backend, slug, meta));

  const started = await startApiRun({ message: "summarize <users/all> today's tickets", channel: SPACE });
  assert.equal(started.ok, true, started.error || "");
  assert.equal(started.slug, entry.slug);
  assert.equal(started.chatThread, true);
  assert.equal(started.platform, "googlechat");
  assert.equal(started.slackThread, false, "slackThread keeps its Slack-only meaning");
  assert.equal(started.threadTs, null);
  assert.equal(started.threadKey, "spaces/AAQAapiRun01/threads/T1", "the session key is the Chat thread the kickoff opened");
  assert.equal(started.threadPermalink, null);

  const kickoff = posts[0];
  assert.equal(kickoff.conversationId, SPACE);
  assert.equal(kickoff.threadKey, "", "the kickoff starts a new thread");
  assert.match(kickoff.text, /API run started/);
  assert.match(kickoff.text, /\*\*Request:\*\*/, "Markdown for Chat, not Slack mrkdwn");
  assert.doesNotMatch(kickoff.text, /<users\/all>/, "a broadcast in the caller's text is defanged");
  assert.doesNotMatch(kickoff.text, /<@/, "no Slack mention syntax in a Chat space");

  const job = await settled(started.jobId);
  assert.equal(job.status, "completed", job.error || "");
  assert.equal(job.deliveryPending, false);
  const replies = posts.slice(1);
  assert.ok(replies.length >= 1, "the answer is posted into the space");
  for (const reply of replies) assert.equal(reply.threadKey, started.threadKey, "every reply lands in the run's thread");
  assert.equal(backend.calls.spawn.length, 1);
});

test("with Google Chat disconnected the run stays headless instead of failing", async () => {
  saveSettings({ engine: "claude", memoryReviewEvery: 0, composioMode: "personal" });
  await chatSpace("gchat:spaces/AAQAapiRun02", "api-gchat-offline");
  const driven = [];
  const started = await startApiRun({ message: "x", channel: "gchat:spaces/AAQAapiRun02", driver: (job, opts) => driven.push({ job, opts }) });
  assert.equal(started.ok, true, started.error || "");
  assert.equal(started.chatThread, false);
  assert.equal(started.threadKey, null);
  assert.equal(driven[0].opts.client, null);
});

test("keyed events continue the SAME Chat thread and the SAME agent session", async () => {
  saveSettings({ engine: "claude", memoryReviewEvery: 0, composioMode: "personal" });
  const { posts } = fakeChat();
  const space = "gchat:spaces/AAQAapiRun03";
  await chatSpace(space, "api-gchat-key");
  const backend = createFakeRuntimeBackend();
  setRuntimeResolver((slug, meta, options) => fakeTarget(backend, slug, meta, options));

  const first = await startApiRun({ message: "first event", channel: space, conversationKey: "make:order-42" });
  assert.equal(first.ok, true, first.error || "");
  assert.equal(first.threadReused, false);
  assert.equal(first.chatThread, true);
  assert.equal(first.sessionId, null, "a keyed run resolves its session on its turn");
  const one = await settled(first.jobId);
  assert.equal(one.status, "completed", one.error || "");

  const second = await startApiRun({ message: "second event", channel: space, conversationKey: "make:order-42" });
  assert.equal(second.ok, true, second.error || "");
  assert.equal(second.threadReused, true);
  assert.equal(second.threadKey, first.threadKey, "the second event lands in the first event's thread");
  const two = await settled(second.jobId);
  assert.equal(two.status, "completed", two.error || "");
  assert.equal(two.sessionId, one.sessionId, "the second event resumes the first event's session");
  assert.ok(backend.calls.spawn[1].args.includes("-r"), "the engine is resumed, not started fresh");
  assert.match(two.result.content, /resume=yes/);

  const roots = posts.filter((p) => p.conversationId === space && !p.threadKey);
  assert.equal(roots.length, 1, "exactly one top-level kickoff for the whole conversation");
  assert.ok(posts.filter((p) => p.threadKey === first.threadKey && /second event/.test(p.text)).length === 1, "the second request is posted as a reply in the thread");
});

test("a keyed Chat thread that vanished is replaced once and the binding follows it", async () => {
  const chat = fakeChat();
  const space = "gchat:spaces/AAQAapiRun04";
  await chatSpace(space, "api-gchat-key-gone");
  const driver = () => {};
  const first = await startApiRun({ message: "a", channel: space, conversationKey: "k", driver });
  // Chat answers a post into a deleted thread by opening a new one (FALLBACK_TO_NEW_THREAD).
  const post = chat.connector.post.bind(chat.connector);
  chat.connector.post = (args) => post({ ...args, threadKey: args.threadKey === first.threadKey ? "" : args.threadKey });
  const second = await startApiRun({ message: "b", channel: space, conversationKey: "k", driver });
  assert.equal(second.threadReused, false);
  assert.notEqual(second.threadKey, first.threadKey);
  chat.connector.post = post;
  const third = await startApiRun({ message: "c", channel: space, conversationKey: "k", driver });
  assert.equal(third.threadReused, true);
  assert.equal(third.threadKey, second.threadKey);
});

test("keyed runs fail closed while Google Chat is disconnected", async () => {
  await chatSpace("gchat:spaces/AAQAapiRun05", "api-gchat-key-off");
  const res = await startApiRun({ message: "x", channel: "gchat:spaces/AAQAapiRun05", conversationKey: "k", driver: () => {} });
  assert.equal(res.ok, false);
  assert.equal(res.code, 503);
  assert.match(res.error, /Google Chat must be connected/);
});

test("apiRunTarget keeps Slack on its WebClient and never hands Slack a Chat conversation", () => {
  const web = { chat: { postMessage: async () => ({}) } };
  const slack = { snapshot: () => ({ connected: true }), getClient: () => web };
  assert.equal(apiRunTarget(slack, "C0123").client, web);
  assert.equal(apiRunTarget({ snapshot: () => ({ connected: false }) }, "C0123").client, null);
  assert.equal(apiRunTarget(slack, SPACE).client, null, "no Chat transport → no client, never Slack's");
  assert.deepEqual(apiRunTarget(slack, "cg-api"), { client: null, platform: "" });
});

test("Slack kickoff text and thread facts are unchanged", () => {
  assert.equal(apiKickoffText({ platform: "slack", jobId: "j1", authorId: "U1", msg: "hi", hasFile: false }),
    "🚀 API run started (job `j1`) for <@U1>\n\n*Request:*\nhi");
  assert.deepEqual(apiThreadFacts({ slackThread: true, channelId: "C1", threadKey: "1.2" }),
    { channelId: "C1", platform: "slack", chatThread: true, slackThread: true, threadKey: "1.2", threadTs: "1.2" });
  assert.deepEqual(apiThreadFacts({ slackThread: false, channelId: "C1", threadKey: "api:x" }),
    { channelId: null, platform: null, chatThread: false, slackThread: false, threadKey: null, threadTs: null });
});

test("the on-failure alert for a Chat space is Markdown and defanged", () => {
  const text = failureAlertText({ id: "j2", channelId: SPACE, platform: "googlechat", taskStatus: "failed", message: "ping <users/all>", error: "boom" });
  assert.match(text, /\*\*Request:\*\*/);
  assert.doesNotMatch(text, /<users\/all>/);
});

test("recovery re-delivers a saved Chat answer through Chat, not Slack", async () => {
  const { connector } = fakeChat();
  const job = { id: "api_gchat_recover", status: "completed", slug: "api-gchat-space", channelId: SPACE, platform: "googlechat",
    threadKey: "spaces/AAQAapiRun01/threads/T9", slackThread: true, deliveryPending: true, webhookPending: false,
    result: { content: "the answer" }, engine: "claude", createdMs: Date.now() };
  getDb().prepare("INSERT INTO api_jobs(id, status, created_ms, data) VALUES(?, ?, ?, ?)").run(job.id, job.status, job.createdMs, toJson(job));
  const delivered = [];
  const slackWeb = { chat: { postMessage: async () => { throw new Error("Slack must not receive a Chat run"); } } };
  await recoverApiRuns({ slack: { snapshot: () => ({ connected: true }), getClient: () => slackWeb },
    deliver: async (client, args) => delivered.push({ client, args }), webhook: async () => {} });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].client, connector);
  assert.equal(delivered[0].args.threadKey, job.threadKey);
  assert.equal(getApiJob(job.id).deliveryPending, false);
});
