// Old reply buttons survive restarts. Google's source envelope and the seal both bind the space.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getDb, metaGet } from '../../db/index.js';
import { chatAction, chatButtons, chatCard, chatText } from './cards.js';

const KINDS = ['files', 'secrets', 'settings', 'file'];
const KEY = 'googlechat_reply_menu_key';
function seal(data) {
  getDb().prepare('INSERT OR IGNORE INTO _meta(key, value) VALUES(?, ?)').run(KEY, randomBytes(32).toString('base64'));
  return createHmac('sha256', Buffer.from(metaGet(KEY), 'base64')).update(JSON.stringify([data.k, data.c, data.t, data.u, data.p])).digest('base64url');
}
export function menuActionData({ kind, conversationId, sessionKey = '', authorId = '', relative = '' }) {
  if (!KINDS.includes(kind) || !conversationId) throw new Error('Menu requires a kind and conversation.');
  const data = { k: kind, c: String(conversationId), t: String(sessionKey), u: String(authorId), p: kind === 'file' ? String(relative) : '' };
  return { ...data, s: seal(data) };
}
export function verifyMenuAction(action, data = {}) {
  const kind = String(action).replace(/^menu\./, '');
  if (!KINDS.includes(kind) || data.k !== kind || ['c', 't', 'u', 'p', 's'].some(key => typeof data[key] !== 'string')) return null;
  const expected = Buffer.from(seal(data)), supplied = Buffer.from(data.s);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  return { kind, conversationId: data.c, sessionKey: data.t, authorId: data.u, relative: data.p };
}
export function replyMenuCard({ footer = '', menu = null } = {}) {
  const widgets = footer ? [chatText(footer)] : [];
  if (menu?.conversationId) {
    const base = { conversationId: menu.conversationId, sessionKey: menu.sessionKey, authorId: menu.authorId };
    const labels = { files: '📂 Files', secrets: '🔑 Variables', settings: '⚙️ Settings' };
    widgets.push(chatButtons(['files', 'secrets', 'settings'].map(kind => chatAction(labels[kind], `menu.${kind}`, '', menuActionData({ kind, ...base })))));
    for (const file of (menu.files || []).slice(0, 3)) widgets.push(chatButtons([chatAction(`📄 ${file.name}`, 'menu.file', '', menuActionData({ kind: 'file', ...base, relative: file.relative }))]));
  }
  return chatCard('ChannelGate', widgets);
}
