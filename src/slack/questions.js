import { resolveSlackConfig } from "../config/settings.js";
import { assertQuestionAccess } from "../gateway/question-access.js";
import { createQuestion, getQuestion, bindQuestionMessage, updateQuestion, saveQuestionAnswers, validateAnswer, missingQuestionAnswers, acceptQuestionSubmission, formatQuestionAnswers } from "../gateway/questions.js";
import { acquireKeyedLock } from "../util/keyed-lock.js";
import { buildQuestionCard, buildQuestionModal, buildCustomAnswerModal, parseQuestionMetadata, parseQuestionPageAnswers, questionPage, QUESTION_FORM_CALLBACK, QUESTION_CUSTOM_CALLBACK } from "./question-views.js";

// The MCP connection lives in the daemon; no bot credential crosses into the engine container.
export function questionSlackClient({ token = resolveSlackConfig().botToken, fetchImpl = fetch } = {}) {
  const call = async (method, body) => {
    if (!token) throw new Error("Slack bot token is not configured.");
    const response = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(`Slack ${method} failed: ${data.error || response.status}`);
    return data;
  };
  return { chat: { postMessage: (b) => call("chat.postMessage", b), update: (b) => call("chat.update", b) }, conversations: { members: (b) => call("conversations.members", b) } };
}

export async function refreshQuestionCard(record, client) {
  if (!record?.id) return;
  const release = await acquireKeyedLock("question-card", record.id);
  try {
    // Async view updates can finish out of order. Never render a captured draft over newer data.
    const latest = getQuestion(record.id);
    if (latest?.messageTs) await client.chat.update({ channel: latest.channelId, ts: latest.messageTs, ...buildQuestionCard(latest) });
  } finally { release(); }
}

export async function postQuestions(context, input, { client = questionSlackClient() } = {}) {
  const meta = await assertQuestionAccess(context, client);
  const release = await acquireKeyedLock("question-post", `${context.channelId}:${context.threadKey}:${context.authorId}`);
  try {
    let record = createQuestion({ ...context, isDM: meta.isDM }, input);
    if (record.messageTs) {
      await refreshQuestionCard(record, client);
      return record;
    }
    const result = await client.chat.postMessage({ channel: record.channelId, thread_ts: record.threadKey, client_msg_id: record.id, ...buildQuestionCard(record) });
    if (!result.ts) throw new Error("Slack did not return the question card's message timestamp. Retry with the same questions.");
    // Stop/clear may have cancelled the request while Slack was posting it. Retire that late card.
    record = bindQuestionMessage(record.id, result.ts);
    if (record.status !== "pending") {
      await refreshQuestionCard({ ...record, messageTs: result.ts }, client);
      throw new Error("These questions were cancelled while being posted.");
    }
    return record;
  } finally { release(); }
}

function actionMetadata(action) {
  if (action?.action_id?.startsWith("cg_question_multi:")) {
    const parts = String(action.block_id || "").split(":");
    if (parts.length !== 4 || parts[0] !== "cg_question") return null;
    return parseQuestionMetadata(JSON.stringify({ id: parts[1], revision: Number(parts[2]) }));
  }
  return parseQuestionMetadata(action?.value);
}

function ownQuestion(metadata, body, { modal = false, allowStale = false } = {}) {
  if (!metadata) throw new Error("Invalid question action.");
  const record = getQuestion(metadata.id);
  if (!record || record.authorId !== body?.user?.id) throw new Error("Only the person who requested these questions can answer them.");
  if (!modal) {
    const channel = body?.channel?.id || body?.container?.channel_id;
    const ts = body?.message?.ts || body?.container?.message_ts;
    if (channel !== record.channelId || ts !== record.messageTs) throw new Error("This action does not belong to this question card.");
  }
  if (record.status !== "pending") throw new Error("These questions have already been submitted or cancelled.");
  if (!allowStale && record.revision !== metadata.revision) throw new Error("These answers changed. Use the latest card or reopen the form.");
  return record;
}

async function notice(client, record, userId, message) {
  if (!record?.channelId || !userId) return;
  await client.chat.postEphemeral({ channel: record.channelId, thread_ts: record.threadKey, user: userId, text: message }).catch(() => {});
}

const submitting = new Set();
// Queue a synthetic human answer through the normal authorization, licensing and session path.
// Nothing executes on selection. The atomic callback alone makes submission terminal. Keep the
// promise observed, but never make Slack wait for an engine turn to finish before acknowledging.
export function startQuestionContinuation(record, client, processMessage, { onError = () => {} } = {}) {
  if (submitting.has(record.id)) return false;
  submitting.add(record.id);
  const event = {
    type: "message", channel: record.channelId, user: record.authorId,
    channel_type: record.isDM ? "im" : "channel", thread_ts: record.threadKey,
    ts: `question-${record.id}`, text: formatQuestionAnswers(record),
  };
  let accepted = false;
  const promise = Promise.resolve().then(() => processMessage(event, client, {
    bypassMention: true, busyChoice: "queue", questionSubmissionId: record.id,
    onQuestionSubmissionAccepted: ({ runId, rec }) => {
      accepted = acceptQuestionSubmission(record.id, record.revision, runId, rec);
      if (accepted) void refreshQuestionCard(getQuestion(record.id), client).catch(() => {});
      return accepted;
    },
  })).then(() => {
    if (!accepted && getQuestion(record.id)?.status === "pending") throw new Error("Your answers are saved, but the continuation could not be queued. Reopen the card and submit again.");
  }).catch(async (error) => {
    onError(error);
    await notice(client, record, record.authorId, error.message);
  }).finally(() => submitting.delete(record.id));
  return promise;
}

export async function handleQuestionAction({ ack, body, action, client }, { processMessage }) {
  await ack();
  let record;
  try {
    const metadata = actionMetadata(action);
    const inModal = Boolean(body.view);
    record = ownQuestion(metadata, body, { modal: inModal, allowStale: true });
    // Leave time within Slack's three-second interaction window to acknowledge errors/open views.
    await assertQuestionAccess(record, client, { timeoutMs: 1500 });
    const actionId = action.action_id;
    // Opening is read-only and also repairs a card whose last Slack update failed. Stale writes
    // are never applied; their catch path refreshes the visible controls from the durable draft.
    if (record.revision !== metadata.revision && actionId !== "cg_question_open" && !actionId.startsWith("cg_question_custom:")) throw new Error("These answers changed. The card has been refreshed; please try again.");
    if (actionId === "cg_question_open") {
      await client.views.open({ trigger_id: body.trigger_id, view: buildQuestionModal(record) });
      return;
    }
    if (actionId === "cg_question_back") {
      const page = metadata.page;
      if (!inModal || !(page > 0) || body.view.callback_id !== QUESTION_FORM_CALLBACK) throw new Error("Invalid question page.");
      record = saveQuestionAnswers(record.id, record.revision, parseQuestionPageAnswers(record, page, body.view.state?.values));
      await client.views.update({ view_id: body.view.id, hash: body.view.hash, view: buildQuestionModal(record, page - 1) });
    } else if (actionId.startsWith("cg_question_custom:")) {
      const qid = actionId.slice("cg_question_custom:".length);
      await client.views.open({ trigger_id: body.trigger_id, view: buildCustomAnswerModal(record, qid) });
      return;
    } else if (actionId.startsWith("cg_question_choose:")) {
      const [, qid, index] = actionId.split(":");
      const q = record.questions.find((q) => q.id === qid);
      const selected = /^\d+$/.test(index) ? q?.options[Number(index)] : null;
      if (!selected || q.type !== "single") throw new Error("Invalid answer option.");
      record = saveQuestionAnswers(record.id, record.revision, { [qid]: { values: [selected.value], custom: "" } });
    } else if (actionId.startsWith("cg_question_multi:")) {
      const qid = actionId.slice("cg_question_multi:".length);
      if (record.questions.find((q) => q.id === qid)?.type !== "multi") throw new Error("Invalid multiple-choice question.");
      record = saveQuestionAnswers(record.id, record.revision, { [qid]: { values: (action.selected_options || []).map((o) => o.value), custom: record.answers[qid]?.custom || "" } });
    } else if (actionId === "cg_question_cancel") {
      record = updateQuestion(record.id, record.revision, { status: "cancelled" });
    } else if (actionId === "cg_question_submit") {
      if (missingQuestionAnswers(record).length) throw new Error("Please answer every required question before submitting.");
      startQuestionContinuation(record, client, processMessage);
      return;
    } else throw new Error("Unknown question action.");
    await refreshQuestionCard(record, client);
  } catch (error) {
    if (record) await refreshQuestionCard(record, client).catch(() => {});
    const target = record || { channelId: body?.channel?.id, threadKey: body?.message?.thread_ts };
    await notice(client, target, body?.user?.id, error.message);
  }
}

export async function handleQuestionView({ ack, body, view = body?.view, client }, { processMessage }) {
  let acknowledged = false;
  const respond = async (value) => { acknowledged = true; await ack(value); };
  let record;
  try {
    const metadata = parseQuestionMetadata(view?.private_metadata);
    record = ownQuestion(metadata, body, { modal: true });
    await assertQuestionAccess(record, client, { timeoutMs: 1500 });
    if (view.callback_id === QUESTION_CUSTOM_CALLBACK) {
      const qid = metadata.questionId;
      const q = record.questions.find((q) => q.id === qid);
      if (!q || !q.allowCustom) throw new Error("Custom answers are not allowed.");
      const custom = view.state?.values?.[`q:${qid}`]?.custom?.value || "";
      record = saveQuestionAnswers(record.id, record.revision, { [qid]: { values: record.answers[qid]?.values || [], custom } });
      await respond();
    } else if (view.callback_id === QUESTION_FORM_CALLBACK) {
      const page = metadata.page;
      const slice = questionPage(record, page);
      const patch = parseQuestionPageAnswers(record, page, view.state?.values);
      const answers = { ...record.answers };
      for (const q of slice.questions) answers[q.id] = validateAnswer(q, patch[q.id]);
      const missing = missingQuestionAnswers({ ...record, answers }, slice.questions);
      if (missing.length) {
        await respond({ response_action: "errors", errors: Object.fromEntries(missing.map((q) => [`q:${q.id}`, "Choose an option or write an answer."])) });
        return;
      }
      record = saveQuestionAnswers(record.id, record.revision, patch);
      if (page + 1 < slice.totalPages) await respond({ response_action: "update", view: buildQuestionModal(record, page + 1) });
      else if (missingQuestionAnswers(record).length) {
        // Back permits incomplete drafts. Return to the first missing page instead of dropping it.
        const first = record.questions.findIndex((q) => missingQuestionAnswers(record).some((m) => m.id === q.id));
        await respond({ response_action: "update", view: buildQuestionModal(record, Math.floor(first / 3)) });
      } else {
        await respond();
        startQuestionContinuation(record, client, processMessage);
      }
    } else throw new Error("Unknown question form.");
    await refreshQuestionCard(getQuestion(record.id), client);
  } catch (error) {
    if (!acknowledged) {
      const block = view?.blocks?.find((b) => b.type === "input")?.block_id;
      await respond(block ? { response_action: "errors", errors: { [block]: error.message } } : {});
    } else await notice(client, record, body?.user?.id, error.message);
  }
}

export function registerQuestionActions(app, processMessage, context = {}) {
  // The live connection owns bot/workspace identity; the synthetic answer must retain it for
  // mention hydration and Slack's recipient_team_id on streamed channel replies.
  const continuation = (event, client, options) => processMessage(event, client, { ...context, ...options });
  app.action(/^cg_question_/, (payload) => handleQuestionAction(payload, { processMessage: continuation }));
  app.view(QUESTION_FORM_CALLBACK, (payload) => handleQuestionView(payload, { processMessage: continuation }));
  app.view(QUESTION_CUSTOM_CALLBACK, (payload) => handleQuestionView(payload, { processMessage: continuation }));
}
