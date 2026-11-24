import { incomingCalls, getIncomingCallList } from "../gateway/voice/incoming.ts";
// A private user dashboard: ten-minute Slack launch grant -> path-scoped browser session.
// Ordinary routes use Activity cookies only. The explicit admin shortcut can mint the owner's
// Activity session from a verified, linked administrator browser session; API keys never qualify.
import crypto from "node:crypto";
import { channelGateLogo, normalizeLogoColor } from "../config/appearance.js";
import { activityIcon } from "./activity-icons.js";
import express from "express";
import { getPublicUrl, getLogoColor } from "../config/settings.js";
import { getChannelEntry, getUser, setUser } from "../config/store.js";
import { onConfigChange } from "../config/change-events.js";
import { getSlackThread, slackThreadRootOwner, isSlackThreadEligible, isSlackThreadParticipant, setSlackThreadHidden, setSlackThreadLater, setSlackThreadDone } from "../gateway/slack-threads.js";
import { onThreadChanged } from "../gateway/thread-changes.js";
import { onActiveRunsChanged } from "../gateway/active-runs.js";
import { syncThreadDoneMarker } from "../slack/thread-done-marker.js";
import { clearDone, markDone } from "../gateway/followups.js";
import { accessContext, activityChannelName, activityThreadSnapshot, discoverSlackThreadHistory, homeThreadsRefreshKey, markAllSlackThreadsDone } from "../slack/home-threads.js";
import { createHomeThreadReader } from "../slack/home-thread-reader.js";
import { isSlackTs } from "../slack/thread-keys.js";
import { isLoopbackHost, timingSafeEqualStr } from "./security.js";
import { readSubscriptionUsage } from "../gateway/subscription-usage.js";
import { activityPage } from "./activity-page.js";
import { activityGroupOrder, activityGroupOrderVersion, validActivityGroupOrder, ACTIVITY_THEMES, activityTheme, ACTIVITY_GROUPINGS, activityGrouping,
  activityColumns, validActivityColumnOrder, validActivityColumnWidths, validActivityColumnHidden, activityColumnDevice, activityComments, normalizeActivityComment, ACTIVITY_COMMENT_LIMIT } from "./activity-order.js";
import { activityAccessPage } from "./activity-access-page.js";
import { installActivityPasskeys } from "./activity-passkeys.js";
import { createActivitySessionStore, ACTIVITY_SESSION_TTL_MS, ACTIVITY_PASSKEY_SESSION_TTL_MS } from "./activity-sessions.js";
import { ACTIVITY_APP_ICONS, activityAppCookie, activityAppSessionId, activityManifest } from "./activity-app.js";
import { activityPasskey } from "../config/activity-passkeys.js";
import { adminAccount, adminPasskeyById } from "../config/admin-accounts.js";
import { adminSession } from "./auth.js";
import { applyUserSettingsChange, userSettingsSnapshot, UserSettingsError } from "../gateway/user-settings.js";
import { registerActivityConnectionRoutes } from "./activity-connections.js";
import { CALL_WORKLET_PATH, CALL_WORKLET_SOURCE } from "./call-overlay.js";
import { callManager as defaultCallManager } from "../gateway/voice/calls.js";
import { automationChannels, checkedChannel, channelAutomations, automationRuns, deleteAutomation, automationBoard, updateAutomation, runAutomationNow, acknowledgeAutomation, setAutomationRoi } from "../gateway/automations-view.js";
import { roiOverview, setSkillRoi, setDefaultRate } from "../gateway/roi-view.js";
import { PERSONAL_SKILLS_ID, channelSkillsView, personalSkillsView, saveSkillSelection, skillChannels } from "../gateway/skills-view.js";
import { listCallHistory, readCallHistory } from "../gateway/voice/history.js";
import { apiTokenChannels, apiTokenChannelView, createDashboardApiToken, revokeDashboardApiToken } from "../gateway/api-tokens-view.js";
import { ApiTokenError } from "../gateway/api-tokens.js";
import { voiceCallsAvailable } from "../config/settings.js";

import { platformOfConversation } from '../platforms/ids.js';
import { activityIdentityIds } from '../config/activity-identities.js';
import { platformActivityAccess, platformActivityThread, platformActivitySnapshot } from './activity-platforms.js';
import { listPlatformThreadsForUser, isPlatformThreadParticipant, setPlatformThreadHidden, setPlatformThreadDone, setPlatformThreadLater, platformThreadUrl } from '../gateway/platform-threads.js';

export const ACTIVITY_GRANT_TTL_MS = 10 * 60_000;
export { ACTIVITY_SESSION_TTL_MS, ACTIVITY_PASSKEY_SESSION_TTL_MS } from "./activity-sessions.js";
const grants = new Map();
// Sessions persist in SQLite (activity-sessions.js) so a gateway restart signs nobody out.
const sessions = createActivitySessionStore();
const streams = new Set();
let configVersion = 0;
onConfigChange(() => {
  configVersion++;
  for (const stream of streams) stream.changed();
});
const token = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
const hash = (value) => crypto.createHash("sha256").update(String(value || "")).digest("hex");
const cookieName = (id) => `cg_activity_${id}`;
const validToken = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
function baseFor(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || !["", "/"].includes(url.pathname) || url.search || url.hash) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) return null;
    return url;
  } catch { return null; }
}
function cap(map, max) { while (map.size >= max) map.delete(map.keys().next().value); }
function capOwner(map, ownerId, max) {
  const owned = [...map].filter(([, row]) => row.ownerId === ownerId);
  while (owned.length >= max) map.delete(owned.shift()[0]);
}
function prune(now) {
  for (const [key, row] of grants) if (row.expiresAt <= now) grants.delete(key);
  sessions.prune(now);
}

// A launch may carry ONE in-app destination, opened after the exchange: today the dashboard with
// the voice-call overlay bound to a conversation (and optionally its thread). Anything else is
// refused at mint time, so a grant can never redirect outside the session's own path.
export const ACTIVITY_NEXT_PATTERN = /^\?call=[A-Z0-9_]{1,32}(?:&thread=\d{1,13}\.\d{1,6})?$/;
export function activityCallPath(channelId, threadTs = "") {
  const path = `?call=${encodeURIComponent(String(channelId || ""))}${threadTs ? `&thread=${encodeURIComponent(String(threadTs))}` : ""}`;
  return ACTIVITY_NEXT_PATTERN.test(path) ? path : "";
}

/** @param {{baseUrl?: string, ownerId: string, teamId: string, now?: number, next?: string}} options */
export function createActivityGrantUrl({ baseUrl = getPublicUrl(), ownerId, teamId, now = Date.now(), next = "" } = {}) {
  const base = baseFor(baseUrl);
  if (!base || !ownerId || !teamId) return "";
  if (next && !ACTIVITY_NEXT_PATTERN.test(next)) return "";
  prune(now); capOwner(grants, String(ownerId), 20); cap(grants, 2000);
  const secret = token();
  grants.set(hash(secret), { ownerId: String(ownerId), teamId: String(teamId), origin: base.origin, expiresAt: now + ACTIVITY_GRANT_TTL_MS, ...(next ? { next } : {}) });
  // The fragment never travels in HTTP requests, proxy logs or Slack link-unfurl requests.
  return `${base.origin}/activity/open#${secret}`;
}

// `worklet` admits the call page's same-origin AudioWorklet module: a nonce cannot cover a
// worklet fetch, so that one page (and only it) also allows 'self' scripts.
function headers(res, nonce = "", { worklet = false } = {}) {
  res.set({ "Cache-Control": "no-store, max-age=0", Pragma: "no-cache", "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
    "Content-Security-Policy": `default-src 'none'; ${nonce ? `script-src 'nonce-${nonce}'${worklet ? " 'self'" : ""}; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data: https://logos.composio.dev https://assets.composio.dev; font-src 'self';` : ""} manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
}
// Outside /activity/ so installed Chrome opens a regular browser tab. This page
// grants nothing: the existing same-origin WebAuthn endpoints verify the passkey.
export function createActivityBrowserLoginHandler({ getBaseUrl = getPublicUrl } = {}) {
  return (req, res) => {
    headers(res);
    const base = baseFor(getBaseUrl());
    if (!base || String(req.headers.host || '').toLowerCase() !== base.host.toLowerCase()
      || (req.headers.origin && req.headers.origin !== base.origin)) return unavailable(res, 403);
    const page = activityAccessPage({ mode: 'browser-login' });
    headers(res, page.nonce);
    return res.type('html').send(page.html);
  };
}
function unavailable(res, status = 401) {
  return res.status(status).json({ error: "Activity is unavailable. Open a new dashboard link from Slack Activity." });
}

async function latestMessageTs(client, channelId, root) {
  if (root.latest_reply) {
    if (typeof root.latest_reply !== "string" || !isSlackTs(root.latest_reply) || Number(root.latest_reply) < Number(root.ts)) throw new Error("Invalid latest reply");
    return root.latest_reply;
  }
  if (!(root.reply_count > 0)) return root.ts;
  // latest_reply is optional in Slack's documented response. Only that fallback needs a
  // transcript walk; require complete pagination before claiming to have the newest reply.
  let latest = root.ts, cursor;
  const seen = new Set();
  do {
    const page = await client.conversations.replies({ channel: channelId, ts: root.ts, limit: 100, ...(cursor ? { cursor } : {}) });
    if (page?.ok === false || !Array.isArray(page?.messages) || !page.messages.length) throw new Error("Thread messages unavailable");
    for (const message of page.messages) {
      if (typeof message.ts !== "string" || !isSlackTs(message.ts) || (message.thread_ts && message.thread_ts !== root.ts)) throw new Error("Invalid thread message");
      if (Number(message.ts) > Number(latest)) latest = message.ts;
    }
    cursor = page.response_metadata?.next_cursor?.trim();
    if ((page.has_more && !cursor) || (cursor && seen.has(cursor))) throw new Error("Incomplete thread pagination");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return latest;
}
function launchPage() {
  return activityAccessPage({ mode: "open" });
}

export function resetActivityStateForTests() {
  for (const stream of streams) stream.end();
  streams.clear(); grants.clear(); sessions.clear();
}
// What a restart does to the router: the rows stay, the cache is gone.
export function forgetActivitySessionCacheForTests() {
  sessions.forgetCache();
}

// Dashboard timing: a Server-Timing header on every list response (visible in the browser's
// network panel) and one log line when a load is slow, so a slow deployment shows WHERE.
const SLOW_DASHBOARD_MS = 1000;
function timed(res, name, started, rows) {
  const ms = Math.round(performance.now() - started);
  res.set("Server-Timing", `${name};dur=${ms}`);
  if (ms >= SLOW_DASHBOARD_MS) console.warn(`[activity] slow ${name} load: ${ms} ms, ${rows ?? 0} rows`);
}

// The feed sends a window, not every thread a person ever had. Working/waiting threads,
// pinned threads and threads of pinned channels always come; the rest is grouped (open,
// completed, hidden), newest activity first, ACTIVITY_PAGE_SIZE per page. "Load more" raises a
// group's limit for this session; live pushes keep the same window. Counts cover everything.
export const ACTIVITY_PAGE_SIZE = 100;
const FEED_GROUPS = ["open", "done", "hidden"];
export const feedGroup = (row) => row.hidden ? "hidden" : row.status === "done" ? "done" : "open";
export function activityFeedWindow(all, limits = {}) {
  const lim = Object.fromEntries(FEED_GROUPS.map((g) => [g, Number.isSafeInteger(limits?.[g]) && limits[g] > 0 ? limits[g] : ACTIVITY_PAGE_SIZE]));
  const counts = { active: 0, open: 0, working: 0, waiting: 0, error: 0, idle: 0, later: 0, done: 0, hidden: 0 };
  const groups = { open: [], done: [], hidden: [] };
  for (const row of all) {
    if (row.hidden) counts.hidden++;
    else {
      if (Object.hasOwn(counts, row.status)) counts[row.status]++;
      if (row.status !== "done") counts.open++;
      if (row.status !== "later" && !(row.status === "done" && row.dismissed)) counts.active++;
    }
    groups[feedGroup(row)].push(row);
  }
  const always = (row) => !row.hidden && (row.status === "working" || row.status === "waiting" || row.pinned || row.channelPinned);
  const recent = (a, b) => (Number(b.lastMessageMs) || 0) - (Number(a.lastMessageMs) || 0);
  const completed = (a, b) => (Number(b.completedMs) || 0) - (Number(a.completedMs) || 0) || recent(a, b);
  const rows = [], more = {};
  for (const g of FEED_GROUPS) {
    const sorted = groups[g].sort(g === "done" ? completed : recent);
    let taken = 0;
    for (const row of sorted) {
      if (always(row)) rows.push(row);
      else if (taken < lim[g]) { rows.push(row); taken++; }
    }
    more[g] = sorted.filter((row) => !always(row)).length > lim[g];
  }
  return { rows, counts, more, limits: lim };
}

export function createActivityRouter({
  getClient, getTeamId, getBaseUrl = getPublicUrl, getBotIdentity = () => null,
  snapshot = activityThreadSnapshot, refreshKey = homeThreadsRefreshKey, readSubscriptions = readSubscriptionUsage,
  now = Date.now, pollMs = 1000, accessRefreshMs = 15_000, maxStreams = 100, drainTimeoutMs = 30_000,
  calls = /** @type {object | null} */ (null), voiceAvailable = voiceCallsAvailable, incoming = /** @type {ReturnType<typeof incomingCalls> | null} */ (null),
  connectionServices = {},
} = {}) {
  const callsFor = () => calls || defaultCallManager();
  const incomingFor = () => incoming || incomingCalls();
  if (!incoming) incomingFor().start();
  const linkedIds = new Map();
  const combinedRefreshKey = (ownerId) => JSON.stringify([refreshKey(ownerId), configVersion,
    ...(linkedIds.get(ownerId) || []).map(id => listPlatformThreadsForUser(id))]);
  if (typeof getClient !== "function" || typeof getTeamId !== "function") throw new Error("Activity requires its live Slack connection");
  const router = express.Router({ caseSensitive: true });
  const reader = createHomeThreadReader();
  router.use((req, res, next) => {
    // /activity itself is the existing administrator history page; it retains admin auth.
    if (req.path === "/") return next("router");
    headers(res);
    const base = baseFor(getBaseUrl());
    if (!base || String(req.headers.host || "").toLowerCase() !== base.host.toLowerCase()
      || (req.headers.origin && req.headers.origin !== base.origin)) return unavailable(res, 403);
    req.activityOrigin = base.origin;
    next();
  });
  // Settings carries a variable value (up to 16 KB) or an email account; everything else is tiny.
  const smallJson = express.json({ limit: "8kb" }), settingsJson = express.json({ limit: "48kb" });
  router.use((req, res, next) => (req.method === "POST" && /^\/[^/]+\/api\/(?:settings|automations\/[^/]+\/[^/]+\/update)$/.test(req.path) ? settingsJson : smallJson)(req, res, next));
  const authorize = async (session) => {
    if (!session || session.expiresAt <= now() || session.origin !== baseFor(getBaseUrl())?.origin) throw Object.assign(new Error("Activity expired"), { status: 401 });
    const user = await getUser(session.ownerId);
    if (!user || (!user.approved && !user.isAdmin) || session.teamId !== getTeamId()) throw Object.assign(new Error("Activity access ended"), { status: 403 });
    if (session.credentialId) {
      const key = activityPasskey(session.credentialId);
      if (!key || key.owner_id !== session.ownerId || key.team_id !== session.teamId || key.origin !== session.origin) throw Object.assign(new Error("Activity passkey removed"), { status: 401 });
    }
    if (session.adminAuth) {
      const account = adminAccount(session.adminAuth.accountId);
      const key = session.adminAuth.credentialId ? adminPasskeyById(session.adminAuth.credentialId) : null;
      if (!account?.enabled || !account.userId || account.userId !== session.ownerId || account.authVersion !== session.adminAuth.authVersion
        || (session.adminAuth.credentialId && key?.accountId !== account.id)) throw Object.assign(new Error("Administrator access changed"), { status: 401 });
    }
    const client = getClient();
    if (!client) throw Object.assign(new Error("Slack disconnected"), { status: 403 });
    return client;
  };
  const sessionFor = (req) => {
    const session = sessions.get(req.params.id);
    const pair = String(req.headers.cookie || "").split(";").map((s) => s.trim()).find((s) => s.startsWith(`${cookieName(req.params.id)}=`));
    const secret = pair?.slice(pair.indexOf("=") + 1);
    return session && validToken(secret) && timingSafeEqualStr(hash(secret), session.cookieHash) ? session : null;
  };
  const context = async (req) => {
    const session = sessionFor(req);
    if (!session || sessions.get(req.params.id) !== session) throw Object.assign(new Error("Activity session missing"), { status: 401 });
    return { session, client: await authorize(session) };
  };
  const issueSession = (res, identity, { redirect = false } = {}) => {
    const id = token(12), secret = token(); prune(now());
    sessions.capOwner(identity.ownerId, 10); sessions.capTotal(1000);
    // A passkey sign-in, or a hand-off from an admin dashboard session (itself earned by a passkey
    // or password plus Slack code), proved the person on this device: it lasts 30 days. A
    // Slack-link launch keeps the 12-hour life.
    const ttl = identity.credentialId || identity.adminAuth ? ACTIVITY_PASSKEY_SESSION_TTL_MS : ACTIVITY_SESSION_TTL_MS;
    const session = { ownerId: identity.ownerId, teamId: identity.teamId, origin: identity.origin,
      ...(identity.credentialId ? { credentialId: identity.credentialId } : {}),
      ...(identity.adminAuth ? { adminAuth: { ...identity.adminAuth } } : {}),
      cookieHash: hash(secret), csrf: token(), expiresAt: now() + ttl, createdAt: now() };
    sessions.set(id, session);
    const secure = new URL(identity.origin).protocol === "https:";
    res.append("Set-Cookie", `${cookieName(id)}=${secret}; HttpOnly; SameSite=Lax; Path=/activity/${id}; Max-Age=${ttl / 1000}${secure ? "; Secure" : ""}`);
    // The installed app's launcher resumes this session; it learns the id only, never the secret.
    res.append("Set-Cookie", activityAppCookie(id, { maxAgeSeconds: ttl / 1000, secure }));
    const next = ACTIVITY_NEXT_PATTERN.test(identity.next || "") ? identity.next : "";
    return redirect ? res.redirect(303, `/activity/${id}${next}`) : res.json({ url: `/activity/${id}${next}` });
  };
  const sendPage = (res, page) => { headers(res, page.nonce); return res.type("html").send(page.html); };
  router.get("/from-admin", async (req, res) => {
    // Strict cookies still travel between same-site sibling origins. Only a same-origin
    // navigation (or direct bookmark) may create a session and consume an owner's slot.
    const site = req.headers["sec-fetch-site"];
    if (site && !["same-origin", "none"].includes(site)) return unavailable(res, 403);
    if (req.headers.referer) {
      try { if (new URL(req.headers.referer).origin !== req.activityOrigin) return unavailable(res, 403); }
      catch { return unavailable(res, 403); }
    }
    const signedIn = adminSession(req);
    if (!signedIn || signedIn.bootstrap || !signedIn.account.userId) return res.redirect(303, "/activity/login");
    const identity = { ownerId: signedIn.account.userId, teamId: getTeamId(), origin: req.activityOrigin,
      expiresAt: now() + ACTIVITY_SESSION_TTL_MS, adminAuth: { accountId: signedIn.accountId, authVersion: signedIn.authVersion } };
    const before = configVersion;
    try {
      await authorize(identity);
      if (before !== configVersion || adminSession(req)?.token !== signedIn.token) return unavailable(res, 403);
      return issueSession(res, identity, { redirect: true });
    } catch (error) { return unavailable(res, error.status || 403); }
  });
  installActivityPasskeys(router, { context, authorize, issueSession, sendPage, getTeamId, version: () => configVersion, now });
  const participatingThread = async (client, session, channelId, threadTs) => {
    if (platformOfConversation(channelId) !== 'slack') {
      const row = await platformActivityThread(session.ownerId, channelId, threadTs);
      if (!row) throw Object.assign(new Error('Thread denied'), { status: 403 });
      return row;
    }
    const row = getSlackThread(channelId, threadTs);
    if (!row || !isSlackThreadParticipant(channelId, threadTs, session.ownerId) || !isSlackThreadEligible(row)) throw Object.assign(new Error("Thread denied"), { status: 403 });
    const entry = await getChannelEntry(channelId);
    const access = await accessContext(client, session.ownerId);
    if (!await access.allows(entry && { ...entry, channelId }, threadTs)) throw Object.assign(new Error("Thread denied"), { status: 403 });
    return row;
  };
  const recheckParticipant = async (req, client, session, channelId, threadTs) => {
    const version = configVersion;
    const row = await participatingThread(client, session, channelId, threadTs);
    await context(req);
    if (version !== configVersion) throw Object.assign(new Error("Thread access changed"), { status: 403 });
    return row;
  };
  const browserSnapshot = async (client, session, id) => {
    const user = await getUser(session.ownerId);
    const pins = new Set(Array.isArray(user?.activityPinnedThreads) ? user.activityPinnedThreads : []);
    const channelPins = new Set(Array.isArray(user?.activityPinnedChannels) ? user.activityPinnedChannels : []);
    const comments = activityComments(user?.activityComments);
    const access = await accessContext(client, session.ownerId);
    const pinnedChannels = [];
    for (const channelId of channelPins) {
      if (typeof channelId !== "string") continue;
      const entry = await getChannelEntry(channelId);
      if (platformOfConversation(channelId) === 'slack' ? await access.allows(entry && { ...entry, channelId }) : await platformActivityAccess(session.ownerId, channelId)) pinnedChannels.push({ channelId, channelName: await activityChannelName({ ...entry, channelId }) });
    }
    const data = await snapshot(client, session.ownerId, { filter: "all-statuses", pageSize: 1000, includeHidden: true,
      pinnedThreads: [...pins], pinnedChannels: pinnedChannels.map((entry) => entry.channelId) }, { backgroundRootReads: true });
    linkedIds.set(session.ownerId, await activityIdentityIds(session.ownerId));
    const external = await platformActivitySnapshot(session.ownerId);
    data.rows.push(...external.rows);
    const all = data.rows.map((row) => ({ platform: row.platform || 'slack', channelId: row.channel_id, threadTs: row.thread_ts,
        hidden: row.hidden_ms > 0, dismissed: row.dismissed_ms > 0, canComplete: row.canComplete ?? row.starter_id === session.ownerId,
        pinned: pins.has(JSON.stringify([row.channel_id, row.thread_ts])), channelPinned: channelPins.has(row.channel_id),
        comment: Object.hasOwn(comments, JSON.stringify([row.channel_id, row.thread_ts])) ? comments[JSON.stringify([row.channel_id, row.thread_ts])] : "",
        title: row.title, channelName: row.channelName, status: row.status, lastMessageMs: row.last_message_ms,
        completedMs: row.status === "done" ? Math.max(0, row.done_ms || 0, row.root_done ? row.root_reaction_ms || 0 : 0) : 0,
        ...(Number.isSafeInteger(row.working_since_ms) ? { workingSinceMs: row.working_since_ms } : {}),
        url: `/activity/${id}/open/${encodeURIComponent(row.channel_id)}/${encodeURIComponent(row.thread_ts)}` }));
    const page = activityFeedWindow(all, session.feedLimits);
    return {
      rows: page.rows, counts: page.counts, more: page.more, limits: page.limits,
      pinnedChannels, unavailable: Boolean(data.unavailable || access.unavailable || external.unavailable), truncated: Boolean(data.truncated || external.truncated), total: data.total + external.rows.length, updatedAt: now(),
      groupBy: activityGrouping(user?.activityGroupBy), groupByVersion: activityGroupOrderVersion(user?.activityGroupByVersion),
      groupOrder: activityGroupOrder(user?.activityGroupOrder), groupOrderVersion: activityGroupOrderVersion(user?.activityGroupOrderVersion),
      columns: activityColumns(user?.activityColumns), columnsVersion: activityGroupOrderVersion(user?.activityColumnsVersion),
      // Touch screens keep their own layout; until one is saved they start from the desktop one.
      columnsTouch: user?.activityColumnsTouch ? activityColumns(user.activityColumnsTouch) : null,
      columnsTouchVersion: activityGroupOrderVersion(user?.activityColumnsTouchVersion),
    };
  };
  router.get("/open", (_req, res) => {
    const page = launchPage(); headers(res, page.nonce); res.type("html").send(page.html);
  });
  router.post("/exchange", async (req, res) => {
    if (req.headers.origin !== req.activityOrigin || !validToken(req.body?.token)) return unavailable(res, 403);
    prune(now());
    const key = hash(req.body.token), grant = grants.get(key);
    if (!grant) return unavailable(res, 410);
    if (grant.origin !== req.activityOrigin) return unavailable(res, 403);
    const version = configVersion;
    try {
      await authorize(grant);
      // A link may be reopened during its ORIGINAL ten-minute lifetime. Recheck after the
      // asynchronous admission check so expiry, pruning or eviction cannot mint a session.
      if (grants.get(key) !== grant || grant.expiresAt <= now()) return unavailable(res, 410);
      if (version !== configVersion) return unavailable(res, 403);
      return issueSession(res, grant);
    } catch (error) { return unavailable(res, error.status || 403); }
  });
  // The agent's display name comes from the bot's own Slack profile, so every install shows
  // its own name. Cached per bot user; a slow or failing lookup never delays the page.
  let agentCache = { key: "", name: "", at: 0 };
  const agentName = async (client) => {
    const identity = getBotIdentity() || {};
    const userId = typeof identity.userId === "string" ? identity.userId : "";
    const handle = typeof identity.handle === "string" ? identity.handle : "";
    const key = `${userId}:${handle}`;
    if (agentCache.key === key && agentCache.name && now() - agentCache.at < 60 * 60_000) return agentCache.name;
    let name = handle;
    if (userId && typeof client?.users?.info === "function") {
      let timer;
      try {
        const info = await Promise.race([client.users.info({ user: userId }),
          new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1500); })]);
        const profile = info?.user?.profile || {};
        name = profile.display_name || profile.real_name || info?.user?.real_name || handle;
      } catch { /* fall back to the handle */ } finally { clearTimeout(timer); }
    }
    name = String(name || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60);
    if (name) agentCache = { key, name, at: now() };
    return name;
  };
  const serveDashboard = async (req, res) => {
    try {
      const { session, client } = await context(req);
      const agent = await agentName(client).catch(() => "");
      const theme = activityTheme((await getUser(session.ownerId))?.activityTheme);
      const view = req.path.endsWith("/automations") ? "automations" : req.path.endsWith("/roi") ? "roi" : req.path.endsWith("/skills") ? "skills" : req.path.endsWith("/calls") ? "calls" : req.path.endsWith("/subscriptions") ? "subscriptions" : /\/settings(?:\/(?:connections(?:\/new)?|email))?$/.test(req.path) ? "settings" : "activity";
      const voiceCalls = voiceAvailable();
      // `?call=<channel>[&thread=<ts>]` opens the voice-call overlay bound to that conversation.
      const launch = view === "activity" && voiceCalls && typeof req.query?.call === "string" ? callTarget({ query: { channel: req.query.call, thread: req.query.thread } }) : null;
      const page = activityPage({ sessionId: req.params.id, csrf: session.csrf, agent, theme, teamId: session.teamId, view, voiceCalls,
        emailPage: req.path.endsWith("/settings/email"), connectionsPage: req.path.includes("/settings/connections"), connectionsNew: req.path.endsWith("/settings/connections/new"), callTarget: launch?.channelId ? launch : null });
      headers(res, page.nonce, { worklet: voiceCalls && view === "activity" }); return res.type("html").send(page.html);
    } catch (error) { return sendPage(res.status(error.status || 401), activityAccessPage({ mode: "login" })); }
  };
  // ── Voice calls (gateway/voice/calls.js) ─────────────────────────────────────
  // The page and every call route live under the session path so its cookie travels. A call is
  // admitted by the same rule as the Dashboard button (channel authorization + membership), and
  // the manager re-checks the caller on every audio chunk and on hang-up.
  // A call may start unbound (the voice then offers the caller's conversations); a thread needs
  // its conversation. Anything malformed is refused rather than guessed.
  const callTarget = (req) => {
    const channelId = String(req.query?.channel || req.body?.channelId || "");
    const threadTs = String(req.query?.thread || req.body?.threadTs || "");
    if ((channelId && !/^[A-Z0-9_]{1,32}$/.test(channelId)) || (threadTs && (!channelId || !isSlackTs(threadTs)))) return null;
    return { channelId, threadTs };
  };
  const csrfOk = (req, session) => req.headers.origin === req.activityOrigin
    && timingSafeEqualStr(String(req.headers["x-cg-csrf"] || req.query?.csrf || ""), session.csrf);
  registerActivityConnectionRoutes(router, { context, csrfOk, services: connectionServices });
  // Older links to the standalone call page land on the dashboard with the overlay instead.
  router.get("/:id/call", async (req, res) => {
    try {
      await context(req);
      const target = callTarget(req);
      if (!target) return unavailable(res, 400);
      return res.redirect(303, `/activity/${encodeURIComponent(req.params.id)}${activityCallPath(target.channelId, target.threadTs)}`);
    } catch (error) { return sendPage(res.status(error.status || 401), activityAccessPage({ mode: "login" })); }
  });
  router.get("/:id/api/devices", async (req, res) => {
    try { const { session } = await context(req); return res.json({ devices: incomingFor().listDevices(session.ownerId) }); }
    catch (e) { return unavailable(res, e.status || 403); }
  });
  router.post("/:id/api/devices", async (req, res) => {
    try {
      const { session } = await context(req);
      if (!csrfOk(req, session)) return unavailable(res, 403);
      return res.json(incomingFor().registerDevice(session.ownerId, req.body || {}));
    } catch (e) { return res.status(e.status || 400).json({ error: e.status === 401 || e.status === 403 ? "Activity is unavailable." : e.message }); }
  });
  router.delete("/:id/api/devices/:deviceId", async (req, res) => {
    try {
      const { session } = await context(req);
      if (!csrfOk(req, session)) return unavailable(res, 403);
      return res.json(incomingFor().removeDevice(session.ownerId, req.params.deviceId));
    } catch (e) { return unavailable(res, e.status || 403); }
  });
  router.get("/:id/api/incoming-calls", async (req, res) => {
    try {
      const { session } = await context(req);
      const rows = getIncomingCallList(session.ownerId);
      return res.json({ calls: rows });
    } catch (e) { return unavailable(res, e.status || 403); }
  });
  router.delete("/:id/api/incoming-calls/:invitationId", async (req, res) => {
    try {
      const { session } = await context(req);
      if (!csrfOk(req, session)) return unavailable(res, 403);
      return res.json(incomingFor().cancel(session.ownerId, req.params.invitationId));
    } catch (e) { return unavailable(res, e.status || 403); }
  });
  router.post("/:id/call/accept", async (req, res) => {
    try {
      const { session, client } = await context(req);
      if (!csrfOk(req, session)) return unavailable(res, 403);
      const identity = getBotIdentity() || {};
      const call = await incomingFor().accept(session.ownerId, req.body?.token, (target, reason) => callsFor().start({
        ownerId: session.ownerId, channelId: target.channelId, threadTs: target.threadTs, openingReason: reason, client,
        teamId: session.teamId, botUserId: typeof identity.userId === "string" ? identity.userId : "" }));
      return res.json(call);
    } catch (e) { return res.status(e.status || 503).json({ error: "The call invitation is unavailable or could not connect." }); }
  });
  router.post("/:id/call/decline", async (req, res) => {
    try {
      const { session } = await context(req);
      if (!csrfOk(req, session)) return unavailable(res, 403);
      return res.json(await incomingFor().decline(session.ownerId, req.body?.token));
    } catch (e) { return res.status(e.status || 404).json({ error: "The call invitation is unavailable." }); }
  });
  router.post("/:id/call/start", async (req, res) => {
    try {
      const { session, client } = await context(req);
      if (!csrfOk(req, session)) return unavailable(res, 403);
      const target = callTarget(req);
      if (!target) return res.status(400).json({ error: "That conversation reference is malformed." });
      const identity = getBotIdentity() || {};
      const call = await callsFor().start({ ownerId: session.ownerId, channelId: target.channelId, threadTs: target.threadTs, client, teamId: session.teamId, botUserId: typeof identity.userId === "string" ? identity.userId : "" });
      await context(req);
      return res.json(call);
    } catch (error) {
      if (error.status === 401 || error.status === 403) return unavailable(res, error.status);
      return res.status(error.status || 503).json({ error: error.message || "The call could not start." });
    }
  });
  router.get("/:id/call/:callId/events", async (req, res) => {
    let session;
    try { ({ session } = await context(req)); } catch (error) { return unavailable(res, error.status || 403); }
    // Subscribe before the headers go out: an unknown or foreign call is a plain 404, and the
    // snapshot the subscription delivers synchronously waits until the stream is open.
    let unsubscribe, open = false;
    const pending = [];
    const write = (event) => {
      if (res.destroyed) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === "ended") res.end();
    };
    try {
      unsubscribe = callsFor().subscribe(req.params.callId, session.ownerId, (event) => { if (open) write(event); else pending.push(event); });
    } catch (error) { return unavailable(res, error.status || 404); }
    res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive" });
    res.flushHeaders(); res.write("retry: 1000\n\n");
    open = true;
    for (const event of pending.splice(0)) write(event);
    const keepalive = setInterval(() => { if (!res.destroyed) res.write(": ping\n\n"); }, 15_000);
    res.on("close", () => { clearInterval(keepalive); unsubscribe?.(); });
  });
  router.post("/:id/call/:callId/audio", express.raw({ type: "application/octet-stream", limit: "64kb" }), async (req, res) => {
    try {
      const { session } = await context(req);
      if (!csrfOk(req, session)) return unavailable(res, 403);
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "audio body missing" });
      const accepted = callsFor().audio(req.params.callId, session.ownerId, req.body);
      return res.json({ ok: true, accepted });
    } catch (error) { return unavailable(res, error.status || 404); }
  });
  router.post("/:id/call/:callId/switch", async (req, res) => {
    try {
      const { session } = await context(req);
      if (!csrfOk(req, session)) return unavailable(res, 403);
      const target = callTarget(req);
      if (!target?.channelId) return res.status(400).json({ error: "Choose a valid conversation for the call." });
      return res.json(await callsFor().switchConversation(req.params.callId, session.ownerId, target));
    } catch (error) {
      return res.status(error.status || 503).json({ error: error.message || "The call could not switch conversations." });
    }
  });
  router.post("/:id/call/:callId/end", async (req, res) => {
    try {
      const { session } = await context(req);
      if (!csrfOk(req, session)) return unavailable(res, 403);
      // `grace=1` is the browser's pagehide beacon: a phone locking its screen or an app going to
      // the background fires it like a closing tab, so the call is only ended if nothing resumes.
      const calls = callsFor();
      if (req.query?.grace === "1" && typeof calls.suspend === "function") return res.json({ ok: calls.suspend(req.params.callId, session.ownerId) });
      const ended = await calls.end(req.params.callId, session.ownerId, "the caller hung up");
      return res.json({ ok: ended });
    } catch (error) { return unavailable(res, error.status || 404); }
  });
  // One installable app: a stable manifest, icons and launcher under /activity/. Registered
  // ahead of "/:id" so these names are never read as session ids.
  router.get("/manifest.webmanifest", async (_req, res) => {
    const agent = await agentName(getClient()).catch(() => "");
    res.set("Cache-Control", "no-store");
    res.type("application/manifest+json").send(JSON.stringify(activityManifest({ agent, color: getLogoColor() })));
  });
  for (const [route, file] of Object.entries(ACTIVITY_APP_ICONS)) router.get(`/${route}`, (req, res) => {
    const color = req.query.color === undefined ? getLogoColor() : (typeof req.query.color === "string" ? normalizeLogoColor("#" + req.query.color) : null);
    if (!color) return res.status(400).end();
    res.set("Cache-Control", req.query.color === undefined ? "no-cache" : "public, max-age=31536000, immutable");
    res.type("png").send(activityIcon(file, color));
  });
  router.get("/icon.svg", (req, res) => {
    const color = req.query.color === undefined ? getLogoColor() : (typeof req.query.color === "string" ? normalizeLogoColor("#" + req.query.color) : null);
    if (!color) return res.status(400).end();
    res.set("Cache-Control", req.query.color === undefined ? "no-cache" : "public, max-age=31536000, immutable");
    res.type("svg").send(channelGateLogo(color));
  });
  router.get(CALL_WORKLET_PATH.replace(/^\/activity/, ""), (_req, res) => {
    res.set("Cache-Control", "public, max-age=3600");
    res.type("application/javascript").send(CALL_WORKLET_SOURCE);
  });
  router.get('/app/session', async (req, res) => {
    const id = activityAppSessionId(req.headers.cookie), session = id && sessions.get(id);
    const before = configVersion;
    try {
      await authorize(session);
      if (before !== configVersion || sessions.get(id) !== session) return unavailable(res);
      // This reveals only a destination. Its path-scoped HttpOnly session cookie is
      // still mandatory on the dashboard; the launcher cookie alone grants no access.
      return res.json({ url: `/activity/${id}` });
    } catch { return unavailable(res); }
  });
  router.get("/app", (req, res) => {
    const id = activityAppSessionId(req.headers.cookie), session = id && sessions.get(id);
    if (session && session.expiresAt > now() && session.origin === req.activityOrigin) return res.redirect(303, `/activity/${id}`);
    return res.redirect(303, "/activity/login");
  });
  router.get("/:id", serveDashboard);
  router.get("/:id/subscriptions", serveDashboard);
  router.get("/:id/settings", serveDashboard);
  router.get("/:id/settings/email", serveDashboard);
  router.get("/:id/settings/connections", serveDashboard);
  router.get("/:id/settings/connections/new", serveDashboard);
  router.get("/:id/calls", serveDashboard);
  router.get("/:id/automations", serveDashboard);
  router.get("/:id/roi", serveDashboard);
  router.get("/:id/skills", serveDashboard);
  // Skills: the same access rule as Automations, re-derived from the session owner on every
  // request; a channel id from the browser only narrows what that access already allows.
  router.get("/:id/api/skills", async (req, res) => {
    try {
      const { session, client } = await context(req);
      const channels = await skillChannels(await accessContext(client, session.ownerId), session.ownerId);
      await context(req);
      return res.json({ channels });
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  router.get("/:id/api/skills/:channelId", async (req, res) => {
    try {
      const { session, client } = await context(req);
      const access = await accessContext(client, session.ownerId);
      const data = req.params.channelId === PERSONAL_SKILLS_ID
        ? await personalSkillsView(session.ownerId, access.user?.isAdmin === true)
        : await channelSkillsView(access, session.ownerId, await checkedChannel(access, session.ownerId, req.params.channelId));
      await context(req);
      return res.json(data);
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  router.post("/:id/api/skills/:channelId", async (req, res) => {
    let session, client;
    try {
      ({ session, client } = await context(req));
      if (!csrfOk(req, session)) return unavailable(res, 403);
    } catch (error) { return unavailable(res, error.status || 403); }
    try {
      const access = await accessContext(client, session.ownerId);
      const result = await saveSkillSelection(access, session.ownerId, req.params.channelId, req.body?.selected, {
        authorize: async () => { const current = await context(req); if (current.session !== session) throw Object.assign(new Error("Activity session changed"), { status: 401 }); },
      });
      const changed = result.added.length + result.removed.length;
      return res.json({ added: result.added, removed: result.removed, notice: changed ? "Skills saved. They apply to the next run." : "No skill changes." });
    } catch (error) {
      if (error.userFacing) return res.status(error.status || 400).json({ error: error.message });
      return unavailable(res, error.status === 401 || error.status === 403 ? error.status : 503);
    }
  });
  // Automations: every request re-derives access from the session owner; channel and schedule
  // ids from the browser only ever narrow what that access already allows.
  router.get("/:id/api/automations", async (req, res) => {
    try {
      const { session, client } = await context(req);
      const started = performance.now();
      const data = await automationChannels(await accessContext(client, session.ownerId), session.ownerId);
      await context(req);
      timed(res, "automations", started, data.length);
      return res.json({ channels: data });
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  // The health board: every automation the viewer may see, with its verdict and fix steps.
  router.get("/:id/api/automations/board", async (req, res) => {
    try {
      const { session, client } = await context(req);
      const access = await accessContext(client, session.ownerId);
      const board = await automationBoard(access, session.ownerId, { days: Number(req.query.days) || 7, botName: await agentName(client).catch(() => ""), teamId: session.teamId });
      await context(req);
      return res.json(board);
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  // The ROI page: automations, API sources and skills in the same scope as the board.
  router.get("/:id/api/automations/roi", async (req, res) => {
    try {
      const { session, client } = await context(req);
      const access = await accessContext(client, session.ownerId);
      const overview = await roiOverview(access, session.ownerId, { days: Number(req.query.days) || 30 });
      await context(req);
      return res.json(overview);
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  // Organization-wide ROI inputs (a skill's, the default hourly rate): admins only.
  for (const [name, handler] of [["skill", setSkillRoi], ["default", setDefaultRate]]) {
    router.post(`/:id/api/automations/roi/${name}`, async (req, res) => {
      try {
        const { session, client } = await context(req);
        if (!csrfOk(req, session)) return unavailable(res, 403);
        const access = await accessContext(client, session.ownerId);
        await context(req);
        return res.json(await handler(access, session.ownerId, req.body || {}));
      } catch (error) {
        if (error.userFacing) return res.status(error.status || 400).json({ error: error.message });
        return unavailable(res, error.status || 503);
      }
    });
  }
  router.get("/:id/api/automations/:channelId", async (req, res) => {
    try {
      const { session, client } = await context(req);
      const access = await accessContext(client, session.ownerId);
      const entry = await checkedChannel(access, session.ownerId, req.params.channelId);
      const automations = channelAutomations(access, session.ownerId, entry);
      await context(req);
      return res.json({ automations });
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  router.get("/:id/api/automations/:channelId/:scheduleId/runs", async (req, res) => {
    try {
      const { session, client } = await context(req);
      const access = await accessContext(client, session.ownerId);
      const entry = await checkedChannel(access, session.ownerId, req.params.channelId);
      const runs = automationRuns(access, entry, String(req.params.scheduleId).slice(0, 64), session.ownerId);
      await context(req);
      return res.json({ runs });
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  // Edit / pause / resume, and Run now: only the creator, an admin, or the DM's owner (an
  // automation runs as its creator). Validation errors are shown to the person; access errors are not.
  for (const [action, handler] of [
    ["update", (access, ownerId, entry, id, req) => updateAutomation(access, ownerId, entry, id, req.body || {}).then((schedule) => ({ ok: true, enabled: schedule.enabled !== false }))],
    ["run", (access, ownerId, entry, id) => runAutomationNow(access, ownerId, entry, id)],
    ["acknowledge", (access, ownerId, entry, id, req) => acknowledgeAutomation(access, ownerId, entry, id, req.body || {})],
    ["roi", (access, ownerId, entry, id, req) => setAutomationRoi(access, ownerId, entry, id, req.body || {})],
  ]) {
    router.post(`/:id/api/automations/:channelId/:scheduleId/${action}`, async (req, res) => {
      try {
        const { session, client } = await context(req);
        if (!csrfOk(req, session)) return unavailable(res, 403);
        const access = await accessContext(client, session.ownerId);
        const entry = await checkedChannel(access, session.ownerId, req.params.channelId);
        await context(req);
        return res.json(await handler(access, session.ownerId, entry, String(req.params.scheduleId).slice(0, 64), req));
      } catch (error) {
        if (error.userFacing) return res.status(error.status || 400).json({ error: error.message });
        return unavailable(res, error.status || 503);
      }
    });
  }
  router.post("/:id/api/automations/:channelId/:scheduleId/delete", async (req, res) => {
    try {
      const { session, client } = await context(req);
      if (!csrfOk(req, session)) return unavailable(res, 403);
      const access = await accessContext(client, session.ownerId);
      const entry = await checkedChannel(access, session.ownerId, req.params.channelId);
      await context(req);
      return res.json({ ok: deleteAutomation(access, session.ownerId, entry, String(req.params.scheduleId).slice(0, 64)) });
    } catch (error) { return unavailable(res, error.status || 503); }
  });

  // Settings → API tokens: the same access rule as Automations, re-derived from the session owner
  // on every request. A minted value is in exactly one response body (no-store) and nowhere else.
  router.get("/:id/api/api-tokens", async (req, res) => {
    try {
      const { session, client } = await context(req);
      const channels = await apiTokenChannels(await accessContext(client, session.ownerId), session.ownerId);
      await context(req);
      return res.json({ channels });
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  router.get("/:id/api/api-tokens/:channelId", async (req, res) => {
    try {
      const { session, client } = await context(req);
      const data = await apiTokenChannelView(await accessContext(client, session.ownerId), session.ownerId, req.params.channelId);
      await context(req);
      return res.json(data);
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  router.post("/:id/api/api-tokens/:channelId", async (req, res) => {
    let session, client;
    try {
      ({ session, client } = await context(req));
      if (!csrfOk(req, session)) return unavailable(res, 403);
    } catch (error) { return unavailable(res, error.status || 403); }
    try {
      const minted = await createDashboardApiToken(await accessContext(client, session.ownerId), session.ownerId, req.params.channelId, req.body?.name, {
        authorize: async () => { const current = await context(req); if (current.session !== session) throw Object.assign(new Error("Activity session changed"), { status: 401 }); },
      });
      res.set("Cache-Control", "no-store");
      return res.json(minted);
    } catch (error) {
      if (error instanceof ApiTokenError) return res.status(error.status).json({ error: error.message });
      return unavailable(res, error.status === 401 || error.status === 403 ? error.status : 503);
    }
  });
  router.post("/:id/api/api-tokens/:channelId/:tokenId/revoke", async (req, res) => {
    let session, client;
    try {
      ({ session, client } = await context(req));
      if (!csrfOk(req, session)) return unavailable(res, 403);
    } catch (error) { return unavailable(res, error.status || 403); }
    try {
      const token = await revokeDashboardApiToken(await accessContext(client, session.ownerId), session.ownerId, req.params.channelId, req.params.tokenId, {
        authorize: async () => { const current = await context(req); if (current.session !== session) throw Object.assign(new Error("Activity session changed"), { status: 401 }); },
      });
      return res.json({ token });
    } catch (error) {
      if (error instanceof ApiTokenError) return res.status(error.status).json({ error: error.message });
      return unavailable(res, error.status === 401 || error.status === 403 ? error.status : 503);
    }
  });

  router.get("/:id/api/calls", async (req, res) => {
    try {
      const { session } = await context(req);
      let before = null;
      if (req.query.before !== undefined) {
        if (typeof req.query.before !== "string" || req.query.before.length > 512) return unavailable(res, 400);
        try { before = JSON.parse(Buffer.from(req.query.before, "base64url").toString("utf8")); } catch { return unavailable(res, 400); }
        if (!before || !Number.isSafeInteger(before.startedMs) || before.startedMs < 0 || typeof before.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(before.id)) return unavailable(res, 400);
      }
      return res.json(listCallHistory(session.ownerId, session.teamId, { before }));
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  router.get("/:id/api/calls/:callId", async (req, res) => {
    try {
      const { session } = await context(req);
      const call = readCallHistory(req.params.callId, session.ownerId, session.teamId);
      return call ? res.json(call) : unavailable(res, 404);
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  // Calls can visit threads started by the bot or another member. The receipt proves the
  // caller visited it; current channel access is checked again before resolving any permalink.
  router.get("/:id/calls/:callId/thread/:index", async (req, res) => {
    try {
      const { session, client } = await context(req);
      const call = readCallHistory(req.params.callId, session.ownerId, session.teamId);
      const index = Number(req.params.index);
      const thread = Number.isSafeInteger(index) && index >= 0 ? call?.threads[index] : null;
      if (!thread) return unavailable(res, 404);
      const check = async () => {
        const entry = await getChannelEntry(thread.channelId);
        const access = await accessContext(client, session.ownerId);
        if (!entry || !await access.allows({ ...entry, channelId: thread.channelId }, thread.threadTs)) throw Object.assign(new Error("Thread denied"), { status: 403 });
      };
      const version = configVersion;
      await check();
      const link = await reader.permalink(client, thread.channelId, thread.messageTs || thread.threadTs);
      const target = new URL(link.permalink);
      if (target.protocol !== "https:" || target.username || target.password || !target.hostname.endsWith(".slack.com") || !target.pathname.startsWith("/archives/")) return unavailable(res, 403);
      target.searchParams.set("thread_ts", thread.threadTs);
      target.searchParams.set("cid", thread.channelId);
      await check(); await context(req);
      if (version !== configVersion) return unavailable(res, 403);
      return res.redirect(303, target.toString());
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  // The viewer's OWN settings, masked. Secret values never leave the process (write-only).
  router.get("/:id/api/settings", async (req, res) => {
    try {
      const { session } = await context(req);
      const data = await userSettingsSnapshot(session.ownerId);
      await context(req); // Revocation while the snapshot awaited cannot publish it.
      return res.json(data);
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  router.post("/:id/api/settings", async (req, res) => {
    let session;
    try {
      ({ session } = await context(req));
      if (req.headers.origin !== req.activityOrigin || !timingSafeEqualStr(String(req.headers["x-cg-csrf"] || ""), session.csrf)) return unavailable(res, 403);
    } catch (error) { return unavailable(res, error.status || 403); }
    try {
      // Only the authenticated owner is ever changed; caller-supplied owners or roles are ignored.
      // `authorize` re-checks this exact session after slow work (DNS, mail logins), before writing.
      const result = await applyUserSettingsChange(session.ownerId, req.body || {}, {
        authorize: async () => { const current = await context(req); if (current.session !== session) throw Object.assign(new Error("Activity session changed"), { status: 401 }); },
      });
      return res.json({ notice: result.notice, settings: await userSettingsSnapshot(session.ownerId) });
    } catch (error) {
      if (error instanceof UserSettingsError) return res.status(error.status).json({ error: error.message, field: error.field });
      return unavailable(res, error.status === 401 || error.status === 403 ? error.status : 503);
    }
  });
  router.get("/:id/api/subscriptions", async (req, res) => {
    try {
      const { session } = await context(req);
      const version = configVersion;
      const data = await readSubscriptions();
      // Usage is organization-wide, intentionally visible to admitted dashboard viewers. Keep
      // login material inside the canonical reader, and recheck access after provider latency.
      const current = await context(req);
      if (current.session !== session || version !== configVersion) return unavailable(res, 503);
      return res.json(data);
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  router.get("/:id/api/threads", async (req, res) => {
    try {
      const { session, client } = await context(req);
      const version = configVersion, started = performance.now();
      const data = await browserSnapshot(client, session, req.params.id);
      await context(req); // A disable/expiry while the snapshot awaited membership cannot publish it.
      if (version !== configVersion) return unavailable(res, 503);
      timed(res, "threads", started, data.rows?.length);
      return res.json(data);
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  router.post("/:id/api/threads/more", async (req, res) => {
    try {
      const { session, client } = await context(req);
      if (req.headers.origin !== req.activityOrigin || !timingSafeEqualStr(String(req.headers["x-cg-csrf"] || ""), session.csrf)) return unavailable(res, 403);
      const group = req.body?.group;
      if (!FEED_GROUPS.includes(group)) return res.status(400).json({ error: "Unknown group" });
      const current = session.feedLimits?.[group] || ACTIVITY_PAGE_SIZE;
      session.feedLimits = { ...session.feedLimits, [group]: Math.min(current + ACTIVITY_PAGE_SIZE, 5000) };
      const version = configVersion;
      const data = await browserSnapshot(client, session, req.params.id);
      await context(req);
      if (version !== configVersion) return unavailable(res, 503);
      for (const stream of streams) if (stream.id === req.params.id) stream.changed(); // keep live pushes on the new window
      return res.json(data);
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  router.post("/:id/api/history", async (req, res) => {
    try {
      const { session, client } = await context(req);
      if (req.headers.origin !== req.activityOrigin || !timingSafeEqualStr(String(req.headers["x-cg-csrf"] || ""), session.csrf)) return unavailable(res, 403);
      const history = await discoverSlackThreadHistory(client, session.ownerId, {
        beforeWrite: async () => { await context(req); },
      });
      await context(req);
      const version = configVersion;
      const data = await browserSnapshot(client, session, req.params.id);
      await context(req);
      if (version !== configVersion) return unavailable(res, 503);
      return res.json({ ...data, history: { scanned: history.scanned, moreHistory: history.moreHistory, unavailable: history.incomplete } });
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  router.get("/:id/open/:channelId/:threadTs", async (req, res) => {
    try {
      const { session, client } = await context(req);
      const row = await participatingThread(client, session, req.params.channelId, req.params.threadTs);
      if (platformOfConversation(req.params.channelId) !== 'slack') {
        const target = platformThreadUrl(row);
        if (!target) return unavailable(res, 404);
        await recheckParticipant(req, client, session, req.params.channelId, req.params.threadTs);
        return res.redirect(303, target);
      }
      // Resolve the latest reply at click time. The index's millisecond activity date loses
      // Slack's microsecond precision and is not a message identifier. Root metadata usually
      // supplies latest_reply; only its absence on a nonempty thread requires pagination.
      const page = await client.conversations.replies({ channel: req.params.channelId, ts: req.params.threadTs, limit: 1 });
      const root = page?.ok !== false && page?.messages?.find((message) => message.ts === req.params.threadTs);
      if (slackThreadRootOwner(req.params.channelId, root) !== getSlackThread(req.params.channelId, req.params.threadTs)?.starter_id) return unavailable(res, 403);
      const latest = await latestMessageTs(client, req.params.channelId, root);
      const link = await reader.permalink(client, req.params.channelId, latest);
      const target = new URL(link.permalink);
      if (target.protocol !== "https:" || target.username || target.password || !target.hostname.endsWith(".slack.com") || !target.pathname.startsWith("/archives/")) return unavailable(res, 403);
      // Keep the thread pane open even for a root with no replies yet.
      target.searchParams.set("thread_ts", req.params.threadTs);
      target.searchParams.set("cid", req.params.channelId);
      const app = new URL("slack://channel");
      app.searchParams.set("team", session.teamId);
      app.searchParams.set("id", req.params.channelId);
      app.searchParams.set("message", latest);
      app.searchParams.set("thread_ts", req.params.threadTs);
      await recheckParticipant(req, client, session, req.params.channelId, req.params.threadTs);
      return res.redirect(303, req.query.browser === "1" ? target.toString() : app.toString());
    } catch (error) { return unavailable(res, error.status || 403); }
  });
  // Hide changes only the authenticated viewer's membership; it never completes work.
  router.post("/:id/api/hide", async (req, res) => {
    try {
      const { session, client } = await context(req);
      if (!csrfOk(req, session)) return unavailable(res, 403);
      const { channelId, threadTs, hidden } = req.body || {};
      if (typeof channelId !== "string" || typeof threadTs !== 'string' || !threadTs || typeof hidden !== "boolean") return unavailable(res, 400);
      const row = await recheckParticipant(req, client, session, channelId, threadTs);
      const changed = platformOfConversation(channelId) === 'slack'
        ? setSlackThreadHidden(channelId, threadTs, session.ownerId, hidden)
        : setPlatformThreadHidden(channelId, threadTs, row.activityUserId, hidden);
      if (!changed) return unavailable(res, 403);
      return res.json({ ok: true });
    } catch (error) { return unavailable(res, error.status || 403); }
  });
  router.post("/:id/api/pin", async (req, res) => {
    try {
      const { session, client } = await context(req);
      if (req.headers.origin !== req.activityOrigin || !timingSafeEqualStr(String(req.headers["x-cg-csrf"] || ""), session.csrf)) return unavailable(res, 403);
      const { channelId, threadTs, pinned } = req.body || {};
      if (typeof channelId !== "string" || typeof threadTs !== "string" || typeof pinned !== "boolean") return unavailable(res, 400);
      await recheckParticipant(req, client, session, channelId, threadTs);
      const key = JSON.stringify([channelId, threadTs]);
      await setUser(session.ownerId, (current) => {
        const pins = new Set(Array.isArray(current?.activityPinnedThreads) ? current.activityPinnedThreads : []);
        if (pinned) pins.add(key); else pins.delete(key);
        return { activityPinnedThreads: [...pins] };
      });
      return res.json({ ok: true });
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  // A private note on one of the viewer's own conversations. Only the owner can read or write it;
  // an empty comment removes it, and the oldest notes give way past the per-viewer limit.
  router.post("/:id/api/comment", async (req, res) => {
    try {
      const { session, client } = await context(req);
      if (req.headers.origin !== req.activityOrigin || !timingSafeEqualStr(String(req.headers["x-cg-csrf"] || ""), session.csrf)) return unavailable(res, 403);
      const { channelId, threadTs } = req.body || {};
      const comment = normalizeActivityComment(req.body?.comment);
      if (typeof channelId !== "string" || typeof threadTs !== "string" || comment === null) return unavailable(res, 400);
      await recheckParticipant(req, client, session, channelId, threadTs);
      const key = JSON.stringify([channelId, threadTs]);
      await setUser(session.ownerId, (current) => {
        const comments = activityComments(current?.activityComments);
        delete comments[key];
        if (comment) comments[key] = comment; // Re-inserted last: the most recently edited survive.
        const keys = Object.keys(comments);
        for (const old of keys.slice(0, Math.max(0, keys.length - ACTIVITY_COMMENT_LIMIT))) delete comments[old];
        return { activityComments: comments };
      });
      return res.json({ comment });
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  router.post("/:id/api/channel-pin", async (req, res) => {
    try {
      const { session, client } = await context(req);
      if (req.headers.origin !== req.activityOrigin || !timingSafeEqualStr(String(req.headers["x-cg-csrf"] || ""), session.csrf)) return unavailable(res, 403);
      const { channelId, pinned } = req.body || {};
      if (typeof channelId !== "string" || !/^(?:[A-Z0-9_]{1,32}|gchat:spaces\/[A-Za-z0-9_-]+|teams:[^\s]{1,2000})$/.test(channelId) || typeof pinned !== "boolean") return unavailable(res, 400);
      const version = configVersion;
      const entry = await getChannelEntry(channelId);
      const access = await accessContext(client, session.ownerId);
      if (!(platformOfConversation(channelId) === 'slack' ? await access.allows(entry && { ...entry, channelId }) : await platformActivityAccess(session.ownerId, channelId))) return unavailable(res, 403);
      await context(req);
      if (version !== configVersion) return unavailable(res, 403);
      await setUser(session.ownerId, (current) => {
        const pins = new Set(Array.isArray(current?.activityPinnedChannels) ? current.activityPinnedChannels : []);
        if (pinned) pins.add(channelId); else pins.delete(channelId);
        return { activityPinnedChannels: [...pins] };
      });
      return res.json({ ok: true });
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  router.post("/:id/api/group-order", async (req, res) => {
    try {
      const { session } = await context(req);
      if (req.headers.origin !== req.activityOrigin || !timingSafeEqualStr(String(req.headers["x-cg-csrf"] || ""), session.csrf)) return unavailable(res, 403);
      const order = req.body?.groupOrder;
      if (!validActivityGroupOrder(order)) return unavailable(res, 400);
      await context(req);
      // Only the authenticated viewer's display preference can be changed. Never accept a
      // caller-supplied owner or merge arbitrary request fields into the user record.
      const user = await setUser(session.ownerId, (current) => ({ activityGroupOrder: [...order],
        activityGroupOrderVersion: activityGroupOrderVersion(current?.activityGroupOrderVersion) + 1 }));
      return res.json({ groupOrder: user.activityGroupOrder, groupOrderVersion: user.activityGroupOrderVersion });
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  router.post("/:id/api/columns", async (req, res) => {
    try {
      const { session } = await context(req);
      if (req.headers.origin !== req.activityOrigin || !timingSafeEqualStr(String(req.headers["x-cg-csrf"] || ""), session.csrf)) return unavailable(res, 403);
      const { order, widths, hidden = [], device: requested } = req.body || {};
      if (!validActivityColumnOrder(order) || !validActivityColumnWidths(widths) || !validActivityColumnHidden(hidden)
        || (requested !== undefined && activityColumnDevice(requested) !== requested)) return unavailable(res, 400);
      await context(req);
      const device = activityColumnDevice(requested);
      const field = device === "touch" ? "activityColumnsTouch" : "activityColumns", versionField = field + "Version";
      // The viewer's own display preference only; copied field by field, never merged from the body.
      const user = await setUser(session.ownerId, (current) => ({
        [field]: { order: [...order], widths: Object.fromEntries(Object.entries(widths)), hidden: [...hidden] },
        [versionField]: activityGroupOrderVersion(current?.[versionField]) + 1 }));
      return res.json({ device, columns: activityColumns(user[field]), columnsVersion: user[versionField] });
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  router.post("/:id/api/group-by", async (req, res) => {
    try {
      const { session } = await context(req);
      if (req.headers.origin !== req.activityOrigin || !timingSafeEqualStr(String(req.headers["x-cg-csrf"] || ""), session.csrf)) return unavailable(res, 403);
      const groupBy = req.body?.groupBy;
      if (!ACTIVITY_GROUPINGS.includes(groupBy)) return unavailable(res, 400);
      await context(req);
      const user = await setUser(session.ownerId, (current) => ({ activityGroupBy: groupBy,
        activityGroupByVersion: activityGroupOrderVersion(current?.activityGroupByVersion) + 1 }));
      return res.json({ groupBy: user.activityGroupBy, groupByVersion: user.activityGroupByVersion });
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  router.post("/:id/api/theme", async (req, res) => {
    try {
      const { session } = await context(req);
      if (req.headers.origin !== req.activityOrigin || !timingSafeEqualStr(String(req.headers["x-cg-csrf"] || ""), session.csrf)) return unavailable(res, 403);
      const theme = req.body?.theme;
      if (!ACTIVITY_THEMES.includes(theme)) return unavailable(res, 400);
      await context(req);
      // The viewer's own display preference only; never a caller-supplied owner or field.
      const user = await setUser(session.ownerId, () => ({ activityTheme: theme }));
      return res.json({ theme: activityTheme(user?.activityTheme) });
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  router.post("/:id/api/completion-all", async (req, res) => {
    try {
      const { session, client } = await context(req);
      if (req.headers.origin !== req.activityOrigin || !timingSafeEqualStr(String(req.headers["x-cg-csrf"] || ""), session.csrf)) return unavailable(res, 403);
      if (req.body?.confirmed !== true) return unavailable(res, 400);
      // Ignore caller-supplied owners/targets. Every write revalidates this exact session and
      // the current owned-thread policy after asynchronous Slack root/membership reads.
      const result = await markAllSlackThreadsDone(client, session.ownerId, {
        beforeWrite: async () => { await context(req); },
      });
      const external = await platformActivitySnapshot(session.ownerId);
      for (const row of external.rows) {
        if (!row.canComplete || row.hidden_ms || row.status === 'done' && row.dismissed_ms > 0) { result.skipped++; continue; }
        try {
          const checked = await recheckParticipant(req, client, session, row.channel_id, row.thread_ts);
          if (!checked.canComplete) { result.skipped++; continue; }
          if (setPlatformThreadDone(row.channel_id, row.thread_ts, checked.activityUserId, true)) result.marked++;
          else result.skipped++;
        } catch (error) {
          if (error.status === 401 || error.status === 403) throw error;
          result.failed++;
        }
      }
      return res.json(result);
    } catch (error) { return unavailable(res, error.status || 503); }
  });
  for (const operation of ["completion", "later"]) router.post(`/:id/api/${operation}`, async (req, res) => {
    try {
      const { session, client } = await context(req);
      if (req.headers.origin !== req.activityOrigin || !timingSafeEqualStr(String(req.headers["x-cg-csrf"] || ""), session.csrf)) return unavailable(res, 403);
      const { channelId, threadTs } = req.body || {};
      const value = req.body?.[operation === "later" ? "later" : "done"];
      if (typeof channelId !== "string" || typeof threadTs !== "string" || typeof value !== "boolean") return unavailable(res, 400);
      const row = await participatingThread(client, session, channelId, threadTs);
      if (platformOfConversation(channelId) !== 'slack') {
        if (!row.canComplete) return unavailable(res, 403);
        const checked = await recheckParticipant(req, client, session, channelId, threadTs);
        if (!checked.canComplete) return unavailable(res, 403);
        const change = operation === 'later' ? setPlatformThreadLater : setPlatformThreadDone;
        if (!change(channelId, threadTs, checked.activityUserId, value)) return unavailable(res, 403);
        return res.json({ ok: true });
      }
      const result = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 1 });
      const root = result?.ok !== false && result?.messages?.find((row) => row.ts === threadTs);
      if (slackThreadRootOwner(channelId, root) !== session.ownerId) return unavailable(res, 403);
      await recheckParticipant(req, client, session, channelId, threadTs);
      const change = operation === "later" ? setSlackThreadLater : setSlackThreadDone;
      if (!change(channelId, threadTs, session.ownerId, value)) return unavailable(res, 403);
      if (operation === "completion") {
        if (value) markDone(session.ownerId, channelId, threadTs); else clearDone(session.ownerId, channelId, threadTs);
      }
      // The decision is durable; the ✅/🕒 reaction is decoration. Answer now and let Slack catch
      // up (the marker sync serializes per thread and schedules its own retry on failure).
      syncThreadDoneMarker(client, channelId, threadTs).catch(() => {});
      return res.json({ ok: true });
    } catch (error) { return unavailable(res, error.status || 403); }
  });
  router.get("/:id/stream", async (req, res) => {
    let initial;
    try { initial = await context(req); } catch (error) { return unavailable(res, error.status || 403); }
    if (streams.size >= maxStreams || [...streams].filter((stream) => stream.id === req.params.id).length >= 2
      || [...streams].filter((stream) => stream.ownerId === initial.session.ownerId).length >= 3) return unavailable(res, 429);
    res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive" });
    res.flushHeaders(); res.write("retry: 2000\n\n");
    let closed = false, sending = false, dirty = false, lastKey, lastAccess = 0, queued;
    const queue = () => { if (!closed && !queued) queued = setTimeout(() => { queued = null; void send(); }, 25); };
    const stream = { id: req.params.id, ownerId: initial.session.ownerId, end: () => res.end(), changed: queue };
    streams.add(stream);
    const endAccess = () => { if (!closed) { res.write('event: access-ended\ndata: {}\n\n'); res.end(); } };
    // A false `write` only means the socket buffer is full (any snapshot above the stream's
    // high-water mark trips it on a healthy connection): wait for the buffer to drain rather
    // than closing, which would make the browser reconnect and refetch the same snapshot forever.
    const drained = () => new Promise((resolve) => {
      if (closed || res.destroyed) return resolve(false);
      const settle = (ok) => { clearTimeout(limit); res.off("drain", onDrain); res.off("close", onClose); resolve(ok); };
      const onDrain = () => settle(true), onClose = () => settle(false);
      const limit = setTimeout(() => settle(false), drainTimeoutMs);
      res.on("drain", onDrain); res.on("close", onClose);
    });
    const send = async () => {
      dirty = true;
      if (sending || closed) return;
      sending = true;
      try {
        while (dirty && !closed) {
          dirty = false;
          const current = await context(req), version = configVersion, key = combinedRefreshKey(initial.session.ownerId);
          const data = await browserSnapshot(current.client, current.session, req.params.id);
          await context(req);
          if (closed) break;
          if (version !== configVersion) { dirty = true; continue; }
          lastKey = key; lastAccess = now();
          if (key !== combinedRefreshKey(initial.session.ownerId)) dirty = true;
          if (!res.write(`event: threads\ndata: ${JSON.stringify(data)}\n\n`) && !(await drained())) { res.end(); break; }
        }
      } catch (error) {
        if (error.status === 401 || error.status === 403) endAccess();
        else if (!closed) res.write('event: threads-unavailable\ndata: {}\n\n');
      } finally { sending = false; }
    };
    const unthread = onThreadChanged(({ channelId, threadTs }) => {
      if (isSlackThreadParticipant(channelId, threadTs, initial.session.ownerId)
        || (linkedIds.get(initial.session.ownerId) || []).some(id => isPlatformThreadParticipant(channelId, threadTs, id))) queue();
    });
    const unruns = onActiveRunsChanged(queue);
    let checking = false;
    const timer = setInterval(async () => {
      if (checking || closed) return;
      checking = true;
      try {
        await context(req);
        if (combinedRefreshKey(initial.session.ownerId) !== lastKey || now() - lastAccess >= accessRefreshMs) await send();
        else if (!closed) res.write(": keepalive\n\n");
      } catch { endAccess(); }
      finally { checking = false; }
    }, pollMs);
    timer.unref?.();
    res.on("close", () => { closed = true; clearInterval(timer); clearTimeout(queued); unthread(); unruns(); streams.delete(stream); });
    void send();
  });
  router.use((_error, _req, res, _next) => unavailable(res, 400));
  return router;
}
