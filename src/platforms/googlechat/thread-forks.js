// Thread forks in Google Chat: an approved `propose_thread_forks` batch and the typed `/fork`.
//
// A fork is a NEW top-level message in the same named, threaded space (Chat starts a new thread for
// it), posted by the app with the fork's title. Its opening request is posted into that thread and
// runs as a turn AUTHORED BY THE REQUESTER, through the transport's durable intake, starting from a
// native copy (engine session fork) of the source thread's session. The source thread gets a link.
//
// Ordering, the same contract as Slack's (src/slack/thread-fork-batch.js):
//   • the source session is HELD first — its queued messages stay in SQLite and its lane is
//     reserved — so the copy is taken after the running source turn and before any later request;
//   • every child's copy is taken before the hold is released (each child signals onSourceForked,
//     or its first turn ends without one);
//   • children run under the ordinary admission, license and run-slot gates.
// Nothing here waits inside a card click or a control lane: an approval returns at once and the
// batch continues on its own, so /stop and a permission card in the source thread stay reachable
// while it waits. Created thread names are journaled on the approval row as they appear; a restart
// consumes the batch without recreating anything.
import { randomUUID } from 'node:crypto';
import { getUser } from '../../config/store.js';
import { threadForkTarget } from '../../gateway/thread-fork-approvals.js';
import { transitionApprovalRequest } from '../../gateway/approval-requests.js';
import { getThreadModel, getThreadEffort, getThreadClean, setThreadEngine, setThreadModel, setThreadEffort, setThreadClean } from '../../gateway/thread-engine.js';
import { recordPlatformThreadMessage } from '../../gateway/platform-threads.js';
import { abortPooled } from '../../engines/session-pool.js';
import { assertEngineSelectable } from '../../engines/selection.js';
import { isForceStopping } from '../../gateway/shutdown.js';
import { forkLicensePool } from '../../slack/fork-thread.js';
import { formatThreadExcerpt } from '../thread-hydration.js';
import { parseModelShortcut } from '../../config/model-shortcuts.js';
import { googleChatAdapter } from '../googlechat.js';
import { isSpaceName, isThreadName, isMessageName } from './api.js';

const SPACE_TTL_MS = 10 * 60_000;
// Named spaces with real threads (THREADED_MESSAGES) or topics (GROUPED_MESSAGES, the legacy
// topic-based rooms): a new top-level message starts a new thread/topic in both.
const THREADED_STATES = new Set(['THREADED_MESSAGES', 'GROUPED_MESSAGES']);
export const FORK_NOT_THREADED = 'This Google Chat space does not use threads, so there is no thread to fork into. Use a named space with threaded replies.';
export const FORK_FLAT_CHAT = 'Google Chat direct messages and group chats have no threads to fork into. Use a named space that has threads.';
const FORK_TEXT_MAX = 2000;

const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim();
// Titles and prompts are model or user text. Brackets would break out of a Markdown link label;
// mentions and broadcasts are defanged later by the surface formatter.
const label = value => oneLine(value).replace(/[[\]]/g, c => (c === '[' ? '(' : ')'));
const spaceOf = conversationId => String(conversationId || '').replace(/^gchat:/, '');
export function googleChatThreadUrl(space, thread) {
  const s = /^spaces\/([A-Za-z0-9_-]+)$/.exec(space);
  const t = /^spaces\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_.-]+)$/.exec(thread);
  if (!s || !t || t[1] !== s[1]) return '';
  return `https://chat.google.com/room/${encodeURIComponent(s[1])}/${encodeURIComponent(t[2])}`;
}
const link = (text, url) => url ? `[${label(text)}](${url})` : label(text);

function forkTitle(text) {
  const line = oneLine(text);
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}

// `/fork <new message>`: null when the text is not a fork command; else { task } or { error }.
export function parseForkCommand(text) {
  const match = /^\/fork(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  if (!match) return null;
  const task = String(match[1] || '').trim();
  if (!task) return { error: 'Use `/fork <new message>` in a thread of a named, threaded space that already has a Claude or Codex answer. The new thread starts from a copy of this thread’s session.' };
  if (parseModelShortcut(task)) return { error: 'Model shortcuts are not available for `/fork` in Google Chat yet. Send `/fork <new message>`, then change the new thread’s runtime there with `/model`.' };
  if (task.length > FORK_TEXT_MAX) return { error: `Keep a \`/fork\` message under ${FORK_TEXT_MAX} characters; the new thread can continue from there.` };
  return { task };
}

export function createGoogleChatThreadForks({ connector, conversation, formatText = null, now = Date.now, log = console } = {}) {
  if (!connector || !conversation?.execute) throw new TypeError('Google Chat thread forks need the connector and the conversation lanes');
  const spaces = new Map();
  // Fork id → the live barrier hooks of a child whose first turn has not settled. Process-local on
  // purpose: after a restart no source is held, so a queued child simply runs.
  const hooks = new Map();
  // Child sessions between their root post and the moment their opening request is queued.
  const starting = new Set();
  const laneKey = (conversationId, sessionKey) => JSON.stringify([conversationId, sessionKey]);
  // Every app post here carries model or user text: the surface formatter defangs mentions and
  // broadcasts and writes the Markdown Chat renders, exactly as for an answer.
  const safe = typeof formatText === 'function' ? formatText
    : text => googleChatAdapter.formatOutbound(String(text)).chunks.map(chunk => chunk.text).join('\n') || String(text);
  const post = (space, threadKey, text) => connector.post({ conversationId: space, threadKey, text: safe(text) });

  // Why this conversation cannot hold forks ('' when it can). DMs and group chats are refused by
  // the shared gate from the stored conversation kind; the threading state is a live space fact.
  async function refusal(conversationId) {
    const space = spaceOf(conversationId);
    if (!isSpaceName(space)) return FORK_FLAT_CHAT;
    let info = spaces.get(space);
    if (!info || info.until <= now()) {
      try {
        const value = await connector.api.getSpace(space);
        info = { value, until: now() + SPACE_TTL_MS };
        spaces.set(space, info);
        if (spaces.size > 500) spaces.delete(spaces.keys().next().value);
      } catch (error) {
        log.warn?.(`[googlechat] space lookup for forks failed: ${error?.message || error}`);
        return 'Google Chat did not confirm that this space has threads, so no fork was created. Try again in a moment.';
      }
    }
    const kind = String(info.value?.spaceType || info.value?.type || '').toUpperCase();
    if (kind && kind !== 'SPACE' && kind !== 'ROOM') return FORK_FLAT_CHAT;
    if (!THREADED_STATES.has(String(info.value?.spaceThreadingState || '').toUpperCase())) return FORK_NOT_THREADED;
    return '';
  }

  // The source thread's earlier messages for a child whose engine refuses the native copy before
  // running anything (run.js isForkUnavailable). Needs the history app scope; "" without it.
  function fallbackContext({ space, sourceThreadKey, cutoff }) {
    return async () => {
      if (typeof connector.readHistory !== 'function') return '';
      const rows = await connector.readHistory({ conversationId: space, threadKey: sourceThreadKey, limit: 30 });
      return formatThreadExcerpt(rows, { label: 'Google Chat', triggerTime: cutoff });
    };
  }

  // Creates every child of one request inside the source session's reserved lane.
  async function createAll(job, signal) {
    const { conversationId, slug, sourceKey, authorId, forks, approvalId, action } = job;
    const space = spaceOf(conversationId);
    const rows = forks.map(fork => ({ title: fork.title, status: 'pending' }));
    const persist = () => {
      if (!approvalId) return;
      // The approval is consumed as soon as the click returns; journal on whichever row state it has.
      for (const state of ['consumed', 'executing']) {
        try { if (transitionApprovalRequest(approvalId, state, state, { forks: rows })) return; }
        catch (error) { log.warn?.(`[googlechat] fork journal failed: ${error?.message || error}`); return; }
      }
    };
    const barrier = [];
    try {
      if (signal.aborted || isForceStopping()) throw new Error('The forks were stopped before creation.');
      const target = await threadForkTarget(action); // current access, lane, session and folder
      await assertEngineSelectable(target.sourceEngine, { channelId: conversationId, meta: target.meta });
      abortPooled(`${slug}::${sourceKey}`); // settle a warm source transcript before copying it
      const model = await getThreadModel(slug, sourceKey), effort = await getThreadEffort(slug, sourceKey);
      const clean = Boolean(target.meta.cleanMode || await getThreadClean(slug, sourceKey));
      const licensePool = await forkLicensePool({ slug, sourceThreadTs: sourceKey, engine: target.sourceEngine, meta: target.meta });
      const sourceUrl = googleChatThreadUrl(space, sourceKey);
      const cutoff = new Date(now()).toISOString();
      const user = await getUser(authorId);
      const creator = oneLine(user?.name) || authorId;
      // The stored space name: a fork turn must never rename the conversation to its resource name.
      const spaceName = oneLine(target.entry?.name || target.meta?.name) || space;
      for (let i = 0; i < forks.length; i++) {
        const fork = forks[i], row = rows[i];
        if (signal.aborted || isForceStopping()) { row.status = 'cancelled'; persist(); continue; }
        let childKey = '';
        try {
          await threadForkTarget(action); // revocation while an earlier Chat call was in flight
          row.status = 'creating';
          persist();
          // No thread name: Chat starts a new thread in the space for this top-level message.
          const root = await post(space, '', `↪️ ${label(creator)} Fork: ${label(fork.title)}`);
          const thread = String(root?.threadKey || '');
          if (!isThreadName(thread) || !thread.startsWith(`${space}/threads/`) || thread === sourceKey) {
            throw new Error('Google Chat did not return a new thread for the fork; creation is uncertain. Do not retry automatically.');
          }
          row.threadKey = thread;
          row.url = googleChatThreadUrl(space, thread);
          row.status = 'created';
          persist();
          childKey = laneKey(conversationId, thread);
          starting.add(childKey);
          // Activity: the requester owns the fork's row, titled like Slack's.
          try {
            recordPlatformThreadMessage({ slug, threadKey: thread, message: {
              platform: 'googlechat', conversationId, rawConversationId: space, kind: 'channel', isDM: false,
              userId: authorId, messageId: isMessageName(root.messageId) ? root.messageId : '', threadKey: thread,
              text: `↪️ ${creator} Fork: ${fork.title}`.replace(/\s+/g, ' ').slice(0, 160),
              raw: { message: { threadReply: false, createTime: new Date(now()).toISOString() } } } });
          } catch (error) { log.warn?.(`[googlechat] fork Activity index failed: ${error?.message || error}`); }
          await setThreadEngine(slug, thread, target.sourceEngine, { licensePool });
          await setThreadModel(slug, thread, model);
          await setThreadEffort(slug, thread, effort);
          await setThreadClean(slug, thread, clean);
          const request = await post(space, thread, `↪️ Fork of ${link('this thread', sourceUrl)} — opening request from ${label(creator)}:\n\n${fork.prompt}`);
          if (!isMessageName(request?.messageId) || !request.messageId.startsWith(`${space}/messages/`)) {
            throw new Error('Google Chat did not return the fork request message; its first response was not started.');
          }
          const id = randomUUID();
          let copied;
          barrier.push(new Promise(resolve => { copied = resolve; }));
          hooks.set(id, { onSourceForked: copied, settled: () => { copied(); hooks.delete(id); } });
          try {
            connector.startForkTurn({ space, spaceName, threadKey: thread, messageId: request.messageId,
              sender: { email: authorId, name: user?.googleChatUserName || '', displayName: creator }, text: fork.prompt,
              fork: { id, sourceSessionId: target.sourceSessionId, sourceThreadKey: sourceKey, cutoff, clean } });
          } catch (error) { hooks.get(id)?.settled(); throw error; }
          row.status = 'starting';
          persist();
        } catch (error) {
          row.status = row.threadKey ? 'created_with_error' : 'failed';
          row.error = oneLine(error?.message || error).slice(0, 200);
          persist();
        } finally {
          if (childKey) starting.delete(childKey);
        }
      }
      const created = rows.filter(row => row.threadKey).length;
      const status = row => row.error ? row.error : row.status === 'starting' ? 'first response requested' : row.status;
      const summary = job.single
        ? rows[0].threadKey && !rows[0].error ? `↪️ Fork started in ${link('a new thread', rows[0].url)}.`
          : `The fork could not be completed: ${rows[0].error || rows[0].status}.${rows[0].url ? ` Its thread: ${link('fork', rows[0].url)}.` : ' Nothing was created.'}`
        : `Created ${created}/${rows.length} forks:\n` + rows.map((row, i) => `${i + 1}. ${link(row.title, row.url)} — ${status(row)}`).join('\n');
      await post(space, sourceKey, summary).catch(error => log.warn?.(`[googlechat] fork index not posted: ${error?.message || error}`));
      return rows;
    } catch (error) {
      for (const row of rows) if (row.status === 'pending') { row.status = 'failed'; row.error = oneLine(error?.message || error).slice(0, 200); }
      persist();
      await post(space, sourceKey, `${job.single ? 'The fork' : 'The approved forks'} could not be created: ${oneLine(error?.message || error)} Nothing was created.`).catch(() => {});
      return rows;
    } finally {
      // Hold the source until every child copied it (or its first turn ended without a copy).
      await Promise.all(barrier);
    }
  }

  // Synchronously holds the source session and reserves its lane, then works on its own.
  function start(job) {
    const space = spaceOf(job.conversationId);
    const release = connector.holdSession?.({ conversationId: job.conversationId, sessionKey: job.sourceKey }) || (() => {});
    let created = false;
    const done = Promise.resolve(conversation.execute({
      message: { conversationId: job.conversationId, userId: job.authorId },
      sessionKey: job.sourceKey,
      queued: async () => {},
      work: signal => { created = true; return createAll(job, signal); },
    })).then(async result => {
      if (!created) await post(space, job.sourceKey, `${job.single ? 'The fork was' : 'The approved forks were'} stopped before creation. Nothing was created.`).catch(() => {});
      return result;
    }, error => { log.error?.(`[googlechat] fork run failed: ${error?.message || error}`); }).finally(release);
    return done;
  }

  // The approval executor's batch runner (server.js → thread-fork-approvals.js). Returns at once.
  async function runApproved(record) {
    const action = record?.action || {};
    if (typeof connector.startForkTurn !== 'function') throw new Error('Google Chat is not connected.');
    const job = { conversationId: action.channelId, slug: action.slug, sourceKey: action.threadKey, authorId: action.authorId,
      forks: action.forks, approvalId: record.id, action };
    await post(spaceOf(job.conversationId), job.sourceKey, `⏳ Approved ${action.forks.length} fork${action.forks.length === 1 ? '' : 's'}. Waiting for the source turn to finish before copying its context.`).catch(() => {});
    void start(job);
    return { ok: true, completed: true, label: 'thread forks',
      message: `The forks start once the source turn finishes; the index of new threads is posted in this thread.` };
  }

  // `/fork <new message>` typed in a source thread. It arrives through the session queue, so the
  // work ahead of it has finished; the copy itself still holds the source like a batch does.
  async function command({ message, sessionKey, entry, reply }) {
    if (message.trigger === 'reaction') return false;
    const parsed = parseForkCommand(message.text);
    if (!parsed) return false;
    if (parsed.error) { await reply(parsed.error); return true; }
    const action = { channelId: message.conversationId, slug: entry.slug, authorId: message.userId, threadKey: sessionKey };
    try { await threadForkTarget(action); }
    catch (error) { await reply(`Can't fork this thread: ${error.message}`); return true; }
    if (typeof connector.startForkTurn !== 'function') { await reply('Google Chat is not connected, so the fork was not created.'); return true; }
    void start({ conversationId: message.conversationId, slug: entry.slug, sourceKey: sessionKey, authorId: message.userId,
      forks: [{ title: forkTitle(parsed.task), prompt: parsed.task }], action, single: true });
    return true;
  }

  // A message reaching a fork thread before its opening request is queued.
  async function guard({ message, sessionKey, reply }) {
    if (!starting.has(laneKey(message.conversationId, sessionKey))) return false;
    await reply('This fork is still starting. Please send your next message after its first reply.');
    return true;
  }

  // The transport hands a queued fork turn here; the live hooks (if this process created it) tie
  // its first copy to the source hold. A turn queued before a restart runs without them.
  async function runChild(ingest, message, options = {}) {
    const fork = options.fork || {};
    const hook = hooks.get(fork.id);
    const space = spaceOf(message.conversationId);
    try {
      return await ingest(message, { ...options, fork: {
        sourceSessionId: String(fork.sourceSessionId || ''),
        onSourceForked: () => hook?.onSourceForked?.(),
        fallbackContext: fork.clean ? null : fallbackContext({ space, sourceThreadKey: fork.sourceThreadKey, cutoff: fork.cutoff }),
      } });
    } finally { hook?.settled(); }
  }

  return { refusal, runApproved, command, guard, runChild, parseForkCommand };
}
