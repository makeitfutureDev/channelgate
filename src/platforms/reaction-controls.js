// Called only after conversation admission, reactor authorization and the sudo thread gate.
import { deleteAck, findAckByMessage } from '../config/acks.js';
import { logEvent } from '../util/logger.js';

export async function acknowledgeReaction({ message, reply }) {
  const ack = findAckByMessage(message.conversationId, message.replyToId);
  if (!ack || !['white_check_mark', '✅', '2705_whiteheavycheckmark'].includes(ack.ackEmoji)) {
    await reply('No pending Tick button reminder on this message.');
    return;
  }
  // A second notice is also an acknowledgment target. Removing the reaction cannot reopen it.
  if (!deleteAck(ack.id)) return;
  await logEvent('ack_resolved', { id: ack.id, by: message.userId, platform: message.platform });
  await reply('✅ Acknowledged — reminder closed.');
}
