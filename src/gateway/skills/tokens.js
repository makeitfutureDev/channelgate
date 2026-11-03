// Access tokens for the catalog's MCP endpoint (/mcp/skills) and the gateway-to-gateway source.
// A token is random, shown exactly once, stored as a sha256 hash with a short prefix for
// recognition, carries scopes, and can be revoked. Verification is a hash lookup, so the table
// never holds a secret and a leaked database does not leak tokens.
//   read    — search/read skills, templates, whoami
//   propose — file proposals (suggest changes) from outside
//   manage  — create/update local skills from outside
//   sync    — export the catalog (what a peer gateway needs)
//
// Two KINDS (operator decision 2026-11-03):
//   catalog — minted by an admin in the admin UI. The LIBRARY for other systems and peer gateways:
//             organization and channel skills; never a personal skill, in any scope.
//   user    — minted by a person for themselves (gateway tools create_my_skill_token …). It is
//             that person: what it can read and change is resolved LIVE from their current rank,
//             channel access and personal skills (skills/token-scope.js), so a revoked approval
//             kills the token and leaving a channel drops that channel's skills. Never `sync`.
import { createHash, randomBytes } from "node:crypto";
import { getDb, fromJson, toJson } from "../../db/index.js";
import { SkillCatalogError, nowIso } from "./catalog.js";

export const TOKEN_SCOPES = Object.freeze(["read", "propose", "manage", "sync"]);
export const TOKEN_KINDS = Object.freeze(["catalog", "user"]);
export const USER_TOKEN_SCOPES = Object.freeze(["read", "propose", "manage"]);
export const MAX_USER_TOKENS = 5;
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
    kind: TOKEN_KINDS.includes(r.kind) ? r.kind : "catalog",
    ownerId: String(r.owner_id || ""),
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

function mint({ name, scopes, kind, ownerId, createdBy, now }) {
  const label = String(name || "").trim().slice(0, 80);
  if (!label) throw new SkillCatalogError("a token needs a name");
  const value = `${PREFIX}${randomBytes(24).toString("base64url")}`;
  const res = getDb()
    .prepare("INSERT INTO skill_access_tokens(name, token_hash, token_prefix, scopes, kind, owner_id, created_at, created_by) VALUES(?, ?, ?, ?, ?, ?, ?, ?)")
    .run(label, hashToken(value), value.slice(0, 10), toJson(scopes), kind, ownerId, now, createdBy);
  return { token: value, record: getAccessToken(Number(res.lastInsertRowid)) };
}

// Mint a CATALOG token (admin UI). Returns { token, record } — `token` is the only time the value
// exists in clear.
export function createAccessToken({ name, scopes = ["read"], createdBy = "", now = nowIso() } = {}) {
  return mint({ name, scopes: normalizeScopes(scopes), kind: "catalog", ownerId: "", createdBy, now });
}

// Mint a USER token for `ownerId` (a person's own; scopes fixed, never sync; capped per person so a
// forgotten laptop cannot accumulate standing credentials).
export function createUserAccessToken({ ownerId, name, now = nowIso() } = {}) {
  const owner = String(ownerId || "").trim();
  if (!owner) throw new SkillCatalogError("a user token needs its owner");
  const live = listUserAccessTokens(owner).filter((t) => !t.revoked).length;
  if (live >= MAX_USER_TOKENS) throw new SkillCatalogError(`you already have ${live} active skill tokens (limit ${MAX_USER_TOKENS}); revoke one first (revoke_my_skill_token)`, { status: 409 });
  return mint({ name, scopes: [...USER_TOKEN_SCOPES], kind: "user", ownerId: owner, createdBy: owner, now });
}

export function getAccessToken(id) {
  return rowToToken(getDb().prepare("SELECT * FROM skill_access_tokens WHERE id = ?").get(Number(id)));
}

export function listAccessTokens() {
  return getDb().prepare("SELECT * FROM skill_access_tokens ORDER BY id").all().map(rowToToken);
}

export function listUserAccessTokens(ownerId) {
  return getDb().prepare("SELECT * FROM skill_access_tokens WHERE kind = 'user' AND owner_id = ? ORDER BY id").all(String(ownerId || "")).map(rowToToken);
}

export function revokeAccessToken(id, { now = nowIso() } = {}) {
  const res = getDb().prepare("UPDATE skill_access_tokens SET revoked_at = ? WHERE id = ? AND revoked_at = ''").run(now, Number(id));
  if (res.changes === 0) throw new SkillCatalogError("token not found or already revoked", { status: 404 });
  return getAccessToken(id);
}

// A person revokes only their OWN user token; anyone else's id is "not found".
export function revokeUserAccessToken(id, ownerId, { now = nowIso() } = {}) {
  const res = getDb().prepare("UPDATE skill_access_tokens SET revoked_at = ? WHERE id = ? AND kind = 'user' AND owner_id = ? AND revoked_at = ''").run(now, Number(id), String(ownerId || ""));
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
