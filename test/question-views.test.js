import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQuestionCard, buildQuestionModal, buildCustomAnswerModal, questionPage,
  questionPresentation, parseQuestionMetadata, parseQuestionPageAnswers,
  QUESTION_FORM_CALLBACK, QUESTION_CUSTOM_CALLBACK,
} from "../src/slack/question-views.js";

const single = (id = "access", extra = {}) => ({
  id, prompt: "Who should have access?", type: "single", required: true, allowCustom: true,
  options: [{ label: "Team only", value: "team" }, { label: "Everyone", value: "all" }], ...extra,
});
const record = (extra = {}) => ({
  id: "question-form-id", revision: 2, title: "A few decisions", status: "pending",
  questions: [single()], answers: {}, ...extra,
});
const allElements = (view) => view.blocks.flatMap((block) => block.elements || (block.element ? [block.element] : []));

function assertSlackBounds(view, modal = false) {
  assert.ok(view.blocks.length <= (modal ? 100 : 50));
  if (modal) {
    assert.ok(view.title.text.length <= 24);
    assert.ok(view.submit.text.length <= 24);
    assert.ok(view.close.text.length <= 24);
    assert.ok(view.private_metadata.length <= 3000);
  }
  const visit = (obj) => {
    if (!obj || typeof obj !== "object") return;
    assert.notEqual(obj.type, "mrkdwn");
    if (obj.action_id) assert.ok(obj.action_id.length <= 255);
    if (obj.block_id) assert.ok(obj.block_id.length <= 255);
    if (obj.type === "section") assert.ok(obj.text.text.length <= 3000);
    if (obj.type === "header") assert.ok(obj.text.text.length <= 150);
    if (obj.type === "actions") assert.ok(obj.elements.length <= 25);
    if (obj.type === "button") {
      assert.ok(obj.text.text.length <= 75);
      assert.ok(obj.value.length <= 2000);
    }
    if (obj.type === "input") assert.ok(obj.label.text.length <= 2000);
    if (["radio_buttons", "checkboxes"].includes(obj.type)) {
      assert.ok(obj.options.length <= 10);
      for (const option of obj.options) {
        assert.ok(option.text.text.length <= 75);
        assert.ok(option.value.length <= 150);
      }
      for (const initial of obj.initial_options || (obj.initial_option ? [obj.initial_option] : [])) {
        assert.ok(obj.options.some((o) => JSON.stringify(o) === JSON.stringify(initial)));
      }
    }
    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(view);
}

test("message buttons carry form/revision identity, dynamic labels and selected state", () => {
  const data = record({ answers: { access: { values: ["team"], custom: "" } } });
  const card = buildQuestionCard(data);
  const elements = allElements(card);
  const team = elements.find((el) => el.action_id === "cg_question_choose:access:0");
  assert.equal(team.text.text, "Team only");
  assert.equal(team.style, "primary");
  assert.deepEqual(JSON.parse(team.value), { id: data.id, revision: 2 });
  assert.equal(elements.find((el) => el.action_id === "cg_question_choose:access:1").style, undefined);
  assert.ok(elements.some((el) => el.action_id === "cg_question_custom:access"));
  assert.ok(elements.some((el) => el.action_id === "cg_question_submit"));
  assert.ok(card.blocks.some((b) => b.block_id === `cg_question:${data.id}:2:access`));
  assertSlackBounds(card);
});

test("multi choices use checkboxes with exact initial option objects and custom text", () => {
  const card = buildQuestionCard(record({ questions: [single("features", { type: "multi" })],
    answers: { features: { values: ["team"], custom: "Another feature" } } }));
  const checkbox = allElements(card).find((el) => el.type === "checkboxes");
  assert.deepEqual(checkbox.initial_options, [checkbox.options[0]]);
  assert.equal(checkbox.action_id, "cg_question_multi:features");
  assert.ok(card.blocks.some((b) => b.text?.text === "Current answer: Team only, Another feature"));
  assertSlackBounds(card);
});

test("auto presentation opens long/text forms and explicit short text message gets write button", () => {
  const long = record({ questions: Array.from({ length: 5 }, (_, i) => single(`q${i}`)) });
  assert.equal(questionPresentation(long), "modal");
  assert.equal(questionPresentation({ ...long, presentation: "message" }), "modal");
  const text = record({ questions: [single("notes", { type: "text", options: [] })] });
  assert.equal(questionPresentation(text), "modal");
  const launch = allElements(buildQuestionCard(long));
  assert.ok(launch.some((el) => el.action_id === "cg_question_open"));
  assert.ok(!launch.some((el) => el.action_id === "cg_question_submit"));
  const explicit = buildQuestionCard({ ...text, presentation: "message" });
  assert.ok(allElements(explicit).some((el) => el.action_id === "cg_question_custom:notes"));
});

test("submitted and cancelled cards remove all controls and show answers as plain text", () => {
  for (const status of ["submitted", "cancelled"]) {
    const card = buildQuestionCard(record({ status, answers: { access: { values: ["team"], custom: "My choice" } } }));
    assert.equal(allElements(card).length, 1); // Header excluded, single context text included.
    assert.ok(!card.blocks.some((b) => b.type === "actions"));
    assert.ok(card.blocks.some((b) => b.text?.text.endsWith("\nMy choice")));
    assertSlackBounds(card);
  }
});

test("paginated form restores each page's draft and exposes Back/Next/Submit", () => {
  const data = record({ questions: Array.from({ length: 7 }, (_, i) => single(`q${i}`)),
    answers: { q3: { values: ["all"], custom: "" }, q4: { values: [], custom: "Custom value" } } });
  assert.deepEqual(questionPage(data, 1).questions.map((q) => q.id), ["q3", "q4", "q5"]);
  for (const invalid of [-1, 3, 0.2, NaN]) assert.throws(() => questionPage(data, invalid), /Invalid question page/);
  const first = buildQuestionModal(data);
  assert.equal(first.callback_id, QUESTION_FORM_CALLBACK);
  assert.equal(first.submit.text, "Next");
  assert.ok(!allElements(first).some((el) => el.action_id === "cg_question_back"));
  const second = buildQuestionModal(data, 1);
  assert.deepEqual(JSON.parse(second.private_metadata), { id: data.id, revision: 2, page: 1 });
  assert.equal(second.blocks.find((b) => b.block_id === "q:q3").element.initial_option.value, "all");
  assert.equal(second.blocks.find((b) => b.block_id === "custom:q4").element.initial_value, "Custom value");
  assert.ok(allElements(second).some((el) => el.action_id === "cg_question_back"));
  const last = buildQuestionModal(data, 2);
  assert.equal(last.submit.text, "Submit");
  assert.equal(last.blocks.filter((b) => b.type === "input").length, 2);
  [first, second, last].forEach((view) => assertSlackBounds(view, true));
});

test("custom modal preserves text, permits clearing and disallows unsupported questions", () => {
  const data = record({ answers: { access: { values: [], custom: "Specific team" } } });
  const view = buildCustomAnswerModal(data, "access");
  assert.equal(view.callback_id, QUESTION_CUSTOM_CALLBACK);
  assert.deepEqual(JSON.parse(view.private_metadata), { id: data.id, revision: 2, questionId: "access" });
  assert.equal(view.blocks[0].optional, true);
  assert.equal(view.blocks[0].element.initial_value, "Specific team");
  assert.equal(view.blocks[0].element.max_length, 2000);
  assert.throws(() => buildCustomAnswerModal(data, "unknown"), /not allowed/);
  assert.throws(() => buildCustomAnswerModal(record({ questions: [single("access", { allowCustom: false })] }), "access"), /not allowed/);
  assertSlackBounds(view, true);
});

test("page parsing gives custom single answer precedence, supplements multi and excludes other pages", () => {
  const data = record({ questions: [single(), single("features", { type: "multi" }), single("notes", { type: "text" }), single("later")] });
  const answers = parseQuestionPageAnswers(data, 0, {
    "q:access": { choice: { selected_option: { value: "team" } } },
    "custom:access": { custom: { value: "A custom team" } },
    "q:features": { choice: { selected_options: [{ value: "team" }, { value: "all" }] } },
    "custom:features": { custom: { value: "One more" } },
    "q:notes": { custom: { value: "Notes" } },
    "q:later": { choice: { selected_option: { value: "all" } } },
  });
  assert.deepEqual(answers, { access: { values: [], custom: "A custom team" }, features: { values: ["team", "all"], custom: "One more" }, notes: { values: [], custom: "Notes" } });
  assert.deepEqual(parseQuestionPageAnswers(data, 0), { access: { values: [], custom: "" }, features: { values: [], custom: "" }, notes: { values: [], custom: "" } });
  assert.deepEqual(parseQuestionPageAnswers(data, 0, {
    "q:access": { choice: { selected_option: { value: "team" } } },
    "custom:access": { custom: { value: "   " } },
  }).access, { values: ["team"], custom: "   " });
});

test("modal input requirements permit custom alternatives and preserve strict required choice", () => {
  const view = buildQuestionModal(record({ questions: [single(), single("strict", { allowCustom: false }), single("notes", { type: "text" })] }));
  assert.equal(view.blocks.find((b) => b.block_id === "q:access").optional, true);
  assert.equal(view.blocks.find((b) => b.block_id === "q:strict").optional, false);
  assert.equal(view.blocks.find((b) => b.block_id === "q:notes").optional, false);
});

test("metadata parser rejects malformed, negative and noninteger identities", () => {
  for (const value of [null, "no json", "null", "{}", '{"id":"x","revision":-1}', '{"id":"x","revision":1.5}', '{"id":"x","revision":1,"page":-1}', '{"id":"x","revision":1,"questionId":3}']) {
    assert.equal(parseQuestionMetadata(value), null);
  }
  assert.deepEqual(parseQuestionMetadata('{"id":"x","revision":0}'), { id: "x", revision: 0 });
});

test("maximum schema sizes remain Slack-valid and caller text cannot inject mentions or mrkdwn", () => {
  const questions = Array.from({ length: 20 }, (_, i) => single(`q${i}`, {
    prompt: "<@U123> <!channel> *unsafe* ".padEnd(300, "x"), type: "multi",
    options: Array.from({ length: 10 }, (_, j) => ({ label: "<@U123>".padEnd(60, "x"), value: String(j).padEnd(60, "v") })),
  }));
  const data = record({ title: "<!channel>".padEnd(150, "x"), questions,
    answers: Object.fromEntries(questions.map((q) => [q.id, { values: q.options.map((o) => o.value), custom: "<!here>".padEnd(2000, "x") }])) });
  for (let page = 0; page < 7; page++) assertSlackBounds(buildQuestionModal(data, page), true);
  assertSlackBounds(buildQuestionCard({ ...data, status: "submitted" }));
  const card = buildQuestionCard({ ...data, questions: questions.slice(0, 4) });
  assertSlackBounds(card);
  assert.equal(card.mrkdwn, false);
  assert.ok(!card.text.includes("<!channel>"));
  assert.ok(card.blocks.some((b) => b.text?.text.includes("<!channel>")));
});
