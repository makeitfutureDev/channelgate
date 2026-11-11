// A private user dashboard: ten-minute Slack launch grant -> path-scoped browser session.
// This router deliberately accepts neither administrator cookies nor run API credentials.
import crypto from "node:crypto";
import express from "express";
import { getPublicUrl } from "../config/settings.js";
import { getChannelEntry, getUser } from "../config/store.js";
import { onConfigChange } from "../config/change-events.js";
import { getSlackThread, isSlackThreadEligible, setSlackThreadDone } from "../gateway/slack-threads.js";
import { onThreadChanged } from "../gateway/thread-changes.js";
import { onActiveRunsChanged } from "../gateway/active-runs.js";
import { clearDone, markDone } from "../gateway/followups.js";
import { accessContext, activityThreadSnapshot, homeThreadsRefreshKey } from "../slack/home-threads.js";
import { createHomeThreadReader } from "../slack/home-thread-reader.js";
import { isLoopbackHost, timingSafeEqualStr } from "./security.js";
import { activityPage } from "./activity-page.js";

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
    "Content-Security-Policy": `default-src 'none'; ${nonce ? `script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:;` : ""} base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
}
function unavailable(res, status = 401) {
  return res.status(status).json({ error: "Activity is unavailable. Open a new dashboard link from Slack Activity." });
}
function launchPage() {
  const nonce = token(16);
  return { nonce, html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open My Activity</title><style nonce="${nonce}">body{background:#10151f;color:#e9edf5;font:16px system-ui;margin:0;display:grid;place-items:center;min-height:100vh}main{padding:32px;max-width:480px}p{line-height:1.6}</style></head><body><main><h1>My Activity</h1><p id="status">Opening your private dashboard…</p></main><script nonce="${nonce}">(async()=>{const secret=location.hash.slice(1);history.replaceState(null,"",location.pathname);try{if(!/^[A-Za-z0-9_-]{43}$/.test(secret))throw Error();const response=await fetch("/activity/exchange",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:secret})});if(!response.ok)throw Error();const data=await response.json();if(typeof data.url!=="string"||!data.url.startsWith("/activity/")||!/^[A-Za-z0-9_-]{16}$/.test(data.url.slice(10)))throw Error();location.replace(data.url);}catch{document.getElementById("status").textContent="This private link expired or is unavailable. Open a new dashboard link from Slack Activity."}})();</script></body></html>` };
}

export function resetActivityStateForTests() {
  for (const stream of streams) stream.end();
  streams.clear(); grants.clear(); sessions.clear();
}

export function createActivityRouter({
  getClient, getTeamId, getBaseUrl = getPublicUrl,
  snapshot = activityThreadSnapshot, refreshKey = homeThreadsRefreshKey,
  now = Date.now, pollMs = 1000, accessRefreshMs = 15_000, maxStreams = 100,
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
  router.use(express.json({ limit: "8kb" }));
  const authorize = async (session) => {
    if (!session || session.expiresAt <= now() || session.origin !== baseFor(getBaseUrl())?.origin) throw Object.assign(new Error("Activity expired"), { status: 401 });
    const user = await getUser(session.ownerId);
    if (!user || (!user.approved && !user.isAdmin) || session.teamId !== getTeamId()) throw Object.assign(new Error("Activity access ended"), { status: 403 });
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
    return {
      rows: data.rows.map((row) => ({ channelId: row.channel_id, threadTs: row.thread_ts,
        title: row.title, channelName: row.channelName, status: row.status, lastMessageMs: row.last_message_ms,
        url: `/activity/${id}/open/${encodeURIComponent(row.channel_id)}/${encodeURIComponent(row.thread_ts)}` })),
      unavailable: Boolean(data.unavailable), truncated: Boolean(data.truncated), total: data.total, updatedAt: now(),
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
      const id = token(12), secret = token(); capOwner(sessions, grant.ownerId, 10); cap(sessions, 1000);
      const session = { ...grant, cookieHash: hash(secret), csrf: token(), expiresAt: now() + ACTIVITY_SESSION_TTL_MS };
      sessions.set(id, session);
      res.setHeader("Set-Cookie", `${cookieName(id)}=${secret}; HttpOnly; SameSite=Lax; Path=/activity/${id}; Max-Age=${ACTIVITY_SESSION_TTL_MS / 1000}${new URL(grant.origin).protocol === "https:" ? "; Secure" : ""}`);
      return res.json({ url: `/activity/${id}` });
    } catch (error) { return unavailable(res, error.status || 403); }
  });
  router.get("/:id", async (req, res) => {
    try {
      const { session } = await context(req);
      const page = activityPage({ sessionId: req.params.id, csrf: session.csrf });
      headers(res, page.nonce); return res.type("html").send(page.html);
    } catch (error) { return unavailable(res, error.status || 403); }
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
  router.get("/:id/open/:channelId/:threadTs", async (req, res) => {
    try {
      const { session, client } = await context(req);
      await ownedThread(client, session, req.params.channelId, req.params.threadTs);
      const link = await reader.permalink(client, req.params.channelId, req.params.threadTs);
      const target = new URL(link.permalink);
      if (target.protocol !== "https:" || target.username || target.password || !target.hostname.endsWith(".slack.com") || !target.pathname.startsWith("/archives/")) return unavailable(res, 403);
      await recheckOwned(req, client, session, req.params.channelId, req.params.threadTs);
      return res.redirect(303, target.toString());
    } catch (error) { return unavailable(res, error.status || 403); }
  });
  router.post("/:id/api/completion", async (req, res) => {
    try {
      const { session, client } = await context(req);
      if (req.headers.origin !== req.activityOrigin || !timingSafeEqualStr(String(req.headers["x-cg-csrf"] || ""), session.csrf)) return unavailable(res, 403);
      const { channelId, threadTs, done } = req.body || {};
      if (typeof channelId !== "string" || typeof threadTs !== "string" || typeof done !== "boolean") return unavailable(res, 400);
      await ownedThread(client, session, channelId, threadTs);
      const result = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 1 });
      const root = result?.ok !== false && result?.messages?.find((row) => row.ts === threadTs);
      if (!root || root.user !== session.ownerId || root.bot_id) return unavailable(res, 403);
      await recheckOwned(req, client, session, channelId, threadTs);
      if (!setSlackThreadDone(channelId, threadTs, session.ownerId, done)) return unavailable(res, 403);
      if (done) markDone(session.ownerId, channelId, threadTs); else clearDone(session.ownerId, channelId, threadTs);
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
          if (!res.write(`event: threads\ndata: ${JSON.stringify(data)}\n\n`)) { res.end(); break; }
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
