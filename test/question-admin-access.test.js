import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();

const { setUser, upsertChannelEntry, defaultChannelMeta, saveChannelMeta } = await import("../src/config/store.js");
const { getQuestion, saveQuestionAnswers } = await import("../src/gateway/questions.js");
const { postQuestions, handleQuestionAction, handleQuestionView, startQuestionContinuation } = await import("../src/slack/questions.js");
const { buildQuestionCard, buildQuestionModal, buildCustomAnswerModal } = await import("../src/slack/question-views.js");
const { readEvents } = await import("../src/util/logger.js");

const OWNER = "UQUESTION_REQUESTER";
const ADMIN = "UQUESTION_ADMIN";
const MEMBER = "UQUESTION_MEMBER";
const CHANNEL = "CQUESTION_ADMIN_ACCESS";
const entry = await upsertChannelEntry(CHANNEL, { name: "question-admin-access", type: "channel", isDM: false });
await saveChannelMeta(entry.slug, defaultChannelMeta({ channelId: CHANNEL, name: entry.name, type: "channel", isDM: false, platform: "slack" }));
const elements = (view) => view.blocks.flatMap((b) => (b.elements || []).map((el) => ({ ...el, block_id: b.block_id })));
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
const choice = (id = "access", extra = {}) => ({ id, prompt: "Choose access", type: "single", required: true,
  allowCustom: true, options: [{ label: "Team", value: "team" }, { label: "Everyone", value: "all" }], ...extra });

async function fixture(questions = [choice()]) {
  await setUser(OWNER, { approved: true, isAdmin: false });
  await setUser(ADMIN, { approved: true, isAdmin: true });
  await setUser(MEMBER, { approved: true, isAdmin: false });
  const context = { channelId: CHANNEL, authorId: OWNER, slug: entry.slug, threadKey: randomUUID() };
  const log = { notices: [], opens: [], viewUpdates: [], continuations: [] };
  const control = { members: [OWNER, ADMIN, MEMBER] };
  const client = {
    conversations: { members: async () => ({ members: control.members }) },
    chat: { postMessage: async () => ({ ts: randomUUID() }), update: async () => ({}),
      postEphemeral: async (payload) => { log.notices.push(payload); return {}; } },
    views: { open: async (payload) => { log.opens.push(payload); }, update: async (payload) => { log.viewUpdates.push(payload); } },
  };
  const record = await postQuestions(context, { title: "Shared draft", questions }, { client });
  const current = () => getQuestion(record.id);
  const processMessage = async (event, receivedClient, options) => {
    assert.equal(receivedClient, client);
    log.continuations.push({ event, options });
    assert.equal(options.onQuestionSubmissionAccepted({ runId: randomUUID(), rec: { ...context, text: event.text } }), true);
  };
  const act = async (actionId, { user = ADMIN, data = current(), channel = CHANNEL, ts = data.messageTs, view, selected_options } = {}) => {
    const action = elements(view || buildQuestionCard(data)).find((el) => el.action_id === actionId);
    assert.ok(action, actionId);
    if (selected_options) action.selected_options = selected_options;
    let acknowledgments = 0;
    await handleQuestionAction({ ack: async () => { acknowledgments++; }, client, action,
      body: { user: { id: user }, channel: { id: channel }, message: { ts }, trigger_id: "trigger", ...(view ? { view } : {}) } }, { processMessage });
    assert.equal(acknowledgments, 1);
  };
  const submitView = async (view, values, user = ADMIN) => {
    const acks = [];
    view = { ...view, id: "VADMIN", hash: "admin-hash", state: { values } };
    await handleQuestionView({ ack: async (value) => acks.push(value), client, view, body: { user: { id: user }, view } }, { processMessage });
    assert.equal(acks.length, 1);
    return acks[0];
  };
  const audit = () => readEvents().filter((event) => event.event === "question_admin_action" && event.questionId === record.id);
  return { context, record, current, client, control, log, processMessage, act, submitView, audit };
}

test("admin card answers resume the requester once and audit the actual responder without answers", async () => {
  const f = await fixture();
  await f.act("cg_question_choose:access:0");
  const answered = f.current();
  await Promise.all([f.act("cg_question_submit", { data: answered }), f.act("cg_question_submit", { data: answered })]);
  await settle();
  assert.deepEqual(f.current().answers.access, { values: ["team"], custom: "" });
  assert.equal(f.current().authorId, OWNER);
  assert.equal(f.current().status, "submitted");
  assert.equal(f.log.continuations.length, 1);
  assert.equal(f.log.continuations[0].event.user, OWNER);
  assert.equal(f.log.continuations[0].options.busyChoice, "queue");
  assert.deepEqual(f.audit().map((event) => event.action).sort(), ["save", "submit"]);
  for (const event of f.audit()) {
    assert.equal(event.author, ADMIN);
    assert.equal(event.requesterId, OWNER);
    assert.deepEqual(Object.keys(event).sort(), ["action", "author", "channel", "event", "questionId", "requesterId", "slug", "ts"]);
  }
});

test("admin multi-choice and custom forms edit the same durable draft", async () => {
  const f = await fixture([choice("features", { type: "multi" })]);
  await f.act("cg_question_multi:features", { selected_options: [{ value: "all" }] });
  await f.act("cg_question_custom:features");
  const modal = f.log.opens.at(-1).view;
  assert.equal(await f.submitView(modal, { "q:features": { custom: { value: "Private custom answer" } } }), undefined);
  assert.deepEqual(f.current().answers.features, { values: ["all"], custom: "Private custom answer" });
  assert.equal(f.log.continuations.length, 0);
  assert.equal(JSON.stringify(f.audit()).includes("Private custom answer"), false);
});

test("admin paginated form opens, saves Back drafts and submits as original requester", async () => {
  const f = await fixture(Array.from({ length: 4 }, (_, i) => choice(`q${i}`, { allowCustom: false })));
  await f.act("cg_question_open");
  const first = f.log.opens.at(-1).view;
  const firstValues = Object.fromEntries([0, 1, 2].map((i) => [`q:q${i}`, { choice: { selected_option: { value: "team" } } }]));
  const next = await f.submitView(first, firstValues);
  assert.equal(next.response_action, "update");
  await f.act("cg_question_back", { view: { ...next.view, id: "VADMIN", hash: "hash", state: { values: {} } } });
  assert.equal(f.current().answers.q3.values.length, 0);
  const again = await f.submitView(f.log.viewUpdates.at(-1).view, firstValues);
  await f.submitView(again.view, { "q:q3": { choice: { selected_option: { value: "all" } } } });
  await settle();
  assert.equal(f.current().status, "submitted");
  assert.equal(f.log.continuations[0].event.user, OWNER);
});

test("current admin may cancel another requester's form", async () => {
  const f = await fixture();
  await f.act("cg_question_cancel");
  assert.equal(f.current().status, "cancelled");
  assert.equal(f.audit()[0].action, "cancel");
  assert.equal(f.log.continuations.length, 0);
});

test("admin access retains card binding and shared revision replay protection", async () => {
  const f = await fixture();
  const initial = f.current();
  for (const mismatch of [{ channel: "CWRONG" }, { ts: "wrong" }, { user: MEMBER }]) {
    await f.act("cg_question_choose:access:0", mismatch);
    assert.equal(f.current().revision, initial.revision);
  }
  const staleModal = buildCustomAnswerModal(initial, "access");
  await f.act("cg_question_choose:access:0", { user: OWNER });
  await f.act("cg_question_choose:access:1", { data: initial });
  const denied = await f.submitView(staleModal, { "q:access": { custom: { value: "stale" } } });
  assert.equal(denied.response_action, "errors");
  assert.deepEqual(f.current().answers.access.values, ["team"]);
  assert.equal(f.audit().length, 0);
});

test("departed admin or requester cannot mutate another requester's draft", async () => {
  for (const members of [[OWNER, MEMBER], [ADMIN, MEMBER]]) {
    const f = await fixture();
    f.control.members = members;
    await f.act("cg_question_choose:access:0");
    assert.deepEqual(f.current().answers, {});
    assert.match(f.log.notices.at(-1).text, /current conversation members/);
    assert.equal(f.audit().length, 0);
  }
});

test("admin role and requester authorization are rechecked on existing modals", async () => {
  const f = await fixture();
  const modal = buildQuestionModal(f.current());
  await setUser(ADMIN, { isAdmin: false });
  const denied = await f.submitView(modal, { "q:access": { choice: { selected_option: { value: "team" } } } });
  assert.equal(denied.response_action, "errors");
  assert.deepEqual(f.current().answers, {});
  await setUser(ADMIN, { isAdmin: true });
  await setUser(OWNER, { approved: false });
  await f.act("cg_question_choose:access:0");
  assert.deepEqual(f.current().answers, {});
  assert.match(f.log.notices.at(-1).text, /no longer have access/);
});

test("admin demotion before continuation launch preserves pending draft and reports to actual responder", async () => {
  const f = await fixture();
  const answered = saveQuestionAnswers(f.record.id, 0, { access: { values: ["team"] } });
  const continuation = startQuestionContinuation(answered, f.client, f.processMessage, { responderId: ADMIN });
  await setUser(ADMIN, { isAdmin: false });
  await continuation;
  assert.equal(f.current().status, "pending");
  assert.equal(f.log.continuations.length, 0);
  assert.equal(f.log.notices.at(-1).user, ADMIN);
  assert.equal(f.audit().length, 0);
});
