import { getDb } from '../../db/index.js';
import { createHash } from 'node:crypto';
import { isConversationId, validateServiceUrl } from './api.js';

const keyFor = (botId, conversationId) => `teams_service_url:${createHash('sha256').update(JSON.stringify([botId, conversationId])).digest('hex')}`;

export function rememberTeamsServiceUrl(botId, conversationId, raw) {
  const url = validateServiceUrl(raw);
  if (!isConversationId(conversationId) || !url) throw new Error('Invalid Teams conversation or service URL');
  getDb().prepare('INSERT INTO _meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(keyFor(botId, conversationId), url);
  return url;
}

export function teamsServiceUrl(botId, conversationId) {
  if (!isConversationId(conversationId)) return '';
  return validateServiceUrl(getDb().prepare('SELECT value FROM _meta WHERE key = ?').get(keyFor(botId, conversationId))?.value);
}
