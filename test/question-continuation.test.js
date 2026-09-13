import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.env.PATH = `${path.join(projectRoot, "test", "fixtures", "prompt-echo")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
process.env.PROGRESS_VIEW = "shimmer";
const { useFakeRuntime } = await import("./runtime-fake.js");
const runtime = await useFakeRuntime();
const { setUser, upsertChannelEntry, defaultChannelMeta, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { getDb } = await import("../src/db/index.js");
const { processMessageEvent, runQueue, stopRunsInChannel } = await import("../src/slack/message-pipeline.js");
const { acceptQuestionReply, clearActiveRun, listActiveRuns, recordActiveRun, recoverRuns } = await import("../src/gateway/active-runs.js");
const { createQuestion, getQuestion, updateQuestion, saveQuestionAnswers, acceptQuestionSubmission } = await import("../src/gateway/questions.js");

const USER = "U_QUESTION_CONTINUATION";
const CHANNEL = "D_QUESTION_CONTINUATION";
let sequence = 0;

function fakeSlack() {
  const posted = [];
  const updated = [];
  const ok = async () => ({ ok: true });
  const client = {
    posted, updated, members: [USER],
    chat: {
      postMessage: async (message) => { posted.push(message); return { ok: true, ts: `9000.${++sequence}` }; },
      update: async (message) => { updated.push(message); return { ok: true }; },
      postEphemeral: ok,
    },
    users: {
      info: async ({ user }) => ({ user: { id: user, real_name: "Question User" } }),
      list: async () => ({ members: [{ id: USER, real_name: "Question User" }], response_metadata: {} }),
    },
    conversations: {
      history: async () => ({ messages: [] }),
      replies: async () => ({ messages: [] }),
      info: async ({ channel }) => ({ channel: { id: channel } }),
      members: async () => ({ members: client.members, response_metadata: {} }),
    },
    apiCall: ok,
  };
  client.chatStream = () => ({
    ts: `9000.${++sequence}`, append: ok,
    stop: async ({ markdown_text = "" } = {}) => { posted.push({ text: markdown_text }); return { ok: true }; },
  });
  return client;
}

async function setup(threadKey) {
  saveSettings({ engine: "claude", composioMode: "personal" });
  await setUser(USER, { name: "Question User", approved: true, isAdmin: false });
  const entry = await upsertChannelEntry(CHANNEL, { name: "question-continuation", type: "im", isDM: true, platform: "slack" });
  await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId: CHANNEL, name: entry.name, type: "im", isDM: true, platform: "slack" }), dmUserId: USER });
  return { channelId: CHANNEL, authorId: USER, slug: entry.slug, threadKey, isDM: true };
}

function question(context) {
  return createQuestion(context, { title: "Access preferences", questions: [
    { id: "access", prompt: "Who should have access?", type: "single", options: [{ label: "Team only", value: "team" }, { label: "Everyone", value: "everyone" }] },
  ] });
}

function event(context, text = "Answers submitted to the agent's questions: Team only") {
  return { type: "message", channel: context.channelId, channel_type: "im", user: context.authorId,
    text, thread_ts: context.threadKey, ts: `${Number(context.threadKey) + 1}.001` };
}

async function queued(key) {
  for (let attempt = 0; attempt < 200 && runQueue.count(key) < 2; attempt++) await delay(5);
  assert.equal(runQueue.count(key), 2, "the answers should be accepted into the existing thread queue");
}

test("submitted answers bypass canonical card hydration and queue durably without steering", async () => {
  const context = await setup("6000.001");
  const client = fakeSlack();
  const request = saveQuestionAnswers(question(context).id, 0, { access: { values: ["team"] } });
  const input = event(context);
  let hydrated = 0;
  client.conversations.replies = async () => { hydrated++; return { messages: [{ ts: input.ts, text: "WRONG canonical card text" }] }; };
  const key = `${context.slug}::${context.threadKey}`;
  const active = { aborted: false, controller: new AbortController(), authorId: USER };
  await runQueue.acquire(key, active);
  const running = processMessageEvent(input, client, {
    botUserId: "U_BOT", teamId: "T_QUESTIONS", bypassMention: true, questionSubmissionId: request.id,
    onQuestionSubmissionAccepted: ({ runId, rec }) => acceptQuestionSubmission(request.id, request.revision, runId, rec),
  });
  try {
    await queued(key);
    assert.equal(hydrated, 0);
    assert.equal(active.controller.signal.aborted, false);
    const stored = listActiveRuns().find((r) => r.questionSubmissionId === request.id);
    assert.equal(stored.authorId, USER);
    assert.equal(stored.threadKey, context.threadKey);
    assert.match(stored.text, /Team only/);
    assert.doesNotMatch(stored.text, /WRONG/);
    assert.equal(getQuestion(request.id).status, "submitted");
    assert.equal(acceptQuestionSubmission(request.id, request.revision, "duplicate", stored), false);
    await stopRunsInChannel(client, CHANNEL, context.slug, USER, context.threadKey);
  } finally {
    runQueue.release(key, active);
    await running;
  }
  assert.equal(listActiveRuns().some((r) => r.questionSubmissionId === request.id), false);
});

test("requester access revoked while answers are queued prevents the engine spawn", async () => {
  const context = await setup("6100.001");
  const client = fakeSlack();
  const request = saveQuestionAnswers(question(context).id, 0, { access: { values: ["team"] } });
  const key = `${context.slug}::${context.threadKey}`;
  const active = { aborted: false, controller: new AbortController(), authorId: USER };
  await runQueue.acquire(key, active);
  const spawnsBefore = runtime.calls.spawn.length;
  const running = processMessageEvent(event(context), client, {
    botUserId: "U_BOT", questionSubmissionId: request.id,
    onQuestionSubmissionAccepted: ({ runId, rec }) => acceptQuestionSubmission(request.id, request.revision, runId, rec),
  });
  try {
    await queued(key);
    await setUser(USER, { approved: false });
  } finally {
    runQueue.release(key, active);
    await running;
  }
  assert.equal(runtime.calls.spawn.length, spawnsBefore);
  assert.equal(listActiveRuns().some((r) => r.questionSubmissionId === request.id), false);
  assert.ok(client.posted.some((m) => /no longer has access|could not be verified/.test(m.text || "")));
});

test("live promotion preserves submission marker before the fixture engine starts", async () => {
  const context = await setup("6150.001");
  const client = fakeSlack();
  const request = saveQuestionAnswers(question(context).id, 0, { access: { values: ["team"] } });
  const input = { ...event(context), ts: `question-${request.id}` };
  client.conversations.replies = async () => ({ messages: [{ ts: context.threadKey, user: USER, text: "Original task needs thread context." }] });
  const spawn = runtime.spawn;
  let observed = false;
  runtime.spawn = (target, spec) => {
    const stored = listActiveRuns().find((r) => r.questionSubmissionId === request.id);
    assert.equal(stored?.threadKey, context.threadKey);
    assert.match(stored.text, /Team only/);
    assert.match(stored.text, /Original task needs thread context/);
    observed = true;
    return spawn(target, spec);
  };
  try {
    await processMessageEvent(input, client, {
      botUserId: "U_BOT", questionSubmissionId: request.id,
      onQuestionSubmissionAccepted: ({ runId, rec }) => acceptQuestionSubmission(request.id, request.revision, runId, rec),
    });
  } finally {
    runtime.spawn = spawn;
  }
  assert.equal(observed, true);
  assert.ok(client.posted.some((m) => /Team only/.test(m.text || "")));
});

test("a typed thread answer carries pending question context into the fixture engine", async () => {
  const context = await setup("6175.001");
  const client = fakeSlack();
  const request = question(context);
  await processMessageEvent(event(context, "Actually, invite only please."), client, { botUserId: "U_BOT" });
  assert.equal(getQuestion(request.id).answeredInThread, true);
  assert.ok(client.posted.some((m) => /Who should have access/.test(m.text || "") && /invite only please/.test(m.text || "")));
});

test("restart recovery rechecks current membership before replaying submitted answers", async () => {
  const context = await setup("6200.001");
  const client = fakeSlack();
  client.members = [];
  const rec = { ...context, id: "question-recovery-revoked", questionSubmissionId: "saved-question", text: "saved answers", attachments: [] };
  recordActiveRun(rec.id, rec);
  let calls = 0;
  await recoverRuns([rec], {
    slack: { snapshot: () => ({ connected: true }), getClient: () => client },
    runner: async () => { calls++; throw new Error("must never spawn"); },
    forceStopping: () => false,
  });
  assert.equal(calls, 0);
  assert.equal(listActiveRuns().some((r) => r.id === rec.id), false);
  assert.ok(client.posted.some((m) => /not resumed/.test(m.text || "")));
});

test("authorized restart recovery retains the submission identity in the durable run", async () => {
  const context = await setup("6300.001");
  const client = fakeSlack();
  const rec = { ...context, id: "question-recovery-valid", questionSubmissionId: "saved-valid-question", text: "saved answers", attachments: [] };
  recordActiveRun(rec.id, rec);
  let calls = 0;
  await recoverRuns([rec], {
    slack: { snapshot: () => ({ connected: true }), getClient: () => client },
    runner: async (args) => {
      calls++;
      assert.equal(args.authorId, USER);
      assert.equal(args.threadKey, context.threadKey);
      assert.equal(listActiveRuns().find((r) => r.id === rec.id).questionSubmissionId, rec.questionSubmissionId);
      return { content: "continued", engine: "claude", usage: { output_tokens: 1 } };
    },
    deliver: async () => {}, usageRecorder: async () => {}, progressFactory: () => null, forceStopping: () => false,
  });
  assert.equal(calls, 1);
  assert.equal(listActiveRuns().some((r) => r.id === rec.id), false);
});

test("stop cancels questions before Slack acknowledgement and retires their controls", async () => {
  const context = await setup("6400.001");
  const client = fakeSlack();
  const request = updateQuestion(question(context).id, 0, { messageTs: "6400.002" });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  client.chat.postMessage = async (message) => { client.posted.push(message); await gate; return { ok: true }; };
  const stopping = stopRunsInChannel(client, CHANNEL, context.slug, USER, context.threadKey);
  assert.equal(getQuestion(request.id).status, "cancelled");
  release();
  assert.equal(await stopping, 1);
  await delay(0);
  assert.ok(client.updated.some((m) => m.ts === request.messageTs && !m.blocks.some((b) => b.type === "actions")));
});

test("clear cancels only questions in the cleared thread", async () => {
  const context = await setup("6500.001");
  const current = question(context);
  const other = question({ ...context, threadKey: "6501.001" });
  const client = fakeSlack();
  await processMessageEvent(event(context, "/clear"), client, { botUserId: "U_BOT" });
  assert.equal(getQuestion(current.id).status, "cancelled");
  assert.equal(getQuestion(other.id).status, "pending");
  await stopRunsInChannel(client, CHANNEL, context.slug, USER, "6501.001");
});

test("ordinary reply atomically retires only matching forms and keeps their prompt context", async () => {
  const context = await setup("6600.001");
  const current = question(context);
  const other = question({ ...context, authorId: "U_OTHER" });
  const text = `Question context: ${JSON.stringify(current.questions)}\nUser reply: invite only`;
  const retired = acceptQuestionReply([current], "question-typed-reply", { ...context, text });
  assert.equal(retired[0].answeredInThread, true);
  assert.equal(getQuestion(current.id).status, "cancelled");
  assert.equal(getQuestion(other.id).status, "pending");
  assert.equal(listActiveRuns().find((r) => r.id === "question-typed-reply").text, text);
  clearActiveRun("question-typed-reply");
  await stopRunsInChannel(fakeSlack(), CHANNEL, context.slug, USER, context.threadKey);
});

test("ordinary reply persistence failure rolls back form cancellation", async () => {
  const context = await setup("6700.001");
  const request = question(context);
  const db = getDb();
  db.exec("CREATE TRIGGER question_reply_failure BEFORE INSERT ON active_runs BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
  try {
    assert.throws(() => acceptQuestionReply([request], "question-write-failure", { ...context, text: "answer" }), /fixture write failure/);
    assert.equal(getQuestion(request.id).status, "pending");
    assert.equal(listActiveRuns().some((r) => r.id === "question-write-failure"), false);
  } finally {
    db.exec("DROP TRIGGER question_reply_failure");
  }
  await stopRunsInChannel(fakeSlack(), CHANNEL, context.slug, USER, context.threadKey);
});
