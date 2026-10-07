// Durable, bounded automation telemetry. No FK to schedules: one-offs and deleted tasks
// retain their history. No tool arguments, outputs, reasoning or credential payloads are saved.
import { randomUUID } from "node:crypto";
import { getDb, toJson, fromJson } from "../db/index.js";
import { redactLogValue } from "../util/redact.js";

const RETENTION_DAYS = 90;
const safeText = (v, n = 1000) => redactLogValue(String(v ?? "")).slice(0, n);
const terminal = (status) => !["queued", "running"].includes(status);

export function createScheduleRun(sched) {
  const now = Date.now();
  const db = getDb();
  db.prepare("DELETE FROM schedule_runs WHERE started_ms < ? AND status NOT IN ('queued', 'running')").run(now - RETENTION_DAYS * 86400_000);
  const run = { id: randomUUID(), scheduleId: sched.id, channelId: sched.channelId,
    description: safeText(sched.description || "Scheduled task", 200),
    scheduledAt: sched.lastCronFireMs ? new Date(sched.lastCronFireMs).toISOString() : sched.runAt || new Date(now).toISOString(),
    schedulingDelayMs: Math.max(0, now - (sched.lastCronFireMs || Date.parse(sched.runAt) || now)),
    startedAt: new Date(now).toISOString(), completedAt: null, lastActivityAt: new Date(now).toISOString(),
    status: "queued", engineStatus: "not-started", taskStatus: "unreported", deliveryStatus: "pending",
    engine: "", model: "", summary: "", connections: [], events: [], durationMs: 0,
    tokensIn: 0, tokensOut: 0, costUsd: null, toolUseCount: 0, deliveryAttempts: 0,
    outcomeSource: "unreported", delivery: sched.delivery || "standard",
    executionVisibility: sched.executionVisibility || "visible", resultPolicy: sched.resultPolicy || "always" };
  db.prepare("INSERT INTO schedule_runs(id, schedule_id, channel_id, started_ms, status, data) VALUES (?, ?, ?, ?, ?, ?)")
    .run(run.id, sched.id, sched.channelId, now, run.status, toJson(run));
  appendScheduleRunEvent(run.id, { kind: "queued" });
  return getScheduleRun(run.id);
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

export function listScheduleRuns({ scheduleId, channelId, limit = 50, before } = {}) {
  const db = getDb();
  const clauses = [], args = [];
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

export function scheduleRunSummary(scheduleId, channelId) {
  const clauses = [], args = [];
  if (scheduleId !== undefined) { clauses.push("schedule_id = ?"); args.push(scheduleId); }
  if (channelId !== undefined) { clauses.push("channel_id = ?"); args.push(channelId); }
  const rows = getDb().prepare(`SELECT status, count(*) AS n,
    sum(CASE WHEN json_extract(data, '$.engineStatus') = 'completed' THEN 1 ELSE 0 END) AS engine_completed,
    sum(CASE WHEN json_extract(data, '$.deliveryStatus') = 'failed' THEN 1 ELSE 0 END) AS delivery_failed,
    sum(json_extract(data, '$.costUsd')) AS cost, max(json_extract(data, '$.startedAt')) AS last_started
    FROM schedule_runs ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} GROUP BY status`).all(...args);
  const summary = { total: 0, succeeded: 0, noOp: 0, failed: 0, blocked: 0, unreported: 0, interrupted: 0, skipped: 0,
    engineCompleted: 0, deliveryFailed: 0, successRate: null, lastStartedAt: null, totalCostUsd: null, retentionDays: RETENTION_DAYS };
  let finished = 0;
  for (const r of rows) {
    summary.total += r.n;
    if (r.status === "no-op") summary.noOp += r.n;
    else if (Object.hasOwn(summary, r.status)) summary[r.status] += r.n;
    if (terminal(r.status) && r.status !== "skipped") finished += r.n;
    summary.engineCompleted += r.engine_completed;
    summary.deliveryFailed += r.delivery_failed;
    if (r.cost !== null) summary.totalCostUsd = (summary.totalCostUsd || 0) + r.cost;
    if (r.last_started && (!summary.lastStartedAt || r.last_started > summary.lastStartedAt)) summary.lastStartedAt = r.last_started;
  }
  summary.lastStatus = listScheduleRuns({ scheduleId, channelId, limit: 1 })[0]?.status || null;
  summary.successRate = finished ? (summary.succeeded + summary.noOp) / finished : null;
  return summary;
}
