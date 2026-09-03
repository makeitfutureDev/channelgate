// Opt-in, single-thread "no-response" nudges. The only state is a per-thread timestamp + a couple
// of flags held in memory (lost on restart, which is fine for a best-effort nudge). When a channel
// opts in (meta.nudges), and the bot's last message in a thread has gone unanswered past the
// threshold (default 24h), the daemon posts ONE gentle reminder in that same thread — never
// scanning other channels, never persisting cross-conversation state. This is the confinement-safe
// sliver of Claude Tag's ambient "tag you when a thread stalls".
import { getChannelMeta } from "../config/store.js";
import { getNoResponseReminderHours } from "../config/settings.js";
import { logEvent } from "../util/logger.js";
import { postNotice } from "../platforms/notify.js";

const threads = new Map(); // "<slug>::<threadKey>" -> { channelId, slug, threadKey, lastBotTs, awaitingUser, reminded }
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
export function noteBotReply(channelId, slug, threadKey) {
  if (!slug || !threadKey) return;
  threads.set(key(slug, threadKey), { channelId, slug, threadKey, lastBotTs: Date.now(), awaitingUser: true, reminded: false });
}

// The user posted in a thread → any pending reminder is answered; stop tracking it.
export function noteUserActivity(slug, threadKey) {
  if (!slug || !threadKey) return;
  threads.delete(key(slug, threadKey));
}

function client(slack) {
  return slack?.snapshot?.().connected ? slack.getClient?.() ?? null : null;
}

async function sweep(slack) {
  const now = Date.now();
  pruneExpired(threads, now); // TTL first, even when Slack is disconnected
  const c = client(slack);
  if (!c) return;
  const thresholdMs = getNoResponseReminderHours() * 60 * 60 * 1000;
  for (const rec of threads.values()) {
    if (!rec.awaitingUser || rec.reminded) continue;
    if (now - rec.lastBotTs < thresholdMs) continue;
    let meta;
    try {
      meta = await getChannelMeta(rec.slug);
    } catch {
      meta = null;
    }
    if (!meta?.nudges) continue; // channel hasn't opted in
    rec.reminded = true;
    rec.awaitingUser = false;
    try {
      await postNotice(c, {
        conversationId: rec.channelId,
        threadKey: rec.threadKey,
        text: "👋 Just checking in — this thread's been quiet for a while. Reply here if you'd like me to keep going, or ignore this and I'll stand down.",
      });
      await logEvent("nudge_sent", { slug: rec.slug, channel: rec.channelId });
    } catch {
      /* couldn't post — leave it reminded so we don't retry-spam */
    }
  }
}

// Start the periodic sweep (default every 30 min). Returns the timer.
export function startNudgeSweep({ slack, intervalMs = 30 * 60 * 1000 } = {}) {
  const timer = setInterval(() => {
    sweep(slack).catch((e) => console.error("[nudges] sweep error:", e?.message || e));
  }, intervalMs);
  timer.unref?.();
  console.log("[nudges] no-response reminder sweep started");
  return timer;
}
