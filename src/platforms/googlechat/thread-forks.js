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
import { parseChannelFork, channelForks } from '../channel-forks.ts';
import { googleChatAdapter } from '../googlechat.js';
import { isSpaceName, isThreadName, isMessageName } from './api.js';

const SPACE_TTL_MS = 10 * 60_000;
// Named spaces with real threads (THREADED_MESSAGES) or topics (GROUPED_MESSAGES, the legacy
// topic-based rooms): a new top-level message starts a new thread/topic in both.
const THREADED_STATES = new Set(['THREADED_MESSAGES', 'GROUPED_MESSAGES']);
export const FORK_NOT_THREADED = 'This Google Chat space does not use threads, so there is no thread to fork into. Use a named space with threaded replies.';
export const FORK_FLAT_CHAT = 'Google Chat direct messages and group chats have no threads to fork into. Use a named space that has threads.';
const spaceOf = conversationId => String(conversationId || '').replace(/^gchat:/, '');
export function googleChatThreadUrl(space, thread) {
  const s = /^spaces\/([A-Za-z0-9_-]+)$/.exec(space);
  const t = /^spaces\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_.-]+)$/.exec(thread);
  if (!s || !t || t[1] !== s[1]) return '';
  return `https://chat.google.com/room/${encodeURIComponent(s[1])}/${encodeURIComponent(t[2])}`;
}
export const parseForkCommand = text => parseChannelFork(text, 'Google Chat', 'a named, threaded space');

export function createGoogleChatThreadForks({ connector, conversation, formatText = null, now = Date.now, log = console } = {}) {
  if (!connector || !conversation?.execute) throw new TypeError('Google Chat thread forks need the connector and the conversation lanes');
  const spaces = new Map();
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

  return { refusal, parseForkCommand, ...channelForks({
    platform: 'googlechat', name: 'Google Chat', place: 'a named, threaded space',
    connector, conversation, now, log, post, link: googleChatThreadUrl,
    ready: () => typeof connector.startForkTurn === 'function',
    root(space, posted) {
      const threadKey = String(posted?.threadKey || '');
      if (!isThreadName(threadKey) || !threadKey.startsWith(`${space}/threads/`)) return null;
      return { threadKey, messageId: isMessageName(posted.messageId) ? posted.messageId : '',
        raw: { message: { threadReply: false, createTime: new Date(now()).toISOString() } } };
    },
    validMessage: (space, id) => isMessageName(id) && id.startsWith(`${space}/messages/`),
    enqueue: turn => connector.startForkTurn({
      space: turn.conversationId, spaceName: turn.conversationName, threadKey: turn.threadKey, messageId: turn.messageId,
      sender: { email: turn.authorId, name: turn.author.googleChatUserName || '', displayName: turn.authorName },
      text: turn.text, fork: turn.fork,
    }),
  }) };
}
