// Opt-in, single-thread "no-response" nudges. The only state is a per-thread timestamp + a couple
// of flags held in memory (lost on restart, which is fine for a best-effort nudge). When the user
// who requested the bot's last reply has reminders enabled, and that reply has gone unanswered
// past the threshold (default 24h), the daemon posts ONE gentle reminder addressed to that user in
// the same thread — never scanning other channels, never persisting cross-conversation state.
import { getUser } from "../config/store.js";
import { getNoResponseReminderHours, userNudgesEnabled } from "../config/settings.js";
import { logEvent } from "../util/logger.js";
import { postNotice } from "../platforms/notify.js";

const threads = new Map(); // "<slug>::<threadKey>" -> { channelId, slug, threadKey, userId, lastBotTs, awaitingUser, reminded }
const key = (slug, threadKey) => `${slug}::${threadKey}`;

// How long a tracked thread may live before it's forgotten. Entries only leave the map when the
// user replies — reminded threads (and never-answered ones in channels that never opt in) would
// otherwise accumulate forever. Well past the nudge threshold (default 24h), so nothing expires
// before its reminder is due.
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Drop entries older than the TTL. Exported for tests (pure over the passed map).
export function pruneExpired(map, nowMs, ttlMs = TTL_MS) {
  for (const [k, rec] of map) {
    if (nowMs - (rec.lastBotTs || 0) > ttlMs) map.delete(k);
  }
}

// The bot just replied in a thread → it's now (potentially) awaiting the user.
export function noteBotReply(channelId, slug, threadKey, userId, { map = threads, nowMs = Date.now() } = {}) {
  if (!slug || !threadKey || !userId) return;
  map.set(key(slug, threadKey), { channelId, slug, threadKey, userId, lastBotTs: nowMs, awaitingUser: true, reminded: false });
}

// The user posted in a thread → any pending reminder is answered; stop tracking it.
export function noteUserActivity(slug, threadKey) {
  if (!slug || !threadKey) return;
  threads.delete(key(slug, threadKey));
}

function client(slack) {
  return slack?.snapshot?.().connected ? slack.getClient?.() ?? null : null;
}

export async function sweepNudges(slack, {
  map = threads,
  nowMs = Date.now(),
  thresholdMs = getNoResponseReminderHours() * 60 * 60 * 1000,
  loadUser = getUser,
  post = postNotice,
  log = logEvent,
} = {}) {
  pruneExpired(map, nowMs); // TTL first, even when Slack is disconnected
  const c = client(slack);
  if (!c) return;
  for (const rec of map.values()) {
    if (!rec.awaitingUser || rec.reminded) continue;
    if (nowMs - rec.lastBotTs < thresholdMs) continue;
    let user;
    try {
      user = await loadUser(rec.userId);
    } catch {
      user = null;
    }
    if (!userNudgesEnabled(user)) continue;
    rec.reminded = true;
    rec.awaitingUser = false;
    try {
      await post(c, {
        conversationId: rec.channelId,
        threadKey: rec.threadKey,
        text: `👋 <@${rec.userId}> Just checking in — this thread's been quiet for a while. Reply here if you'd like me to keep going, or ignore this and I'll stand down.`,
      });
      await log("nudge_sent", { slug: rec.slug, channel: rec.channelId, author: rec.userId });
    } catch {
      /* couldn't post — leave it reminded so we don't retry-spam */
    }
  }
}

// Start the periodic sweep (default every 30 min). Returns the timer.
export function startNudgeSweep({ slack, intervalMs = 30 * 60 * 1000 } = {}) {
  const timer = setInterval(() => {
    sweepNudges(slack).catch((e) => console.error("[nudges] sweep error:", e?.message || e));
  }, intervalMs);
  timer.unref?.();
  console.log("[nudges] no-response reminder sweep started");
  return timer;
}
