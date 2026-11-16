// Caller-owned call receipts. Never persist the live client, session, credentials or audio.
import { getDb } from "../../db/index.js";
import { costHistoryStart, costVisibleAt } from "../../ee/cost-history.js";

export function saveCallHistory(call) {
  getDb().prepare(`INSERT INTO voice_calls
    (id, owner_id, team_id, started_ms, ended_ms, duration_ms, cost_usd, model, summary, reason, threads)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(call.id, call.ownerId, call.teamId, call.startedMs, call.endedMs, call.durationMs,
      call.costUSD, call.model || "", call.summary, call.reason, JSON.stringify(call.threads));
}

function view(row, cutoff) {
  const { owner_id: _owner, team_id: _team, ...rest } = row;
  return { id: rest.id, startedMs: rest.started_ms, endedMs: rest.ended_ms, durationMs: rest.duration_ms,
    costUSD: costVisibleAt(rest.ended_ms, new Date(), cutoff) ? rest.cost_usd : null,
    model: rest.model, summary: rest.summary, reason: rest.reason, threads: JSON.parse(rest.threads) };
}

export function listCallHistory(ownerId, teamId, { before = null, limit = 30 } = {}) {
  const cutoff = costHistoryStart();
  const cursorSql = before ? " AND (started_ms < ? OR (started_ms = ? AND id < ?))" : "";
  const cursorArgs = before ? [before.startedMs, before.startedMs, before.id] : [];
  const rows = getDb().prepare(`SELECT id, started_ms, ended_ms, duration_ms, cost_usd, model,
    (SELECT count(*) FROM json_each(threads)) AS thread_count
    FROM voice_calls WHERE owner_id = ? AND team_id = ?${cursorSql} ORDER BY started_ms DESC, id DESC LIMIT ?`)
    .all(ownerId, teamId, ...cursorArgs, limit + 1);
  const last = rows[Math.min(rows.length, limit) - 1];
  return { calls: rows.slice(0, limit).map((r) => ({ id: r.id, startedMs: r.started_ms, durationMs: r.duration_ms,
    costUSD: costVisibleAt(r.ended_ms, new Date(), cutoff) ? r.cost_usd : null, model: r.model, threadCount: r.thread_count })),
  nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ startedMs: last.started_ms, id: last.id })).toString("base64url") : null };
}

export function readCallHistory(id, ownerId, teamId) {
  const row = getDb().prepare("SELECT * FROM voice_calls WHERE id = ? AND owner_id = ? AND team_id = ?").get(id, ownerId, teamId);
  return row ? view(row, costHistoryStart()) : null;
}
