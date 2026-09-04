// Access tokens for the catalog's MCP endpoint (/mcp/skills) and the gateway-to-gateway source.
// A token is random, shown exactly once, stored as a sha256 hash with a short prefix for
// recognition, carries scopes, and can be revoked. Verification is a hash lookup, so the table
// never holds a secret and a leaked database does not leak tokens.
//   read    — search/read skills, templates, whoami
//   propose — file proposals (suggest changes) from outside
//   manage  — create/update local skills from outside
//   sync    — export the catalog (what a peer gateway needs)
import { createHash, randomBytes } from "node:crypto";
import { getDb, fromJson, toJson } from "../../db/index.js";
import { SkillCatalogError, nowIso } from "./catalog.js";

export const TOKEN_SCOPES = Object.freeze(["read", "propose", "manage", "sync"]);
const PREFIX = "cgs_";

export function hashToken(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function rowToToken(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    prefix: r.token_prefix,
    scopes: fromJson(r.scopes, []) || [],
    createdAt: r.created_at,
    createdBy: r.created_by,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
    revoked: Boolean(r.revoked_at),
  };
}

export function normalizeScopes(scopes) {
  const out = [...new Set((Array.isArray(scopes) ? scopes : String(scopes || "").split(/[\s,]+/)).map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
  for (const s of out) if (!TOKEN_SCOPES.includes(s)) throw new SkillCatalogError(`unknown scope "${s}" (use ${TOKEN_SCOPES.join(", ")})`);
  return out.length ? out : ["read"];
}

// Mint a token. Returns { token, record } — `token` is the only time the value exists in clear.
export function createAccessToken({ name, scopes = ["read"], createdBy = "", now = nowIso() } = {}) {
  const label = String(name || "").trim().slice(0, 80);
  if (!label) throw new SkillCatalogError("a token needs a name");
  const value = `${PREFIX}${randomBytes(24).toString("base64url")}`;
  const res = getDb()
    .prepare("INSERT INTO skill_access_tokens(name, token_hash, token_prefix, scopes, created_at, created_by) VALUES(?, ?, ?, ?, ?, ?)")
    .run(label, hashToken(value), value.slice(0, 10), toJson(normalizeScopes(scopes)), now, createdBy);
  return { token: value, record: getAccessToken(Number(res.lastInsertRowid)) };
}

export function getAccessToken(id) {
  return rowToToken(getDb().prepare("SELECT * FROM skill_access_tokens WHERE id = ?").get(Number(id)));
}

export function listAccessTokens() {
  return getDb().prepare("SELECT * FROM skill_access_tokens ORDER BY id").all().map(rowToToken);
}

export function revokeAccessToken(id, { now = nowIso() } = {}) {
  const res = getDb().prepare("UPDATE skill_access_tokens SET revoked_at = ? WHERE id = ? AND revoked_at = ''").run(now, Number(id));
  if (res.changes === 0) throw new SkillCatalogError("token not found or already revoked", { status: 404 });
  return getAccessToken(id);
}

export function deleteAccessToken(id) {
  return getDb().prepare("DELETE FROM skill_access_tokens WHERE id = ?").run(Number(id)).changes > 0;
}

// Resolve a presented bearer value to its record (null when unknown or revoked). Records the use.
export function verifyAccessToken(value, { now = nowIso() } = {}) {
  const v = String(value || "").trim();
  if (!v.startsWith(PREFIX)) return null;
  const row = getDb().prepare("SELECT * FROM skill_access_tokens WHERE token_hash = ?").get(hashToken(v));
  if (!row || row.revoked_at) return null;
  getDb().prepare("UPDATE skill_access_tokens SET last_used_at = ? WHERE id = ?").run(now, row.id);
  return rowToToken(row);
}

export function tokenHasScope(record, scope) {
  return Boolean(record && Array.isArray(record.scopes) && record.scopes.includes(scope));
}
