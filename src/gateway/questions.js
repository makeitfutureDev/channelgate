// Durable question drafts. Submission and the accepted continuation share one SQLite transaction:
// an acknowledged answer can never be lost between a Slack click and queue ownership.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb, toJson, fromJson } from "../db/index.js";

const identifier = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/);
const option = z.object({ label: z.string().trim().min(1).max(60), value: z.string().trim().min(1).max(60) }).strict();
export const questionInput = {
  title: z.string().trim().min(1).max(120),
  presentation: z.enum(["auto", "message", "modal"]).default("auto"),
  questions: z.array(z.object({
    id: identifier,
    prompt: z.string().trim().min(1).max(300),
    type: z.enum(["single", "multi", "text"]),
    options: z.array(option).max(10).default([]),
    required: z.boolean().default(true),
    allowCustom: z.boolean().default(true),
  }).strict()).min(1).max(20),
};

export function normalizeQuestions(input) {
  const value = z.object(questionInput).strict().parse(input);
  if (new Set(value.questions.map((q) => q.id)).size !== value.questions.length) throw new Error("Question IDs must be unique.");
  for (const q of value.questions) {
    if (q.type !== "text" && !q.options.length) throw new Error("Choice questions need options.");
    if (q.type === "single" && q.options.length > 4) throw new Error("Single-choice questions support up to four options.");
    if (q.type === "text" && q.options.length) throw new Error("Text questions cannot have options.");
    if (new Set(q.options.map((o) => o.value)).size !== q.options.length) throw new Error("Option values must be unique within each question.");
    if (q.type === "text") q.allowCustom = true;
  }
  if (value.presentation === "message" && value.questions.length > 4) throw new Error("Message cards support up to four questions. Use auto or modal for longer forms.");
  return value;
}

export function getQuestion(id) {
  const row = getDb().prepare("SELECT data FROM question_requests WHERE id = ?").get(id);
  return row ? fromJson(row.data, null) : null;
}

export function listPendingQuestions({ channelId, threadKey = null, authorId = null } = {}) {
  return getDb().prepare("SELECT data FROM question_requests WHERE channel_id = ? AND status = 'pending' ORDER BY updated_ms")
    .all(channelId).map((r) => fromJson(r.data, null))
    .filter((r) => r && (threadKey == null || r.threadKey === threadKey) && (authorId == null || r.authorId === authorId));
}

export function createQuestion(context, input) {
  const spec = normalizeQuestions(input);
  const existing = listPendingQuestions(context);
  if (existing.length) {
    const current = existing[0];
    if (JSON.stringify({ title: current.title, presentation: current.presentation, questions: current.questions }) === JSON.stringify(spec)) return current;
    throw new Error("This user already has pending questions in this thread. Wait for their answers or have them cancel the existing card.");
  }
  const record = { ...spec, id: randomUUID(), channelId: context.channelId, threadKey: context.threadKey,
    authorId: context.authorId, slug: context.slug, isDM: Boolean(context.isDM),
    status: "pending", revision: 0, answers: {}, messageTs: "", createdAt: Date.now(), updatedAt: Date.now() };
  getDb().prepare("INSERT INTO question_requests(id,channel_id,thread_key,author_id,status,revision,updated_ms,data) VALUES(?,?,?,?,?,?,?,?)")
    .run(record.id, record.channelId, record.threadKey, record.authorId, record.status, record.revision, record.updatedAt, toJson(record));
  return record;
}

export function updateQuestion(id, revision, patch) {
  const current = getQuestion(id);
  if (!current || current.status !== "pending") throw new Error("These questions have already been submitted or cancelled.");
  if (current.revision !== revision) throw new Error("These answers changed in another view. Reopen the form from the latest card.");
  const next = { ...current, ...patch, id: current.id, revision: revision + 1, updatedAt: Date.now() };
  const result = getDb().prepare("UPDATE question_requests SET status=?,revision=?,updated_ms=?,data=? WHERE id=? AND revision=? AND status='pending'")
    .run(next.status, next.revision, next.updatedAt, toJson(next), id, revision);
  if (!result.changes) throw new Error("These questions changed. Use the latest card.");
  return next;
}

// Attaching delivery metadata does not change the answers/version embedded in the posted card.
export function bindQuestionMessage(id, messageTs) {
  const record = getQuestion(id);
  if (!record) throw new Error("These questions are no longer available.");
  const next = { ...record, messageTs };
  getDb().prepare("UPDATE question_requests SET data=? WHERE id=? AND revision=?")
    .run(toJson(next), id, record.revision);
  return getQuestion(id);
}

export function validateAnswer(question, answer = {}) {
  const values = answer.values ?? [];
  const custom = answer.custom ?? "";
  if (!Array.isArray(values) || values.some((v) => typeof v !== "string") || new Set(values).size !== values.length ||
      values.some((v) => !question.options.some((o) => o.value === v))) throw new Error("Invalid answer option.");
  if (typeof custom !== "string" || custom.length > 2000 || (custom && !question.allowCustom)) throw new Error("Invalid custom answer (maximum 2000 characters).");
  if ((question.type === "single" && values.length > 1) || (question.type === "text" && values.length)) throw new Error("Invalid answer selection.");
  // A written answer replaces a single choice; on multi-choice questions it supplements it.
  return { values: question.type === "single" && custom.trim() ? [] : values, custom: custom.trim() };
}

export function saveQuestionAnswers(id, revision, patch) {
  const current = getQuestion(id);
  if (!current) throw new Error("These questions are no longer available.");
  const answers = { ...current.answers };
  for (const [qid, answer] of Object.entries(patch)) {
    const question = current.questions.find((q) => q.id === qid);
    if (!question) throw new Error("Unknown question.");
    Object.defineProperty(answers, qid, { value: validateAnswer(question, answer), enumerable: true, configurable: true, writable: true });
  }
  return updateQuestion(id, revision, { answers });
}

export function missingQuestionAnswers(record, questions = record.questions) {
  return questions.filter((q) => q.required && !(record.answers[q.id]?.values?.length || record.answers[q.id]?.custom?.trim()));
}

export function acceptQuestionSubmission(id, revision, runId, rec) {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = getQuestion(id);
    if (!current || current.status !== "pending" || current.revision !== revision || missingQuestionAnswers(current).length) {
      db.exec("ROLLBACK");
      return false;
    }
    if (rec.authorId !== current.authorId || rec.channelId !== current.channelId || rec.threadKey !== current.threadKey || rec.slug !== current.slug) throw new Error("Question continuation identity mismatch.");
    updateQuestion(id, revision, { status: "submitted", submittedAt: Date.now(), runId });
    db.prepare("INSERT INTO active_runs(id,data) VALUES(?,?)").run(runId, toJson({ ...rec, id: runId, questionSubmissionId: id }));
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function cancelPendingQuestions(context) {
  return listPendingQuestions(context).map((r) => updateQuestion(r.id, r.revision, { status: "cancelled" }));
}

export function formatQuestionAnswers(record) {
  return `Answers submitted to the agent's questions (${record.title}):\n${record.questions.map((q, i) => {
    const answer = record.answers[q.id] || {};
    const labels = (answer.values || []).map((v) => q.options.find((o) => o.value === v)?.label || v);
    if (answer.custom) labels.push(answer.custom);
    return `${i + 1}. ${q.prompt}\nAnswer: ${labels.join("; ") || "Skipped (optional)"}`;
  }).join("\n\n")}\n\nContinue the task using these user-provided answers.`;
}
