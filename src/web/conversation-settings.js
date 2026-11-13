// Private credential entry for chat surfaces without masked, private native inputs. A one-use
// bearer link becomes a short-lived browser cookie; authority never comes from submitted fields.
import crypto from 'node:crypto';
import express from 'express';
import { timingSafeEqualStr } from './security.js';
import { requirePlatform } from '../platforms/registry.js';
import { platformOfConversation } from '../platforms/ids.js';
import { createTeamsSettingsContext } from '../platforms/msteams/settings.js';
import { handleCatalogAction } from '../platforms/msteams/settings-catalog.js';
import { listChannelEnv } from '../config/channel-env.js';
import { listUserEnv, listOrgEnv } from '../config/scoped-env.js';
import { getUser } from '../config/store.js';
import { listEmailAccounts } from '../gateway/email-accounts.js';
import { listUserEmailAccounts } from '../gateway/email-account-store.js';

export const CONVERSATION_SETTINGS_GRANT_TTL_MS = 10 * 60_000;
export const CONVERSATION_SETTINGS_SESSION_TTL_MS = 30 * 60_000;
const grants = new Map(), sessions = new Map();
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const hash = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function prune(now = Date.now()) {
  for (const map of [grants, sessions]) for (const [key, value] of map) if (value.expiresAt <= now) map.delete(key);
}
function cap(map, maximum) { while (map.size >= maximum) map.delete(map.keys().next().value); }
export function resetConversationSettingsStateForTests() { grants.clear(); sessions.clear(); }

export function createConversationSettingsGrantUrl({ baseUrl, channelId, slug, ownerId, threadTs = '', tab = 'secrets', now = Date.now() } = {}) {
  let base;
  try { base = new URL(String(baseUrl || '')); } catch { return ''; }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || !channelId || !slug || !ownerId || !['secrets', 'mcp'].includes(tab)) return '';
  prune(now); cap(grants, 2000);
  const secret = token();
  grants.set(hash(secret), { channelId: String(channelId), slug: String(slug), ownerId: String(ownerId), threadTs: String(threadTs), tab, origin: base.origin, expiresAt: now + CONVERSATION_SETTINGS_GRANT_TTL_MS });
  base.search = ''; base.hash = '';
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/conversation-settings/open/${secret}`;
  return base.toString();
}

const cookieName = id => `cg_conversation_settings_${id}`;
function sessionFor(req) {
  prune();
  const session = sessions.get(req.params.id);
  const pair = String(req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName(req.params.id)}=`));
  const secret = pair?.slice(pair.indexOf('=') + 1);
  return session && secret && timingSafeEqualStr(hash(secret), session.cookieHash) ? session : null;
}
function trustedOrigin(req, grant) {
  const expected = new URL(grant.origin);
  if (String(req.headers.host || '').toLowerCase() !== expected.host.toLowerCase()) return false;
  const origin = req.headers.origin;
  return !origin || origin === expected.origin;
}
function headers(res) {
  // No script at all and one nonce'd stylesheet: the page stays a plain credential form.
  const nonce = token(16);
  res.locals.styleNonce = nonce;
  res.set({ 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` });
}

const STYLE = `:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--line:#e2ded6;--text:#1f1e1c;--muted:#6b675f;--field:#fff;--accent:#087a5b;--accent-text:#fff;--soft:#f1efea;--ok-bg:#e7f5ef;--ok:#0a6b50;--warn-bg:#fdf0ee;--warn:#a52a22;--info-bg:#eaf0fb;--info:#2a4f9c}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--card:#1f1f1c;--line:#35332e;--text:#eeece7;--muted:#a19c92;--field:#161614;--accent:#2fae87;--accent-text:#06231a;--soft:#2a2925;--ok-bg:#153328;--ok:#7fdcb9;--warn-bg:#3a1c19;--warn:#f2a199;--info-bg:#1c2942;--info:#a9c1f5}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 20px 56px}
header{margin-bottom:20px}
h1{margin:0 0 4px;font-size:24px;letter-spacing:-.01em}
h2{margin:0;font-size:17px}
p{margin:0}
.sub,.lead,small,.meta,.empty{color:var(--muted)}
.sub{font-size:14px}.lead{margin-top:4px;font-size:13px}
.slug{font:600 13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--soft);border:1px solid var(--line);border-radius:6px;padding:2px 8px;vertical-align:middle}
.notice{margin:0 0 16px;padding:12px 14px;border-radius:10px;background:var(--ok-bg);color:var(--ok);font-weight:600}
.notice.bad{background:var(--warn-bg);color:var(--warn)}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-bottom:16px}
ul{list-style:none;margin:14px 0 0;padding:0;border:1px solid var(--line);border-radius:10px}
.row{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:11px 14px}
.row+.row{border-top:1px solid var(--line)}
.row-main{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center;min-width:0}
.row-main code{font:600 13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
.meta{flex-basis:100%;font-size:13px;word-break:break-word}
.empty{padding:14px;font-size:14px}
.badge,.chip{display:inline-block;font-size:12px;line-height:1;padding:4px 8px;border-radius:999px;white-space:nowrap}
.badge{font-weight:600;background:var(--soft);color:var(--muted)}
.badge.on{background:var(--ok-bg);color:var(--ok)}
.badge.scope{background:var(--info-bg);color:var(--info)}
.chip{border:1px solid var(--line);border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;margin:2px 2px 0 0}
details{margin-top:14px;border:1px solid var(--line);border-radius:10px}
summary{cursor:pointer;padding:11px 14px;font-weight:600}
details[open] summary{border-bottom:1px solid var(--line)}
details form{padding:16px 14px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 14px}
.field{display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:600;min-width:0}
.field.wide,fieldset{grid-column:1/-1}
.field small{font-weight:400}
fieldset{border:0;margin:0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:12px 14px}
legend{padding:0;margin:4px 0 8px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
input,select{width:100%;font:inherit;font-weight:400;color:var(--text);background:var(--field);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
input:focus,select:focus,button:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.actions{margin-top:14px}
button{appearance:none;font:inherit;font-weight:600;border:1px solid transparent;border-radius:8px;padding:8px 16px;cursor:pointer;background:var(--accent);color:var(--accent-text)}
.inline{flex:none}
.inline button{background:transparent;border-color:var(--line);color:var(--warn);font-size:13px;padding:5px 11px}
.inline button:hover{background:var(--warn-bg)}
footer{margin-top:20px;font-size:13px;color:var(--muted);text-align:center}
@media (max-width:560px){.grid,fieldset{grid-template-columns:1fr}section{padding:16px}}`;
function shell(res, title, body) {
  const nonce = res.locals?.styleNonce;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${nonce ? `<style nonce="${nonce}">${STYLE}</style>` : ''}</head><body><main>${body}</main></body></html>`;
}
function unavailable(res, status) {
  return res.status(status).type('html').send(shell(res, 'Private settings', '<section><h1>Private settings unavailable</h1><p class="sub">Open a new private settings link from your conversation.</p></section>'));
}

const SCOPE_LABEL = { channel: 'This conversation', personal: 'Only me', organization: 'Organization' };
const scopeBadge = scope => `<span class="badge scope">${SCOPE_LABEL[scope]}</span>`;
const scopeSelect = (name, title, scopes) => `<label class="field"><span>${title}</span><select name="${name}">${scopes.map(scope => `<option value="${scope}">${SCOPE_LABEL[scope]}</option>`).join('')}</select></label>`;
const input = (name, title, { password = false, hint = '', placeholder = '', wide = false } = {}) => `<label class="field${wide ? ' wide' : ''}"><span>${escapeHtml(title)}</span><input name="${name}" type="${password ? 'password' : 'text'}" autocomplete="${password ? 'new-password' : 'off'}" maxlength="8000" value=""${placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : ''}>${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</label>`;
function form(session, action, body, label = 'Save') {
  return `<form method="post"><input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}"><input type="hidden" name="action" value="${action}"><div class="grid">${body}</div><div class="actions"><button type="submit">${escapeHtml(label)}</button></div></form>`;
}
// A one-button form at the end of a list row (remove, disconnect).
function rowAction(session, action, hidden, label) {
  return `<form method="post" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}"><input type="hidden" name="action" value="${action}">${hidden}<button type="submit">${escapeHtml(label)}</button></form>`;
}
const list = (items, empty) => `<ul>${items.join('') || `<li class="empty">${empty}</li>`}</ul>`;
const fold = (title, body, open = false) => `<details${open ? ' open' : ''}><summary>${title}</summary>${body}</details>`;
async function page(session, ctx) {
  const scopes = ['channel', 'personal', ...(ctx.userIsAdmin ? ['organization'] : [])];
  const rows = [
    ...listChannelEnv(ctx.meta).map(row => ({ ...row, scope: 'channel' })),
    ...(await listUserEnv(ctx.ownerId)).map(row => ({ ...row, scope: 'personal' })),
    ...(ctx.userIsAdmin ? listOrgEnv().map(row => ({ ...row, scope: 'organization' })) : []),
  ];
  const variableList = rows.map(row => `<li class="row"><div class="row-main"><code>${escapeHtml(row.name)}</code>${scopeBadge(row.scope)}<span class="badge${row.protected ? ' on' : ''}">${row.protected ? 'Hidden' : 'Readable'}</span>${row.hosts.length ? `<div class="meta">Used on ${row.hosts.map(host => `<span class="chip">${escapeHtml(host)}</span>`).join('')}</div>` : ''}</div>${rowAction(session, 'settings.variable.remove', `<input type="hidden" name="variableScope" value="${row.scope}"><input type="hidden" name="name" value="${escapeHtml(row.name)}">`, 'Remove')}</li>`);
  const variables = `<section><h2>Variables</h2><p class="lead">Secrets and settings the agent can use in this conversation. Stored values are never shown.</p>${list(variableList, 'No variables yet.')}`
    + fold('Add or update a variable', form(session, 'settings.variable.save', input('variableName', 'Name', { placeholder: 'MY_API_KEY' }) + scopeSelect('variableScope', 'Available to', scopes)
      + input('variableValue', 'Value', { password: true, wide: true, hint: 'Saving an existing name replaces its value.' })
      + '<label class="field"><span>Used on hosts</span><select name="variableHostsMode"><option value="preserve">Keep existing rule</option><option value="replace">Replace rule with hosts below</option><option value="clear">Clear declared rule</option></select></label>'
      + input('variableHosts', 'HTTPS hostnames', { placeholder: 'api.example.com, *.example.org', hint: 'Comma-separated. Used only with “Replace rule”.' }), 'Save variable'), true) + '</section>';
  const personal = await getUser(ctx.ownerId);
  const connection = (label, configured, action, key) => `<li class="row"><div class="row-main"><strong>${label}</strong><span class="badge${configured ? ' on' : ''}">${configured ? 'Configured' : 'Not configured'}</span></div>${configured ? rowAction(session, action, `<input type="hidden" name="connection" value="${key}">`, 'Disconnect') : ''}</li>`;
  const connections = `<section><h2>Channel connections</h2><p class="lead">Shared by everyone in this conversation. Leave a field blank to keep what is stored.</p>`
    + list([connection('Composio', ctx.meta.composioToken, 'settings.connections.remove', 'composio'), connection('Toolbox', ctx.meta.toolboxToken, 'settings.connections.remove', 'toolbox'), connection('Make MCP', ctx.meta.makeToolboxUrl && ctx.meta.makeToolboxKey, 'settings.connections.remove', 'make')])
    + fold('Set or rotate channel tokens', form(session, 'settings.connections.save', input('composioToken', 'Composio token', { password: true }) + input('composioTokenLabel', 'Composio account label') + input('toolboxToken', 'Toolbox token', { password: true, wide: true }) + input('makeToolboxUrl', 'Make MCP server URL') + input('makeToolboxKey', 'Make MCP token', { password: true }), 'Save connections'))
    + `</section><section><h2>My connections</h2><p class="lead">Used only for your own requests. Leave a field blank to keep what is stored.</p>`
    + list([connection('Composio', personal?.composioToken, 'settings.personal.remove', 'composio'), connection('Toolbox', personal?.toolboxToken, 'settings.personal.remove', 'toolbox')])
    + fold('Set or rotate my tokens', form(session, 'settings.personal.save', input('personalComposioToken', 'Personal Composio token', { password: true }) + input('personalToolboxToken', 'Personal Toolbox token', { password: true }), 'Save my connections')) + '</section>';
  // Email accounts: masked rows only (the list shape carries no password) and inputs that are
  // never prefilled, so no mailbox password is ever part of a rendered attribute.
  const accounts = [
    ...listEmailAccounts(ctx.meta.emailAccounts, 'channel').map(account => ({ ...account, formScope: 'channel' })),
    ...(await listUserEmailAccounts(ctx.ownerId)).map(account => ({ ...account, formScope: 'personal' })),
  ];
  const accountList = accounts.map(account => `<li class="row"><div class="row-main"><strong>${escapeHtml(account.name)}</strong>${scopeBadge(account.formScope)}<div class="meta">${escapeHtml(account.address)} · IMAP ${escapeHtml(`${account.imap.host}:${account.imap.port}`)} · SMTP ${escapeHtml(`${account.smtp.host}:${account.smtp.port}`)}</div></div>${rowAction(session, 'settings.email.remove', `<input type="hidden" name="emailScope" value="${account.formScope}"><input type="hidden" name="name" value="${escapeHtml(account.name)}">`, 'Remove')}</li>`);
  const emailAccounts = `<section><h2>Email accounts</h2><p class="lead">Connect a mailbox by its IMAP and SMTP settings; both logins are tested before anything is saved. Leave passwords blank to keep the stored ones when editing; blank SMTP user/password = same as IMAP.</p>${list(accountList, 'No email account connected.')}`
    + fold('Add or update an email account', form(session, 'settings.email.save', input('name', 'Account name', { placeholder: 'work, support' }) + scopeSelect('emailScope', 'Belongs to', ['channel', 'personal'])
      + input('address', 'Email address') + input('displayName', 'Display name (optional)')
      + '<fieldset><legend>Incoming · IMAP</legend>' + input('imapHost', 'Server') + input('imapPort', 'Port', { placeholder: '993' }) + input('imapUser', 'User') + input('imapPassword', 'Password', { password: true }) + '</fieldset>'
      + '<fieldset><legend>Outgoing · SMTP</legend>' + input('smtpHost', 'Server') + input('smtpPort', 'Port', { placeholder: '587' }) + input('smtpUser', 'User', { placeholder: 'Same as IMAP' }) + input('smtpPassword', 'Password', { password: true, placeholder: 'Same as IMAP' }) + '</fieldset>', 'Save email account')) + '</section>';
  const notice = session.notice ? `<p role="status" class="notice${session.notice.startsWith('Not saved') ? ' bad' : ''}">${escapeHtml(session.notice)}</p>` : '';
  return `<header><h1>Private settings <span class="slug">${escapeHtml(ctx.entry.slug)}</span></h1><p class="sub">Values stay hidden. Leave token fields blank to keep their stored values.</p></header>${notice}${variables}${connections}${emailAccounts}<footer>This window expires after 30 minutes. Close it when finished.</footer>`;
}

const ALLOWED_ACTIONS = new Set(['settings.variable.save', 'settings.variable.remove', 'settings.connections.save', 'settings.connections.remove', 'settings.personal.save', 'settings.personal.remove', 'settings.email.save', 'settings.email.remove']);
export function createConversationSettingsRouter({ authorize, connector } = {}) {
  const router = express.Router();
  router.use((_req, res, next) => { headers(res); next(); });
  router.use(express.urlencoded({ extended: false, limit: '40kb', parameterLimit: 30 }));
  const workspace = authorize || (grant => {
    const adapter = requirePlatform(platformOfConversation(grant.channelId));
    if (!adapter.workspaceAccess) throw new Error('Private settings unavailable.');
    return adapter.workspaceAccess(grant);
  });
  const checkedWorkspace = async grant => {
    const fresh = await workspace(grant, { connector });
    if (!fresh || fresh.entry?.slug !== grant.slug || (fresh.entry.id && fresh.entry.id !== grant.channelId) || (fresh.entry.channelId && fresh.entry.channelId !== grant.channelId)
      || (fresh.userId || fresh.ownerId) !== grant.ownerId || (fresh.channelId && fresh.channelId !== grant.channelId) || (fresh.meta?.channelId && fresh.meta.channelId !== grant.channelId)) throw new Error('Private settings expired.');
    return fresh;
  };
  const contextFor = async session => {
    const fresh = await checkedWorkspace(session.grant);
    const state = { message: { userId: session.grant.ownerId, conversationId: session.grant.channelId }, entry: fresh.entry, meta: fresh.meta,
      sharedSettings: false, publicCredentials: false, tab: session.grant.tab, sessionKey: `${session.grant.channelId}:${session.grant.threadTs}` };
    const ctx = createTeamsSettingsContext(state, { connector, authorize: checkedWorkspace, source: 'googlechat_settings' });
    await ctx.authorize();
    return ctx;
  };
  router.get('/open/:token', async (req, res) => {
    prune();
    const key = hash(req.params.token), grant = grants.get(key);
    // Only a request to the original gateway origin may consume the link.
    if (grant && !trustedOrigin(req, grant)) return unavailable(res, 403);
    grants.delete(key);
    if (!grant) return unavailable(res, 410);
    try {
      await contextFor({ grant });
      const id = token(12), secret = token();
      cap(sessions, 1000);
      sessions.set(id, { grant, cookieHash: hash(secret), csrf: token(), expiresAt: Date.now() + CONVERSATION_SETTINGS_SESSION_TTL_MS });
      const secure = new URL(grant.origin).protocol === 'https:' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `${cookieName(id)}=${secret}; HttpOnly; SameSite=Lax; Path=/conversation-settings/${id}; Max-Age=${CONVERSATION_SETTINGS_SESSION_TTL_MS / 1000}${secure}`);
      return res.redirect(303, `/conversation-settings/${id}`);
    } catch { return unavailable(res, 403); }
  });
  router.get('/:id', async (req, res) => {
    const session = sessionFor(req);
    if (!session) return unavailable(res, 401);
    if (!trustedOrigin(req, session.grant)) return unavailable(res, 403);
    try { return res.type('html').send(shell(res, 'Private conversation settings', await page(session, await contextFor(session)))); }
    catch { return unavailable(res, 403); }
  });
  router.post('/:id', async (req, res) => {
    const session = sessionFor(req);
    if (!session) return unavailable(res, 401);
    if (!trustedOrigin(req, session.grant) || typeof req.body?.csrf !== 'string' || !timingSafeEqualStr(req.body.csrf, session.csrf)) return unavailable(res, 403);
    const action = req.body?.action;
    if (!ALLOWED_ACTIONS.has(action)) return unavailable(res, 400);
    let ctx;
    try { ctx = await contextFor(session); } catch { return unavailable(res, 403); }
    try {
      // Existing server URLs/labels never become browser defaults. Empty fields preserve them,
      // allowing rotation of one token while a configured Make connection stays intact.
      const data = action === 'settings.connections.save' ? { ...req.body,
        makeToolboxUrl: req.body.makeToolboxUrl?.trim() || ctx.meta.makeToolboxUrl || '',
        composioTokenLabel: req.body.composioTokenLabel?.trim() || ctx.meta.composioTokenLabel || '',
      } : req.body;
      await handleCatalogAction(action, data, ctx, {});
      session.notice = 'Saved. Credential values remain hidden.';
      return res.redirect(303, `/conversation-settings/${req.params.id}`);
    } catch (error) {
      // A refused save keeps the still-authorized session. Policy messages name rules, never
      // values; a message that echoes any submitted field is replaced rather than reflected.
      const message = String(error?.message || '');
      // Mail server hosts and ports are routing data, not secrets: a login failure must be allowed
      // to name the server it could not reach, or every refused mailbox would read the same.
      const submitted = Object.entries(req.body || {}).filter(([key]) => !['csrf', 'action', 'variableScope', 'variableHostsMode', 'connection', 'emailScope', 'imapHost', 'imapPort', 'smtpHost', 'smtpPort'].includes(key))
        .map(([, value]) => String(value ?? '').trim()).filter(value => value.length >= 3);
      const safe = message && message.length <= 300 && !/[\r\n]/.test(message) && !error?.code && !error?.status
        && !submitted.some(value => message.includes(value));
      session.notice = `Not saved. ${safe ? message : 'Check the name, scope and your permissions, then try again.'} No value was stored.`;
      return res.redirect(303, `/conversation-settings/${req.params.id}`);
    }
  });
  // Never send parser diagnostics or reflected request values back to a credential form.
  router.use((_error, _req, res, _next) => unavailable(res, 400));
  return router;
}
