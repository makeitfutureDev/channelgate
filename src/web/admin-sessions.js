// Admin dashboard sessions that survive a gateway restart.
//
// A session used to live only in auth.js's memory, so every restart of the daemon signed every
// administrator out of the dashboard. Rows now live in `admin_sessions`; the in-memory map is a
// cache in front of them, loaded lazily on the first request after a restart. Only the sha256 of
// the cookie token is stored, so the table never holds anything that opens a session by itself.
// Every use still re-checks the account, its auth version and the sign-in method (auth.js), so a
// revoked account, a removed passkey or a changed password ends a stored session immediately.
import crypto from "node:crypto";
import { getDb } from "../db/index.js";

// The last-seen time slides on every request; persisting it on every request would turn each
// dashboard poll into a write, so the row is refreshed at most this often. The idle windows are
// measured in minutes (bootstrap) or days, so a minute of drift is immaterial.
const TOUCH_EVERY_MS = 60_000;

const COLUMNS = ["account_id", "auth_version", "bootstrap", "method", "password_fingerprint", "password_slack_version", "created_at", "last_seen_at", "authenticated_at"];

export function hashSessionToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function toRow(s) {
  return {
    account_id: s.accountId, auth_version: s.authVersion, bootstrap: s.bootstrap ? 1 : 0, method: s.method || "passkey",
    password_fingerprint: s.passwordFingerprint || "", password_slack_version: Number(s.passwordSlackVersion) || 0,
    created_at: s.createdAt, last_seen_at: s.lastSeenAt, authenticated_at: s.authenticatedAt,
  };
}
function fromRow(row) {
  if (!row) return null;
  const s = {
    createdAt: Number(row.created_at), lastSeenAt: Number(row.last_seen_at), authenticatedAt: Number(row.authenticated_at),
    accountId: row.account_id, authVersion: Number(row.auth_version), bootstrap: Boolean(row.bootstrap), method: row.method,
  };
  if (row.method === "password-slack") {
    s.passwordFingerprint = row.password_fingerprint;
    s.passwordSlackVersion = Number(row.password_slack_version) || 0;
  }
  return s;
}

export function createAdminSessionStore({ db = getDb } = {}) {
  const cache = new Map(); // token hash → session record
  const persisted = new Map(); // token hash → last_seen_at last written
  const statements = () => {
    const d = db();
    return {
      get: d.prepare(`SELECT ${COLUMNS.join(", ")} FROM admin_sessions WHERE token_hash = ?`),
      put: d.prepare(`INSERT OR REPLACE INTO admin_sessions (token_hash, ${COLUMNS.join(", ")}) VALUES (?, ${COLUMNS.map(() => "?").join(", ")})`),
      touch: d.prepare("UPDATE admin_sessions SET last_seen_at = ?, authenticated_at = ? WHERE token_hash = ?"),
      del: d.prepare("DELETE FROM admin_sessions WHERE token_hash = ?"),
      count: d.prepare("SELECT COUNT(*) AS n FROM admin_sessions"),
      oldest: d.prepare("SELECT token_hash FROM admin_sessions ORDER BY created_at ASC LIMIT ?"),
      all: d.prepare("DELETE FROM admin_sessions"),
      prune: d.prepare(`DELETE FROM admin_sessions WHERE
        (bootstrap = 1 AND (created_at <= ? OR last_seen_at <= ?)) OR created_at <= ? OR last_seen_at <= ?`),
    };
  };
  function get(token) {
    if (!token || typeof token !== "string") return null;
    const key = hashSessionToken(token);
    const cached = cache.get(key);
    if (cached) return cached;
    const s = fromRow(statements().get.get(key));
    if (!s) return null;
    cache.set(key, s); persisted.set(key, s.lastSeenAt);
    return s;
  }
  function set(token, s) {
    const key = hashSessionToken(token), row = toRow(s);
    statements().put.run(key, ...COLUMNS.map((c) => row[c]));
    cache.set(key, s); persisted.set(key, s.lastSeenAt);
    return s;
  }
  // Persist the sliding window (throttled) and, unthrottled, a fresh re-authentication — the
  // recent-auth check gates sensitive actions and must not be lost to a restart either.
  function touch(token, { force = false } = {}) {
    const key = hashSessionToken(token), s = cache.get(key);
    if (!s) return;
    if (!force && s.lastSeenAt - (persisted.get(key) || 0) < TOUCH_EVERY_MS) return;
    statements().touch.run(s.lastSeenAt, s.authenticatedAt, key);
    persisted.set(key, s.lastSeenAt);
  }
  function remove(token) {
    const key = hashSessionToken(token);
    cache.delete(key); persisted.delete(key);
    statements().del.run(key);
  }
  // Keep at most `total` sessions, dropping the oldest first.
  function capTotal(total) {
    const st = statements();
    const n = st.count.get().n;
    if (n <= total) return;
    for (const row of st.oldest.all(n - total)) {
      cache.delete(row.token_hash); persisted.delete(row.token_hash);
      st.del.run(row.token_hash);
    }
  }
  // Drop rows past their lifetime. `lifetime(bootstrap)` returns { idleMs, absoluteMs }; the
  // validity decision itself stays in auth.js, this only stops dead rows from piling up.
  function prune(now, lifetime) {
    const boot = lifetime(true), normal = lifetime(false);
    statements().prune.run(now - boot.absoluteMs, now - boot.idleMs, now - normal.absoluteMs, now - normal.idleMs);
    for (const [key, s] of cache) {
      const { idleMs, absoluteMs } = lifetime(s.bootstrap);
      if (now - s.createdAt > absoluteMs || now - s.lastSeenAt > idleMs) { cache.delete(key); persisted.delete(key); }
    }
  }
  function clear() { cache.clear(); persisted.clear(); statements().all.run(); }
  // Tests: forget the cache (what a restart does) without touching the rows.
  function forgetCache() { cache.clear(); persisted.clear(); }
  return { get, set, touch, delete: remove, capTotal, prune, clear, forgetCache };
}
