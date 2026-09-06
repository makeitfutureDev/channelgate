// Durable Composio SDK session mappings. Connected accounts live in Composio under the stable
// external identity; this table only remembers which remote MCP session belongs to one Slack
// thread/access class so restarts reuse it without storing credentials.
import { createHash } from "node:crypto";
import { getDb } from "../db/index.js";

const ID_RE = /^[A-Z][A-Z0-9]{1,63}$/i;
const KINDS = new Set(["user", "channel"]);
const ACCESS_KINDS = new Set(["owner", "manager", "member"]);

function requiredId(value, label) {
  const clean = String(value || "").trim();
  if (!ID_RE.test(clean)) throw new Error(`invalid Composio ${label} identifier`);
  return clean;
}

function requiredText(value, label, max = 512) {
  const clean = String(value || "").trim();
  if (!clean || clean.length > max || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new Error(`invalid Composio ${label}`);
  }
  return clean;
}

export function composioIdentity({ workspaceId = "", kind = "", id = "" } = {}) {
  if (!KINDS.has(kind)) throw new Error("invalid Composio identity kind");
  const workspace = requiredId(workspaceId, "workspace");
  const subject = requiredId(id, kind);
  return `slack:${workspace}:${kind}:${subject}`;
}

export function composioSessionKey({ identityId = "", threadKey = "", accessKind = "" } = {}) {
  const identity = requiredText(identityId, "identity", 256);
  const thread = requiredText(threadKey, "thread key", 512);
  if (!ACCESS_KINDS.has(accessKind)) throw new Error("invalid Composio access kind");
  const digest = createHash("sha256")
    .update(JSON.stringify([identity, thread, accessKind]))
    .digest("hex");
  return `cs_${digest}`;
}

function rowToSession(row) {
  if (!row) return null;
  return {
    sessionKey: row.session_key,
    identityId: row.identity_id,
    scopeKind: row.scope_kind,
    threadKey: row.thread_key,
    accessKind: row.access_kind,
    sessionId: row.session_id,
    mcpUrl: row.mcp_url,
    createdMs: row.created_ms,
    updatedMs: row.updated_ms,
  };
}

export function getComposioSession(sessionKey) {
  const key = requiredText(sessionKey, "session key", 128);
  return rowToSession(
    getDb()
      .prepare("SELECT * FROM composio_sessions WHERE session_key = ?")
      .get(key)
  );
}

export function saveComposioSession({
  sessionKey,
  identityId,
  scopeKind,
  threadKey,
  accessKind,
  sessionId,
  mcpUrl,
} = {}) {
  const key = requiredText(sessionKey, "session key", 128);
  const identity = requiredText(identityId, "identity", 256);
  const scope = String(scopeKind || "");
  if (!KINDS.has(scope)) throw new Error("invalid Composio scope kind");
  const thread = requiredText(threadKey, "thread key", 512);
  if (!ACCESS_KINDS.has(accessKind)) throw new Error("invalid Composio access kind");
  const remoteId = requiredText(sessionId, "remote session id", 256);
  const remoteUrl = new URL(requiredText(mcpUrl, "MCP URL", 2048));
  if (remoteUrl.protocol !== "https:") throw new Error("Composio MCP URL must use HTTPS");
  const now = Date.now();

  getDb()
    .prepare(`
      INSERT INTO composio_sessions(
        session_key, identity_id, scope_kind, thread_key, access_kind,
        session_id, mcp_url, created_ms, updated_ms
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        identity_id = excluded.identity_id,
        scope_kind = excluded.scope_kind,
        thread_key = excluded.thread_key,
        access_kind = excluded.access_kind,
        session_id = excluded.session_id,
        mcp_url = excluded.mcp_url,
        updated_ms = excluded.updated_ms
    `)
    .run(key, identity, scope, thread, accessKind, remoteId, remoteUrl.toString(), now, now);
  return getComposioSession(key);
}

export function deleteComposioSession(sessionKey) {
  const key = requiredText(sessionKey, "session key", 128);
  return getDb().prepare("DELETE FROM composio_sessions WHERE session_key = ?").run(key).changes > 0;
}
