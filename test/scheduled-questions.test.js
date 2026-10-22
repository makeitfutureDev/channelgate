// A schedule's delivery thread is not its engine session. Form submissions must retain the
// original per-fire session, including recovery, while unrelated fires remain independent.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.env.PATH = `${path.join(projectRoot, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";

const { useFakeRuntime, createFakeRuntimeBackend } = await import("./runtime-fake.js");
const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage } = await import("../src/gateway/run.js");
const { getSession, getSessionMap } = await import("../src/gateway/sessions.js");
const { createQuestion, saveQuestionAnswers, bindQuestionMessage, acceptQuestionSubmission, getQuestion } = await import("../src/gateway/questions.js");
const { postQuestions } = await import("../src/slack/questions.js");
const { clearActiveRun } = await import("../src/gateway/active-runs.js");
const { readEvents } = await import("../src/util/logger.js");
const { acquireKeyedLock } = await import("../src/util/keyed-lock.js");

let sequence = 0;
const input = () => ({ title: "Scheduled task decision", questions: [
  { id: "access", prompt: "Who should have access?", type: "single", options: [{ label: "Team only", value: "team" }] },
] });

async function fixture(engine = "claude", { admin = false, adminMode = false } = {}) {
  const n = ++sequence;
  const authorId = `U_SCHEDULED_QUESTIONS_${n}`;
  const channelId = `C_SCHEDULED_QUESTIONS_${n}`;
  saveSettings({ engine, engineEnabled: { claude: true, codex: true }, engineFallback: false,
    agentMemory: false, memoryReviewEvery: 0, composioMode: "personal", containerFullAccessHome: false });
  await setUser(authorId, { name: "Scheduled question user", approved: true, isAdmin: admin });
  const entry = await upsertChannelEntry(channelId, { name: `scheduled-questions-${n}`, type: "channel", platform: "slack" });
  await saveChannelMeta(entry.slug, { channelId, name: entry.name, type: "channel", platform: "slack",
    template: "custom", engine, allowedMcps: [], cleanMode: false, allowNetwork: false, allowBash: true,
    access: "approved", adminMode });
  const backend = await useFakeRuntime(createFakeRuntimeBackend());
  return { channelId, authorId, slug: entry.slug, threadKey: `1900000${n}.000100`,
    sessionThreadKey: `sched-question-${n}-fire`, backend };
}

function request(context, extra = {}) {
  const record = createQuestion({ ...context, sourceSudo: false, ...extra }, input());
  return bindQuestionMessage(record.id, `${Number(context.threadKey || 1900000000) + 1}.000200`);
}

function submit(context, record) {
  const answered = saveQuestionAnswers(record.id, record.revision, { access: { values: ["team"] } });
  const runId = `scheduled-question-${record.id}`;
  assert.equal(acceptQuestionSubmission(answered.id, answered.revision, runId, {
    channelId: context.channelId, authorId: context.authorId, slug: context.slug,
    threadKey: answered.threadKey, text: "Team only", startedAt: Date.now(),
  }), true);
  clearActiveRun(runId);
  return getQuestion(record.id);
}

for (const engine of ["claude", "codex"]) {
  test(`${engine}: Submit and restart recovery resume the scheduled fire without creating a display-thread session`, async () => {
    const context = await fixture(engine);
    const source = await runMessage({ channelId: context.channelId, authorId: context.authorId,
      threadKey: context.sessionThreadKey, questionThreadKey: context.threadKey,
      origin: "schedule", text: "Prepare the scheduled task and request its access decision.", preferCold: true });
    assert.equal(source.engine, engine);
    assert.equal(source.isNew, true);
    assert.match(source.content, /resume=no/);

    const record = submit(context, request(context));
    for (const origin of ["slack_foreground", "recovery"]) {
      let accessChecks = 0;
      const continuation = await runMessage({ channelId: context.channelId, authorId: context.authorId,
        threadKey: context.threadKey, questionSubmissionId: record.id, origin,
        text: "The requesting user submitted Team only. Continue the scheduled task.", preferCold: true,
        verifyQuestionAccess: async () => { accessChecks++; } });
      assert.equal(accessChecks, 1, "access is rechecked after acquiring the source session lock");
      assert.equal(continuation.engine, engine);
      assert.equal(continuation.isNew, false);
      assert.equal(continuation.sessionId, source.sessionId);
      assert.match(continuation.content, /resume=yes/);
      assert.equal(await getSession(context.slug, context.threadKey), null);
      assert.deepEqual(Object.keys(await getSessionMap(context.slug)), [context.sessionThreadKey]);
    }
    const launches = readEvents({ limit: 100 }).filter((row) => row.event === "run_config" && row.slug === context.slug);
    assert.equal(launches.length, 3);
    assert.ok(launches.every((row) => row.threadKey === context.sessionThreadKey));
    assert.deepEqual(launches.map((row) => row.isNewSession).sort(), [false, false, true]);
    const spawned = context.backend.calls.spawn;
    const last = spawned.at(-1).args;
    if (engine === "claude") assert.equal(last[last.indexOf("-r") + 1], source.sessionId);
    else assert.equal(last[last.indexOf("resume") + 1], source.sessionId);
  });
}

test("a forged requester cannot use a saved scheduled question to resume another user's session", async () => {
  const context = await fixture();
  const record = submit(context, request(context));
  const before = context.backend.calls.spawn.length;
  for (const mismatch of [{ authorId: "U_OTHER_REQUESTER" }, { threadKey: "1999999.000100" }, { untrustedPrincipal: true }]) {
    await assert.rejects(runMessage({ channelId: context.channelId, authorId: context.authorId,
      threadKey: context.threadKey, questionSubmissionId: record.id, origin: "slack_foreground",
      text: "Use these answers", ...mismatch }), /identity mismatch/);
  }
  assert.equal(context.backend.calls.spawn.length, before);
  assert.deepEqual(await getSessionMap(context.slug), {});
});

test("a sudo scheduled form refuses a creator who has lost admin rank before submission resumes", async () => {
  const context = await fixture("claude", { admin: true });
  const record = submit(context, request(context, { sourceSudo: true }));
  await setUser(context.authorId, { isAdmin: false, approved: true });
  const result = await runMessage({ channelId: context.channelId, authorId: context.authorId,
    threadKey: context.threadKey, questionSubmissionId: record.id, origin: "slack_foreground", text: "Continue" });
  assert.equal(result.accessRefused, true);
  assert.match(result.content, /Only organization admins/);
  assert.equal(context.backend.calls.spawn.length, 0);
  assert.deepEqual(await getSessionMap(context.slug), {});
});

test("a demoted admin's ordinary scheduled form starts a fresh project session and imports no admin history", async () => {
  const context = await fixture("claude", { admin: true, adminMode: true });
  const source = await runMessage({ channelId: context.channelId, authorId: context.authorId,
    threadKey: context.sessionThreadKey, questionThreadKey: context.threadKey,
    origin: "schedule", text: "Prepare scheduled work", preferCold: true });
  const record = submit(context, request(context));
  await setUser(context.authorId, { isAdmin: false, approved: true });
  const continuation = await runMessage({ channelId: context.channelId, authorId: context.authorId,
    threadKey: context.threadKey, questionSubmissionId: record.id, origin: "slack_foreground", text: "Continue", preferCold: true });
  assert.equal(continuation.isNew, true);
  assert.notEqual(continuation.sessionId, source.sessionId);
  assert.equal(context.backend.calls.copyIn.length, 0);
  assert.equal(context.backend.calls.copyOut.length, 0);
  assert.equal(context.backend.calls.spawn.at(-1).args.includes("-r"), false);
  assert.equal(await getSession(context.slug, context.threadKey), null);
});

test("a still-admin human can continue a saved sudo form after its one-time schedule has retired", async () => {
  const context = await fixture("claude", { admin: true });
  // The fake executes both lanes in a container-shaped fixture. Give a resolved host target
  // the scratch artifact mount that a real container target already carries.
  const prepareTarget = context.backend.prepareTarget;
  context.backend.prepareTarget = (base) => ({ ...prepareTarget(base),
    artifactDir: base.artifactDir || path.join(process.env.CG_TEST_SCRATCH, "sudo-form-artifacts", base.slug) });
  // No schedule row remains: a submitted human answer is a new authenticated admin turn.
  // The daemon-saved sourceSudo fact retains that form's runtime request, not its creator's rank.
  const record = submit(context, request(context, { sourceSudo: true }));
  const result = await runMessage({ channelId: context.channelId, authorId: context.authorId,
    threadKey: context.threadKey, questionSubmissionId: record.id, origin: "slack_foreground", text: "Continue", preferCold: true });
  assert.equal(result.accessRefused, undefined);
  assert.equal(context.backend.calls.spawn.length, 1);
  assert.equal(context.backend.calls.spawn[0].args.includes("--dangerously-skip-permissions"), true);
});

test("submitted answers wait for the scheduled source and can be stopped before a second engine starts", async () => {
  const context = await fixture();
  let entered;
  let finishPreparation;
  const preparing = new Promise((resolve) => { entered = resolve; });
  const preparation = new Promise((resolve) => { finishPreparation = resolve; });
  const ensureUp = context.backend.ensureUp;
  context.backend.ensureUp = async (...args) => { entered(); await preparation; return ensureUp(...args); };
  const source = runMessage({ channelId: context.channelId, authorId: context.authorId,
    threadKey: context.sessionThreadKey, questionThreadKey: context.threadKey,
    origin: "schedule", text: "Prepare scheduled work", preferCold: true });
  await preparing;
  const record = submit(context, request(context));
  const controller = new AbortController();
  let accessChecks = 0;
  const waiting = runMessage({ channelId: context.channelId, authorId: context.authorId,
    threadKey: context.threadKey, questionSubmissionId: record.id, origin: "slack_foreground", text: "Continue",
    signal: controller.signal, verifyQuestionAccess: async () => { accessChecks++; } });
  const stopped = assert.rejects(waiting, { name: "AbortError" });
  try {
    await delay(20);
    assert.equal(accessChecks, 0, "the continuation must not pass its spawn preflight before the source finishes");
    assert.equal(context.backend.calls.spawn.length, 0);
    controller.abort();
    await stopped;
  } finally { finishPreparation(); await source; }
  assert.equal(context.backend.calls.spawn.length, 1, "only the original scheduled engine may start");
  const release = await acquireKeyedLock("scheduled-question-session", `${context.channelId}:${context.sessionThreadKey}`);
  release();
});

test("silent top-level forms bind their Slack thread durably and retry without duplicate posts", async () => {
  const context = await fixture();
  const posted = [];
  const client = {
    chat: {
      postMessage: async (body) => { posted.push(body); return { ok: true, ts: `1950000${posted.length}.000100` }; },
      update: async () => ({ ok: true }),
    },
    conversations: { members: async () => ({ members: [context.authorId], response_metadata: {} }) },
  };
  const silent = { ...context, threadKey: "", sourceSudo: false };
  const first = await postQuestions(silent, input(), { client });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].thread_ts, undefined);
  assert.equal(first.threadKey, "19500001.000100");
  assert.equal(first.messageTs, first.threadKey);
  assert.equal(first.sessionThreadKey, context.sessionThreadKey);
  assert.equal((await postQuestions(silent, input(), { client })).id, first.id);
  assert.equal(posted.length, 1);
  const next = await postQuestions({ ...silent, sessionThreadKey: `${context.sessionThreadKey}-next` }, input(), { client });
  assert.notEqual(next.id, first.id);
  assert.equal(posted.length, 2, "a different scheduled fire may independently request answers");
  const saved = submit(context, first);
  assert.equal(saved.threadKey, first.messageTs);
});
