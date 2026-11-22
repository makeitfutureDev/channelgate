// A background job's status as surfaces other than Slack render it: the Adaptive Card the job's
// "started" notice carries, the card a "Check status" click answers with, and the `/jobs` list.
// Slack keeps its own Block Kit button (src/slack/app.js → cg_bgjob_status) over the same facts.
//
// Authorization is the CALLER's: it must have admitted the clicker to the conversation whose
// `slug` it passes. A job is reported only when it belongs to that conversation, so a job id lifted
// from another conversation reads nothing.
import { readFileSync } from "node:fs";
import path from "node:path";
import { gatewayRoot } from "../config/paths.js";
import { getChannelEntry, getChannelMeta, isAdmin, isApproved } from "../config/store.js";
import { isAuthorized } from "./modes.js";
import { getActiveBackgroundJobs } from "./background.js";
import { chatAction, chatButtons, chatCard, chatText } from "../platforms/googlechat/cards.js";

export const BACKGROUND_STATUS_ACTION = "bgjob.status";
export const BACKGROUND_ACCESS_DENIED = "You're not authorized to see this conversation's background work.";
const JOB_ID = /^[a-f0-9-]{4,40}$/i;
const TAIL_CHARS = 600;

export function formatSpan(ms) {
  return ms < 60_000 ? "under a minute" : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m`
    : ms < 86_400_000 ? `${(ms / 3_600_000).toFixed(1)}h` : `${(ms / 86_400_000).toFixed(1)}d`;
}

const kindLabel = kind => kind === "agent" ? "Background agent" : "Background job";
const lastLines = (text, count = 6) => String(text || "").trim().split("\n").filter(Boolean).slice(-count).join("\n").slice(-TAIL_CHARS);

// { state: "running" | "finishing" | "finished" | "unknown", ... } for one job of one conversation.
export function backgroundJobStatus({ jobId, slug, jobs = getActiveBackgroundJobs(), root = gatewayRoot } = {}) {
  const id = String(jobId || "");
  if (!JOB_ID.test(id) || !slug) return { state: "unknown", id };
  const live = jobs?.status?.(id);
  if (live && live.slug === slug) {
    return { state: live.finished ? "finishing" : "running", id, kind: live.kind, what: kindLabel(live.kind), label: live.label,
      runtimeMs: live.runtimeMs, maxMs: live.maxMs, recent: lastLines(live.tail) };
  }
  if (live) return { state: "unknown", id };
  // The live record is gone the moment a job finishes, but its log survives: keep the button
  // useful after completion instead of a bare "not running".
  let recent = "";
  try { recent = readFileSync(path.join(root(), "logs", "bg", `${slug}__${id}.log`), "utf8").trim().slice(-TAIL_CHARS); }
  catch { /* no log for this conversation */ }
  return recent ? { state: "finished", id, recent } : { state: "unknown", id };
}

// Who may see a conversation's background work: the same gate as Slack's button and /status — an
// admin, an approved user, or an explicit guest of THIS conversation. `conversationId` must come
// from the surface's verified envelope, never from card data. Returns the conversation's entry.
export async function backgroundAccessEntry(conversationId, userId) {
  const entry = await getChannelEntry(conversationId);
  const meta = entry ? await getChannelMeta(entry.slug) : null;
  if (!meta) return null;
  const [adminUser, approvedUser] = await Promise.all([isAdmin(userId), isApproved(userId)]);
  return isAuthorized(meta, userId, Boolean(meta.isDM), { isAdminUser: adminUser, isApprovedUser: approvedUser }) ? entry : null;
}

// One status as plain lines (Markdown-light: bold only), shared by the card and the text fallback.
export function backgroundStatusLines(status) {
  if (status.state === "running") {
    return [`⏳ **${status.what}** ${status.label} is still running — ${formatSpan(status.runtimeMs)} elapsed (cap ${formatSpan(status.maxMs)}).`,
      status.recent ? `Recent activity:\n${status.recent}` : "No output yet."];
  }
  if (status.state === "finishing") {
    return [`🏁 **${status.what}** ${status.label} finished after ${formatSpan(status.runtimeMs)} — its result is being posted here now.`,
      ...(status.recent ? [`Last activity:\n${status.recent}`] : [])];
  }
  if (status.state === "finished") return ["🏁 This job already finished — its result was posted in this conversation.", `Last activity:\n${status.recent}`];
  return ["This job is no longer running here — it finished or was interrupted, and its result is posted in its conversation."];
}

// The running jobs of one conversation, newest first, for `/jobs`.
export function listBackgroundJobs(slug, { jobs = getActiveBackgroundJobs() } = {}) {
  if (!slug) return [];
  return (jobs?.listForChannel?.(slug) || []).map(job => ({ ...job, what: kindLabel(job.kind) }))
    .sort((a, b) => a.runtimeMs - b.runtimeMs);
}

const block = (text, extra = {}) => ({ type: "TextBlock", text, wrap: true, ...extra });
const statusButton = (id, title = "Check status") => ({ type: "Action.Execute", title, verb: BACKGROUND_STATUS_ACTION,
  data: { cgAction: BACKGROUND_STATUS_ACTION, id }, fallback: { type: "Action.Submit", title, data: { cgAction: BACKGROUND_STATUS_ACTION, id } } });
const adaptive = (body, actions = []) => ({ type: "AdaptiveCard", version: "1.4", body, ...(actions.length ? { actions } : {}) });

// The "started" notice. Its button carries only the job id; the click re-authorizes everything.
export function backgroundStartedCard({ id, kind, label }) {
  return adaptive([block(`${kind === "agent" ? "🤖" : "⚙️"} **${kindLabel(kind)}** ${label} is running — the result will be posted here when it finishes.`)],
    [statusButton(id)]);
}

export function backgroundStatusCard(status) {
  const [headline, ...rest] = backgroundStatusLines(status);
  return adaptive([block(headline), ...rest.map(text => block(text, { fontType: "Monospace", isSubtle: true }))],
    status.state === "running" || status.state === "finishing" ? [statusButton(status.id, "Refresh")] : []);
}

export function backgroundJobsCard(list) {
  if (!list.length) return adaptive([block("No background jobs are running in this conversation.")]);
  return adaptive([block(`**Background work in this conversation** (${list.length})`, { size: "Medium" }),
    ...list.slice(0, 10).map(job => block(`${job.what} **${job.label}** — ${formatSpan(job.runtimeMs)} elapsed (id ${job.id})`))],
  list.slice(0, 5).map(job => statusButton(job.id, `Status: ${String(job.label).slice(0, 40)}`)));
}

export function backgroundJobsText(list) {
  if (!list.length) return "No background jobs are running in this conversation.";
  return [`Background work in this conversation (${list.length}):`,
    ...list.slice(0, 10).map(job => `- ${job.what} **${job.label}** — ${formatSpan(job.runtimeMs)} elapsed (id ${job.id})`)].join("\n");
}

// The same three views as Google Chat Cards v2. Card text is escaped by chatText before Chat reads
// it as HTML; only the `**bold**` the status lines themselves write becomes <b>.
const chatLine = text => {
  const widget = chatText(text);
  widget.textParagraph.text = widget.textParagraph.text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  return widget;
};
const chatStatusButton = (id, label = "Check status") => chatAction(label, BACKGROUND_STATUS_ACTION, "", { id });

// The started notice's text already says what is running; the card under it adds the button.
export function backgroundStartedChatCard({ id, kind, label }) {
  return chatCard(`${kind === "agent" ? "🤖" : "⚙️"} ${kindLabel(kind)}: ${label}`, [chatButtons([chatStatusButton(id)])]);
}

export function backgroundStatusChatCard(status) {
  const [headline, ...rest] = backgroundStatusLines(status);
  const live = status.state === "running" || status.state === "finishing";
  return chatCard("Background work status", [chatLine(headline), ...rest.map(chatText),
    ...(live ? [chatButtons([chatStatusButton(status.id, "Refresh")])] : [])]);
}

export function backgroundJobsChatCard(list) {
  if (!list.length) return chatCard("Background work", [chatText("No background jobs are running in this conversation.")]);
  return chatCard(`Background work in this conversation (${list.length})`, [
    ...list.slice(0, 10).map(job => chatLine(`${job.what} **${job.label}** — ${formatSpan(job.runtimeMs)} elapsed (id ${job.id})`)),
    chatButtons(list.slice(0, 5).map(job => chatStatusButton(job.id, `Status: ${String(job.label).slice(0, 40)}`))),
  ]);
}
