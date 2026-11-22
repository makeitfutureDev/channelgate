// Durable Composio SDK session mappings. Connected accounts live in Composio under the stable
// external identity; this table only remembers which remote MCP session belongs to one Slack,
// Microsoft Teams or Google Chat thread/access class so restarts reuse it without storing
// credentials.
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

// Microsoft Teams identities: an author is a Bot Framework user id (`29:…`), a conversation is the
// gateway's namespaced id (`teams:<native conversation id>`), and the workspace is the Entra
// tenant. Slack identities keep their exact original form, so existing connected accounts stay
// attached to the same Composio user.
const TEAMS_TENANT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEAMS_USER_RE = /^29:[A-Za-z0-9_-]{1,256}$/;
const TEAMS_CONVERSATION_RE = /^teams:([A-Za-z0-9][A-Za-z0-9:@._=-]{0,299})$/;

// Google Chat identities: an author is the immutable Google account resource name (`users/<id>`,
// never the e-mail address, which a Workspace admin can rename or hand to another person), a
// conversation is the gateway's namespaced space id (`gchat:spaces/<id>`), and the workspace is the
// Google Cloud project ID of the Chat app's service account. An e-mail-shaped author is recognized
// as Google Chat only so that it is refused under these rules instead of being read as Slack.
const GCHAT_PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const GCHAT_USER_RE = /^users\/[A-Za-z0-9_-]{1,128}$/;
const GCHAT_SPACE_RE = /^gchat:(spaces\/[A-Za-z0-9_-]{1,128})$/;
const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+$/;

// Which surface an identity subject belongs to. Callers use it to supply that surface's workspace.
export function composioSubjectPlatform({ kind = "", id = "" } = {}) {
  const subject = String(id || "").trim();
  if (kind === "user" && TEAMS_USER_RE.test(subject)) return "msteams";
  if (kind === "channel" && subject.startsWith("teams:")) return "msteams";
  if (kind === "user" && (subject.startsWith("users/") || EMAIL_SHAPE_RE.test(subject))) return "googlechat";
  if (kind === "channel" && subject.startsWith("gchat:")) return "googlechat";
  return "slack";
}

export function composioIdentity({ workspaceId = "", kind = "", id = "" } = {}) {
  if (!KINDS.has(kind)) throw new Error("invalid Composio identity kind");
  const platform = composioSubjectPlatform({ kind, id });
  if (platform === "googlechat") {
    const project = String(workspaceId || "").trim();
    if (!GCHAT_PROJECT_RE.test(project)) throw new Error("invalid Composio Google Chat project identifier");
    const raw = String(id || "").trim();
    const subject = kind === "user" ? (GCHAT_USER_RE.test(raw) ? raw : "") : GCHAT_SPACE_RE.exec(raw)?.[1];
    if (!subject) throw new Error(`invalid Composio Google Chat ${kind} identifier`);
    return `googlechat:${project}:${kind}:${subject}`;
  }
  if (platform === "msteams") {
    const tenant = String(workspaceId || "").trim().toLowerCase();
    if (!TEAMS_TENANT_RE.test(tenant)) throw new Error("invalid Composio Microsoft Teams tenant identifier");
    const raw = String(id || "").trim();
    const subject = kind === "user" ? raw : TEAMS_CONVERSATION_RE.exec(raw)?.[1];
    if (!subject) throw new Error(`invalid Composio Microsoft Teams ${kind} identifier`);
    return `msteams:${tenant}:${kind}:${subject}`;
  }
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
