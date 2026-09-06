// The single-use ledger behind link-based approvals.
//
// A signed approval link is a bearer credential. The HMAC in the token proves it was minted by
// this gateway and that nobody edited the id, the action, the scope or the expiry inside it — but
// a signature alone is replayable forever, and mail clients, chat unfurlers and corporate proxies
// copy links around. This table is the other half: one row per minted nonce, flipped from unused
// to used by a single atomic statement, so the SECOND request carrying the same token loses.
//
// It deliberately stores no secret and no request detail (no command, no plan text, no channel):
// only which approval the nonce belongs to, what it may do, who it was minted for, when it stops
// working and whether it has been spent. Everything else is read from the approval itself at
// decision time, through the same lookup a Slack click uses.
import { getDb } from "../db/index.js";

// How long a terminal row is kept after it expires or is used. Long enough that a person who
// clicks a link twice gets "already used" rather than the indistinguishable "unknown", short
// enough that the table stays small.
const RETENTION_MS = 24 * 60 * 60 * 1000;

function rowToRecord(row) {
  if (!row) return null;
  return {
    nonce: row.nonce,
    approvalId: row.approval_id,
    kind: row.kind,
    action: row.action,
    scope: row.scope || "",
    requester: row.requester || "",
    expiresAt: row.expires_ms,
    usedAt: row.used_ms || 0,
  };
}

// Remember a freshly minted token. Called once per link at mint time; the caller owns the nonce
// (it is inside the signed payload), so a duplicate insert would mean a nonce collision and is a
// genuine error rather than something to paper over.
export function recordApprovalLinkToken({ nonce, approvalId, kind, action, scope = "", requester = "", expiresAt } = {}) {
  getDb().prepare(
    "INSERT INTO approval_link_tokens(nonce, approval_id, kind, action, scope, requester, expires_ms, used_ms) VALUES(?, ?, ?, ?, ?, ?, ?, 0)",
  ).run(String(nonce), String(approvalId), String(kind), String(action), String(scope || ""), String(requester || ""), Number(expiresAt) || 0);
  return getApprovalLinkToken(nonce);
}

export function getApprovalLinkToken(nonce) {
  return rowToRecord(getDb().prepare(
    "SELECT nonce, approval_id, kind, action, scope, requester, expires_ms, used_ms FROM approval_link_tokens WHERE nonce = ?",
  ).get(String(nonce ?? "")));
}

// Is this nonce still spendable? A READ, with no side effect — the confirmation page uses it, and
// the whole point of that page is that looking at a link never decides anything.
export function inspectApprovalLinkToken(nonce, now = Date.now()) {
  const row = getApprovalLinkToken(nonce);
  if (!row) return { ok: false, reason: "unknown" };
  if (row.usedAt) return { ok: false, reason: "used", row };
  if (row.expiresAt && row.expiresAt <= now) return { ok: false, reason: "expired", row };
  return { ok: true, row };
}

// Spend the nonce. One UPDATE guarded by `used_ms = 0` is the whole concurrency story: SQLite
// serializes writers, so of two simultaneous POSTs carrying the same token exactly one sees
// `changes === 1` and goes on to decide.
export function consumeApprovalLinkToken(nonce, now = Date.now()) {
  const key = String(nonce ?? "");
  const before = getApprovalLinkToken(key);
  if (!before) return { ok: false, reason: "unknown" };
  if (before.usedAt) return { ok: false, reason: "used", row: before };
  if (before.expiresAt && before.expiresAt <= now) return { ok: false, reason: "expired", row: before };
  const changed = getDb().prepare(
    "UPDATE approval_link_tokens SET used_ms = ? WHERE nonce = ? AND used_ms = 0",
  ).run(now, key).changes;
  if (!changed) return { ok: false, reason: "used", row: getApprovalLinkToken(key) };
  return { ok: true, row: { ...before, usedAt: now } };
}

// A decision made ANYWHERE — a Slack click, the admin API, another link — retires every other
// link for that approval. Without this a "deny" link stays live in someone's ephemeral after the
// request was approved, which is the link equivalent of a dead button that still fires.
export function retireApprovalLinkTokens(approvalId, now = Date.now()) {
  return getDb().prepare(
    "UPDATE approval_link_tokens SET used_ms = ? WHERE approval_id = ? AND used_ms = 0",
  ).run(now, String(approvalId ?? "")).changes;
}

export function pruneApprovalLinkTokens(now = Date.now()) {
  return getDb().prepare(
    "DELETE FROM approval_link_tokens WHERE (used_ms > 0 AND used_ms < ?) OR (used_ms = 0 AND expires_ms < ?)",
  ).run(now - RETENTION_MS, now - RETENTION_MS).changes;
}
