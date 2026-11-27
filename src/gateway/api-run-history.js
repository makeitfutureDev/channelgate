// The HTTP run API's half of the run ledger (schedule-runs.js). An API run is recorded exactly
// like a scheduled run — same row, same recorder, same health verdict — under a SOURCE id instead
// of a schedule id: the credential that started it (a channel API token, or the organization
// key), optionally split by the caller's own `name`. Kept apart from api-runs.js (which drags in
// the whole run orchestrator) so the dashboard and the MCP tools can read it cheaply. `api_jobs`
// stays what it was: the HTTP API's 7-day response store, not history.
import { getDb, fromJson } from "../db/index.js";
import { listApiTokens } from "./api-tokens.js";
import { createAutomationRun, getScheduleRun, updateScheduleRun, appendScheduleRunEvent, apiRunGroups, bumpScheduleRunCounter } from "./schedule-runs.js";
import { redactLogValue } from "../util/redact.js";

export const API_SOURCE_PREFIX = "api:";
export const ORG_KEY_SOURCE = "api:org-key";
// Concurrently running API jobs the gateway admits before answering 429 (gateway-wide).
export const API_MAX_INFLIGHT = 25;
export const API_RUN_NAME_MAX = 80;
const NAME_SEPARATOR = "~";
const REJECTION_WINDOW_MS = 10 * 60 * 1000;
const LIVE = new Set(["running", "queued"]);

// The caller's optional `name` for a run ("nightly-import"): what the Automations page groups by.
export function normalizeApiRunName(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw Object.assign(new Error("name must be a string."), { statusCode: 400 });
  const name = value.replace(/\s+/g, " ").trim();
  if (name.length > API_RUN_NAME_MAX) throw Object.assign(new Error(`name is limited to ${API_RUN_NAME_MAX} characters.`), { statusCode: 400 });
  return name;
}
const nameSlug = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

// `api:<token id>` or `api:org-key`, plus `~<name slug>` when the caller named the run. The
// credential always leads, so who may see a source is readable from its id alone.
export function apiSourceId(job) {
  const base = job.principalKind === "user" && job.apiTokenId ? `${API_SOURCE_PREFIX}${job.apiTokenId}` : ORG_KEY_SOURCE;
  const slug = nameSlug(job.name);
  return slug ? `${base}${NAME_SEPARATOR}${slug}` : base;
}
export function apiSourceParts(id) {
  const [base, slug = ""] = String(id || "").split(NAME_SEPARATOR);
  const org = base === ORG_KEY_SOURCE;
  return { org, tokenId: org ? "" : base.slice(API_SOURCE_PREFIX.length), nameSlug: slug };
}
export const isApiSource = (id) => String(id || "").startsWith(API_SOURCE_PREFIX);

// The ledger status of one job, the automations' vocabulary. A clean run nobody asked to report
// is "completed" (finished, not judged); the HTTP API itself keeps answering "unreported" for it.
export function apiRunStatus(job) {
  if (LIVE.has(job.status)) return job.status;
  if (job.status === "stopped") return "skipped";
  if (job.status === "interrupted") return "interrupted";
  if (job.status === "failed") return "failed";
  if ((job.taskStatus || "unreported") === "unreported" && job.outcome?.source === "none") return "completed";
  return job.taskStatus || "unreported";
}

// Where the result went, in the ledger's delivery states. The webhook is the caller's delivery:
// a refused or unreachable endpoint is a FAILED delivery, not silence. Slack follows the run's
// visibility: a hidden run posts nothing by rule, an on-failure run only its alert.
export function apiDeliveryStatus(job) {
  if (LIVE.has(job.status)) return "pending";
  if (job.webhook && job.webhookPending) return job.webhookAttempts ? "failed" : "pending";
  if (job.slackThread) return job.deliveryPending || job.interruptionNoticePending ? "pending" : job.status === "stopped" ? "suppressed" : "delivered";
  if (job.webhook) return "delivered";
  if (job.visibility === "on-failure") return job.failureAlertedMs ? "delivered" : "suppressed";
  return "suppressed";
}

// Who sees which source: an admin sees every source (the organization key included); anyone else
// only the runs of tokens they created — the API tokens page's own rule (api-tokens.js).
const tokenMap = (channelId) => new Map(listApiTokens({ channelId }).map((t) => [String(t.id), t]));
function sourceVisible(id, tokens, { isAdmin, userId }) {
  if (isAdmin) return true;
  const { org, tokenId } = apiSourceParts(id);
  if (org) return false;
  const token = tokens.get(tokenId);
  return Boolean(token && userId && token.createdBy === userId);
}
export function apiSourceVisible(channelId, sourceId, { isAdmin = false, userId = "" } = {}) {
  return isApiSource(sourceId) && sourceVisible(sourceId, isAdmin ? new Map() : tokenMap(channelId), { isAdmin, userId });
}

// The API sources of one conversation the viewer may see, from the ledger (90 days of runs).
export function apiSourcesForChannel(channelId, { isAdmin = false, userId = "" } = {}) {
  const groups = apiRunGroups(channelId);
  if (!groups.length) return [];
  const tokens = tokenMap(channelId);
  return groups.filter((g) => sourceVisible(g.id, tokens, { isAdmin, userId })).map((g) => {
    const { org, tokenId } = apiSourceParts(g.id);
    const token = org ? null : tokens.get(tokenId) || null;
    const named = getDb().prepare("SELECT json_extract(data, '$.description') AS name FROM schedule_runs WHERE schedule_id = ? AND channel_id = ? ORDER BY rowid DESC LIMIT 1").get(g.id, channelId)?.name || "";
    const credential = org ? "organization API key" : `token “${token?.name || "deleted token"}”`;
    return { id: g.id, kind: "API", name: apiSourceParts(g.id).nameSlug ? named : "", credential,
      title: apiSourceParts(g.id).nameSlug && named ? named : `API runs · ${credential}`,
      revoked: Boolean(token?.revokedAt), createdBy: token?.createdBy || "", total: g.total,
      lastStartedAt: g.lastStartedMs ? new Date(g.lastStartedMs).toISOString() : null };
  });
}

// ── Writing ───────────────────────────────────────────────────────────────────────────────────
const excerpt = (job) => redactLogValue(String(job.message || (job.hasAttachment ? "(file only)" : "")).replace(/\s+/g, " ").trim()).slice(0, 300);

// Open the ledger row of a new API job. The row reuses the job id, so `GET /api/runs/:id` and the
// Automations page name the same run. Never stores the webhook URL, the prompt beyond a redacted
// excerpt, or the answer.
export function openApiRun(job) {
  return createAutomationRun({ id: job.id, scheduleId: apiSourceId(job), channelId: job.channelId, startedMs: job.createdMs || Date.now(),
    description: job.name || "", trigger: "api", facts: {
      apiTokenId: job.apiTokenId ? String(job.apiTokenId) : "", principalKind: job.principalKind || "api", request: excerpt(job),
      visibility: job.visibility || "visible", reportOutcome: Boolean(job.reportOutcome), webhook: Boolean(job.webhook),
      delivery: job.webhook ? "webhook" : job.slackThread ? "thread" : "caller",
      executionVisibility: job.visibility === "visible" || !job.visibility ? "visible" : "silent",
      resultPolicy: job.visibility === "hidden" ? "never" : job.visibility === "on-failure" ? "on-failure" : "always",
      deliveryThread: job.slackThread ? job.threadKey : "" } });
}

// Bring the ledger row in line with the job at one of its checkpoints. The TASK outcome is never
// written here (the shared recorder does that, automation-run-recorder.js): this carries the
// job-level facts only — live state, a stop, a thrown failure, an interruption, the settled cost
// and where the result went. Telemetry: a failure here must never fail the run.
export function syncApiRun(job) {
  try {
    const run = getScheduleRun(job.id);
    if (!run) return null;
    const patch = { deliveryStatus: apiDeliveryStatus(job) };
    const done = job.completedMs ? new Date(job.completedMs).toISOString() : new Date().toISOString();
    if (LIVE.has(job.status)) {
      patch.status = job.status;
      patch.engineStatus = job.status === "running" ? "running" : "not-started";
    } else if (job.status === "stopped") {
      Object.assign(patch, { status: "skipped", taskStatus: "skipped", summary: job.error || "Stopped before it finished.", completedAt: run.completedAt || done, deliveryStatus: "suppressed" });
    } else if (job.status === "interrupted") {
      Object.assign(patch, { status: "interrupted", taskStatus: "interrupted", engineStatus: "interrupted", error: job.error || "", completedAt: run.completedAt || done, effectsUnknown: true });
    } else if (job.status === "failed") {
      Object.assign(patch, { status: "failed", taskStatus: "failed", engineStatus: "failed", outcomeSource: "gateway", error: job.ledgerError || job.error || "The run failed.",
        errorKind: job.errorKind || run.errorKind || "execution", completedAt: run.completedAt || done });
    } else if (LIVE.has(run.status)) {
      // Completed without a recorded outcome (a row backfilled from a stored job).
      Object.assign(patch, { status: apiRunStatus(job), taskStatus: apiRunStatus(job), engineStatus: "completed", outcomeSource: job.outcome?.source || "unreported",
        summary: job.outcome?.summary || "", connections: job.outcome?.connections || [], completedAt: done, ...(job.outcome?.errorKind ? { errorKind: job.outcome.errorKind } : {}) });
    }
    if (job.engine && !run.engine) patch.engine = job.engine;
    if (job.model && !run.model) patch.model = job.model;
    if (typeof job.costUSD === "number") { patch.costUsd = job.costUSD; patch.costEstimated = Boolean(job.costEstimated); }
    if (job.durationMs && !run.durationMs) patch.durationMs = job.durationMs;
    // The run's own error stays the run's: a refused webhook is a delivery fact beside it.
    if (patch.deliveryStatus === "failed" && job.webhook) patch.deliveryError = redactLogValue(String(job.webhookError || "The webhook did not accept the result.")).slice(0, 300);
    else if (run.deliveryError) patch.deliveryError = "";
    if (job.webhookAttempts) patch.deliveryAttempts = job.webhookAttempts;
    const next = updateScheduleRun(job.id, patch);
    if (next && run.deliveryStatus !== next.deliveryStatus && next.deliveryStatus !== "pending") {
      appendScheduleRunEvent(job.id, { kind: next.deliveryStatus === "failed" ? "delivery_failed" : next.deliveryStatus === "delivered" ? "delivered" : "delivery_suppressed" });
    }
    return next;
  } catch {
    return null;
  }
}

// A repeat POST with a known idempotencyKey: counted on the run it was folded into.
export function noteApiDuplicate(jobId) {
  try { return bumpScheduleRunCounter(jobId, "duplicates"); } catch { return 0; }
}

// A call refused at the in-flight cap. Nothing ran, so there is no job; the refusal still leaves
// a trace — one ledger row per source per ten minutes, counting the calls it stands for.
export function noteApiRejection({ channelId, principalKind = "api", apiTokenId = null, name = "", now = Date.now() }) {
  try {
    const scheduleId = apiSourceId({ principalKind, apiTokenId, name });
    const recent = getDb().prepare("SELECT id, data FROM schedule_runs WHERE schedule_id = ? AND channel_id = ? AND status = 'skipped' AND started_ms >= ? ORDER BY started_ms DESC LIMIT 5")
      .all(scheduleId, channelId, now - REJECTION_WINDOW_MS).find((r) => fromJson(r.data, {})?.errorKind === "rejected");
    if (recent) return bumpScheduleRunCounter(recent.id, "rejectedCount");
    const run = createAutomationRun({ scheduleId, channelId, startedMs: now, description: name, trigger: "api", facts: {
      apiTokenId: apiTokenId ? String(apiTokenId) : "", principalKind, rejectedCount: 1 } });
    updateScheduleRun(run.id, { status: "skipped", taskStatus: "skipped", outcomeSource: "gateway", errorKind: "rejected", deliveryStatus: "suppressed",
      completedAt: new Date(now).toISOString(), summary: `Refused: ${API_MAX_INFLIGHT} API runs were already in flight (HTTP 429). Nothing ran.` });
    appendScheduleRunEvent(run.id, { kind: "rejected" });
    return 1;
  } catch {
    return 0;
  }
}

// Stored jobs from before API runs were written to the ledger: give each its row once, so the
// last week of API history does not vanish from the Automations page on upgrade. Idempotent.
export function backfillApiRunLedger() {
  let rows;
  try {
    rows = getDb().prepare("SELECT data FROM api_jobs WHERE id NOT IN (SELECT id FROM schedule_runs) ORDER BY created_ms").all();
  } catch {
    return 0;
  }
  let made = 0;
  for (const r of rows) {
    const job = fromJson(r.data, null);
    if (!job?.id || !job.channelId) continue;
    try {
      openApiRun(job);
      syncApiRun(job);
      made += 1;
    } catch { /* one unreadable job never blocks the rest */ }
  }
  return made;
}
