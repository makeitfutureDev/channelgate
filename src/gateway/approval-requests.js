import { createHash } from "node:crypto";
import { getDb, fromJson, toJson } from "../db/index.js";

const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Hash only the authority-bearing action fields. Labels/card wording may change without creating
// a second authorization, while a different command, cap, principal, channel, or thread always
// gets a different key. The full action stays in the protected SQLite JSON record for execution.
export function approvalActionKey(action = {}) {
  const exact = {
    version: 1,
    kind: String(action.kind || ""),
    channelId: String(action.channelId || ""),
    slug: String(action.slug || ""),
    authorId: String(action.authorId || ""),
    threadKey: String(action.threadKey || ""),
    command: String(action.command || ""),
    workDir: String(action.workDir || ""),
    maxMs: Number(action.maxMs) || 0,
  };
  if (action.kind === "channel_instructions") {
    exact.text = String(action.text || "");
    exact.mode = String(action.mode || "");
    exact.fingerprint = String(action.fingerprint || "");
  }
  return createHash("sha256").update(JSON.stringify(exact)).digest("hex");
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    ...(fromJson(row.data, {}) || {}),
    id: row.id,
    actionKey: row.action_key,
    status: row.status,
    createdAt: row.created_ms,
    updatedAt: row.updated_ms,
  };
}

export function getApprovalRequest(id) {
  return rowToRecord(getDb().prepare(
    "SELECT id, action_key, status, created_ms, updated_ms, data FROM approval_requests WHERE id = ?",
  ).get(id));
}

export function findPendingApproval(actionKey) {
  return rowToRecord(getDb().prepare(
    "SELECT id, action_key, status, created_ms, updated_ms, data FROM approval_requests WHERE action_key = ? AND status = 'pending'",
  ).get(actionKey));
}

// Every durable request still awaiting a decision, newest first. The admin approvals API lists
// these beside the in-memory (long-poll) cards; nothing here is secret — the same fields already
// render on the Slack card the request posted.
export function listPendingApprovalRequests(limit = 200) {
  return getDb().prepare(
    "SELECT id, action_key, status, created_ms, updated_ms, data FROM approval_requests WHERE status = 'pending' ORDER BY created_ms DESC LIMIT ?",
  ).all(Math.max(1, Number(limit) || 1)).map(rowToRecord);
}

export function createApprovalRequest(record) {
  const now = Number(record.createdAt) || Date.now();
  const stored = { ...record, createdAt: now, updatedAt: now };
  getDb().prepare(
    "INSERT INTO approval_requests(id, action_key, status, created_ms, updated_ms, data) VALUES(?, ?, ?, ?, ?, ?)",
  ).run(stored.id, stored.actionKey, stored.status || "pending", now, now, toJson(stored));
  return getApprovalRequest(stored.id);
}

// Atomic compare-and-swap for the click state machine. Only the expected prior state may advance;
// duplicate/replayed Slack clicks therefore cannot execute an action twice.
export function transitionApprovalRequest(id, fromStatus, status, patch = {}) {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = getApprovalRequest(id);
    if (!current || current.status !== fromStatus) {
      db.exec("COMMIT");
      return null;
    }
    const now = Date.now();
    const next = { ...current, ...patch, id: current.id, actionKey: current.actionKey, status, updatedAt: now };
    const changed = db.prepare(
      "UPDATE approval_requests SET status = ?, updated_ms = ?, data = ? WHERE id = ? AND status = ?",
    ).run(status, now, toJson(next), id, fromStatus).changes;
    db.exec("COMMIT");
    return changed ? getApprovalRequest(id) : null;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw error;
  }
}

export function patchPendingApproval(id, patch = {}) {
  const current = getApprovalRequest(id);
  if (!current || current.status !== "pending") return null;
  const now = Date.now();
  const next = { ...current, ...patch, status: "pending", updatedAt: now };
  getDb().prepare(
    "UPDATE approval_requests SET updated_ms = ?, data = ? WHERE id = ? AND status = 'pending'",
  ).run(now, toJson(next), id);
  return getApprovalRequest(id);
}

export function deleteApprovalRequest(id) {
  return getDb().prepare("DELETE FROM approval_requests WHERE id = ?").run(id).changes > 0;
}

export function pruneTerminalApprovalRequests(now = Date.now()) {
  return getDb().prepare(
    "DELETE FROM approval_requests WHERE status IN ('denied', 'consumed', 'failed') AND updated_ms < ?",
  ).run(now - TERMINAL_RETENTION_MS).changes;
}

// A daemon can stop in the tiny interval after an approval is atomically claimed but before the
// click handler marks it consumed. Reconcile those rows before accepting Slack traffic: a matching
// persisted job proves the exact action started. Without that proof, fail closed: the process may
// have spawned in the tiny pre-persistence gap, so reopening the button could execute it twice. The
// singleton daemon lock makes this recovery pass the only writer responsible for an interrupted
// process's rows.
export function recoverInterruptedApprovalExecutions() {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const approvals = db.prepare(
      "SELECT id, action_key, status, created_ms, updated_ms, data FROM approval_requests WHERE status = 'executing'",
    ).all();
    const jobs = new Map();
    for (const row of db.prepare("SELECT id, data FROM bg_jobs").all()) {
      const job = fromJson(row.data, {}) || {};
      if (job.approvalId) jobs.set(String(job.approvalId), { id: row.id, ...job });
    }
    const update = db.prepare(
      "UPDATE approval_requests SET status = ?, updated_ms = ?, data = ? WHERE id = ? AND status = 'executing'",
    );
    let consumed = 0;
    let failed = 0;
    for (const row of approvals) {
      const current = rowToRecord(row);
      const job = jobs.get(current.id);
      const now = Date.now();
      const status = job ? "consumed" : "failed";
      const next = {
        ...current,
        status,
        updatedAt: now,
        ...(job
          ? { jobId: job.id, jobLabel: job.label || current.action?.label || "background job" }
          : { error: "Gateway restarted while executing the approved action; execution is uncertain, so this approval was consumed without retry." }),
      };
      const changed = update.run(status, now, toJson(next), current.id).changes;
      if (changed && job) consumed += 1;
      else if (changed) failed += 1;
    }
    db.exec("COMMIT");
    return { consumed, failed };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw error;
  }
}
