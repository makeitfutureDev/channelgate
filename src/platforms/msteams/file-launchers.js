// Durable references for chat launchers only. Private dialog drafts and grant URLs stay in
// memory. Restoring a reference never bypasses current workspace/roster authorization.
import { getDb } from '../../db/index.js';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const RETENTION_MS = 24 * 60 * 60_000;

export function recordTeamsFileLauncher(id, botId, state, now = Date.now()) {
  const reference = {
    message: { conversationId: state.message.conversationId, rawConversationId: state.message.rawConversationId,
      userId: state.message.userId, threadKey: state.message.threadKey || '',
      raw: { tenantId: state.message.raw?.tenantId || '' } },
    entry: { slug: state.entry.slug }, sessionKey: state.sessionKey,
    deliveryId: state.deliveryId, relative: state.relative || '', selectedFile: Boolean(state.selectedFile),
    filesLauncher: true, inConversation: true, expires: state.expires,
  };
  const db = getDb();
  db.prepare('DELETE FROM teams_file_launchers WHERE expires_ms < ?').run(now - RETENTION_MS);
  db.prepare('INSERT INTO teams_file_launchers(id, bot_id, expires_ms, data) VALUES(?, ?, ?, ?)')
    .run(id, String(botId || ''), state.expires, JSON.stringify(reference));
}

export function inspectTeamsFileLauncher(id, botId, now = Date.now()) {
  if (typeof id !== 'string' || !UUID.test(id)) return { reason: 'missing-reference' };
  const row = getDb().prepare('SELECT bot_id, expires_ms, data FROM teams_file_launchers WHERE id = ?').get(id);
  if (!row) return { reason: 'unknown' };
  if (row.bot_id !== String(botId || '')) return { reason: 'wrong-bot' };
  if (row.expires_ms < now) return { reason: 'expired' };
  return { state: JSON.parse(row.data) };
}

export function forgetTeamsFileLauncher(id) {
  getDb().prepare('DELETE FROM teams_file_launchers WHERE id = ?').run(id);
}
