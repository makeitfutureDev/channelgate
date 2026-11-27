import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const store = await import("../src/config/admin-accounts.js");
const { getDb } = await import("../src/db/index.js");
const { saveSettings } = await import("../src/config/settings.js");
const auth = await import("../src/web/auth.js");
const { createAdminSession, adminSession, invalidateAllSessions, handleLogout, _forgetSessionCacheForTests: restart } = auth;
let sequence = 0;

// Admin dashboard sessions used to live only in memory, so every gateway restart signed every
// administrator out. They now persist in `admin_sessions` (only the token's sha256) and a passkey
// session lasts 30 days / 7 idle days; the password-only bootstrap session keeps 30 min / 12 h.

beforeEach(() => {
  invalidateAllSessions();
  getDb().exec(`
    DELETE FROM admin_identity_links;
    DELETE FROM admin_enrollment_tokens;
    DELETE FROM admin_passkeys;
    DELETE FROM admin_accounts;
    DELETE FROM _meta WHERE key IN ('admin_bootstrap_created', 'admin_passkeys_enrolled');
  `);
});

function passkeyAccount() {
  const a = store.ensureBootstrapAdmin();
  return store.saveAdminPasskey({ accountId: a.id, authVersion: a.authVersion,
    credential: { id: Buffer.from(`persist-fixture-${++sequence}`).toString("base64url"), publicKey: new Uint8Array([1, 2, sequence]), counter: 0, transports: ["internal"] },
    deviceType: "multiDevice", backedUp: true, name: "Fixture passkey" });
}
function session(account, opts) {
  let header;
  createAdminSession({ headers: {} }, { setHeader: (_name, value) => { header = value; } }, account, opts);
  const cookie = header.split(";")[0];
  return { header, request: { headers: { cookie } }, token: cookie.slice("cg_session=".length) };
}
const sha = (token) => crypto.createHash("sha256").update(token).digest("hex");
const rows = () => getDb().prepare("SELECT * FROM admin_sessions").all();
// Age a stored session as if `ms` passed, then drop the in-memory cache the way a restart does.
function age(token, { created = 0, seen = 0 }) {
  getDb().prepare("UPDATE admin_sessions SET created_at = created_at - ?, last_seen_at = last_seen_at - ? WHERE token_hash = ?").run(created, seen, sha(token));
  restart();
}
const HOUR = 60 * 60_000, DAY = 24 * HOUR;

test("a passkey admin session survives a restart, stores only the token hash and lasts thirty days", () => {
  const s = session(passkeyAccount());
  assert.match(s.header, /Max-Age=2592000/, "the cookie must outlive the old twelve-hour window");
  const [row] = rows();
  assert.equal(row.token_hash, sha(s.token));
  assert.ok(!JSON.stringify(row).includes(s.token), "the raw cookie token must never be stored");
  restart();
  assert.ok(adminSession(s.request), "a restart must not sign the administrator out");
  age(s.token, { created: 13 * HOUR, seen: 13 * HOUR });
  assert.ok(adminSession(s.request), "past twelve hours a passkey session stays valid");
  age(s.token, { created: 20 * DAY, seen: 6 * DAY });
  assert.ok(adminSession(s.request), "six idle days do not end it");
  age(s.token, { created: 11 * DAY });
  assert.equal(adminSession(s.request), null, "thirty days is the absolute limit");
  assert.equal(rows().length, 0, "an expired session's row is removed");
});

test("seven idle days end a passkey admin session", () => {
  const s = session(passkeyAccount());
  age(s.token, { created: 8 * DAY, seen: 8 * DAY });
  assert.equal(adminSession(s.request), null);
});

test("the password-only bootstrap session persists but keeps the short window", () => {
  saveSettings({ adminPassword: "fixture-password-long-enough" });
  const s = session(store.ensureBootstrapAdmin(), { bootstrap: true, method: "password" });
  assert.match(s.header, /Max-Age=43200/);
  restart();
  assert.ok(adminSession(s.request)?.bootstrap, "bootstrap sessions survive a restart too");
  age(s.token, { seen: 31 * 60_000 });
  assert.equal(adminSession(s.request), null, "thirty idle minutes still end a bootstrap session");
});

test("revocation, a password change and logout still end a stored session after a restart", () => {
  const account = passkeyAccount();
  const revoked = session(account);
  store.revokeAdminSessions(account.id); restart();
  assert.equal(adminSession(revoked.request), null, "a bumped auth version revokes a stored session");

  const cleared = session(store.adminAccount(account.id));
  invalidateAllSessions(); restart();
  assert.equal(adminSession(cleared.request), null, "invalidateAllSessions clears the stored rows");
  assert.equal(rows().length, 0);

  const out = session(store.adminAccount(account.id));
  handleLogout(out.request, { setHeader() {}, json() {} }); restart();
  assert.equal(adminSession(out.request), null, "logout deletes the stored row");
});

test("a fresh re-authentication survives a restart, the sliding window is written at most once a minute", () => {
  const s = session(passkeyAccount());
  age(s.token, { seen: 2 * 60_000 });
  getDb().prepare("UPDATE admin_sessions SET authenticated_at = authenticated_at - ? WHERE token_hash = ?").run(10 * 60_000, sha(s.token));
  restart();
  assert.equal(auth.requireRecentAdminAuth(s.request), false, "an old sign-in is not recent");
  auth.refreshAdminSession(s.request); restart();
  assert.equal(auth.requireRecentAdminAuth(s.request), true, "the re-authentication is persisted immediately");
  const seen = rows()[0].last_seen_at;
  assert.ok(Date.now() - seen < 5_000, "a request after a minute of quiet refreshes last_seen_at");
});
