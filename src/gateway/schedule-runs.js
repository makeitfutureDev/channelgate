// Durable, bounded automation telemetry. No FK to schedules: one-offs and deleted tasks
// retain their history. No tool arguments, outputs, reasoning or credential payloads are saved.
import { costHistoryStart, costVisibleAt } from "../ee/cost-history.js";
import { randomUUID } from "node:crypto";
import { getDb, toJson, fromJson } from "../db/index.js";
import { redactLogValue } from "../util/redact.js";

const RETENTION_DAYS = 90;
const safeText = (v, n = 1000) => redactLogValue(String(v ?? "")).slice(0, n);
const terminal = (status) => !["queued", "running"].includes(status);

// The API half of the ledger files its rows under `api:<source>` (api-run-history.js).
const API_ROWS = "schedule_id LIKE 'api:%'";

// One ledger row, whatever started the run. `facts` is the trigger's own block (scheduling facts
// for a schedule, credential/visibility facts for an API run); everything a run later records —
// engine, outcome, delivery, events, cost — has one shape here. `id` lets an API run reuse its
// job id; an existing row is left alone (a recovery or backfill may offer the same run twice).
export function createAutomationRun({ id = randomUUID(), scheduleId, channelId, startedMs = Date.now(), description = "", trigger = "schedule", facts = {} }) {
  const db = getDb();
  const now = Date.now();
  db.prepare("DELETE FROM schedule_runs WHERE started_ms < ? AND status NOT IN ('queued', 'running')").run(now - RETENTION_DAYS * 86400_000);
  const startedAt = new Date(startedMs).toISOString();
  const run = { id, scheduleId, channelId, description: safeText(description, 200), scheduledAt: startedAt, schedulingDelayMs: 0, trigger,
    startedAt, completedAt: null, lastActivityAt: startedAt,
    status: "queued", engineStatus: "not-started", taskStatus: "unreported", deliveryStatus: "pending",
    engine: "", model: "", summary: "", connections: [], events: [], durationMs: 0,
    tokensIn: 0, tokensOut: 0, costUsd: null, toolUseCount: 0, deliveryAttempts: 0,
    outcomeSource: "unreported", delivery: "standard", executionVisibility: "visible", resultPolicy: "always", ...facts };
  const inserted = db.prepare("INSERT INTO schedule_runs(id, schedule_id, channel_id, started_ms, status, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
    .run(run.id, scheduleId, channelId, Math.floor(startedMs), run.status, toJson(run));
  if (Number(inserted.changes)) appendScheduleRunEvent(run.id, { kind: "queued" });
  return getScheduleRun(run.id);
}

export function createScheduleRun(sched) {
  const now = Date.now();
  const manual = sched.trigger === "manual";
  return createAutomationRun({ scheduleId: sched.id, channelId: sched.channelId, startedMs: now, description: sched.description || "Scheduled task",
    trigger: manual ? "manual" : "schedule", facts: {
      scheduledAt: manual ? new Date(now).toISOString() : sched.lastCronFireMs ? new Date(sched.lastCronFireMs).toISOString() : sched.runAt || new Date(now).toISOString(),
      schedulingDelayMs: manual ? 0 : Math.max(0, now - (sched.lastCronFireMs || Date.parse(sched.runAt) || now)),
      ...(manual && sched.triggeredBy ? { triggeredBy: safeText(sched.triggeredBy, 64) } : {}),
      delivery: sched.delivery || "standard", executionVisibility: sched.executionVisibility || "visible", resultPolicy: sched.resultPolicy || "always" } });
}

export function getScheduleRun(id, channelId) {
  if (!id) return null;
  const row = channelId === undefined
    ? getDb().prepare("SELECT data FROM schedule_runs WHERE id = ?").get(id)
    : getDb().prepare("SELECT data FROM schedule_runs WHERE id = ? AND channel_id = ?").get(id, channelId);
  return row ? fromJson(row.data, {}) : null;
}

export function updateScheduleRun(id, patch) {
  const db = getDb();
  const run = getScheduleRun(id);
  if (!run) return null;
  // Only daemon callers write these named facts, but keep even diagnostics bounded and redacted.
  const safe = { ...patch };
  for (const key of ["summary", "error", "engine", "model", "errorKind"]) {
    if (key in safe) safe[key] = safeText(safe[key], key === "summary" ? 1000 : 400);
  }
  if (safe.connections) safe.connections = safe.connections.slice(0, 30).map((c) => ({ name: safeText(c.name, 120), status: c.status }));
  const next = { ...run, ...safe };
  db.prepare("UPDATE schedule_runs SET status = ?, data = ? WHERE id = ?").run(next.status, toJson(next), id);
  return next;
}

export function appendScheduleRunEvent(id, event) {
  const run = getScheduleRun(id);
  if (!run) return;
  const at = new Date().toISOString();
  const entry = { at, kind: safeText(event.kind, 60) };
  // Name only: targets, paths, arguments, outputs and arbitrary event text may carry secrets.
  if (["tool_use", "tool_result"].includes(event.kind) && typeof event.name === "string") entry.name = safeText(event.name, 100);
  if (event.kind === "tool_result" && ["failed", "completed"].includes(event.status)) entry.status = event.status;
  const events = [...run.events, entry];
  updateScheduleRun(id, { events: events.slice(-200), eventsDropped: (run.eventsDropped || 0) + Math.max(0, events.length - 200), lastActivityAt: at });
}

// `scheduledOnly` leaves the API half out: a conversation-wide read must not hand one person's
// API runs to everyone in the conversation (their own rule is api-run-history.js).
export function listScheduleRuns({ scheduleId, channelId, limit = 50, before, scheduledOnly = false } = {}) {
  const db = getDb();
  const clauses = [], args = [];
  if (scheduledOnly) clauses.push(`NOT ${API_ROWS}`);
  if (scheduleId !== undefined) { clauses.push("schedule_id = ?"); args.push(scheduleId); }
  if (channelId !== undefined) { clauses.push("channel_id = ?"); args.push(channelId); }
  if (before) {
    const row = db.prepare("SELECT rowid FROM schedule_runs WHERE id = ?").get(before);
    if (!row) return [];
    clauses.push("rowid < ?"); args.push(row.rowid);
  }
  const count = Number(limit);
  args.push(Number.isFinite(count) ? Math.max(1, Math.min(100, Math.floor(count))) : 50);
  return db.prepare(`SELECT data FROM schedule_runs ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY rowid DESC LIMIT ?`).all(...args).map((r) => fromJson(r.data, {}));
}

// The latest FINISHED run of every automation in one conversation, in one query: what the
// Automations channel list hands to the shared verdict (automation-health.js currentProblem).
// "Finished" is the health board's own reading: not live, and not a plain skip.
export function latestScheduleRuns(channelId) {
  const rows = getDb().prepare(`SELECT schedule_id, data FROM schedule_runs WHERE rowid IN
    (SELECT max(rowid) FROM schedule_runs WHERE channel_id = ? AND status NOT IN ('queued', 'running')
      AND NOT (status = 'skipped' AND coalesce(json_extract(data, '$.errorKind'), '') = '') GROUP BY schedule_id)`).all(channelId);
  return new Map(rows.map((r) => [r.schedule_id, fromJson(r.data, {}) || {}]));
}

// The API sources that have runs in one conversation: one group per `api:<source>` id.
export function apiRunGroups(channelId) {
  return getDb().prepare(`SELECT schedule_id AS id, count(*) AS total, max(started_ms) AS last_ms FROM schedule_runs
    WHERE channel_id = ? AND ${API_ROWS} GROUP BY schedule_id`).all(channelId)
    .map((r) => ({ id: r.id, total: Number(r.total), lastStartedMs: Number(r.last_ms) }));
}

// API runs in flight right now, gateway-wide (the HTTP API's cap is gateway-wide too). Bounded to
// a week so the count never walks the whole ledger.
export function liveApiRunCount(now = Date.now()) {
  return Number(getDb().prepare(`SELECT count(*) AS n FROM schedule_runs WHERE started_ms >= ? AND status IN ('queued', 'running') AND ${API_ROWS}`).get(now - 7 * 86400_000).n);
}

// Add to a numeric counter on one run (duplicates of an idempotent start, repeated rejections).
export function bumpScheduleRunCounter(id, key, by = 1) {
  if (!/^[A-Za-z]{1,40}$/.test(key)) return 0;
  return Number(getDb().prepare(`UPDATE schedule_runs SET data = json_set(data, '$.${key}', coalesce(json_extract(data, '$.${key}'), 0) + ?) WHERE id = ?`).run(Math.floor(by), id).changes);
}

// Every run of one automation started at or after `sinceMs`, newest first (bounded).
export function scheduleRunsSince({ scheduleId, channelId, sinceMs, limit = 500 }) {
  return getDb().prepare("SELECT data FROM schedule_runs WHERE schedule_id = ? AND channel_id = ? AND started_ms >= ? ORDER BY started_ms DESC LIMIT ?")
    .all(scheduleId, channelId, Math.floor(Number(sinceMs) || 0), Math.max(1, Math.min(2000, Math.floor(limit)))).map((r) => fromJson(r.data, {}));
}

// Mark runs as acknowledged (a person looked at the error and handled it), or clear the mark.
// The run's own outcome is never rewritten: history stays truthful, only the health verdict
// stops treating it as an open problem. Bounded to one automation inside one conversation.
export function setScheduleRunsAcknowledged({ scheduleId, channelId, runIds, by = null }) {
  const ids = [...new Set((runIds || []).filter((id) => typeof id === "string" && id.length <= 64))].slice(0, 2000);
  if (!ids.length) return 0;
  const db = getDb();
  const scope = "schedule_id = ? AND channel_id = ? AND id IN (SELECT value FROM json_each(?))";
  if (!by) return Number(db.prepare(`UPDATE schedule_runs SET data = json_remove(data, '$.acknowledgedAt', '$.acknowledgedBy', '$.acknowledgedByName') WHERE ${scope}`)
    .run(scheduleId, channelId, JSON.stringify(ids)).changes);
  return Number(db.prepare(`UPDATE schedule_runs SET data = json_set(data, '$.acknowledgedAt', ?, '$.acknowledgedBy', ?, '$.acknowledgedByName', ?) WHERE ${scope}`)
    .run(new Date().toISOString(), safeText(by.id, 64), safeText(by.name, 120), scheduleId, channelId, JSON.stringify(ids)).changes);
}

// Output-only view: internal readers and update paths always retain original accounting.
export function visibleScheduleRun(run, historyStart = costHistoryStart()) {
  if (!run || costVisibleAt(run.completedAt ?? run.startedAt, new Date(), historyStart)) return run;
  return { ...run, costUsd: null, ...(Object.hasOwn(run, "costEstimated") ? { costEstimated: false } : {}) };
}

export function scheduleRunSummary(scheduleId, channelId, historyStart = costHistoryStart(), { scheduledOnly = false } = {}) {
  const clauses = [], args = [];
  if (scheduledOnly) clauses.push(`NOT ${API_ROWS}`);
  if (scheduleId !== undefined) { clauses.push("schedule_id = ?"); args.push(scheduleId); }
  if (channelId !== undefined) { clauses.push("channel_id = ?"); args.push(channelId); }
  const rows = getDb().prepare(`SELECT status, count(*) AS n,
    sum(CASE WHEN json_extract(data, '$.engineStatus') = 'completed' THEN 1 ELSE 0 END) AS engine_completed,
    sum(CASE WHEN json_extract(data, '$.deliveryStatus') = 'failed' THEN 1 ELSE 0 END) AS delivery_failed,
    sum(CASE WHEN ? IS NULL OR julianday(COALESCE(json_extract(data, '$.completedAt'), json_extract(data, '$.startedAt'))) >= julianday(?)
      THEN json_extract(data, '$.costUsd') ELSE NULL END) AS cost, max(json_extract(data, '$.startedAt')) AS last_started
    FROM schedule_runs ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} GROUP BY status`).all(historyStart?.toISOString() ?? null, historyStart?.toISOString() ?? null, ...args);
  const summary = { total: 0, succeeded: 0, noOp: 0, failed: 0, blocked: 0, unreported: 0, interrupted: 0, skipped: 0, completed: 0, live: 0,
    engineCompleted: 0, deliveryFailed: 0, successRate: null, lastStartedAt: null, totalCostUsd: null, retentionDays: RETENTION_DAYS, costHistoryDays: historyStart ? 30 : null };
  let finished = 0;
  for (const r of rows) {
    summary.total += r.n;
    if (r.status === "no-op") summary.noOp += r.n;
    else if (!terminal(r.status)) summary.live += r.n;
    else if (Object.hasOwn(summary, r.status)) summary[r.status] += r.n;
    // "completed" is a run nobody asked to judge: it finished, and says nothing about success.
    if (terminal(r.status) && r.status !== "skipped" && r.status !== "completed") finished += r.n;
    summary.engineCompleted += r.engine_completed;
    summary.deliveryFailed += r.delivery_failed;
    if (r.cost !== null) summary.totalCostUsd = (summary.totalCostUsd || 0) + r.cost;
    if (r.last_started && (!summary.lastStartedAt || r.last_started > summary.lastStartedAt)) summary.lastStartedAt = r.last_started;
  }
  const last = listScheduleRuns({ scheduleId, channelId, limit: 1, scheduledOnly })[0];
  summary.lastStatus = last?.status || null;
  summary.lastAcknowledged = Boolean(last?.acknowledgedAt);
  summary.successRate = finished ? (summary.succeeded + summary.noOp) / finished : null;
  return summary;
}
