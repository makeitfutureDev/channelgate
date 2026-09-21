// Real durable store and authorization with captured Slack payloads; no engine/network access.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();

const { setUser, upsertChannelEntry, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");
const { getDb } = await import("../src/db/index.js");
const { getQuestion, saveQuestionAnswers } = await import("../src/gateway/questions.js");
const { postQuestions, handleQuestionAction, handleQuestionView, refreshQuestionCard, registerQuestionActions, questionSlackClient } = await import("../src/slack/questions.js");
const { buildQuestionCard, buildQuestionModal, buildCustomAnswerModal } = await import("../src/slack/question-views.js");

const OWNER = "UQUESTION_OWNER";
const OTHER = "UQUESTION_OTHER";
const CHANNEL = "CQUESTION_INTERACTIONS";
await setUser(OWNER, { name: "Question owner", approved: true, isAdmin: false });
await setUser(OTHER, { name: "Other member", approved: true, isAdmin: false });
const entry = await upsertChannelEntry(CHANNEL, { name: "question-interactions", type: "channel", isDM: false });
const SLUG = entry.slug;
await saveChannelMeta(SLUG, { ...await getChannelMeta(SLUG), channelId: CHANNEL, access: "approved", platform: "slack", isDM: false });

const choice = (id = "access", extra = {}) => ({ id, prompt: "Who can access this?", type: "single", required: true,
  allowCustom: true, options: [{ label: "Team", value: "team" }, { label: "Everyone", value: "all" }], ...extra });
const elements = (view) => view.blocks.flatMap((b) => (b.elements || []).map((el) => ({ ...el, block_id: b.block_id })));
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve)); };

async function fixture(questions = [choice()]) {
  const log = { posts: [], updates: [], notices: [], opens: [], viewUpdates: [], continuations: [], accepted: [] };
  const control = { members: [OWNER, OTHER], updateError: null };
  const client = {
    conversations: { members: async () => ({ members: control.members }) },
    chat: {
      postMessage: async (payload) => { log.posts.push(payload); return { ok: true, ts: `1900.${log.posts.length}` }; },
      update: async (payload) => { if (control.updateError) throw control.updateError; log.updates.push(payload); return { ok: true }; },
      postEphemeral: async (payload) => { log.notices.push(payload); return { ok: true }; },
    },
    views: {
      open: async (payload) => { log.opens.push(payload); return { ok: true }; },
      update: async (payload) => { log.viewUpdates.push(payload); return { ok: true }; },
    },
  };
  const context = { channelId: CHANNEL, authorId: OWNER, slug: SLUG, threadKey: `1800.${randomUUID()}` };
  const input = { title: "Choose the behavior", questions };
  const initial = await postQuestions(context, input, { client });
  const current = () => getQuestion(initial.id);
  const processMessage = async (event, usedClient, options) => {
    assert.equal(usedClient, client);
    log.continuations.push({ event, options });
    log.accepted.push(options.onQuestionSubmissionAccepted({ runId: randomUUID(), rec: { ...context, userId: OWNER } }));
  };
  const act = async (actionId, { data = current(), user = OWNER, channel = CHANNEL, ts = data.messageTs, selected_options, view } = {}) => {
    const source = view || buildQuestionCard(data);
    const action = elements(source).find((el) => el.action_id === actionId);
    assert.ok(action, `missing action ${actionId}`);
    if (selected_options) action.selected_options = selected_options;
    const acks = [];
    const body = { user: { id: user }, channel: { id: channel }, message: { ts, thread_ts: data.threadKey }, trigger_id: "trigger-test", ...(view ? { view } : {}) };
    await handleQuestionAction({ ack: async (result) => acks.push(result), body, action, client }, { processMessage });
    assert.equal(acks.length, 1);
    return acks;
  };
  const submitView = async (view, values, user = OWNER) => {
    const acks = [];
    view = { ...view, id: "VQUESTION", hash: "hash-test", state: { values } };
    await handleQuestionView({ ack: async (result) => acks.push(result), body: { user: { id: user }, view }, view, client }, { processMessage });
    assert.equal(acks.length, 1);
    return acks[0];
  };
  return { log, control, client, context, input, initial, current, act, submitView };
}

test("posting is idempotent and visible card carries the persisted revision", async () => {
  const f = await fixture();
  const again = await postQuestions(f.context, f.input, { client: f.client });
  assert.equal(again.id, f.initial.id);
  assert.equal(f.log.posts.length, 1);
  const visible = f.log.updates.at(-1) || f.log.posts.at(-1);
  assert.equal(JSON.parse(elements(visible).find((el) => el.action_id === "cg_question_submit").value).revision, again.revision);
});

test("registered submit handlers preserve the live bot and workspace context", async () => {
  const f = await fixture();
  await f.act("cg_question_choose:access:0");
  let handler;
  let received;
  registerQuestionActions({ action(_pattern, fn) { handler = fn; }, view() {} }, async (_event, _client, options) => {
    received = options;
    options.onQuestionSubmissionAccepted({ runId: randomUUID(), rec: f.context });
  }, { botUserId: "U_BOT_CONTEXT", teamId: "T_WORKSPACE_CONTEXT" });
  const record = f.current();
  const action = elements(buildQuestionCard(record)).find((el) => el.action_id === "cg_question_submit");
  await handler({ ack: async () => {}, action, client: f.client, body: { user: { id: OWNER }, channel: { id: CHANNEL }, message: { ts: record.messageTs } } });
  await settle();
  assert.equal(received.botUserId, "U_BOT_CONTEXT");
  assert.equal(received.teamId, "T_WORKSPACE_CONTEXT");
  assert.equal(received.bypassMention, true);
  assert.equal(f.current().status, "submitted");
});

test("options and custom save are drafts; duplicate submit creates one durable continuation", async () => {
  const f = await fixture();
  await f.act("cg_question_choose:access:0");
  assert.deepEqual(f.current().answers.access, { values: ["team"], custom: "" });
  await f.act("cg_question_custom:access");
  const custom = f.log.opens.at(-1).view;
  const result = await f.submitView(custom, { "q:access": { custom: { type: "plain_text_input", value: "Invited guests" } } });
  assert.equal(result, undefined);
  assert.deepEqual(f.current().answers.access, { values: [], custom: "Invited guests" });
  assert.equal(f.log.continuations.length, 0);
  const before = f.current();
  await Promise.all([f.act("cg_question_submit", { data: before }), f.act("cg_question_submit", { data: before })]);
  await settle();
  assert.equal(f.log.continuations.length, 1);
  assert.deepEqual(f.log.accepted, [true]);
  assert.equal(f.current().status, "submitted");
  const continuation = f.log.continuations[0];
  assert.equal(continuation.event.channel, CHANNEL);
  assert.equal(continuation.event.user, OWNER);
  assert.equal(continuation.event.thread_ts, f.context.threadKey);
  assert.match(continuation.event.text, /Invited guests/);
  assert.equal(continuation.options.busyChoice, "queue");
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM active_runs WHERE id=?").get(f.current().runId).n, 1);
});

test("other user, wrong channel/message, stale buttons and departed members cannot mutate drafts", async () => {
  const f = await fixture();
  const initial = f.current();
  for (const args of [{ user: OTHER }, { channel: "CWRONG" }, { ts: "wrong.timestamp" }]) {
    await f.act("cg_question_choose:access:0", args);
    assert.equal(f.current().revision, initial.revision);
  }
  await f.act("cg_question_choose:access:0");
  const selected = f.current();
  await f.act("cg_question_choose:access:1", { data: initial });
  assert.deepEqual(f.current().answers, selected.answers);
  f.control.members = [OTHER];
  await f.act("cg_question_choose:access:1");
  assert.deepEqual(f.current().answers, selected.answers);
  assert.equal(f.log.notices.length, 5);
  assert.equal(f.log.continuations.length, 0);
});

test("modal owner and revision checks reject replayed custom answers", async () => {
  const f = await fixture();
  const stale = buildCustomAnswerModal(f.current(), "access");
  const values = { "q:access": { custom: { value: "Untrusted answer" } } };
  const denied = await f.submitView(stale, values, OTHER);
  assert.equal(denied.response_action, "errors");
  assert.deepEqual(f.current().answers, {});
  await f.act("cg_question_choose:access:0");
  const rejected = await f.submitView(stale, values);
  assert.equal(rejected.response_action, "errors");
  assert.deepEqual(f.current().answers.access, { values: ["team"], custom: "" });
  assert.equal(f.log.continuations.length, 0);
});

test("multi checkbox payload identity persists options and custom text together", async () => {
  const f = await fixture([choice("features", { type: "multi" })]);
  await f.act("cg_question_multi:features", { selected_options: [{ text: { type: "plain_text", text: "Everyone" }, value: "all" }] });
  await f.submitView(buildCustomAnswerModal(f.current(), "features"), { "q:features": { custom: { value: "One more" } } });
  assert.deepEqual(f.current().answers.features, { values: ["all"], custom: "One more" });
  await f.act("cg_question_multi:features", { selected_options: [] });
  assert.deepEqual(f.current().answers.features, { values: [], custom: "One more" });
  assert.equal(f.log.continuations.length, 0);
});

test("Next validates required answers, Back saves incomplete drafts and Submit resumes once", async () => {
  const f = await fixture(Array.from({ length: 4 }, (_, i) => choice(`q${i}`, { allowCustom: false })));
  await f.act("cg_question_open");
  const first = f.log.opens.at(-1).view;
  const missing = await f.submitView(first, {});
  assert.equal(missing.response_action, "errors");
  assert.deepEqual(Object.keys(missing.errors), ["q:q0", "q:q1", "q:q2"]);
  const firstValues = Object.fromEntries([0, 1, 2].map((i) => [`q:q${i}`, { choice: { type: "radio_buttons", selected_option: { value: "team" } } }]));
  const next = await f.submitView(first, firstValues);
  assert.equal(next.response_action, "update");
  assert.equal(JSON.parse(next.view.private_metadata).page, 1);
  const page1 = { ...next.view, id: "VQUESTION", hash: "hash-test", state: { values: {} } };
  await f.act("cg_question_back", { view: page1 });
  assert.equal(JSON.parse(f.log.viewUpdates.at(-1).view.private_metadata).page, 0);
  assert.deepEqual(f.current().answers.q3, { values: [], custom: "" });
  assert.equal(f.log.continuations.length, 0);
  const secondNext = await f.submitView(f.log.viewUpdates.at(-1).view, firstValues);
  await f.submitView(secondNext.view, { "q:q3": { choice: { type: "radio_buttons", selected_option: { value: "all" } } } });
  await settle();
  assert.equal(f.current().status, "submitted");
  assert.equal(f.log.continuations.length, 1);
  assert.deepEqual(f.current().answers.q3, { values: ["all"], custom: "" });
});

test("cancellation retires a form without invoking the agent", async () => {
  const f = await fixture();
  await f.act("cg_question_cancel");
  assert.equal(f.current().status, "cancelled");
  assert.equal(f.log.continuations.length, 0);
  assert.ok(!f.log.updates.at(-1).blocks.some((b) => b.type === "actions"));
});

test("retry repairs a failed card refresh without duplicate posting", async () => {
  const f = await fixture();
  f.control.updateError = new Error("temporary update failure");
  await f.act("cg_question_choose:access:0");
  const updated = f.current();
  assert.deepEqual(updated.answers.access, { values: ["team"], custom: "" });
  assert.match(f.log.notices.at(-1).text, /temporary update failure/);
  // A retry of the original request must redraw this persisted revision, even if an earlier
  // interactive card edit failed after the draft was saved.
  f.control.updateError = null;
  await postQuestions(f.context, f.input, { client: f.client });
  assert.equal(f.log.posts.length, 1);
  const visible = f.log.updates.at(-1);
  assert.equal(JSON.parse(elements(visible).find((el) => el.action_id === "cg_question_submit").value).revision, updated.revision);
});

test("stale Open form recovers the durable draft after a card update fails", async () => {
  const f = await fixture();
  const original = f.current();
  f.control.updateError = new Error("temporary card update failure");
  await f.act("cg_question_choose:access:1");
  assert.ok(f.current().revision > original.revision);
  f.control.updateError = null;
  await f.act("cg_question_open", { data: original });
  assert.equal(f.log.opens.length, 1);
  const view = f.log.opens[0].view;
  assert.equal(JSON.parse(view.private_metadata).revision, f.current().revision);
  assert.equal(view.blocks.find((b) => b.block_id === "q:access").element.initial_option.value, "all");
  assert.equal(f.log.continuations.length, 0);
});

test("overlapping card refreshes serialize and reread the newest durable answers", async () => {
  const f = await fixture();
  const saved = saveQuestionAnswers(f.current().id, f.current().revision, { access: { values: ["team"], custom: "" } });
  let releaseFirst;
  let announceFirst;
  const firstEntered = new Promise((resolve) => { announceFirst = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const completed = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  f.client.chat.update = async (payload) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (++calls === 1) {
      announceFirst();
      await firstGate;
    }
    completed.push(payload);
    inFlight--;
    return { ok: true };
  };
  const first = refreshQuestionCard(saved, f.client);
  await firstEntered;
  const newest = saveQuestionAnswers(saved.id, saved.revision, { access: { values: ["all"], custom: "" } });
  // Intentionally pass the old record: rendering must reread after the first update finishes.
  const second = refreshQuestionCard(saved, f.client);
  await settle();
  assert.equal(calls, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(maxInFlight, 1);
  assert.equal(completed.length, 2);
  const final = completed.at(-1);
  assert.equal(JSON.parse(elements(final).find((el) => el.action_id === "cg_question_submit").value).revision, newest.revision);
  assert.equal(elements(final).find((el) => el.action_id === "cg_question_choose:access:1").style, "primary");
  assert.equal(f.log.continuations.length, 0);
});

test("slow modal membership verification acknowledges an error before Slack's three-second deadline", async () => {
  const f = await fixture();
  const original = f.current();
  let resolveMembership;
  f.client.conversations.members = () => new Promise((resolve) => { resolveMembership = resolve; });
  const started = performance.now();
  const response = await f.submitView(buildCustomAnswerModal(original, "access"), {
    "q:access": { custom: { value: "Must not be saved after timeout" } },
  });
  const elapsed = performance.now() - started;
  assert.equal(response.response_action, "errors");
  assert.match(response.errors["q:access"], /verification took too long/);
  assert.ok(elapsed < 3000, `Slack acknowledgement took ${elapsed}ms`);
  assert.equal(f.current().revision, original.revision);
  resolveMembership({ members: [OWNER] });
  await settle();
  assert.deepEqual(f.current().answers, {});
  assert.equal(f.log.continuations.length, 0);
});


test("question Slack transport encodes member queries and preserves JSON chat writes", async () => {
  const requests = [];
  const client = questionSlackClient({ token: "test-only-token", fetchImpl: async (url, init) => {
    requests.push({ url: new URL(url), init });
    return { ok: true, json: async () => ({ ok: true, members: ["UOWNER"] }) };
  } });
  await client.conversations.members({ channel: "CQUESTION", limit: 200, cursor: "next+/=&" });
  const { url, init } = requests[0];
  assert.equal(url.pathname, "/api/conversations.members");
  assert.equal(url.searchParams.get("channel"), "CQUESTION");
  assert.equal(url.searchParams.get("limit"), "200");
  assert.equal(url.searchParams.get("cursor"), "next+/=&");
  assert.equal(init.method, "GET");
  assert.equal(init.body, undefined);
  assert.equal(init.headers.Authorization, "Bearer test-only-token");
  assert.equal(url.toString().includes("test-only-token"), false);
  for (const method of ["postMessage", "update"]) {
    const payload = { channel: "CQUESTION", text: "Demo" };
    await client.chat[method](payload);
    const request = requests.at(-1);
    assert.equal(request.url.pathname, `/api/chat.${method}`);
    assert.equal(request.init.method, "POST");
    assert.deepEqual(JSON.parse(request.init.body), payload);
  }
});

test("question Slack transport fails closed on API and HTTP errors", async () => {
  for (const response of [
    { ok: true, json: async () => ({ ok: false, error: "invalid_arguments" }) },
    { ok: false, status: 503, json: async () => ({}) },
  ]) {
    const client = questionSlackClient({ token: "test-only-token", fetchImpl: async () => response });
    await assert.rejects(client.conversations.members({ channel: "CQUESTION" }), /Slack conversations.members failed:/);
  }
});
