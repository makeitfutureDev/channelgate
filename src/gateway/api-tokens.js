// Channel-level user tokens for the HTTP run API.
//
// The organization-wide run API key (settings `apiKey`, DEPRECATED) is one credential for every
// conversation that acts as a fixed admin principal with nobody behind it. A channel token is the
// opposite on both axes: it belongs to ONE conversation and ONE person. A run it starts is bound to
// that conversation (a request naming another channel is refused) and acts AS its creator — their
// live rank from the user store, their channel authorization re-checked at every run, their
// personal scope — exactly as if they had posted the message in Slack. Revoking the token, or
// un-approving its creator, stops the next call.
//
// Values are random (192 bits), shown exactly once at creation and stored only as a sha256 hash
// with a short prefix and last four characters for recognition. Resolution is a hash lookup, so a
// leaked database leaks no token.
import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../db/index.js";

export const API_TOKEN_PREFIX = "cgk_";

export class ApiTokenError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function nowIso() {
  return new Date().toISOString();
}

export function hashApiToken(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function looksLikeApiToken(value) {
  return String(value || "").startsWith(API_TOKEN_PREFIX);
}

function rowToToken(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    prefix: r.token_prefix,
    last4: r.last4,
    channelId: r.channel_id,
    slug: r.slug,
    createdBy: r.created_by,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at || "",
    revokedAt: r.revoked_at || "",
    revoked: Boolean(r.revoked_at),
  };
}

/** Mint a token. Returns { token, record } — `token` is the only time the value exists in clear. */
export function createApiToken({ name, channelId, slug, createdBy, now = nowIso() } = {}) {
  const label = String(name || "").trim().slice(0, 80);
  if (!label) throw new ApiTokenError("a token needs a name");
  if (!channelId || !slug) throw new ApiTokenError("a token belongs to one registered conversation");
  if (!createdBy) throw new ApiTokenError("a token belongs to one person");
  const value = `${API_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
  const res = getDb()
    .prepare("INSERT INTO api_tokens(name, token_hash, token_prefix, last4, channel_id, slug, created_by, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)")
    .run(label, hashApiToken(value), value.slice(0, 8), value.slice(-4), String(channelId), String(slug), String(createdBy), now);
  return { token: value, record: getApiToken(Number(res.lastInsertRowid)) };
}

export function getApiToken(id) {
  return rowToToken(getDb().prepare("SELECT * FROM api_tokens WHERE id = ?").get(Number(id)));
}

/** List tokens — all, one channel's, or one person's (never a value). */
export function listApiTokens({ channelId = "", createdBy = "", includeRevoked = true } = {}) {
  const where = [];
  const args = [];
  if (channelId) { where.push("channel_id = ?"); args.push(String(channelId)); }
  if (createdBy) { where.push("created_by = ?"); args.push(String(createdBy)); }
  if (!includeRevoked) where.push("revoked_at = ''");
  const sql = `SELECT * FROM api_tokens${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC`;
  return getDb().prepare(sql).all(...args).map(rowToToken);
}

export function revokeApiToken(id, { now = nowIso() } = {}) {
  const res = getDb().prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at = ''").run(now, Number(id));
  if (res.changes === 0) throw new ApiTokenError("token not found or already revoked", 404);
  return getApiToken(id);
}

/** Resolve a presented value to its live record (null when unknown or revoked). Records the use. */
export function resolveApiToken(value, { now = nowIso() } = {}) {
  const v = String(value || "").trim();
  if (!looksLikeApiToken(v)) return null;
  const row = getDb().prepare("SELECT * FROM api_tokens WHERE token_hash = ?").get(hashApiToken(v));
  if (!row || row.revoked_at) return null;
  getDb().prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now, row.id);
  return rowToToken(row);
}

/** The curl example a creator gets back with their token (the value is interpolated by the caller once). */
export function curlExample(baseUrl, token = "<token>") {
  const base = String(baseUrl || "https://<your-gateway>").replace(/\/+$/, "");
  return [
    `curl -X POST ${base}/api/runs \\`,
    `  -H "X-API-Key: ${token}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"message":"Summarize the latest report"}'`,
  ].join("\n");
}
