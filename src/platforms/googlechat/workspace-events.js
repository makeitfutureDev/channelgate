// Google Workspace Events subscriptions that deliver Google Chat REACTION events.
//
// Chat apps receive no interaction event for a reaction. Google's supported path is one Workspace
// Events subscription per space (`//chat.googleapis.com/spaces/S`) with app authentication and the
// admin-approved `chat.app.messages.readonly` scope, publishing CloudEvents to a Pub/Sub topic.
// With resource data included (who reacted, which emoji) a subscription lives at most four hours,
// so this manager reconciles on a timer instead of trusting expiration reminders (Google's own
// advice: reminders may never arrive when the endpoint is broken).
//
// The manager is stateless on purpose: every pass LISTS the app's live subscriptions, so a restart,
// a crash mid-create or a second process converges instead of leaking duplicates.
import { REACTION_EVENT_TYPES, REACTION_CREATED } from "./reactions.js";

const BASE = "https://workspaceevents.googleapis.com/v1";
const TOPIC_RE = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][A-Za-z0-9_.~+%-]{2,254}$/;
export const isTopicName = value => TOPIC_RE.test(String(value || ""));
export const targetFor = space => `//chat.googleapis.com/${space}`;
// Renew when less than this remains. With a four-hour maximum and a 30-minute pass, a subscription
// is extended about every hour and survives two consecutive failed passes.
const RENEW_BELOW_MS = 2 * 60 * 60_000;
const INTERVAL_MS = 30 * 60_000;

export function createWorkspaceEventsClient({ auth, fetchImpl = fetch } = {}) {
  if (!auth?.token) throw new TypeError("createWorkspaceEventsClient requires a Google auth provider");
  async function call(path, { method = "GET", query = null, body = null } = {}) {
    const url = new URL(`${BASE}/${path}`);
    for (const [k, v] of Object.entries(query || {})) if (v != null && v !== "") url.searchParams.set(k, String(v));
    const res = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${await auth.token()}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return res.json().catch(() => ({}));
    const text = await res.text().catch(() => "");
    let detail = text.slice(0, 300);
    try { detail = String(JSON.parse(text).error?.message || detail).slice(0, 300); } catch { /* non-JSON */ }
    if (res.status === 401) auth.reset?.();
    const error = new Error(`Workspace Events ${method} ${path.split("?")[0]} failed (${res.status}): ${detail}`);
    error.status = res.status;
    throw error;
  }
  return {
    async list() {
      const out = [];
      let pageToken = "";
      do {
        const res = await call("subscriptions", { query: { filter: `event_types:"${REACTION_CREATED}"`, pageSize: 100, pageToken } });
        out.push(...(res?.subscriptions || []));
        pageToken = res?.nextPageToken || "";
      } while (pageToken && out.length < 10_000);
      return out;
    },
    create({ space, topic }) {
      return call("subscriptions", { method: "POST", body: {
        targetResource: targetFor(space),
        eventTypes: REACTION_EVENT_TYPES,
        notificationEndpoint: { pubsubTopic: topic },
        payloadOptions: { includeResource: true },
      } });
    },
    // ttl 0s = the longest expiration Google allows for this subscription.
    renew(name) { return call(name, { method: "PATCH", query: { updateMask: "ttl" }, body: { ttl: "0s" } }); },
    reactivate(name) { return call(`${name}:reactivate`, { method: "POST", body: {} }); },
    remove(name) { return call(name, { method: "DELETE" }); },
  };
}

const ours = (sub, topic) => sub?.notificationEndpoint?.pubsubTopic === topic
  && REACTION_EVENT_TYPES.every(type => (sub.eventTypes || []).includes(type))
  && sub.payloadOptions?.includeResource === true;
const spaceOf = sub => String(sub?.targetResource || "").replace(/^\/\/chat\.googleapis\.com\//, "");

export function createReactionSubscriptions({ client, listSpaces, topic, log = console, now = Date.now, intervalMs = INTERVAL_MS, onStatus = () => {} } = {}) {
  if (!isTopicName(topic)) throw new Error('Reaction events topic must look like "projects/<project>/topics/<name>"');
  let timer = null;
  let running = null;
  let again = false;
  let stopped = true;
  let status = { state: "starting", spaces: 0, active: 0, error: "" };
  let lastLogged = "";
  const report = next => {
    status = { ...status, ...next, checkedAt: new Date(now()).toISOString() };
    onStatus(status);
    const line = status.error ? `error: ${status.error}` : `${status.active}/${status.spaces} spaces subscribed`;
    if (line !== lastLogged) { lastLogged = line; (status.error ? log.warn : log.info)?.(`[googlechat] reaction events ${line}`); }
  };

  async function pass() {
    const spaces = (await listSpaces()).map(space => space.name);
    const wanted = new Set(spaces);
    const subscriptions = await client.list();
    const covered = new Map();
    const failures = [];
    for (const sub of subscriptions) {
      if (stopped) return;
      if (!ours(sub, topic)) continue; // another deployment's or a hand-made subscription: never touched
      const space = spaceOf(sub);
      const state = String(sub.state || "");
      try {
        // The app left the space, or a duplicate from an interrupted pass: retire it.
        if (!wanted.has(space) || covered.has(space)) { if (state !== "DELETED") await client.remove(sub.name); continue; }
        if (state === "DELETED") continue;
        if (state === "SUSPENDED") await client.reactivate(sub.name);
        const left = Date.parse(sub.expireTime) - now();
        // Reactivation keeps the old expiry, so a reactivated subscription is always renewed.
        if (state === "SUSPENDED" || !(left > RENEW_BELOW_MS)) await client.renew(sub.name);
        covered.set(space, sub.name);
      } catch (error) {
        failures.push(`${space}: ${error?.message || error}`);
        // An expired or vanished subscription cannot be renewed; a fresh one replaces it below.
        if (error?.status !== 404 && error?.status !== 400) covered.set(space, sub.name);
      }
    }
    for (const space of spaces) {
      if (stopped) return;
      if (covered.has(space)) continue;
      try { await client.create({ space, topic }); covered.set(space, "pending"); }
      catch (error) {
        // 409: another process created it between our list and this create. The next pass adopts it.
        if (error?.status === 409) covered.set(space, "existing");
        else failures.push(`${space}: ${error?.message || error}`);
      }
    }
    report({ state: failures.length ? "degraded" : "active", spaces: spaces.length, active: covered.size,
      error: failures.length ? `${failures.length} space(s) failed; first: ${failures[0]}` : "" });
  }

  async function reconcile() {
    if (stopped) return;
    if (running) { again = true; return running; }
    running = (async () => {
      do {
        again = false;
        try { await pass(); }
        catch (error) { report({ state: "error", error: error?.message || String(error) }); }
      } while (again && !stopped);
    })().finally(() => { running = null; });
    return running;
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      timer = setInterval(() => { reconcile(); }, intervalMs);
      timer.unref?.();
      return reconcile();
    },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = null; },
    // Lifecycle events (expiration reminder, suspended, expired) and the app joining a space all
    // just ask for a pass; the pass itself is the single source of truth.
    reconcile,
    get status() { return status; },
  };
}
