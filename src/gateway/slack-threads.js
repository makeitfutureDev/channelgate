// Personal App Home thread index. Ownership comes from the Slack root, never from a run's author
// or a follow-up participant. Runtime state stays in its existing tables; this index keeps only
// the bounded root preview and explicit completion/outcome facts across restarts.
import { getDb, fromJson } from "../db/index.js";
import { slackThreadFor, isSlackTs } from "../slack/thread-keys.js";
import { messageHasCompletionReaction } from "./completion-reactions.js";

export function getSlackThread(channelId, threadTs) {
  return getDb().prepare("SELECT * FROM slack_threads WHERE channel_id = ? AND thread_ts = ?").get(channelId, threadTs) || null;
}

export function indexSlackThread({ channelId, slug, root }) {
  if (!channelId || !slug || !isSlackTs(root?.ts) || !root.user || root.bot_id || root.subtype === "bot_message") return null;
  const title = String(root.text || "").replace(/<@[A-Z0-9]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 160) || "Conversation with attachments";
  const rootDone = messageHasCompletionReaction(root) ? 1 : 0;
  const lastMessage = Math.floor(Number(root.latest_reply || root.ts) * 1000);
  getDb().prepare(`INSERT INTO slack_threads(channel_id,thread_ts,slug,starter_id,title,updated_ms,root_done,last_message_ms)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(channel_id,thread_ts) DO UPDATE SET
    starter_id=excluded.starter_id,title=excluded.title,slug=excluded.slug,
    last_message_ms=MAX(last_message_ms,excluded.last_message_ms)`)
    .run(channelId, root.ts, slug, root.user, title, Math.floor(Number(root.ts) * 1000), rootDone, lastMessage);
  return getSlackThread(channelId, root.ts);
}

export async function trackSlackThread(client, { channelId, slug, threadKey, messageTs }) {
  const threadTs = slackThreadFor(threadKey);
  if (!threadTs) return;
  try {
    if (!getSlackThread(channelId, threadTs)) {
      const page = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 1 });
      const root = page?.ok !== false && page?.messages?.find((m) => m.ts === threadTs);
      if (!root || !indexSlackThread({ channelId, slug, root })) return;
    }
    // A new message updates activity but does not silently reopen explicitly completed work.
    const at = Math.floor(Number(messageTs) * 1000);
    if (Number.isFinite(at)) getDb().prepare(`UPDATE slack_threads SET updated_ms=MAX(updated_ms,?),
      last_message_ms=MAX(last_message_ms,?),
      error_ms=CASE WHEN ? > error_ms THEN 0 ELSE error_ms END
      WHERE channel_id=? AND thread_ts=?`).run(at, at, at, channelId, threadTs);
  } catch { /* discovery must never break an admitted request */ }
}

export function recordSlackThreadOutcome(channelId, threadKey, { error = false, at = Date.now() } = {}) {
  const threadTs = slackThreadFor(threadKey);
  if (!threadTs) return;
  try {
    getDb().prepare("UPDATE slack_threads SET updated_ms=MAX(updated_ms,?),error_ms=? WHERE channel_id=? AND thread_ts=?")
      .run(at, error ? at : 0, channelId, threadTs);
  } catch { /* best-effort status, not a run admission gate */ }
}

export function setSlackThreadDone(channelId, threadTs, userId, done, at = Date.now()) {
  return Boolean(getDb().prepare("UPDATE slack_threads SET done_ms=?,updated_ms=MAX(updated_ms,?) WHERE channel_id=? AND thread_ts=? AND starter_id=?")
    .run(done ? at : -at, at, channelId, threadTs, userId).changes);
}

export function updateSlackThreadRootCompletion(channelId, root, { reactionAt = 0, completed = messageHasCompletionReaction(root), lastMessageMs = 0, inspectedAt = 0 } = {}) {
  if (!root?.ts) return;
  const done = completed ? 1 : 0;
  const checkedAt = inspectedAt || Date.now();
  // Passive reads have no reaction timestamp and cannot outrank an explicit Reopen.
  // Keep the actual added-event watermark independently of cached evidence: a Home read may
  // observe the check before its event arrives, and accepted messages may arrive out of order.
  getDb().prepare(`UPDATE slack_threads SET root_reaction_ms=MAX(root_reaction_ms,?),
    root_done=CASE WHEN ?>=checked_ms THEN ? ELSE root_done END,checked_ms=MAX(checked_ms,?),
    last_message_ms=CASE WHEN ?>0 THEN
      CASE WHEN ?>=checked_ms AND last_message_ms<=? THEN ? ELSE last_message_ms END
      ELSE MAX(last_message_ms,?) END
    WHERE channel_id=? AND thread_ts=?`)
    .run(done ? reactionAt : 0, checkedAt, done, checkedAt, inspectedAt, checkedAt, inspectedAt, lastMessageMs, lastMessageMs, channelId, root.ts);
}

export function recordSlackThreadMessage(channelId, threadKey, messageTs) {
  const threadTs = slackThreadFor(threadKey);
  const at = Math.floor(Number(messageTs) * 1000);
  if (!threadTs || !Number.isFinite(at)) return;
  getDb().prepare("UPDATE slack_threads SET last_message_ms=MAX(last_message_ms,?) WHERE channel_id=? AND thread_ts=?")
    .run(at, channelId, threadTs);
}

export function slackThreadIsDone(row) {
  return Boolean(row && (row.done_ms > 0 || (row.root_done && (row.done_ms >= 0 || row.root_reaction_ms > Math.abs(row.done_ms)))));
}

// Retain a discovery tombstone so a bot-started/deleted thread cannot starve older history.
export function skipSlackThreadCandidate({ channelId, slug, threadTs }) {
  getDb().prepare(`INSERT INTO slack_threads(channel_id,thread_ts,slug,starter_id,title,updated_ms,checked_ms)
    VALUES(?,?,?,'','',?,?) ON CONFLICT(channel_id,thread_ts) DO UPDATE SET starter_id='',title='',checked_ms=excluded.checked_ms`)
    .run(channelId, threadTs, slug, Math.floor(Number(threadTs) * 1000), Date.now());
}

export function slackThreadsForUser(userId) {
  return getDb().prepare("SELECT * FROM slack_threads WHERE starter_id=? ORDER BY updated_ms DESC,thread_ts DESC").all(userId);
}

// Reconstruct runtime state without importing the engine/spawn graph into App Home.
export function slackThreadRuntime({ pendingApprovals = [] } = {}) {
  const db = getDb();
  const states = new Map();
  const add = (rec, state) => {
    const thread = slackThreadFor(rec?.slackThreadTs || rec?.threadKey || rec?.threadTs);
    if (!rec?.channelId || !thread) return;
    const key = `${rec.channelId}::${thread}`;
    const prev = states.get(key);
    if (!prev || state === "waiting") states.set(key, state);
  };
  for (const row of db.prepare("SELECT data FROM active_runs").all()) {
    const rec = fromJson(row.data, {});
    add(rec, rec.awaitingChoice ? "waiting" : "working");
  }
  for (const row of db.prepare("SELECT data FROM bg_jobs").all()) add(fromJson(row.data, {}), "working");
  for (const row of db.prepare("SELECT data FROM question_requests WHERE status='pending'").all()) add(fromJson(row.data, {}), "waiting");
  for (const row of db.prepare("SELECT data FROM approval_requests WHERE status IN ('pending','executing')").all()) {
    const rec = fromJson(row.data, {});
    add(rec.action || rec, "waiting");
  }
  for (const rec of pendingApprovals) add(rec, "waiting");
  return states;
}

export function slackThreadStatus(row, runtime) {
  if (slackThreadIsDone(row)) return "done";
  return runtime.get(`${row.channel_id}::${row.thread_ts}`) || (row.error_ms ? "error" : "idle");
}

export function slackThreadCandidates(channels) {
  const db = getDb();
  const bySlug = new Map(channels.map((c) => [c.slug, c]));
  const candidates = new Map();
  const add = (channelId, slug, key) => {
    const threadTs = slackThreadFor(key);
    if (!threadTs || getSlackThread(channelId, threadTs)) return;
    candidates.set(`${channelId}::${threadTs}`, { channelId, slug, threadTs });
  };
  for (const row of db.prepare("SELECT slug,thread_key FROM sessions WHERE session_id != ''").all()) {
    const c = bySlug.get(row.slug);
    if (c) add(c.channelId, c.slug, row.thread_key);
  }
  const ids = new Set(channels.map((c) => c.channelId));
  for (const table of ["followup_threads", "active_runs"]) {
    for (const row of db.prepare(`SELECT data FROM ${table}`).all()) {
      const rec = fromJson(row.data, {});
      if (ids.has(rec.channelId)) add(rec.channelId, rec.slug, rec.threadTs || rec.threadKey);
    }
  }
  return [...candidates.values()].sort((a, b) => Number(b.threadTs) - Number(a.threadTs));
}
