// A private user dashboard: ten-minute Slack launch grant -> path-scoped browser session.
// Ordinary routes use Activity cookies only. The explicit admin shortcut can mint the owner's
// Activity session from a verified, linked administrator browser session; API keys never qualify.
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { getPublicUrl } from "../config/settings.js";
import { getChannelEntry, getUser, setUser } from "../config/store.js";
import { onConfigChange } from "../config/change-events.js";
import { getSlackThread, isSlackThreadEligible, setSlackThreadLater, setSlackThreadDone } from "../gateway/slack-threads.js";
import { onThreadChanged } from "../gateway/thread-changes.js";
import { onActiveRunsChanged } from "../gateway/active-runs.js";
import { syncThreadDoneMarker } from "../slack/thread-done-marker.js";
import { clearDone, markDone } from "../gateway/followups.js";
import { accessContext, activityThreadSnapshot, discoverSlackThreadHistory, homeThreadsRefreshKey, markAllSlackThreadsDone } from "../slack/home-threads.js";
import { createHomeThreadReader } from "../slack/home-thread-reader.js";
import { isSlackTs } from "../slack/thread-keys.js";
import { isLoopbackHost, timingSafeEqualStr } from "./security.js";
import { readSubscriptionUsage } from "../gateway/subscription-usage.js";
import { activityPage } from "./activity-page.js";
import { activityGroupOrder, activityGroupOrderVersion, validActivityGroupOrder, ACTIVITY_THEMES, activityTheme } from "./activity-order.js";
import { activityAccessPage } from "./activity-access-page.js";
import { installActivityPasskeys } from "./activity-passkeys.js";
import { ACTIVITY_APP_ICONS, activityAppCookie, activityAppSessionId, activityManifest } from "./activity-app.js";
import { activityPasskey } from "../config/activity-passkeys.js";
import { adminAccount, adminPasskeyById } from "../config/admin-accounts.js";
import { adminSession } from "./auth.js";
import { applyUserSettingsChange, userSettingsSnapshot, UserSettingsError } from "../gateway/user-settings.js";

export const ACTIVITY_GRANT_TTL_MS = 10 * 60_000;
export const ACTIVITY_SESSION_TTL_MS = 12 * 60 * 60_000;
const grants = new Map(), sessions = new Map();
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
  for (const map of [grants, sessions]) for (const [key, row] of map) if (row.expiresAt <= now) map.delete(key);
}

export function createActivityGrantUrl({ baseUrl = getPublicUrl(), ownerId, teamId, now = Date.now() } = {}) {
  const base = baseFor(baseUrl);
  if (!base || !ownerId || !teamId) return "";
  prune(now); capOwner(grants, String(ownerId), 20); cap(grants, 2000);
  const secret = token();
  grants.set(hash(secret), { ownerId: String(ownerId), teamId: String(teamId), origin: base.origin, expiresAt: now + ACTIVITY_GRANT_TTL_MS });
  // The fragment never travels in HTTP requests, proxy logs or Slack link-unfurl requests.
  return `${base.origin}/activity/open#${secret}`;
}

function headers(res, nonce = "") {
  res.set({ "Cache-Control": "no-store, max-age=0", Pragma: "no-cache", "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
    "Content-Security-Policy": `default-src 'none'; ${nonce ? `script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; font-src 'self';` : ""} manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
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

export function createActivityRouter({
  getClient, getTeamId, getBaseUrl = getPublicUrl, getBotIdentity = () => null,
  snapshot = activityThreadSnapshot, refreshKey = homeThreadsRefreshKey, readSubscriptions = readSubscriptionUsage,
  now = Date.now, pollMs = 1000, accessRefreshMs = 15_000, maxStreams = 100, drainTimeoutMs = 30_000,
} = {}) {
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
  router.use((req, res, next) => (req.method === "POST" && /^\/[^/]+\/api\/settings$/.test(req.path) ? settingsJson : smallJson)(req, res, next));
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
    capOwner(sessions, identity.ownerId, 10); cap(sessions, 1000);
    const session = { ownerId: identity.ownerId, teamId: identity.teamId, origin: identity.origin,
      ...(identity.credentialId ? { credentialId: identity.credentialId } : {}),
      ...(identity.adminAuth ? { adminAuth: { ...identity.adminAuth } } : {}),
      cookieHash: hash(secret), csrf: token(), expiresAt: now() + ACTIVITY_SESSION_TTL_MS };
    sessions.set(id, session);
    const secure = new URL(identity.origin).protocol === "https:";
    res.append("Set-Cookie", `${cookieName(id)}=${secret}; HttpOnly; SameSite=Lax; Path=/activity/${id}; Max-Age=${ACTIVITY_SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`);
    // The installed app's launcher resumes this session; it learns the id only, never the secret.
    res.append("Set-Cookie", activityAppCookie(id, { maxAgeSeconds: ACTIVITY_SESSION_TTL_MS / 1000, secure }));
    return redirect ? res.redirect(303, `/activity/${id}`) : res.json({ url: `/activity/${id}` });
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
  const ownedThread = async (client, session, channelId, threadTs) => {
    const row = getSlackThread(channelId, threadTs);
    if (!row || row.starter_id !== session.ownerId || !isSlackThreadEligible(row)) throw Object.assign(new Error("Thread denied"), { status: 403 });
    const entry = await getChannelEntry(channelId);
    const access = await accessContext(client, session.ownerId);
    if (!await access.allows(entry && { ...entry, channelId }, threadTs)) throw Object.assign(new Error("Thread denied"), { status: 403 });
    return row;
  };
  const recheckOwned = async (req, client, session, channelId, threadTs) => {
    const version = configVersion;
    await ownedThread(client, session, channelId, threadTs);
    await context(req);
    if (version !== configVersion) throw Object.assign(new Error("Thread access changed"), { status: 403 });
  };
  const browserSnapshot = async (client, session, id) => {
    const data = await snapshot(client, session.ownerId, { filter: "all-statuses", pageSize: 1000 });
    const user = await getUser(session.ownerId);
    return {
      rows: data.rows.map((row) => ({ channelId: row.channel_id, threadTs: row.thread_ts,
        title: row.title, channelName: row.channelName, status: row.status, lastMessageMs: row.last_message_ms,
        ...(Number.isSafeInteger(row.working_since_ms) ? { workingSinceMs: row.working_since_ms } : {}),
        url: `/activity/${id}/open/${encodeURIComponent(row.channel_id)}/${encodeURIComponent(row.thread_ts)}` })),
      unavailable: Boolean(data.unavailable), truncated: Boolean(data.truncated), total: data.total, updatedAt: now(),
      groupOrder: activityGroupOrder(user?.activityGroupOrder), groupOrderVersion: activityGroupOrderVersion(user?.activityGroupOrderVersion),
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
      const view = req.path.endsWith("/subscriptions") ? "subscriptions" : req.path.endsWith("/settings") ? "settings" : "activity";
      const page = activityPage({ sessionId: req.params.id, csrf: session.csrf, agent, theme, teamId: session.teamId, view });
      headers(res, page.nonce); return res.type("html").send(page.html);
    } catch (error) { return sendPage(res.status(error.status || 401), activityAccessPage({ mode: "login" })); }
  };
  // One installable app: a stable manifest, icons and launcher under /activity/. Registered
  // ahead of "/:id" so these names are never read as session ids.
  router.get("/manifest.webmanifest", async (_req, res) => {
    const agent = await agentName(getClient()).catch(() => "");
    res.type("application/manifest+json").send(JSON.stringify(activityManifest({ agent })));
  });
  for (const [route, file] of Object.entries(ACTIVITY_APP_ICONS)) router.get(`/${route}`, (_req, res) => {
    res.set("Cache-Control", "public, max-age=86400");
    res.sendFile(file, { root: fileURLToPath(new URL("../../public/activity/", import.meta.url)) });
  });
  router.get("/app", (req, res) => {
    const id = activityAppSessionId(req.headers.cookie), session = id && sessions.get(id);
    if (session && session.expiresAt > now() && session.origin === req.activityOrigin) return res.redirect(303, `/activity/${id}`);
    return res.redirect(303, "/activity/login");
  });
  router.get("/:id", serveDashboard);
  router.get("/:id/subscriptions", serveDashboard);
  router.get("/:id/settings", serveDashboard);
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
      const version = configVersion;
      const data = await browserSnapshot(client, session, req.params.id);
      await context(req); // A disable/expiry while the snapshot awaited membership cannot publish it.
      if (version !== configVersion) return unavailable(res, 503);
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
      await ownedThread(client, session, req.params.channelId, req.params.threadTs);
      // Resolve the latest reply at click time. The index's millisecond activity date loses
      // Slack's microsecond precision and is not a message identifier. Root metadata usually
      // supplies latest_reply; only its absence on a nonempty thread requires pagination.
      const page = await client.conversations.replies({ channel: req.params.channelId, ts: req.params.threadTs, limit: 1 });
      const root = page?.ok !== false && page?.messages?.find((message) => message.ts === req.params.threadTs);
      if (!root || root.user !== session.ownerId || root.bot_id) return unavailable(res, 403);
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
      await recheckOwned(req, client, session, req.params.channelId, req.params.threadTs);
      return res.redirect(303, req.query.browser === "1" ? target.toString() : app.toString());
    } catch (error) { return unavailable(res, error.status || 403); }
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
      await ownedThread(client, session, channelId, threadTs);
      const result = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 1 });
      const root = result?.ok !== false && result?.messages?.find((row) => row.ts === threadTs);
      if (!root || root.user !== session.ownerId || root.bot_id) return unavailable(res, 403);
      await recheckOwned(req, client, session, channelId, threadTs);
      const change = operation === "later" ? setSlackThreadLater : setSlackThreadDone;
      if (!change(channelId, threadTs, session.ownerId, value)) return unavailable(res, 403);
      if (operation === "completion") {
        if (value) markDone(session.ownerId, channelId, threadTs); else clearDone(session.ownerId, channelId, threadTs);
      }
      await syncThreadDoneMarker(client, channelId, threadTs);
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
          const current = await context(req), version = configVersion, key = refreshKey(initial.session.ownerId);
          const data = await browserSnapshot(current.client, current.session, req.params.id);
          await context(req);
          if (closed) break;
          if (version !== configVersion) { dirty = true; continue; }
          lastKey = key; lastAccess = now();
          if (key !== refreshKey(initial.session.ownerId)) dirty = true;
          if (!res.write(`event: threads\ndata: ${JSON.stringify(data)}\n\n`) && !(await drained())) { res.end(); break; }
        }
      } catch (error) {
        if (error.status === 401 || error.status === 403) endAccess();
        else if (!closed) res.write('event: threads-unavailable\ndata: {}\n\n');
      } finally { sending = false; }
    };
    const unthread = onThreadChanged(({ channelId, threadTs }) => {
      if (getSlackThread(channelId, threadTs)?.starter_id === initial.session.ownerId) queue();
    });
    const unruns = onActiveRunsChanged(queue);
    let checking = false;
    const timer = setInterval(async () => {
      if (checking || closed) return;
      checking = true;
      try {
        await context(req);
        if (refreshKey(initial.session.ownerId) !== lastKey || now() - lastAccess >= accessRefreshMs) await send();
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
