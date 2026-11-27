// Activity sessions that survive a gateway restart.
//
// A session used to live only in the router's memory, so every restart of the daemon (several a
// day on a busy deployment) signed everyone out of their dashboard and the installed app. Rows now
// live in `activity_sessions`; the in-memory map is a cache in front of them, loaded lazily on the
// first request for an id after a restart. Only the sha256 of the cookie secret is stored, as
// before, so the table never holds anything that opens a session by itself.
//
// Lifetime depends on how the session was earned: a passkey sign-in or an admin dashboard
// hand-off (the person proved who they are on this device) lasts ACTIVITY_PASSKEY_SESSION_TTL_MS;
// a Slack-link launch keeps the short ACTIVITY_SESSION_TTL_MS. Every request still re-checks the owner's
// approval, the passkey's existence and the admin account's version, so a long session is revoked
// the moment any of those changes.
import { getDb } from "../db/index.js";

export const ACTIVITY_SESSION_TTL_MS = 12 * 60 * 60_000;
export const ACTIVITY_PASSKEY_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

const COLUMNS = ["owner_id", "team_id", "origin", "credential_id", "admin_auth", "cookie_hash", "csrf", "expires_at", "created_at"];

function toRow(session) {
  return {
    owner_id: session.ownerId, team_id: session.teamId, origin: session.origin,
    credential_id: session.credentialId || "", admin_auth: session.adminAuth ? JSON.stringify(session.adminAuth) : "",
    cookie_hash: session.cookieHash, csrf: session.csrf, expires_at: session.expiresAt, created_at: session.createdAt || Date.now(),
  };
}
function fromRow(row) {
  if (!row) return null;
  const session = { ownerId: row.owner_id, teamId: row.team_id, origin: row.origin, cookieHash: row.cookie_hash, csrf: row.csrf, expiresAt: Number(row.expires_at), createdAt: Number(row.created_at) };
  if (row.credential_id) session.credentialId = row.credential_id;
  if (row.admin_auth) { try { session.adminAuth = JSON.parse(row.admin_auth); } catch { /* an unreadable admin reference is no admin reference */ } }
  return session;
}

export function createActivitySessionStore({ db = getDb } = {}) {
  const cache = new Map();
  const statements = () => {
    const d = db();
    return {
      get: d.prepare("SELECT id, " + COLUMNS.join(", ") + " FROM activity_sessions WHERE id = ?"),
      put: d.prepare(`INSERT OR REPLACE INTO activity_sessions (id, ${COLUMNS.join(", ")}) VALUES (?, ${COLUMNS.map(() => "?").join(", ")})`),
      del: d.prepare("DELETE FROM activity_sessions WHERE id = ?"),
      prune: d.prepare("DELETE FROM activity_sessions WHERE expires_at <= ?"),
      owner: d.prepare("SELECT id FROM activity_sessions WHERE owner_id = ? ORDER BY created_at ASC"),
      count: d.prepare("SELECT COUNT(*) AS n FROM activity_sessions"),
      oldest: d.prepare("SELECT id FROM activity_sessions ORDER BY created_at ASC LIMIT ?"),
      all: d.prepare("DELETE FROM activity_sessions"),
    };
  };
  function get(id) {
    if (!id || typeof id !== "string") return null;
    const cached = cache.get(id);
    if (cached) return cached;
    // Expiry is the router's decision (it owns the clock): an expired row is refused there and
    // removed by the next prune.
    const session = fromRow(statements().get.get(id));
    if (!session) return null;
    cache.set(id, session);
    return session;
  }
  function set(id, session) {
    const row = toRow({ ...session, createdAt: session.createdAt || Date.now() });
    statements().put.run(id, ...COLUMNS.map((column) => row[column]));
    cache.set(id, session);
    return session;
  }
  function remove(id) { cache.delete(id); statements().del.run(id); }
  function prune(at) {
    for (const [id, session] of cache) if (session.expiresAt <= at) cache.delete(id);
    statements().prune.run(at);
  }
  // Keep at most `max` sessions per owner and `total` overall, dropping the oldest first.
  function capOwner(ownerId, max) {
    const ids = statements().owner.all(ownerId).map((row) => row.id);
    while (ids.length >= max) remove(ids.shift());
  }
  function capTotal(total) {
    const n = statements().count.get().n;
    if (n < total) return;
    for (const row of statements().oldest.all(n - total + 1)) remove(row.id);
  }
  function clear() { cache.clear(); statements().all.run(); }
  // Tests: forget the cache (what a restart does) without touching the rows.
  function forgetCache() { cache.clear(); }
  return { get, set, delete: remove, prune, capOwner, capTotal, clear, forgetCache };
}
