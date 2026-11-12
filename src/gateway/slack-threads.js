// Personal App Home thread index. Ownership comes from the Slack root, never from a run's author
// or a follow-up participant. Runtime state stays in its existing tables; this index keeps only
// the bounded root preview and explicit completion/outcome facts across restarts.
import { getDb, fromJson } from "../db/index.js";
import { slackThreadFor, isSlackTs } from "../slack/thread-keys.js";
import { messageHasCompletionReaction } from "./completion-reactions.js";
import { notifyThreadChanged } from "./thread-changes.js";

export function getSlackThread(channelId, threadTs) {
  return getDb().prepare("SELECT * FROM slack_threads WHERE channel_id = ? AND thread_ts = ?").get(channelId, threadTs) || null;
}

export function indexSlackThread({ channelId, slug, root, agentEngaged = false }) {
  if (!channelId || !slug || !isSlackTs(root?.ts) || !root.user || root.bot_id || root.subtype === "bot_message") return null;
  const previous = getSlackThread(channelId, root.ts);
  const title = String(root.text || "").replace(/<@[A-Z0-9]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 160) || "Conversation with attachments";
  const rootDone = messageHasCompletionReaction(root) ? 1 : 0;
  const lastMessage = Math.floor(Number(root.latest_reply || root.ts) * 1000);
  getDb().prepare(`INSERT INTO slack_threads(channel_id,thread_ts,slug,starter_id,title,updated_ms,root_done,last_message_ms,agent_engaged)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(channel_id,thread_ts) DO UPDATE SET
    starter_id=excluded.starter_id,
    title=CASE WHEN session_title!='' THEN session_title ELSE excluded.title END,slug=excluded.slug,
    agent_engaged=MAX(agent_engaged,excluded.agent_engaged),
    last_message_ms=MAX(last_message_ms,excluded.last_message_ms)`)
    .run(channelId, root.ts, slug, root.user, title, Math.floor(Number(root.ts) * 1000), rootDone, lastMessage, agentEngaged === true ? 1 : 0);
  const current = getSlackThread(channelId, root.ts);
  if (!previous || ["starter_id", "title", "slug", "agent_engaged", "last_message_ms"].some((key) => previous[key] !== current[key])) {
    notifyThreadChanged({ channelId, threadTs: root.ts });
  }
  return current;
}

// Slack already authenticated this metadata event. Only update known human roots; an event
// never creates ownership/engagement or starts a run. Activity readers still authorize viewers.
export function renameSlackThread({ channelId, threadTs, title, eventTs } = {}) {
  if (!channelId || !isSlackTs(threadTs) || !isSlackTs(eventTs) || typeof title !== "string") return false;
  const clean = title.trim().slice(0, 200);
  const timestamp = Number(eventTs);
  if (!clean || !Number.isFinite(timestamp) || timestamp <= 0) return false;
  const previous = getSlackThread(channelId, threadTs);
  if (!previous?.starter_id) return false;
  const changed = getDb().prepare(`UPDATE slack_threads SET title=?,session_title=?,session_title_ts=?
    WHERE channel_id=? AND thread_ts=? AND starter_id!='' AND session_title_ts<?`)
    .run(clean, clean, timestamp, channelId, threadTs, timestamp).changes;
  if (changed && previous.title !== clean) notifyThreadChanged({ channelId, threadTs });
  return Boolean(changed);
}

export async function trackSlackThread(client, { channelId, slug, threadKey, messageTs }) {
  const threadTs = slackThreadFor(threadKey);
  if (!threadTs) return;
  try {
    if (!getSlackThread(channelId, threadTs)) {
      const page = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 1 });
      const root = page?.ok !== false && page?.messages?.find((m) => m.ts === threadTs);
      if (!root || !indexSlackThread({ channelId, slug, root, agentEngaged: true })) return;
    }
    markSlackThreadEngaged(channelId, threadTs);
    // A new message updates activity but does not silently reopen explicitly completed work.
    const at = Math.floor(Number(messageTs) * 1000);
    if (Number.isFinite(at)) getDb().prepare(`UPDATE slack_threads SET updated_ms=MAX(updated_ms,?),
      last_message_ms=MAX(last_message_ms,?),
      error_ms=CASE WHEN ? > error_ms THEN 0 ELSE error_ms END
      WHERE channel_id=? AND thread_ts=?`).run(at, at, at, channelId, threadTs);
    notifyThreadChanged({ channelId, threadTs });
  } catch { /* discovery must never break an admitted request */ }
}

export function recordSlackThreadOutcome(channelId, threadKey, { error = false, at = Date.now() } = {}) {
  const threadTs = slackThreadFor(threadKey);
  if (!threadTs) return;
  try {
    getDb().prepare("UPDATE slack_threads SET agent_engaged=1,updated_ms=MAX(updated_ms,?),error_ms=? WHERE channel_id=? AND thread_ts=?")
      .run(at, error ? at : 0, channelId, threadTs);
    notifyThreadChanged({ channelId, threadTs });
  } catch { /* best-effort status, not a run admission gate */ }
}

export function setSlackThreadDone(channelId, threadTs, userId, done, at = Date.now()) {
  const changed = Boolean(getDb().prepare("UPDATE slack_threads SET done_ms=?,later_ms=0,updated_ms=MAX(updated_ms,?),completion_marker_retry_ms=? WHERE channel_id=? AND thread_ts=? AND starter_id=?")
    .run(done ? at : -at, at, at, channelId, threadTs, userId).changes);
  if (changed) notifyThreadChanged({ channelId, threadTs });
  return changed;
}

// A personal postponement is durable display state, never a cancellation or a timer.
export function setSlackThreadLater(channelId, threadTs, userId, later, at = Date.now()) {
  const changed = Boolean(getDb().prepare(`UPDATE slack_threads SET later_ms=?,
    done_ms=CASE WHEN ? THEN ? ELSE done_ms END,updated_ms=MAX(updated_ms,?),
    completion_marker_retry_ms=?
    WHERE channel_id=? AND thread_ts=? AND starter_id=?`)
    .run(later ? at : 0, later ? 1 : 0, -at, at, at, channelId, threadTs, userId).changes);
  if (changed) notifyThreadChanged({ channelId, threadTs });
  return changed;
}

export function updateSlackThreadRootCompletion(channelId, root, { reactionAt = 0, completed = messageHasCompletionReaction(root), lastMessageMs = 0, inspectedAt = 0 } = {}) {
  if (!root?.ts) return;
  const previous = getSlackThread(channelId, root.ts);
  const done = completed ? 1 : 0;
  const checkedAt = inspectedAt || Date.now();
  // Passive reads have no reaction timestamp and cannot outrank an explicit Reopen.
  // Keep the actual added-event watermark independently of cached evidence: a Home read may
  // observe the check before its event arrives, and accepted messages may arrive out of order.
  getDb().prepare(`UPDATE slack_threads SET root_reaction_ms=MAX(root_reaction_ms,?),
    root_done=CASE WHEN ?>=checked_ms THEN ? ELSE root_done END,checked_ms=MAX(checked_ms,?),
    last_message_ms=CASE WHEN ?>0 THEN
      CASE WHEN ?>=checked_ms AND last_message_ms<=? THEN ? ELSE last_message_ms END
      ELSE MAX(last_message_ms,?) END,
    completion_marker_retry_ms=CASE WHEN (?>=checked_ms AND root_done!=?) OR ?>root_reaction_ms
      THEN ? ELSE completion_marker_retry_ms END
    WHERE channel_id=? AND thread_ts=?`)
    .run(done ? reactionAt : 0, checkedAt, done, checkedAt, inspectedAt, checkedAt, inspectedAt, lastMessageMs, lastMessageMs, checkedAt, done, done ? reactionAt : 0, Date.now(), channelId, root.ts);
  const current = getSlackThread(channelId, root.ts);
  if (current && ["root_done", "root_reaction_ms", "last_message_ms"].some((key) => previous?.[key] !== current[key])) {
    notifyThreadChanged({ channelId, threadTs: root.ts });
  }
}

export function recordSlackThreadMessage(channelId, threadKey, messageTs, { human = false } = {}) {
  const threadTs = slackThreadFor(threadKey);
  const at = Math.floor(Number(messageTs) * 1000);
  if (!threadTs || !isSlackTs(messageTs) || !Number.isFinite(at)) return false;
  // A fresh human reply resumes postponed work, even without an agent mention. Ignore
  // old deliveries and keep the saved clock until its durable cleanup has succeeded.
  const resumed = human && getDb().prepare(`UPDATE slack_threads SET later_ms=0,
    updated_ms=MAX(updated_ms,?),completion_marker_retry_ms=?
    WHERE channel_id=? AND thread_ts=? AND later_ms>0 AND later_ms<?`)
    .run(at, Date.now(), channelId, threadTs, at).changes > 0;
  const changed = getDb().prepare("UPDATE slack_threads SET last_message_ms=? WHERE channel_id=? AND thread_ts=? AND last_message_ms<?")
    .run(at, channelId, threadTs, at).changes;
  if (changed || resumed) notifyThreadChanged({ channelId, threadTs });
  return Boolean(resumed);
}

export function slackThreadIsDone(row) {
  return Boolean(row && (row.done_ms > 0 || (row.root_done && (row.done_ms >= 0 || row.root_reaction_ms > Math.abs(row.done_ms)))));
}

// Retain a discovery tombstone so a bot-started/deleted thread cannot starve older history.
export function skipSlackThreadCandidate({ channelId, slug, threadTs }) {
  getDb().prepare(`INSERT INTO slack_threads(channel_id,thread_ts,slug,starter_id,title,updated_ms,checked_ms)
    VALUES(?,?,?,'','',?,?) ON CONFLICT(channel_id,thread_ts) DO UPDATE SET starter_id='',title='',checked_ms=excluded.checked_ms`)
    .run(channelId, threadTs, slug, Math.floor(Number(threadTs) * 1000), Date.now());
  notifyThreadChanged({ channelId, threadTs });
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
    const rec = fromJson(row.data, {}) || {};
    add(rec, rec.awaitingChoice ? "waiting" : "working");
  }
  for (const row of db.prepare("SELECT data FROM bg_jobs").all()) add(fromJson(row.data, {}), "working");
  for (const row of db.prepare("SELECT data FROM question_requests WHERE status='pending'").all()) add(fromJson(row.data, {}), "waiting");
  for (const row of db.prepare("SELECT data FROM approval_requests WHERE status IN ('pending','executing')").all()) {
    const rec = fromJson(row.data, {}) || {};
    add(rec.action || rec, "waiting");
  }
  for (const rec of pendingApprovals) add(rec, "waiting");
  return states;
}

// Earliest accepted-run start per thread, for Activity's "running for" clock. Waiting turns
// (awaitingChoice) are excluded: their clock belongs to the person, not the agent.
export function slackThreadWorkingSince() {
  const db = getDb();
  const since = new Map();
  const add = (rec) => {
    const thread = slackThreadFor(rec?.slackThreadTs || rec?.threadKey || rec?.threadTs);
    const at = Number(rec?.startedAt);
    if (!rec?.channelId || !thread || rec.awaitingChoice || !Number.isSafeInteger(at) || at <= 0) return;
    const key = `${rec.channelId}::${thread}`;
    if (!since.has(key) || at < since.get(key)) since.set(key, at);
  };
  for (const table of ["active_runs", "bg_jobs"]) {
    for (const row of db.prepare(`SELECT data FROM ${table}`).all()) add(fromJson(row.data, {}) || {});
  }
  return since;
}

export function slackThreadStatus(row, runtime) {
  if (slackThreadIsDone(row)) return "done";
  if (row.later_ms > 0) return "later";
  return runtime.get(`${row.channel_id}::${row.thread_ts}`) || (row.error_ms ? "error" : "idle");
}

// Live-only discovery: an accepted/queued turn can precede the ordinary root index write.
// Shell jobs and historical sessions must not turn unrelated conversations into agent threads.
export function liveSlackThreadCandidates() {
  const candidates = new Map();
  for (const table of ["active_runs", "bg_jobs"]) {
    for (const row of getDb().prepare(`SELECT data FROM ${table}`).all()) {
      const rec = fromJson(row.data, {}) || {};
      if (table === "bg_jobs" && rec.kind !== "agent") continue;
      const threadTs = slackThreadFor(rec.slackThreadTs || rec.threadKey || rec.threadTs);
      if (!rec.channelId || !threadTs || getSlackThread(rec.channelId, threadTs)) continue;
      candidates.set(`${rec.channelId}::${threadTs}`, { channelId: rec.channelId, threadTs });
    }
  }
  return [...candidates.values()].sort((a, b) => Number(b.threadTs) - Number(a.threadTs));
}

// Observation alone is not participation: ordinary human follow-ups and unrelated bots are
// recorded too. Only gateway sessions/runs, agent jobs, and the gateway-specific aiInvolved bit
// establish engagement. The marker survives session clearing and runtime-row cleanup.
export function markSlackThreadEngaged(channelId, threadTs) {
  const changed = getDb().prepare("UPDATE slack_threads SET agent_engaged=1 WHERE channel_id=? AND thread_ts=? AND agent_engaged=0")
    .run(channelId, threadTs).changes;
  if (changed) notifyThreadChanged({ channelId, threadTs });
}

function engagementEvidence() {
  const db = getDb();
  const bySlug = new Map();
  const byChannel = new Map();
  for (const row of db.prepare("SELECT slug,thread_key FROM sessions WHERE trim(session_id) != ''").all()) {
    const threadTs = slackThreadFor(row.thread_key);
    if (threadTs) bySlug.set(`${row.slug}::${threadTs}`, { slug: row.slug, threadTs });
  }
  for (const table of ["followup_threads", "active_runs", "bg_jobs"]) {
    for (const row of db.prepare(`SELECT data FROM ${table}`).all()) {
      const rec = fromJson(row.data, {}) || {};
      if (table === "followup_threads" && rec.aiInvolved !== true) continue;
      if (table === "bg_jobs" && rec.kind !== "agent") continue;
      const threadTs = slackThreadFor(rec.slackThreadTs || rec.threadTs || rec.threadKey);
      if (rec.channelId && threadTs) byChannel.set(`${rec.channelId}::${threadTs}`, { channelId: rec.channelId, threadTs });
    }
  }
  return { bySlug, byChannel };
}

export function isSlackThreadEligible(row, evidence = engagementEvidence()) {
  if (!row?.starter_id) return false;
  if (row.agent_engaged === 1) return true;
  const engaged = evidence.bySlug.has(`${row.slug}::${row.thread_ts}`) || evidence.byChannel.has(`${row.channel_id}::${row.thread_ts}`);
  if (engaged) markSlackThreadEngaged(row.channel_id, row.thread_ts);
  return engaged;
}

export function eligibleSlackThreadsForUser(userId) {
  const evidence = engagementEvidence();
  return slackThreadsForUser(userId).filter((row) => isSlackThreadEligible(row, evidence));
}

export function slackThreadCandidates(channels) {
  const evidence = engagementEvidence();
  const bySlug = new Map(channels.map((c) => [c.slug, c]));
  const byId = new Map(channels.map((c) => [c.channelId, c]));
  const candidates = new Map();
  const add = (entry, threadTs) => {
    if (!entry) return;
    const { channelId, slug } = entry;
    if (getSlackThread(channelId, threadTs)) {
      markSlackThreadEngaged(channelId, threadTs);
      return;
    }
    candidates.set(`${channelId}::${threadTs}`, { channelId, slug, threadTs });
  };
  for (const row of evidence.bySlug.values()) add(bySlug.get(row.slug), row.threadTs);
  for (const row of evidence.byChannel.values()) add(byId.get(row.channelId), row.threadTs);
  return [...candidates.values()].sort((a, b) => Number(b.threadTs) - Number(a.threadTs));
}
