// Personal "AI is waiting on you" follow-ups. The gateway already receives every message in the
// channels it's a member of (it just ignores the ones that don't @mention it). Here we PASSIVELY
// observe that stream and, per thread, remember who has taken part and who spoke last.
//
// SCOPE (the ONLY thing we remind about): threads where the AI is waiting for the human's decision —
// i.e. a genuine AI thread (the gateway was @mentioned or posted, `aiInvolved`) in which the BOT
// spoke LAST, so the ball is now in a human participant's court. We deliberately do NOT remind about
// human-to-human replies someone owes; if you replied last, the AI isn't waiting on you. The moment
// a participant answers, the bot is no longer the last author and the thread clears itself.
//
// Twice a day (08:00 and 14:00 Europe/Bucharest by default) each approved user gets ONE DM digest
// of the threads the AI is waiting on them for, each line a permalink. Reacting ✅ dismisses a thread;
// any fresh activity after that re-opens it automatically (its lastTs moves past the done marker).
// Nothing is sent to a user with an empty list — no spam. Missed slots CATCH UP: if the machine was
// asleep at a slot time, the digest fires late on the next tick (durable per-day marker in SQLite
// `_meta`, so a restart never double-sends).
//
// Confinement note: this can only ever see channels the bot is in and that are already registered
// with the gateway (used at least once). It never reads a user's private DMs/threads with others.
import { getUsers } from "../config/store.js";
import {
  getFollowupRemindersEnabled,
  getFollowupDigestHours,
  getFollowupTimeZone,
} from "../config/settings.js";
import { logEvent } from "../util/logger.js";
import { getDb, toJson, fromJson, metaGet, metaSet } from "../db/index.js";
import { postDirectMessage } from "../platforms/notify.js";

export const FOLLOWUP_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_DIGEST_LINES = 25; // cap one DM digest (oldest-waiting first)
const MENTION_RE = /<@([A-Z0-9]+)(?:\|[^>]+)?>/g;

// Shape: rows in followup_threads ("<channelId>::<threadTs>" → rec) + followup_done
// ((userId, thread_key) → doneMs).
//   rec = { channelId, slug, channelName, threadTs, participants[], mentioned[], aiInvolved,
//           lastTs, lastAuthorId, lastText }
//   aiInvolved is true once the bot was @mentioned or posted in the thread — only these "AI threads"
//   can ever generate a reminder, and then only when the bot spoke last (see aiAwaitsUser).
// Backed by SQLite (followup_threads + followup_done). Mutations touch ONLY the affected row
// (upsert / targeted delete): recordActivity runs for EVERY message in every managed channel, and
// the old wipe-both-tables-and-reinsert write amplified into lock contention with the MCP server
// process sharing the DB.
function readThread(db, key) {
  const r = db.prepare("SELECT data FROM followup_threads WHERE thread_key = ?").get(key);
  return r ? fromJson(r.data, null) : null;
}

function upsertThread(db, key, rec) {
  db.prepare("INSERT INTO followup_threads(thread_key, data) VALUES(?, ?) ON CONFLICT(thread_key) DO UPDATE SET data = excluded.data").run(key, toJson(rec));
}

const tkey = (channelId, threadTs) => `${channelId}::${threadTs}`;
const digestKey = (channelId, messageTs) => `${channelId}::${messageTs}`;

function normalizeThreadRefs(threads) {
  const seen = new Set();
  const normalized = [];
  for (const thread of Array.isArray(threads) ? threads : []) {
    const channelId = String(thread?.channelId || "").trim();
    const threadTs = String(thread?.threadTs || "").trim();
    const key = tkey(channelId, threadTs);
    if (!channelId || !threadTs || seen.has(key)) continue;
    seen.add(key);
    normalized.push({ channelId, threadTs });
  }
  return normalized;
}

function readDigestSnapshot(db, key) {
  const row = db.prepare("SELECT data FROM followup_digest_messages WHERE message_key = ?").get(key);
  return row ? fromJson(row.data, null) : null;
}

function withImmediateTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function saveDigestSnapshot({
  channelId,
  messageTs,
  userId,
  threads,
  createdMs = Date.now(),
  dismissedMs = null,
} = {}) {
  channelId = String(channelId || "").trim();
  messageTs = String(messageTs || "").trim();
  userId = String(userId || "").trim();
  const listed = normalizeThreadRefs(threads);
  if (!channelId || !messageTs || !userId || !listed.length) return false;
  const created = Number(createdMs);
  const dismissed = dismissedMs == null ? null : Number(dismissedMs);
  const rec = {
    channelId,
    messageTs,
    userId,
    threads: listed,
    createdMs: Number.isFinite(created) ? created : Date.now(),
    dismissedMs: Number.isFinite(dismissed) ? dismissed : null,
  };
  getDb()
    .prepare(
      "INSERT INTO followup_digest_messages(message_key, created_ms, data) VALUES(?, ?, ?) " +
      "ON CONFLICT(message_key) DO UPDATE SET created_ms = excluded.created_ms, data = excluded.data",
    )
    .run(digestKey(channelId, messageTs), rec.createdMs, toJson(rec));
  return true;
}

export function getDigestSnapshot(channelId, messageTs) {
  return readDigestSnapshot(getDb(), digestKey(channelId, messageTs));
}

export function pruneDigestSnapshots(nowMs = Date.now()) {
  const cutoff = Number(nowMs) - FOLLOWUP_RETENTION_MS;
  if (!Number.isFinite(cutoff)) return 0;
  return Number(
    getDb().prepare("DELETE FROM followup_digest_messages WHERE created_ms < ?").run(cutoff).changes || 0,
  );
}

export function applyDigestDoneReaction(userId, channelId, messageTs, atMs = Date.now()) {
  const db = getDb();
  const key = digestKey(channelId, messageTs);
  return withImmediateTransaction(db, () => {
    const rec = readDigestSnapshot(db, key);
    if (!rec || rec.userId !== userId) return false;
    if (Number.isFinite(rec.dismissedMs)) return true; // Slack redelivery / duplicate application
    const at = Number(atMs);
    const dismissedMs = Number.isFinite(at) && at > 0 ? at : Date.now();
    const upsert = db.prepare(
      "INSERT INTO followup_done(user_id, thread_key, done_ms) VALUES(?, ?, ?) " +
      "ON CONFLICT(user_id, thread_key) DO UPDATE SET done_ms = " +
      "CASE WHEN followup_done.done_ms > excluded.done_ms THEN followup_done.done_ms ELSE excluded.done_ms END",
    );
    for (const thread of normalizeThreadRefs(rec.threads)) {
      upsert.run(userId, tkey(thread.channelId, thread.threadTs), dismissedMs);
    }
    rec.dismissedMs = dismissedMs;
    db.prepare("UPDATE followup_digest_messages SET data = ? WHERE message_key = ?").run(toJson(rec), key);
    return true;
  });
}

export function removeDigestDoneReaction(userId, channelId, messageTs) {
  const db = getDb();
  const key = digestKey(channelId, messageTs);
  return withImmediateTransaction(db, () => {
    const rec = readDigestSnapshot(db, key);
    if (!rec || rec.userId !== userId) return false;
    if (!Number.isFinite(rec.dismissedMs)) return true;
    const remove = db.prepare(
      "DELETE FROM followup_done WHERE user_id = ? AND thread_key = ? AND done_ms = ?",
    );
    for (const thread of normalizeThreadRefs(rec.threads)) {
      remove.run(userId, tkey(thread.channelId, thread.threadTs), rec.dismissedMs);
    }
    rec.dismissedMs = null;
    db.prepare("UPDATE followup_digest_messages SET data = ? WHERE message_key = ?").run(toJson(rec), key);
    return true;
  });
}

// Drop thread state that's gone quiet, plus any done-markers pointing at threads we've forgotten.
// Deletes only the stale rows (lastTs lives inside the JSON blob, so select + filter in JS and
// delete by key). Rate-limited to once an hour — the 14-day window doesn't need per-message sweeps.
let lastPruneMs = 0;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
function pruneStale(db, nowMs) {
  if (nowMs - lastPruneMs < PRUNE_EVERY_MS) return;
  lastPruneMs = nowMs;
  const del = db.prepare("DELETE FROM followup_threads WHERE thread_key = ?");
  for (const r of db.prepare("SELECT thread_key, data FROM followup_threads").all()) {
    if (nowMs - (fromJson(r.data, {}).lastTs || 0) > FOLLOWUP_RETENTION_MS) del.run(r.thread_key);
  }
  db.prepare("DELETE FROM followup_done WHERE thread_key NOT IN (SELECT thread_key FROM followup_threads)").run();
}

function previewText(text) {
  return String(text || "")
    .replace(MENTION_RE, "@user")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

// Record one observed message into the per-thread state. `isBot` covers the gateway's own posts
// (and any other bot): they move "who spoke last" but never count as a human participant — so a
// thread the bot answered last owes nobody. `aiTurn` is true when THIS message means the AI took
// part (the bot posted, or someone @mentioned it) — it latches rec.aiInvolved, which gates whether
// the thread is ever eligible for a reminder.
export function recordActivity({ channelId, slug, channelName, threadTs, userId, isBot, aiTurn, text, tsMs }) {
  if (!channelId || !threadTs || !userId) return;
  const db = getDb();
  const k = tkey(channelId, threadTs);
  const rec = readThread(db, k) || {
    channelId,
    slug: slug || "",
    channelName: channelName || channelId,
    threadTs,
    participants: [],
    mentioned: [],
    aiInvolved: false,
    lastTs: 0,
    lastAuthorId: "",
    lastText: "",
  };
  if (channelName) rec.channelName = channelName;
  if (slug) rec.slug = slug;
  if (aiTurn) rec.aiInvolved = true;
  const at = Number.isFinite(tsMs) ? tsMs : Date.now();
  // Observation is fire-and-forget, so completions can land out of order — an older message
  // arriving late may still add itself as a participant, but must never move the "who spoke
  // last" snapshot backwards (that would resurrect a reminder the human already answered).
  const advances = at >= rec.lastTs;
  if (advances) {
    rec.lastTs = at;
    rec.lastAuthorId = userId;
  }
  if (!isBot) {
    if (!rec.participants.includes(userId)) rec.participants.push(userId);
    for (const m of String(text || "").matchAll(MENTION_RE)) {
      if (!rec.mentioned.includes(m[1])) rec.mentioned.push(m[1]);
    }
    if (advances) rec.lastText = previewText(text);
  }
  upsertThread(db, k, rec); // only the touched row is written
  pruneStale(db, at);
}

// Mark a thread done for one user (their ✅). Suppresses reminders until newer activity arrives.
export function markDone(userId, channelId, threadTs, atMs = Date.now()) {
  if (!userId || !channelId || !threadTs) return;
  getDb()
    .prepare("INSERT INTO followup_done(user_id, thread_key, done_ms) VALUES(?, ?, ?) ON CONFLICT(user_id, thread_key) DO UPDATE SET done_ms = excluded.done_ms")
    .run(userId, tkey(channelId, threadTs), Number(atMs) || 0);
}

// Un-mark (✅ removed) — re-open the thread for that user immediately.
export function clearDone(userId, channelId, threadTs) {
  if (!userId || !channelId || !threadTs) return;
  getDb().prepare("DELETE FROM followup_done WHERE user_id = ? AND thread_key = ?").run(userId, tkey(channelId, threadTs));
}

// Is the AI waiting on `userId` in this thread? This is the ONE and ONLY thing we remind about:
// threads where the bot spoke LAST (so the ball is in the human's court — the AI is waiting for your
// decision), it's a genuine AI thread (the gateway took part, `aiInvolved`), `userId` actually took
// part (posted in it), and they haven't ✅'d it since that last bot message. The moment `userId`
// replies the bot is no longer the last author, so the thread clears itself. We do NOT remind about
// human-to-human replies you owe — only about decisions the AI is waiting on from you.
function aiAwaitsUser(rec, userId, botUserId, doneMap) {
  if (!rec.aiInvolved) return false; // the gateway AI genuinely took part
  if (rec.lastAuthorId !== botUserId) return false; // the AI must have spoken last (waiting on you)
  if (!rec.participants.includes(userId)) return false; // you must have taken part in the thread
  const doneTs = doneMap?.[tkey(rec.channelId, rec.threadTs)];
  if (doneTs && doneTs >= rec.lastTs) return false; // dismissed since that last bot message
  return true;
}

// All threads where the AI is currently waiting on `userId`'s decision, longest-waiting first.
export function pendingForUser(userId, botUserId) {
  const db = getDb();
  const doneMap = {};
  for (const r of db.prepare("SELECT thread_key, done_ms FROM followup_done WHERE user_id = ?").all(userId)) doneMap[r.thread_key] = r.done_ms;
  return db
    .prepare("SELECT data FROM followup_threads")
    .all()
    .map((r) => fromJson(r.data, {}))
    .filter((rec) => aiAwaitsUser(rec, userId, botUserId, doneMap))
    .sort((a, b) => a.lastTs - b.lastTs);
}

// ── Twice-daily digest ──────────────────────────────────────────────────────

// Current wall-clock {dateKey, hour, minute} in the configured IANA timezone (so 08:00/14:00 mean
// Europe/Bucharest regardless of the host's TZ).
function nowInTz(tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const g = (t) => parts.find((p) => p.type === t)?.value;
    let hour = Number(g("hour"));
    if (hour === 24) hour = 0; // some ICU builds render midnight as 24
    return { dateKey: `${g("year")}-${g("month")}-${g("day")}`, hour, minute: Number(g("minute")) };
  } catch {
    const d = new Date();
    return { dateKey: d.toISOString().slice(0, 10), hour: d.getHours(), minute: d.getMinutes() };
  }
}

function fmtWaited(ms) {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (h < 24) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

function client(slack) {
  return slack?.snapshot?.().connected ? slack.getClient?.() ?? null : null;
}

// Format one user's pending list the way the DM digest renders it: a "waiting on your decision"
// header plus one permalink bullet per thread (capped at MAX_DIGEST_LINES, oldest-waiting first).
// Shared by the scheduled digest and the on-demand `/pending` command. `getPermalink(channelId, ts)`
// is injected (an async resolver around chat.getPermalink) so the formatting itself stays a pure,
// testable function; a resolver failure falls back to the plain channel label.
export async function formatPendingReport(pending, nowMs, getPermalink) {
  const lines = [];
  for (const rec of pending.slice(0, MAX_DIGEST_LINES)) {
    let link = "";
    try {
      link = (await getPermalink(rec.channelId, rec.threadTs)) || "";
    } catch {
      /* not in the channel anymore / no permalink — fall back to a plain label */
    }
    const where = rec.channelName || rec.channelId;
    const waited = fmtWaited(nowMs - rec.lastTs);
    const label = link ? `<${link}|${where}>` : where;
    const preview = rec.lastText ? ` — “${rec.lastText}”` : "";
    lines.push(`• ${label} · waiting ${waited}${preview}`);
  }
  const more = pending.length > MAX_DIGEST_LINES ? `\n…and ${pending.length - MAX_DIGEST_LINES} more.` : "";
  return (
    `🤖 *I'm waiting on your decision in ${pending.length} thread${pending.length === 1 ? "" : "s"}:*\n` +
    lines.join("\n") +
    more
  );
}

// Permalink resolver for a Slack WebClient (the injectable half of formatPendingReport).
const permalinkVia = (c) => async (channelId, threadTs) =>
  (await c.chat.getPermalink({ channel: channelId, message_ts: threadTs }))?.permalink || "";

// On-demand version of the digest (the `/pending` in-thread command): the caller's LIVE pending
// list, formatted exactly like the scheduled DM. Empty list → a short friendly note instead of
// silence (unlike the digest, the user explicitly asked).
export async function buildPendingReportForUser(c, userId, botUserId, nowMs = Date.now()) {
  const pending = pendingForUser(userId, botUserId);
  if (!pending.length) return "✅ Nothing pending — I'm not waiting on your decision in any thread.";
  const body = await formatPendingReport(pending, nowMs, permalinkVia(c));
  return body + `\n\n_Reply in a thread to answer — it clears automatically once you do. Or react ✅ to dismiss it._`;
}

// Build and DM one user's digest of threads the AI is waiting on them for. Returns the count
// (0 → nothing sent).
export async function sendDigest(c, userId, botUserId, nowMs) {
  const pending = pendingForUser(userId, botUserId);
  if (!pending.length) return 0;

  const text =
    (await formatPendingReport(pending, nowMs, permalinkVia(c))) +
    `\n\n_Reply in a thread to answer — it clears automatically once you do. Or React ✅ to dismiss all listed threads. I check at the start of your day and again early afternoon._`;

  try {
    // "Open the 1:1 with this person and post there" is a different API on every surface, so the
    // connector owns it — this module only knows it wants to DM the user.
    const posted = await postDirectMessage(c, { userId, text });
    const dm = posted?.conversationId;
    if (!dm) return 0;
    if (posted?.messageId) {
      saveDigestSnapshot({
        channelId: dm,
        messageTs: posted.messageId,
        userId,
        threads: pending.slice(0, MAX_DIGEST_LINES).map(({ channelId, threadTs }) => ({ channelId, threadTs })),
        createdMs: nowMs,
      });
      pruneDigestSnapshots(nowMs);
    }
    await logEvent("followup_digest_sent", { user: userId, pending: pending.length });
    return pending.length;
  } catch (e) {
    await logEvent("followup_digest_error", { user: userId, error: e.message });
    return 0;
  }
}

async function runDigest(slack) {
  const c = client(slack);
  if (!c) return;
  const botUserId = slack?.snapshot?.().botUserId || "";
  const users = await getUsers();
  for (const [userId, u] of Object.entries(users)) {
    if (!(u?.approved || u?.isAdmin)) continue; // only people cleared to use the gateway
    await sendDigest(c, userId, botUserId, Date.now());
  }
}

// Durable "already fired today" marker per slot hour, in the shared `_meta` key-value table
// (same pattern as the legacy-import guard — no migration needed). One row per configured hour,
// overwritten in place with the LOCAL dateKey it last fired on: value !== today ⇒ not fired today.
// Being in SQLite (not process memory) is what makes catch-up restart-safe: a restart can't
// double-send, and a slot missed while the machine slept is still known to be unfired.
const slotMetaKey = (hour) => `followup_digest_last:${hour}`;

// Pure decision: which configured slot hours are due to fire NOW — on time or late (catch-up)?
// A slot is due when its wall-clock time has been REACHED today (>= slot:00, not just exactly at
// minute 0) and its durable marker doesn't already say it fired today. So the exact-minute tick
// still fires at 08:00, and a wake-from-sleep at 09:30 fires the missed 08:00 slot at 09:30.
// `firedDateFor(hour)` returns the dateKey the slot last fired on (null if never).
// Exported for tests (pure — clock and marker store are injected).
export function dueDigestSlots({ dateKey, hour, minute, hours, firedDateFor }) {
  const nowMin = hour * 60 + minute;
  return (hours || []).filter((h) => nowMin >= h * 60 && firedDateFor(h) !== dateKey);
}

// Minute loop: fire each configured hour once per day, in the configured TZ, with late catch-up.
export function startFollowupDigest({ slack } = {}) {
  const tick = async () => {
    if (!getFollowupRemindersEnabled()) return;
    const tz = getFollowupTimeZone();
    const { dateKey, hour, minute } = nowInTz(tz);
    const due = dueDigestSlots({
      dateKey,
      hour,
      minute,
      hours: getFollowupDigestHours(),
      firedDateFor: (h) => metaGet(slotMetaKey(h)),
    });
    if (!due.length) return;
    // Slack down? Leave the markers untouched so the slot stays due and we retry next tick.
    if (!client(slack)) return;
    // Mark BEFORE sending (a crash mid-send skips rather than double-sends), and mark ALL due
    // slots but send ONE digest: waking at 15:00 with both 08:00 and 14:00 missed means one
    // catch-up DM, not two identical ones.
    for (const h of due) metaSet(slotMetaKey(h), dateKey);
    try {
      await runDigest(slack);
    } catch (e) {
      console.error("[followups] digest error:", e?.message || e);
    }
  };
  const timer = setInterval(() => {
    tick().catch((e) => console.error("[followups] tick error:", e?.message || e));
  }, 60_000);
  timer.unref?.();
  console.log("[followups] pending-response digest started (08:00 & 14:00 by default, late catch-up after sleep)");
  return timer;
}
