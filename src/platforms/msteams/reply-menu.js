// The Teams reply menu — 📂 Files · 🔑 Variables · ⚙️ Settings plus one 📄 button per workspace
// file the answer referenced — under the run-stats line, matching Slack's reply footer.
//
// Unlike the /files and /settings launchers, these buttons hold no server-side state: they must
// keep working on old replies and across restarts. Each button carries its conversation, session,
// requester and (for a file) workspace-relative path, sealed with an HMAC under a per-deployment
// key kept in the database. A click is honoured only in the conversation Teams itself reports for
// the invoke, only by the requester when the reply had one (an automation post is unbound, as in
// Slack), and every window it opens re-applies the clicker's own live workspace authorization.
// The seal stops a crafted invoke from naming another conversation, session or requester; a file
// path never widens access because it is confined to the workspace and the clicker can browse it.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getDb, metaGet } from '../../db/index.js';

export const MENU_KINDS = Object.freeze(['files', 'secrets', 'settings', 'file']);
export const MAX_MENU_FILE_BUTTONS = 3;
const KEY = 'teams_reply_menu_key';
const LABELS = { files: '📂 Files', secrets: '🔑 Variables', settings: '⚙️ Settings' };
let cachedKey = null;

function menuKey() {
  if (cachedKey) return cachedKey;
  // INSERT OR IGNORE then read back: two processes racing on first use agree on one key.
  getDb().prepare('INSERT OR IGNORE INTO _meta(key, value) VALUES(?, ?)').run(KEY, randomBytes(32).toString('base64'));
  cachedKey = Buffer.from(metaGet(KEY), 'base64');
  return cachedKey;
}

const fields = ({ k, c, t = '', u = '', p = '' }) => JSON.stringify([k, c, t, u, p]);
const seal = data => createHmac('sha256', menuKey()).update(fields(data)).digest('base64url');

export function menuActionData({ kind, conversationId, sessionKey = '', authorId = '', relative = '' }) {
  if (!MENU_KINDS.includes(kind) || !conversationId) throw new Error('A menu button needs a kind and conversation.');
  const data = { k: kind, c: String(conversationId), t: String(sessionKey || ''), u: String(authorId || ''), ...(kind === 'file' ? { p: String(relative) } : {}) };
  return { msteams: { type: 'task/fetch' }, cgAction: `menu.${kind}`, ...data, s: seal(data) };
}

// Returns the verified fields, or null for anything not produced by menuActionData.
export function verifyMenuAction(action, data = {}) {
  const kind = String(action || '').replace(/^menu\./, '');
  if (!MENU_KINDS.includes(kind) || data.k !== kind || typeof data.c !== 'string' || typeof data.s !== 'string') return null;
  const value = { k: kind, c: data.c, t: typeof data.t === 'string' ? data.t : '', u: typeof data.u === 'string' ? data.u : '', p: kind === 'file' && typeof data.p === 'string' ? data.p : '' };
  const expected = Buffer.from(seal(value)), actual = Buffer.from(data.s);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return { kind, conversationId: value.c, sessionKey: value.t, authorId: value.u, relative: value.p };
}

const button = (title, data) => ({ type: 'Action.Submit', title: String(title).slice(0, 80), associatedInputs: 'none', data });

// The answer stays in activity text so its Markdown and mention entities keep their normal
// rendering; only the footer needs native small type, which Markdown cannot produce.
// The card body is the stats line (when present) followed by the fixed menu and the file buttons.
export function replyMenuCard({ footer = '', menu = null } = {}) {
  const body = [{ type: 'Container', minHeight: '8px', items: [] }];
  if (footer) body.push({ type: 'TextBlock', text: String(footer), size: 'Small', isSubtle: true, wrap: true, spacing: 'None' });
  const actions = [];
  if (menu?.conversationId) {
    const base = { conversationId: menu.conversationId, sessionKey: menu.sessionKey, authorId: menu.authorId };
    for (const kind of ['files', 'secrets', 'settings']) actions.push(button(LABELS[kind], menuActionData({ kind, ...base })));
    for (const file of (menu.files || []).slice(0, MAX_MENU_FILE_BUTTONS)) {
      actions.push(button(`📄 ${file.name}`, menuActionData({ kind: 'file', ...base, relative: file.relative })));
    }
  }
  return { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body,
    ...(actions.length ? { actions } : {}) };
}
