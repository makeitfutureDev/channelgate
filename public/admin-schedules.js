// Automation health presentation. Task outcomes and connection checks are agent-reported;
// engine completion and message delivery are recorded separately by the gateway.
import { escapeHtml } from "./admin-view.js";

const RUN_LABELS = Object.freeze({
  queued: "Queued", running: "Running", succeeded: "Completed", "no-op": "Completed · no result",
  failed: "Failed", blocked: "Blocked", unreported: "Outcome not reported", interrupted: "Interrupted", skipped: "Skipped",
  "not-started": "Not started", completed: "Completed", pending: "Pending", delivered: "Delivered", suppressed: "Suppressed",
  available: "Available", unavailable: "Unavailable", unknown: "Not checked",
  ok: "Engine completed", found: "Matched", "no-match": "No match",
});
export function automationStatusLabel(value) {
  return Object.hasOwn(RUN_LABELS, value) ? RUN_LABELS[value] : String(value || "Not recorded").replaceAll("_", " ");
}
export function automationStatusTone(value) {
  return ["succeeded", "no-op", "completed", "delivered", "available"].includes(value) ? "ok"
    : ["queued", "running", "pending", "suppressed", "skipped", "not-started"].includes(value) ? "off" : "warn";
}
function detail(label, value) {
  return `<div class="schedule-detail"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value ?? "—"))}</strong></div>`;
}
function date(value) { return value ? new Date(value).toLocaleString() : "—"; }
export function automationSummaryMarkup(summary) {
  if (!summary?.total) return '<p class="hint">No recorded runs yet. New runs will appear here, including silent runs.</p>';
  const complete = Number(summary.succeeded || 0) + Number(summary.noOp || 0);
  const terminal = complete + Number(summary.failed || 0) + Number(summary.blocked || 0) + Number(summary.unreported || 0) + Number(summary.interrupted || 0);
  return `<div class="schedule-details">${[
    detail("Recorded runs", summary.total), detail("Successful task outcomes", `${complete}${terminal ? ` · ${Math.round(complete / terminal * 100)}% of finished runs` : ""}`),
    detail("No result", summary.noOp || 0), detail("Failed / blocked", `${summary.failed || 0} / ${summary.blocked || 0}`),
    detail("Unreported / interrupted", `${summary.unreported || 0} / ${summary.interrupted || 0}`), detail("Engine completed", summary.engineCompleted || 0),
    detail("Delivery failures", summary.deliveryFailed || 0), detail("Skipped", summary.skipped || 0),
    detail("Last run requested", date(summary.lastStartedAt)), detail("Recorded cost", summary.totalCostUsd == null ? "—" : `$${Number(summary.totalCostUsd).toFixed(4)}`),
  ].join("")}</div><p class="hint">Task outcomes and connection checks are reported by the agent. Engine completion and delivery are tracked separately.</p>`;
}
export function automationRunMarkup(run) {
  const duration = Number.isFinite(run.durationMs) ? `${(run.durationMs / 1000).toFixed(1)}s` : "—";
  const checks = (run.connections || []).map((connection) => `<li><strong>${escapeHtml(connection.name)}</strong> · ${escapeHtml(automationStatusLabel(connection.status))}</li>`).join("");
  const events = (run.events || []).map((event) => `<li><time>${escapeHtml(date(event.at))}</time> <strong>${escapeHtml(String(event.kind || "event").replaceAll("_", " "))}</strong>${event.name || event.text ? ` · ${escapeHtml(event.name || event.text)}` : ""}</li>`).join("");
  return `<div class="schedule-details">${[
    detail("Automation", run.description || run.scheduleId), detail("Conversation", run.channelName || run.channelId),
    detail("Run status", automationStatusLabel(run.status)), detail("Scheduled", date(run.scheduledAt)),
    detail("Run requested", date(run.startedAt)), detail("Finished", date(run.completedAt)),
    detail("Last activity", date(run.lastActivityAt)), detail("Scheduling delay", Number.isFinite(run.schedulingDelayMs) ? `${(run.schedulingDelayMs / 1000).toFixed(1)}s` : "—"),
    detail("Engine", `${run.engine || "—"} · ${run.model || "default model"}`), detail("Engine status", automationStatusLabel(run.engineStatus)),
    detail("Task outcome (agent-reported)", automationStatusLabel(run.taskStatus)), detail("Delivery", automationStatusLabel(run.deliveryStatus)),
    detail("Duration", duration), detail("Tool calls", run.toolUseCount ?? "—"),
    detail("Tokens in / out", `${run.tokensIn ?? "—"} / ${run.tokensOut ?? "—"}`), detail("Cost", run.costUsd == null ? "—" : `$${Number(run.costUsd).toFixed(4)}`),
  ].join("")}</div>${run.summary ? `<p class="schedule-run-summary">${escapeHtml(run.summary)}</p>` : ""}
  ${run.error ? `<p class="schedule-modal-error">${escapeHtml(run.errorKind || "Error")}: ${escapeHtml(run.error)}</p>` : ""}
  <h4>Connection checks</h4>${checks ? `<ul class="schedule-run-events">${checks}</ul>` : '<p class="hint">No connection checks reported.</p>'}
  <h4>Run log</h4>${run.eventsDropped ? `<p class="hint">${Number(run.eventsDropped)} earlier events omitted from this bounded log.</p>` : ""}${events ? `<ol class="schedule-run-events">${events}</ol>` : '<p class="hint">No log events recorded.</p>'}`;
}
