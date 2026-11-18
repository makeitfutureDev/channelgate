// Activity metadata for admitted Google Chat and Teams turns. The starter is the first
// observed root human; an unseen native root never confers completion authority.
import { getDb } from '../db/index.js';
import { parseConversationId } from '../platforms/ids.js';
import { notifyThreadChanged } from './thread-changes.js';

function runtimeSnapshot({ pendingApprovals = [] } = {}) {
  const db = getDb();
  const states = new Map();
  const since = new Map();
  const add = (run, status) => {
    if (!run?.channelId || !run?.threadKey) return;
    const key = `${run.channelId}::${run.threadKey}`;
    if (!states.has(key) || status === 'waiting') states.set(key, status);
    const at = Number(run.startedAt);
    if (status === 'working' && Number.isSafeInteger(at) && at > 0 && (!since.has(key) || at < since.get(key))) since.set(key, at);
  };
  const read = (sql, handle) => {
    for (const { data } of db.prepare(sql).all()) {
      try { handle(JSON.parse(data)); } catch { /* malformed old row */ }
    }
  };
  read('SELECT data FROM active_runs', run => {
    if (run.awaitingChoice && run.queuedRunId) return;
    add(run, run.awaitingChoice ? 'waiting' : 'working');
  });
  read('SELECT data FROM bg_jobs', run => add(run, 'working'));
  read("SELECT data FROM question_requests WHERE status='pending'", run => add(run, 'waiting'));
  read("SELECT data FROM approval_requests WHERE status IN ('pending','executing')", run => add(run.action || run, 'waiting'));
  for (const run of pendingApprovals) add(run, 'waiting');
  return { states, since };
}
export function platformThreadRuntime(options = {}) {
  return runtimeSnapshot(options).states;
}
function withRuntime(row, active = runtimeSnapshot()) {
  if (!row) return row;
  const status = row.done_ms > 0 ? 'done' : row.later_ms > 0 ? 'later'
    : active.states.get(`${row.channel_id}::${row.thread_ts}`) || (row.status === 'working' ? 'idle' : row.status);
  return { ...row, status, working_since_ms: status === 'working' ? active.since.get(`${row.channel_id}::${row.thread_ts}`) || 0 : 0 };
}

const STATUSES = new Set(['idle', 'working', 'error', 'done', 'later']);
const changed = (channelId, threadKey) => notifyThreadChanged({ channelId, threadTs: threadKey });

export function getPlatformThread(channelId, threadKey) {
  return withRuntime(getDb().prepare('SELECT * FROM platform_threads WHERE channel_id=? AND thread_ts=?').get(channelId, threadKey) || null);
}
export function listPlatformThreadsForUser(userId) {
  const active = runtimeSnapshot();
  return getDb().prepare(`SELECT t.*,p.hidden_ms,p.dismissed_ms,p.last_own_message_ms FROM platform_threads t
    JOIN platform_thread_participants p USING(channel_id,thread_ts) WHERE p.user_id=?
    ORDER BY t.updated_ms DESC,t.thread_ts DESC`).all(userId).map(row => withRuntime(row, active));
}
export function isPlatformThreadParticipant(channelId, threadKey, userId) {
  return Boolean(getDb().prepare('SELECT 1 FROM platform_thread_participants WHERE channel_id=? AND thread_ts=? AND user_id=?').get(channelId, threadKey, userId));
}

// Construct links from normalized platform identifiers. Never persist a supplied URL.
function sourceUrl(message, threadKey) {
  if (message.platform === 'googlechat') {
    const space = /^spaces\/([A-Za-z0-9_-]+)$/.exec(message.rawConversationId);
    const thread = /^spaces\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)$/.exec(threadKey);
    if (!space || thread && thread[1] !== space[1]) return '';
    return `https://chat.google.com/room/${encodeURIComponent(space[1])}${thread ? `/${encodeURIComponent(thread[2])}` : ''}`;
  }
  if (message.platform === 'msteams') {
    const conversation = message.rawConversationId;
    if (!conversation || !message.messageId) return '';
    const root = message.kind === 'channel' ? threadKey : message.messageId;
    const url = new URL(`https://teams.microsoft.com/l/message/${encodeURIComponent(conversation)}/${encodeURIComponent(root)}`);
    const tenant = message.raw?.tenantId;
    const team = message.raw?.teamId;
    if (tenant) url.searchParams.set('tenantId', String(tenant));
    if (team) url.searchParams.set('groupId', String(team));
    if (message.kind !== 'channel') url.searchParams.set('context', JSON.stringify({ contextType: 'chat' }));
    return url.href;
  }
  return '';
}
export function platformThreadUrl(row) {
  try {
    const url = new URL(row?.source_url);
    const expected = { googlechat: 'chat.google.com', msteams: 'teams.microsoft.com' }[row?.platform];
    return expected && url.protocol === 'https:' && url.hostname === expected && !url.username && !url.password && !url.port ? url.href : '';
  } catch { return ''; }
}

function messageTime(message) {
  const raw = message.raw?.message?.createTime || message.raw?.activity?.timestamp;
  const at = Date.parse(raw);
  return Number.isSafeInteger(at) && at > 0 ? at : Date.now();
}
export function recordPlatformThreadMessage({ message, slug, threadKey }) {
  if (!message || message.trigger && message.trigger !== 'message' || !message.userId || !message.messageId || !slug || !threadKey) return null;
  if (!['googlechat', 'msteams'].includes(message.platform) || parseConversationId(message.conversationId).platform !== message.platform) return null;
  const db = getDb();
  const at = messageTime(message);
  const channel = message.conversationId;
  const rootKnown = message.isDM === true && threadKey === message.conversationId || (message.platform === 'googlechat'
    ? message.raw?.message?.threadReply === false && Boolean(message.threadKey)
    : message.kind === 'channel' ? message.messageId === message.threadKey
      : message.kind === 'group' && !message.replyToId);
  const starter = rootKnown ? message.userId : '';
  const title = String(message.text || '').replace(/\s+/g, ' ').trim().slice(0, 160) || 'Conversation with attachments';
  db.exec('BEGIN IMMEDIATE');
  try {
    const duplicate = db.prepare('SELECT 1 FROM platform_thread_messages WHERE channel_id=? AND message_id=?').get(channel, message.messageId);
    if (duplicate) { db.exec('COMMIT'); return getPlatformThread(channel, threadKey); }
    db.prepare(`INSERT INTO platform_threads(channel_id,thread_ts,platform,slug,starter_id,title,updated_ms,last_message_ms,source_url)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(channel_id,thread_ts) DO UPDATE SET
      starter_id=CASE WHEN platform_threads.starter_id='' THEN excluded.starter_id ELSE platform_threads.starter_id END,
      title=CASE WHEN platform_threads.starter_id='' AND excluded.starter_id!='' THEN excluded.title ELSE platform_threads.title END`)
      .run(channel, threadKey, message.platform, slug, starter, title, at, at, sourceUrl(message, threadKey));
    db.prepare('INSERT INTO platform_thread_messages(channel_id,message_id,thread_ts,message_ms) VALUES(?,?,?,?)').run(channel, message.messageId, threadKey, at);
    db.prepare(`INSERT INTO platform_thread_participants(channel_id,thread_ts,user_id,last_own_message_ms) VALUES(?,?,?,?)
      ON CONFLICT(channel_id,thread_ts,user_id) DO UPDATE SET
      hidden_ms=CASE WHEN excluded.last_own_message_ms>MAX(hidden_ms,last_own_message_ms) THEN 0 ELSE hidden_ms END,
      dismissed_ms=CASE WHEN excluded.last_own_message_ms>MAX(dismissed_ms,last_own_message_ms) THEN 0 ELSE dismissed_ms END,
      last_own_message_ms=MAX(last_own_message_ms,excluded.last_own_message_ms)`)
      .run(channel, threadKey, message.userId, at);
    db.prepare(`UPDATE platform_threads SET updated_ms=MAX(updated_ms,?),last_message_ms=MAX(last_message_ms,?),
      status=CASE WHEN ?>MAX(last_message_ms,done_ms,later_ms,completion_reopened_ms) THEN 'idle' ELSE status END,
      done_ms=CASE WHEN ?>MAX(done_ms,later_ms,completion_reopened_ms) THEN 0 ELSE done_ms END,
      later_ms=CASE WHEN ?>MAX(done_ms,later_ms,completion_reopened_ms) THEN 0 ELSE later_ms END,
      error_ms=CASE WHEN ?>error_ms THEN 0 ELSE error_ms END
      WHERE channel_id=? AND thread_ts=?`).run(at, at, at, at, at, at, channel, threadKey);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  changed(channel, threadKey);
  return getPlatformThread(channel, threadKey);
}

export function recordPlatformThreadOutcome(channelId, threadKey, { status = 'idle', at = Date.now() } = {}) {
  if (!STATUSES.has(status)) return false;
  const result = getDb().prepare(`UPDATE platform_threads SET status=CASE WHEN done_ms>0 THEN 'done' WHEN later_ms>0 THEN 'later' ELSE ? END,
    error_ms=CASE WHEN ?='error' THEN ? ELSE 0 END, updated_ms=MAX(updated_ms,?) WHERE channel_id=? AND thread_ts=?`)
    .run(status, status, at, at, channelId, threadKey);
  if (result.changes) changed(channelId, threadKey);
  return Boolean(result.changes);
}
export function setPlatformThreadHidden(channelId, threadKey, userId, hidden, at = Date.now()) {
  if (!Number.isSafeInteger(at) || at <= 0) return false;
  const result = getDb().prepare(`UPDATE platform_thread_participants SET hidden_ms=CASE WHEN ? THEN MAX(?,hidden_ms,last_own_message_ms) ELSE 0 END
    WHERE channel_id=? AND thread_ts=? AND user_id=?`).run(hidden ? 1 : 0, at, channelId, threadKey, userId);
  if (result.changes) changed(channelId, threadKey);
  return Boolean(result.changes);
}
export function setPlatformThreadDone(channelId, threadKey, userId, done, at = Date.now()) {
  if (!Number.isSafeInteger(at) || at <= 0) return false;
  const result = getDb().prepare(`UPDATE platform_threads SET done_ms=?,later_ms=0,status=?,updated_ms=MAX(updated_ms,?),
    completion_reopened_ms=CASE WHEN ? THEN completion_reopened_ms ELSE MAX(completion_reopened_ms,?) END
    WHERE channel_id=? AND thread_ts=? AND starter_id=?`).run(done ? at : 0, done ? 'done' : 'idle', at, done ? 1 : 0, at, channelId, threadKey, userId);
  if (result.changes) {
    if (done) getDb().prepare('UPDATE platform_thread_participants SET dismissed_ms=? WHERE channel_id=? AND thread_ts=? AND user_id=?').run(at, channelId, threadKey, userId);
    else getDb().prepare('UPDATE platform_thread_participants SET dismissed_ms=0 WHERE channel_id=? AND thread_ts=?').run(channelId, threadKey);
    changed(channelId, threadKey);
  }
  return Boolean(result.changes);
}
export function setPlatformThreadLater(channelId, threadKey, userId, later, at = Date.now()) {
  if (!Number.isSafeInteger(at) || at <= 0) return false;
  const result = getDb().prepare(`UPDATE platform_threads SET later_ms=?,done_ms=CASE WHEN ? THEN 0 ELSE done_ms END,
    status=CASE WHEN ? THEN 'later' WHEN done_ms>0 THEN 'done' ELSE 'idle' END,updated_ms=MAX(updated_ms,?)
    WHERE channel_id=? AND thread_ts=? AND starter_id=?`).run(later ? at : 0, later ? 1 : 0, later ? 1 : 0, at, channelId, threadKey, userId);
  if (result.changes) {
    if (later) getDb().prepare('UPDATE platform_thread_participants SET dismissed_ms=0 WHERE channel_id=? AND thread_ts=?').run(channelId, threadKey);
    changed(channelId, threadKey);
  }
  return Boolean(result.changes);
}
export function refreshPlatformThread(channelId, threadKey) {
  return getPlatformThread(channelId, threadKey);
}
