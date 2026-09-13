import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const store = await import("../src/gateway/questions.js");
const { getDb } = await import("../src/db/index.js");
const { register } = await import("../src/mcp/tools/questions.js");

let nextThread = 0;
const context = () => ({ channelId: "C_QUESTIONS", slug: "questions-test", authorId: "U_REQUESTER", threadKey: `${++nextThread}.00001` });
const input = () => ({ title: "Choices", questions: [
  { id: "access", prompt: "Access?", type: "single", options: [{ label: "Team only", value: "team" }, { label: "Invite only", value: "invite" }] },
] });

test("schema rejects duplicate IDs, forged fields, unsupported choices and invalid lengths", () => {
  const value = input();
  assert.equal(store.normalizeQuestions(value).questions[0].allowCustom, true);
  assert.throws(() => store.normalizeQuestions({ ...value, channelId: "C_OTHER" }));
  assert.throws(() => store.normalizeQuestions({ ...value, questions: [...value.questions, ...value.questions] }), /unique/);
  assert.throws(() => store.normalizeQuestions({ ...value, questions: [{ ...value.questions[0], options: Array(5).fill({ label: "x", value: "x" }) }] }), /four/);
  assert.throws(() => store.normalizeQuestions({ ...value, questions: [{ ...value.questions[0], options: [{ label: "x", value: "x" }, { label: "y", value: "x" }] }] }), /unique/);
  assert.throws(() => store.normalizeQuestions({ ...value, title: "x".repeat(121) }));
  assert.throws(() => store.normalizeQuestions({ ...value, questions: [{ id: "__proto__", prompt: "bad", type: "text" }] }));
  assert.throws(() => store.normalizeQuestions({ ...value, presentation: "message", questions: Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, prompt: "x", type: "text" })) }), /four/);
});

test("creation retries reuse the same pending card, drafts are readable by a fresh process", () => {
  const ctx = context();
  let record = store.createQuestion(ctx, input());
  record = store.bindQuestionMessage(record.id, "123.001");
  assert.equal(record.revision, 0, "delivery binding must not stale the posted controls");
  record = store.saveQuestionAnswers(record.id, record.revision, { access: { values: ["team"], custom: "" } });
  assert.equal(store.createQuestion(ctx, input()).id, record.id);
  assert.throws(() => store.createQuestion(ctx, { ...input(), title: "Different" }), /pending/);
  const moduleUrl = new URL("../src/gateway/questions.js", import.meta.url).href;
  const fresh = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `const {getQuestion}=await import(${JSON.stringify(moduleUrl)}); process.stdout.write(JSON.stringify(getQuestion(${JSON.stringify(record.id)})));`], { encoding: "utf8" }));
  assert.deepEqual(fresh.answers.access.values, ["team"]);
  assert.equal(fresh.messageTs, "123.001");
});

test("draft validation rejects forged options, stale writes and custom text where disabled", () => {
  let record = store.createQuestion(context(), input());
  assert.throws(() => store.saveQuestionAnswers(record.id, 0, { access: { values: ["forged"] } }), /Invalid/);
  assert.throws(() => store.saveQuestionAnswers(record.id, 0, { missing: { custom: "x" } }), /Unknown/);
  record = store.saveQuestionAnswers(record.id, 0, { access: { values: ["team"], custom: " My answer " } });
  assert.deepEqual(record.answers.access, { values: [], custom: "My answer" });
  assert.throws(() => store.saveQuestionAnswers(record.id, 0, { access: { values: ["invite"] } }), /changed/);
  assert.throws(() => store.validateAnswer({ ...record.questions[0], allowCustom: false }, { custom: "No" }), /Invalid/);
  assert.throws(() => store.validateAnswer(record.questions[0], { custom: "x".repeat(2001) }), /2000/);
  assert.deepEqual(store.validateAnswer(record.questions[0], { values: ["team"], custom: "  " }), { values: ["team"], custom: "" });
});

test("Submit validates required answers and atomically creates exactly one continuation", () => {
  const ctx = context();
  let record = store.createQuestion(ctx, input());
  const run = { ...ctx, text: "Answers", questionSubmissionId: record.id };
  assert.equal(store.acceptQuestionSubmission(record.id, 0, "unanswered", run), false);
  record = store.saveQuestionAnswers(record.id, 0, { access: { values: ["invite"] } });
  assert.throws(() => store.acceptQuestionSubmission(record.id, record.revision, "wrong-author", { ...run, authorId: "U_OTHER" }), /identity/);
  assert.equal(store.getQuestion(record.id).status, "pending");
  assert.equal(store.acceptQuestionSubmission(record.id, record.revision, "submitted-once", run), true);
  assert.equal(store.acceptQuestionSubmission(record.id, record.revision, "submitted-twice", run), false);
  assert.equal(store.getQuestion(record.id).status, "submitted");
  assert.ok(getDb().prepare("SELECT id FROM active_runs WHERE id=?").get("submitted-once"));
  assert.equal(getDb().prepare("SELECT id FROM active_runs WHERE id=?").get("submitted-twice"), undefined);
});

test("failed continuation persistence rolls back submission, and cancellation is scoped", () => {
  const ctx = context();
  let record = store.createQuestion(ctx, input());
  record = store.saveQuestionAnswers(record.id, 0, { access: { values: ["team"] } });
  getDb().exec("CREATE TEMP TRIGGER reject_question_run BEFORE INSERT ON active_runs BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  try { assert.throws(() => store.acceptQuestionSubmission(record.id, record.revision, "rollback", ctx), /test failure/); }
  finally { getDb().exec("DROP TRIGGER reject_question_run"); }
  assert.equal(store.getQuestion(record.id).status, "pending");
  assert.equal(store.getQuestion(record.id).revision, record.revision);
  const other = store.createQuestion({ ...ctx, authorId: "U_OTHER" }, input());
  assert.equal(store.cancelPendingQuestions(ctx).length, 1);
  assert.equal(store.getQuestion(other.id).status, "pending");
  assert.equal(store.acceptQuestionSubmission(record.id, record.revision, "after-stop", ctx), false);
});

test("question tool is available to both engines only for a trusted foreground thread", async () => {
  const base = { origin: "slack_foreground", principalTrusted: true, threadKey: "123.456", channelId: "C_THIS", slug: "this", createdBy: "U_THIS", text: (s) => ({ content: [{ type: "text", text: s }] }) };
  for (const activeEngine of ["claude", "codex"]) {
    const calls = [];
    let handler;
    register({ registerTool(name, def, fn) { assert.equal(name, "ask_questions"); handler = fn; } }, { ...base, activeEngine }, {
      post: async (ctx, args) => { calls.push({ ctx, args }); return { id: "request-id" }; },
    });
    const result = await handler(input());
    assert.deepEqual(calls[0].ctx, { channelId: "C_THIS", threadKey: "123.456", authorId: "U_THIS", slug: "this" });
    assert.match(result.content[0].text, /Awaiting.*Submit/);
  }
  for (const override of [{ origin: "schedule" }, { origin: "recovery" }, { origin: "background_agent" }, { principalTrusted: false }, { threadKey: "123.456::agent-1" }]) {
    let registered = false;
    register({ registerTool() { registered = true; } }, { ...base, ...override });
    assert.equal(registered, false);
  }
});
