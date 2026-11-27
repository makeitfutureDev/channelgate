// Called only after conversation admission, reactor authorization and the sudo thread gate.
import { deleteAck, findAckByMessage } from '../config/acks.js';
import { getPlatformThread, isPlatformThreadParticipant, setPlatformThreadDone, setPlatformThreadHidden } from '../gateway/platform-threads.js';
import { logEvent } from '../util/logger.js';

// ✅ on a message: close the tracked reminder it carries, else treat it as the reactor's personal
// "done with this" for the conversation's Activity entry — the follow-up inbox of these surfaces.
// The person who started the session marks it done; another participant dismisses it from their
// own list only. Removing the reaction reopens nothing; a new message in the session brings it back.
export async function acknowledgeReaction({ message, reply, sessionKey = '' }) {
  const ack = findAckByMessage(message.conversationId, message.replyToId);
  if (ack && ['white_check_mark', '✅', '2705_whiteheavycheckmark'].includes(ack.ackEmoji)) {
    // A second notice is also an acknowledgment target. Removing the reaction cannot reopen it.
    if (!deleteAck(ack.id)) return;
    await logEvent('ack_resolved', { id: ack.id, by: message.userId, platform: message.platform });
    await reply('✅ Acknowledged — reminder closed.');
    return;
  }
  const thread = sessionKey ? getPlatformThread(message.conversationId, sessionKey) : null;
  if (thread && thread.starter_id === message.userId && setPlatformThreadDone(message.conversationId, sessionKey, message.userId, true)) {
    await logEvent('platform_thread_done_reaction', { channel: message.conversationId, author: message.userId, platform: message.platform, scope: 'starter' });
    await reply('✅ Marked done in your Activity. A new message in this conversation brings it back.');
    return;
  }
  if (thread && isPlatformThreadParticipant(message.conversationId, sessionKey, message.userId)
    && setPlatformThreadHidden(message.conversationId, sessionKey, message.userId, true)) {
    await logEvent('platform_thread_done_reaction', { channel: message.conversationId, author: message.userId, platform: message.platform, scope: 'participant' });
    await reply('✅ Dismissed from your Activity. A new message in this conversation brings it back.');
    return;
  }
  await reply('No pending Tick button reminder on this message, and no Activity entry of yours to mark done.');
}
