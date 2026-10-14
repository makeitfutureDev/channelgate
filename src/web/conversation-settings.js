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
  res.set({ 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
}
function unavailable(res, status) {
  return res.status(status).type('html').send('<!doctype html><html><head><meta charset="utf-8"><title>Private settings</title></head><body><h1>Private settings unavailable</h1><p>Open a new private settings link from your conversation.</p></body></html>');
}

const input = (name, title, password = false) => `<label>${escapeHtml(title)} <input name="${name}" type="${password ? 'password' : 'text'}" autocomplete="${password ? 'new-password' : 'off'}" maxlength="8000" value=""></label><br>`;
function form(session, action, body, label = 'Save') {
  return `<form method="post"><input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}"><input type="hidden" name="action" value="${action}">${body}<button type="submit">${escapeHtml(label)}</button></form>`;
}
async function page(session, ctx) {
  const scopes = ['channel', 'personal', ...(ctx.userIsAdmin ? ['organization'] : [])];
  const rows = [
    ...listChannelEnv(ctx.meta).map(row => ({ ...row, scope: 'channel' })),
    ...(await listUserEnv(ctx.ownerId)).map(row => ({ ...row, scope: 'personal' })),
    ...(ctx.userIsAdmin ? listOrgEnv().map(row => ({ ...row, scope: 'organization' })) : []),
  ];
  const variableList = rows.map(row => `<li>${escapeHtml(row.scope)} · ${escapeHtml(row.name)} · ${row.protected ? 'Hidden' : 'Readable'}${row.hosts.length ? ` · Used on: ${escapeHtml(row.hosts.join(', '))}` : ''}${form(session, 'settings.variable.remove', `<input type="hidden" name="variableScope" value="${row.scope}"><input type="hidden" name="name" value="${escapeHtml(row.name)}">`, 'Remove')}</li>`).join('');
  const personal = await getUser(ctx.ownerId);
  const status = value => value ? 'Configured' : 'Not configured';
  const connections = `<h2>Channel connections</h2><p>Composio: ${status(ctx.meta.composioToken)} · Toolbox: ${status(ctx.meta.toolboxToken)} · Make MCP: ${status(ctx.meta.makeToolboxUrl && ctx.meta.makeToolboxKey)}</p>`
    + form(session, 'settings.connections.save', input('composioToken', 'New Composio token', true) + input('composioTokenLabel', 'New account label') + input('toolboxToken', 'New Toolbox token', true) + input('makeToolboxUrl', 'Make MCP server URL') + input('makeToolboxKey', 'New Make MCP token', true))
    + ['composio', 'toolbox', 'make'].map(connection => form(session, 'settings.connections.remove', `<input type="hidden" name="connection" value="${connection}">`, `Disconnect channel ${connection}`)).join('')
    + `<h2>My connections</h2><p>Composio: ${status(personal?.composioToken)} · Toolbox: ${status(personal?.toolboxToken)}</p>`
    + form(session, 'settings.personal.save', input('personalComposioToken', 'New personal Composio token', true) + input('personalToolboxToken', 'New personal Toolbox token', true))
    + ['composio', 'toolbox'].map(connection => form(session, 'settings.personal.remove', `<input type="hidden" name="connection" value="${connection}">`, `Disconnect my ${connection}`)).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Private conversation settings</title></head><body><main><h1>Private settings · ${escapeHtml(ctx.entry.slug)}</h1><p>Values stay hidden. Leave token fields blank to keep their stored values.</p>${session.notice ? `<p role="status">${escapeHtml(session.notice)}</p>` : ''}<h2>Variables</h2><ul>${variableList}</ul>${form(session, 'settings.variable.save', `<label>Scope <select name="variableScope">${scopes.map(scope => `<option value="${scope}">${scope}</option>`).join('')}</select></label><br>` + input('variableName', 'Name') + input('variableValue', 'New value', true) + '<label>Used on hosts <select name="variableHostsMode"><option value="preserve">Keep existing rule</option><option value="replace">Replace rule with hosts below</option><option value="clear">Clear declared rule</option></select></label><br>' + input('variableHosts', 'HTTPS hostnames, comma-separated'))}${connections}<p>This window expires after 30 minutes. Close it when finished.</p></main></body></html>`;
}

const ALLOWED_ACTIONS = new Set(['settings.variable.save', 'settings.variable.remove', 'settings.connections.save', 'settings.connections.remove', 'settings.personal.save', 'settings.personal.remove']);
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
    try { return res.type('html').send(await page(session, await contextFor(session))); }
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
      const submitted = Object.entries(req.body || {}).filter(([key]) => !['csrf', 'action', 'variableScope', 'variableHostsMode', 'connection'].includes(key))
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
