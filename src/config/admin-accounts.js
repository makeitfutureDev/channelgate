// Local dashboard identities. Chat users never acquire dashboard access implicitly.
import crypto from 'node:crypto';
import { getDb, metaGet, metaSet } from '../db/index.js';

export function normalizeAdminUsername(value) {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9._@-]{0,79}$/.test(name)) throw new Error('Use 1–80 letters, numbers, dots, underscores, @ or hyphens for the username.');
  return name;
}
function account(row) {
  return row ? { id: row.id, username: row.username, displayName: row.display_name, userHandle: row.user_handle,
    enabled: Boolean(row.enabled), authVersion: row.auth_version, bootstrapAllowed: Boolean(row.bootstrap_allowed), createdAt: row.created_ms } : null;
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
export function adminPasskeys(accountId) {
  return getDb().prepare('SELECT * FROM admin_passkeys WHERE account_id = ? ORDER BY created_ms').all(accountId).map(row => ({
    id: row.id, accountId: row.account_id, publicKey: new Uint8Array(row.public_key), counter: row.counter,
    transports: JSON.parse(row.transports), deviceType: row.device_type, backedUp: Boolean(row.backed_up), name: row.name,
    createdAt: row.created_ms, lastUsedAt: row.last_used_ms,
  }));
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
export function revokeAdminSessions(id) { getDb().prepare('UPDATE admin_accounts SET auth_version = auth_version + 1 WHERE id = ?').run(id); }
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
    WHERE id = ? AND account_id = ? AND counter = ? AND EXISTS (SELECT 1 FROM admin_accounts a WHERE a.id = ? AND a.enabled = 1 AND a.auth_version = ?)`).run(info.newCounter, Date.now(), info.credentialDeviceType, info.credentialBackedUp ? 1 : 0, key.id, a.id, key.counter, a.id, a.authVersion);
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
