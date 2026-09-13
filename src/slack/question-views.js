// Pure Block Kit views. The gateway owns validation, authorization and durable answers.
export const QUESTION_ACTION_PREFIX = "cg_question_";
export const QUESTION_FORM_CALLBACK = "cg_question_form";
export const QUESTION_CUSTOM_CALLBACK = "cg_question_custom_form";
export const QUESTIONS_PER_PAGE = 3;

const plain = (text) => ({ type: "plain_text", text: String(text), emoji: false });
const section = (text) => ({ type: "section", text: plain(text) });
const context = (text) => ({ type: "context", elements: [plain(text)] });
const answerFor = (record, id) => record.answers?.[id] || { values: [], custom: "" };
const option = ({ label, value }) => ({ text: plain(label), value });
const metadata = (record, extra = {}) => JSON.stringify({ id: record.id, revision: record.revision, ...extra });
const button = (record, label, action, extra = {}, selected = false) => ({
  type: "button", text: plain(label), action_id: `${QUESTION_ACTION_PREFIX}${action}`,
  value: metadata(record, extra), ...(selected ? { style: "primary" } : {}),
});

export function parseQuestionMetadata(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed.id !== "string" || !parsed.id || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0) return null;
    if (parsed.page !== undefined && (!Number.isSafeInteger(parsed.page) || parsed.page < 0)) return null;
    if (parsed.questionId !== undefined && typeof parsed.questionId !== "string") return null;
    return parsed;
  } catch { return null; }
}

export function questionPage(record, page = 0) {
  const totalPages = Math.ceil(record.questions.length / QUESTIONS_PER_PAGE);
  if (!Number.isInteger(page) || page < 0 || page >= totalPages) throw new Error("Invalid question page");
  return { page, totalPages, questions: record.questions.slice(page * QUESTIONS_PER_PAGE, (page + 1) * QUESTIONS_PER_PAGE) };
}

export function questionPresentation(record) {
  if (record.presentation === "modal" || record.questions.length > 4) return "modal";
  if (record.presentation === "message") return "message";
  return record.questions.some((q) => q.type === "text") ? "modal" : "message";
}

function answerText(question, answer) {
  const labels = (question.options || []).filter((o) => answer.values?.includes(o.value)).map((o) => o.label);
  if (answer.custom) {
    if (question.type === "multi") labels.push(answer.custom);
    else return answer.custom;
  }
  return labels.join(", ") || "Not answered";
}

/** Returns message payload fields usable by chat.postMessage and chat.update. */
export function buildQuestionCard(record) {
  const pending = record.status === "pending";
  const blocks = [{ type: "header", text: plain(record.title) }];
  if (!pending) {
    blocks.push(context(record.status === "submitted" ? "Answers submitted" : record.answeredInThread ? "Continued with your reply in the thread" : "Questions cancelled"));
    // One section per question stays below Slack's 50-block message limit at the schema maximum.
    for (const q of record.questions) blocks.push(section(`${q.prompt}\n${answerText(q, answerFor(record, q.id))}`));
  } else if (questionPresentation(record) === "modal") {
    blocks.push(section(`${record.questions.length} questions to continue. Your draft is saved as you move between pages.`));
    blocks.push({ type: "actions", elements: [button(record, "Answer questions", "open", {}, true), button(record, "Cancel", "cancel")] });
  } else {
    blocks.push(context("Choose an answer for each question, then submit. Only the requester can answer."));
    for (const q of record.questions) {
      const answer = answerFor(record, q.id);
      blocks.push(section(`${q.prompt}${q.required ? "" : " (optional)"}`));
      const elements = [];
      if (q.type === "single") {
        for (const [index, o] of q.options.entries()) {
          elements.push(button(record, o.label, `choose:${q.id}:${index}`, {}, !answer.custom && answer.values?.includes(o.value)));
        }
      } else if (q.type === "multi") {
        const options = q.options.map(option);
        const initial = options.filter((o) => answer.values?.includes(o.value));
        elements.push({ type: "checkboxes", action_id: `${QUESTION_ACTION_PREFIX}multi:${q.id}`, options, ...(initial.length ? { initial_options: initial } : {}) });
      }
      if (q.allowCustom || q.type === "text") elements.push(button(record, q.type === "text" ? "Write answer" : "Custom answer…", `custom:${q.id}`));
      if (elements.length) blocks.push({ type: "actions", block_id: `cg_question:${record.id}:${record.revision}:${q.id}`, elements });
      if (answer.values?.length || answer.custom) blocks.push(section(`Current answer: ${answerText(q, answer)}`));
    }
    blocks.push({ type: "actions", elements: [button(record, "Submit answers", "submit", {}, true), button(record, "Open form", "open"), button(record, "Cancel", "cancel")] });
  }
  // Keep notification fallback caller-independent: plain_text blocks alone do not protect text.
  return { text: pending ? "Questions need your answers" : record.status === "submitted" ? "Answers submitted" : "Questions cancelled", blocks, mrkdwn: false, unfurl_links: false, unfurl_media: false };
}

function textInput(question, answer, custom = false) {
  return {
    type: "input", block_id: `${custom ? "custom" : "q"}:${question.id}`,
    label: plain(custom ? "Custom answer" : question.prompt),
    optional: custom || !question.required,
    element: { type: "plain_text_input", action_id: "custom", multiline: true, max_length: 2000, ...(answer.custom ? { initial_value: answer.custom } : {}) },
    ...(custom ? { hint: plain(question.type === "multi" ? "Adds to the options selected above." : "Overrides the option selected above. Leave empty to use that option.") } : {}),
  };
}

export function buildQuestionModal(record, page = 0) {
  const slice = questionPage(record, page);
  const blocks = [section(record.title), context(`Page ${page + 1} of ${slice.totalPages}`)];
  for (const q of slice.questions) {
    const answer = answerFor(record, q.id);
    if (q.type === "text") blocks.push(textInput(q, answer));
    else {
      const options = q.options.map(option);
      const initial = options.filter((o) => answer.values?.includes(o.value));
      const element = { type: q.type === "multi" ? "checkboxes" : "radio_buttons", action_id: "choice", options };
      if (initial.length) {
        if (q.type === "multi") element.initial_options = initial;
        else element.initial_option = initial[0];
      }
      blocks.push({ type: "input", block_id: `q:${q.id}`, label: plain(q.prompt), optional: !q.required || q.allowCustom, element });
      if (q.allowCustom) blocks.push(textInput(q, answer, true));
    }
    blocks.push({ type: "divider" });
  }
  if (page > 0) blocks.push({ type: "actions", elements: [button(record, "Back", "back", { page })] });
  return {
    type: "modal", callback_id: QUESTION_FORM_CALLBACK, private_metadata: metadata(record, { page }),
    title: plain("Answer questions"), close: plain("Close"), submit: plain(page + 1 < slice.totalPages ? "Next" : "Submit"),
    blocks,
  };
}

export function buildCustomAnswerModal(record, questionId) {
  const q = record.questions.find((entry) => entry.id === questionId);
  if (!q || (!q.allowCustom && q.type !== "text")) throw new Error("Custom answers are not allowed for this question");
  const input = textInput(q, answerFor(record, q.id));
  // Empty custom input removes the draft custom answer; final submission validates requirements.
  input.optional = true;
  return {
    type: "modal", callback_id: QUESTION_CUSTOM_CALLBACK,
    private_metadata: metadata(record, { questionId }), title: plain("Custom answer"),
    close: plain("Close"), submit: plain("Save answer"),
    blocks: [input, context(q.type === "multi" ? "Adds to your selected options." : "Replaces your selected option. To switch back, choose an option on the card.")],
  };
}

/** Only extracts fields on the displayed page. The store validates and merges the patch. */
export function parseQuestionPageAnswers(record, page, stateValues = {}) {
  const answers = {};
  for (const q of questionPage(record, page).questions) {
    const fields = stateValues[`q:${q.id}`] || {};
    const choice = fields.choice;
    const values = q.type === "multi" ? (choice?.selected_options || []).map((o) => o.value)
      : q.type === "single" && choice?.selected_option ? [choice.selected_option.value] : [];
    const custom = q.type === "text" ? fields.custom?.value || ""
      : q.allowCustom ? stateValues[`custom:${q.id}`]?.custom?.value || "" : "";
    answers[q.id] = { values: q.type === "single" && custom.trim() ? [] : values, custom };
  }
  return answers;
}
