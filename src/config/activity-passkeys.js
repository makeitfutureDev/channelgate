// Durable Activity-only identities. Admission still comes from the live Users directory.
import crypto from 'node:crypto';
import { getDb } from '../db/index.js';

export function activityAccount({ ownerId, teamId, origin }, create = false) {
  const db = getDb();
  if (create) db.prepare('INSERT OR IGNORE INTO activity_accounts(id,owner_id,team_id,origin) VALUES(?,?,?,?)')
    .run(crypto.randomBytes(32).toString('base64url'), ownerId, teamId, origin);
  return db.prepare('SELECT * FROM activity_accounts WHERE owner_id=? AND team_id=? AND origin=?').get(ownerId, teamId, origin);
}
export function activityPasskeys(accountId) {
  if (!accountId) return [];
  return getDb().prepare('SELECT id,name,created_ms,last_used_ms,transports FROM activity_passkeys WHERE account_id=? ORDER BY created_ms').all(accountId)
    .map(row => ({ id: row.id, name: row.name, createdAt: row.created_ms, lastUsedAt: row.last_used_ms, transports: JSON.parse(row.transports) }));
}
export function activityPasskey(id) {
  if (typeof id !== 'string' || id.length > 2048) return null;
  const row = getDb().prepare(`SELECT p.*,a.owner_id,a.team_id,a.origin FROM activity_passkeys p
    JOIN activity_accounts a ON a.id=p.account_id WHERE p.id=?`).get(id);
  return row ? { ...row, publicKey: new Uint8Array(row.public_key), transports: JSON.parse(row.transports) } : null;
}
export function saveActivityPasskey(accountId, credential, name, now) {
  // A single statement makes the cap apply even across concurrent registration responses.
  const result = getDb().prepare(`INSERT INTO activity_passkeys(id,account_id,public_key,counter,transports,name,created_ms)
    SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM activity_passkeys WHERE account_id=?)<10`)
    .run(credential.id, accountId, Buffer.from(credential.publicKey), credential.counter, JSON.stringify(credential.transports || []),
      (typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '') || 'My passkey', now, accountId);
  if (!result.changes) throw new Error('Passkey limit reached');
}
export function advanceActivityPasskey(key, counter, now) {
  return Boolean(getDb().prepare('UPDATE activity_passkeys SET counter=?,last_used_ms=? WHERE id=? AND account_id=? AND counter=?')
    .run(counter, now, key.id, key.account_id, key.counter).changes);
}
export function removeActivityPasskey(accountId, id) {
  return Boolean(getDb().prepare('DELETE FROM activity_passkeys WHERE account_id=? AND id=?').run(accountId, id).changes);
}
