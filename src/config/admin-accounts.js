// Dashboard credential containers bind to the canonical Users directory by verified stable ID.
import crypto from 'node:crypto';
import { getDb, metaGet, metaSet } from '../db/index.js';
import { isApiPrincipal } from './api-principal.js';

export function normalizeAdminUsername(value) {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9._@-]{0,79}$/.test(name)) throw new Error('Use 1–80 letters, numbers, dots, underscores, @ or hyphens for the username.');
  return name;
}
function account(row) {
  const user = row?.user_id ? dashboardUser(row.user_id) : null;
  return row ? { id: row.id, username: row.username, displayName: user?.name || row.display_name, userHandle: row.user_handle,
    userId: row.user_id || null, enabled: Boolean(row.enabled) && (!row.user_id || user?.isAdmin === true), authVersion: row.auth_version, bootstrapAllowed: Boolean(row.bootstrap_allowed), createdAt: row.created_ms } : null;
}
export function adminAccount(id) { return account(getDb().prepare('SELECT * FROM admin_accounts WHERE id = ?').get(id)); }
export function adminAccountByUsername(name) { return account(getDb().prepare('SELECT * FROM admin_accounts WHERE username = ?').get(normalizeAdminUsername(name))); }
export function createAdminAccount(username, displayName = username, bootstrap = false) {
  username = normalizeAdminUsername(username);
  displayName = String(displayName || username).trim().slice(0, 100);
  if (/[\x00-\x1f\x7f]/.test(displayName)) throw new Error('Invalid display name.');
  const id = crypto.randomUUID();
  getDb().prepare(`INSERT INTO admin_accounts (id, username, display_name, user_handle, bootstrap_allowed, created_ms) VALUES (?, ?, ?, ?, ?, ?)`).run(id, username, displayName, crypto.randomBytes(32).toString('base64url'), bootstrap ? 1 : 0, Date.now());
  return adminAccount(id);
}
export function ensureBootstrapAdmin() {
  let a = adminAccountByUsername('admin');
  if (!a && metaGet('admin_bootstrap_created') !== '1') {
    const db = getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      a = adminAccountByUsername('admin');
      if (!a) a = createAdminAccount('admin', 'Administrator', metaGet('admin_passkeys_enrolled') !== '1');
      metaSet('admin_bootstrap_created', '1'); db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return a;
}
function passkey(row) {
  return row ? {
    id: row.id, accountId: row.account_id, publicKey: new Uint8Array(row.public_key), counter: row.counter,
    transports: JSON.parse(row.transports), deviceType: row.device_type, backedUp: Boolean(row.backed_up), name: row.name,
    createdAt: row.created_ms, lastUsedAt: row.last_used_ms,
  } : null;
}
export function adminPasskeys(accountId) {
  return getDb().prepare('SELECT * FROM admin_passkeys WHERE account_id = ? ORDER BY created_ms').all(accountId).map(passkey);
}
export function adminPasskeyById(id) {
  if (typeof id !== 'string' || id.length > 2048) return null;
  return passkey(getDb().prepare('SELECT * FROM admin_passkeys WHERE id = ?').get(id));
}
export function listAdminAccounts() {
  ensureBootstrapAdmin();
  return getDb().prepare(`SELECT a.*, (SELECT COUNT(*) FROM admin_passkeys p WHERE p.account_id = a.id) AS passkey_count FROM admin_accounts a ORDER BY created_ms`).all().map(row => ({ ...account(row), passkeyCount: row.passkey_count }));
}
export function hasAdminPasskeys() { return Boolean(getDb().prepare('SELECT 1 FROM admin_passkeys LIMIT 1').get()); }
export function bootstrapAvailable() {
  const a = ensureBootstrapAdmin();
  return Boolean(a?.enabled && a.bootstrapAllowed && metaGet('admin_passkeys_enrolled') !== '1' && !adminPasskeys(a.id).length);
}
export function revokeAdminSessions(id) {
  const db = getDb();
  db.prepare('UPDATE admin_accounts SET auth_version = auth_version + 1 WHERE id = ?').run(id);
  db.prepare('DELETE FROM admin_enrollment_tokens WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM admin_identity_links WHERE account_id = ?').run(id);
}
export function setAdminEnabled(id, enabled) {
  const db = getDb(); db.exec('BEGIN IMMEDIATE');
  try {
    const a = adminAccount(id); if (!a) throw new Error('Account not found.');
    if (!enabled && adminPasskeys(id).length && !listAdminAccounts().some(x => x.id !== id && x.enabled && x.passkeyCount)) throw new Error('Cannot disable the last administrator with a passkey.');
    db.prepare('UPDATE admin_accounts SET enabled = ?, auth_version = auth_version + 1 WHERE id = ?').run(enabled ? 1 : 0, id);
    db.prepare('DELETE FROM admin_enrollment_tokens WHERE account_id = ?').run(id); db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return adminAccount(id);
}
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
export function createAdminEnrollment(id, { recover = false } = {}) {
  const db = getDb(); db.exec('BEGIN IMMEDIATE');
  try {
    const a = adminAccount(id); if (!a?.enabled) throw new Error('Account is unavailable.');
    if (recover) {
      db.prepare('DELETE FROM admin_identity_links WHERE account_id = ?').run(id);
      db.prepare('DELETE FROM admin_passkeys WHERE account_id = ?').run(id);
      db.prepare('UPDATE admin_accounts SET auth_version = auth_version + 1, bootstrap_allowed = 0 WHERE id = ?').run(id);
      metaSet('admin_passkeys_enrolled', '1');
    }
    db.prepare('DELETE FROM admin_enrollment_tokens WHERE account_id = ? OR expires_ms < ?').run(id, Date.now());
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO admin_enrollment_tokens (digest, account_id, auth_version, expires_ms) VALUES (?, ?, ?, ?)').run(digest(token), id, adminAccount(id).authVersion, Date.now() + 15 * 60_000);
    db.exec('COMMIT'); return token;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function adminEnrollment(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = getDb().prepare('SELECT * FROM admin_enrollment_tokens WHERE digest = ? AND expires_ms > ?').get(digest(token), Date.now());
  if (!row) return null;
  const a = adminAccount(row.account_id);
  return a?.enabled && a.authVersion === row.auth_version ? { account: a, digest: row.digest } : null;
}
// Signature verification is asynchronous. Recheck account/version and token under the write lock
// so disabling/recovering the account while the authenticator is open invalidates that ceremony.
export function saveAdminPasskey({ accountId, authVersion, credential, deviceType, backedUp, name, enrollmentDigest }) {
  const db = getDb(); db.exec('BEGIN IMMEDIATE');
  try {
    const a = adminAccount(accountId);
    if (!a?.enabled || a.authVersion !== authVersion) throw new Error('Account access changed. Start again.');
    if (adminLinkRequired(a)) throw new Error('Verify your existing admin user before registering a passkey.');
    if (enrollmentDigest) {
      const result = db.prepare('DELETE FROM admin_enrollment_tokens WHERE digest = ? AND account_id = ? AND auth_version = ? AND expires_ms > ?').run(enrollmentDigest, accountId, authVersion, Date.now());
      if (result.changes !== 1) throw new Error('Setup link expired or was already used.');
    }
    db.prepare(`INSERT INTO admin_passkeys (id, account_id, public_key, counter, transports, device_type, backed_up, name, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(credential.id, accountId, Buffer.from(credential.publicKey), credential.counter, JSON.stringify(credential.transports || []), deviceType, backedUp ? 1 : 0, String(name || 'Passkey').trim().slice(0, 80), Date.now());
    // This latch is permanent: clearing/changing the old shared password never restores login.
    metaSet('admin_passkeys_enrolled', '1');
    db.prepare('UPDATE admin_accounts SET bootstrap_allowed = 0, auth_version = auth_version + 1 WHERE id = ?').run(accountId);
    db.prepare('UPDATE admin_accounts SET bootstrap_allowed = 0').run();
    db.exec('COMMIT'); return adminAccount(accountId);
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function advanceAdminCounter(a, key, info) {
  const result = getDb().prepare(`UPDATE admin_passkeys SET counter = ?, last_used_ms = ?, device_type = ?, backed_up = ?
    WHERE id = ? AND account_id = ? AND counter = ? AND EXISTS (SELECT 1 FROM admin_accounts a WHERE a.id = ? AND a.enabled = 1 AND a.auth_version = ? AND (a.user_id IS NULL OR EXISTS (SELECT 1 FROM users u WHERE u.user_id = a.user_id AND u.user_id <> 'api' AND json_valid(u.data) AND json_type(u.data, '$.isAdmin') = 'true')))`).run(info.newCounter, Date.now(), info.credentialDeviceType, info.credentialBackedUp ? 1 : 0, key.id, a.id, key.counter, a.id, a.authVersion);
  if (result.changes !== 1) throw new Error('Account or passkey changed. Start again.');
}
export function deleteAdminPasskey(accountId, keyId) {
  const db = getDb(); db.exec('BEGIN IMMEDIATE');
  try {
    if (adminPasskeys(accountId).length < 2) throw new Error('Register a spare passkey before removing your last passkey.');
    const result = db.prepare('DELETE FROM admin_passkeys WHERE id = ? AND account_id = ?').run(keyId, accountId);
    if (result.changes !== 1) throw new Error('Passkey not found.');
    revokeAdminSessions(accountId); db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function passkeysConfigured() { return metaGet('admin_passkeys_enrolled') === '1' || hasAdminPasskeys(); }

// Read only canonical user rows, avoiding a store/settings import cycle. Never infer identity
// from display names, emails, the API principal, or a caller-provided admin flag.
export function dashboardUser(userId) {
  if (typeof userId !== 'string' || !userId || isApiPrincipal(userId)) return null;
  const row = getDb().prepare('SELECT data FROM users WHERE user_id = ?').get(userId);
  if (!row) return null;
  try {
    const data = JSON.parse(row.data);
    return { id: userId, name: String(data.name || userId), isAdmin: data.isAdmin === true };
  } catch { return null; }
}
export function eligibleAdminUsers() {
  return getDb().prepare('SELECT user_id FROM users ORDER BY user_id').all().map(row => dashboardUser(row.user_id)).filter(u => u?.isAdmin);
}
export function adminLinkRequired(a) { return Boolean(a && !a.userId && eligibleAdminUsers().length); }
export function adminAccountForUser(userId) { return account(getDb().prepare('SELECT * FROM admin_accounts WHERE user_id = ?').get(userId)); }
export function ensureUserAdminAccount(userId) {
  const user = dashboardUser(userId);
  if (!user?.isAdmin) throw new Error('The selected user is not an administrator.');
  let a = adminAccountForUser(userId);
  if (!a) {
    const id = crypto.randomUUID();
    getDb().prepare(`INSERT INTO admin_accounts (id, username, display_name, user_handle, user_id, created_ms) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, `user-${id}`, user.name, crypto.randomBytes(32).toString('base64url'), userId, Date.now());
    a = adminAccount(id);
  }
  return a;
}
// Called INSIDE setUser's IMMEDIATE transaction. Both demotion and later promotion invalidate
// old sessions/ceremonies. Re-promotion never resurrects authority minted before the role change.
export function adminUserAuthorityChanged(db, userId, previous, next) {
  if ((previous?.isAdmin === true) === (next?.isAdmin === true)) return;
  db.prepare('UPDATE admin_accounts SET auth_version = auth_version + 1 WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM admin_enrollment_tokens WHERE account_id IN (SELECT id FROM admin_accounts WHERE user_id = ?)').run(userId);
  db.prepare('DELETE FROM admin_identity_links WHERE user_id = ? OR account_id IN (SELECT id FROM admin_accounts WHERE user_id = ?)').run(userId, userId);
}
export function createAdminIdentityLink(a, userId, sessionToken) {
  const db = getDb(); db.exec('BEGIN IMMEDIATE');
  try {
    const current = adminAccount(a.id);
    if (!current?.enabled || current.userId || current.authVersion !== a.authVersion || !dashboardUser(userId)?.isAdmin) throw new Error('The selected administrator is unavailable.');
    const target = adminAccountForUser(userId);
    if (target && adminPasskeys(target.id).length) throw new Error('This user already has linked passkeys. Sign in with those passkeys instead.');
    db.prepare('DELETE FROM admin_identity_links WHERE account_id = ? OR expires_ms <= ?').run(a.id, Date.now());
    const requestId = crypto.randomBytes(24).toString('base64url');
    const code = String(crypto.randomInt(10_000_000, 100_000_000));
    const expiresAt = Date.now() + 5 * 60_000;
    db.prepare(`INSERT INTO admin_identity_links (id, account_id, user_id, auth_version, session_digest, code_digest, expires_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(requestId, a.id, userId, a.authVersion, digest(sessionToken), digest(`${requestId}\0${code}`), expiresAt);
    db.exec('COMMIT'); return { requestId, code, expiresAt };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function cancelAdminIdentityLink(requestId) { getDb().prepare('DELETE FROM admin_identity_links WHERE id = ?').run(requestId); }
export function verifyAdminIdentityLink(a, requestId, code, sessionToken) {
  const db = getDb(); db.exec('BEGIN IMMEDIATE');
  try {
    const row = typeof requestId === 'string' && /^[A-Za-z0-9_-]{32}$/.test(requestId)
      ? db.prepare('SELECT * FROM admin_identity_links WHERE id = ?').get(requestId) : null;
    const current = adminAccount(a.id);
    if (!row || !current?.enabled || current.userId || current.authVersion !== a.authVersion || row.account_id !== a.id || row.auth_version !== a.authVersion || row.session_digest !== digest(sessionToken) || row.expires_ms <= Date.now() || row.attempts >= 5 || !dashboardUser(row.user_id)?.isAdmin) throw new Error('Verification request expired or is no longer valid.');
    const given = digest(`${requestId}\0${String(code)}`);
    if (typeof code !== 'string' || !/^\d{8}$/.test(code) || !crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(row.code_digest, 'hex'))) {
      db.prepare('UPDATE admin_identity_links SET attempts = attempts + 1 WHERE id = ?').run(requestId);
      db.prepare('DELETE FROM admin_identity_links WHERE id = ? AND attempts >= 5').run(requestId);
      db.exec('COMMIT'); throw new Error('The verification code is incorrect.');
    }
    const target = adminAccountForUser(row.user_id);
    if (target && target.id !== a.id) {
      if (adminPasskeys(target.id).length) throw new Error('This user already has linked passkeys.');
      // Only an empty invite container can be displaced; credential bytes are never reassigned.
      db.prepare('DELETE FROM admin_accounts WHERE id = ?').run(target.id);
    }
    db.prepare('UPDATE admin_accounts SET user_id = ?, auth_version = auth_version + 1 WHERE id = ?').run(row.user_id, a.id);
    db.prepare('DELETE FROM admin_identity_links WHERE account_id = ? OR user_id = ?').run(a.id, row.user_id);
    db.prepare('DELETE FROM admin_enrollment_tokens WHERE account_id = ?').run(a.id);
    db.exec('COMMIT'); return adminAccount(a.id);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* wrong code already committed its attempt count */ }
    throw error;
  }
}

export function getIdentityLinkState(requestId) { return getDb().prepare('SELECT id FROM admin_identity_links WHERE id = ? AND expires_ms > ?').get(requestId, Date.now()) || null; }
