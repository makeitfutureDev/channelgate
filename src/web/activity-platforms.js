// Combined Activity resolves explicitly linked identities only. Platform accounts retain their
// own admission policy and fresh native membership; a dashboard link grants neither.
import { activityIdentityIds } from '../config/activity-identities.js';
import { getChannelEntry, getChannelMeta } from '../config/store.js';
import { platformOfConversation } from '../platforms/ids.js';
import { googleChatWorkspaceContext } from '../platforms/googlechat/workspace-access.js';
import { teamsWorkspaceContext } from '../platforms/msteams/workspace-access.js';
import { getThreadSudo } from '../gateway/thread-engine.js';
import { listPlatformThreadsForUser, getPlatformThread, isPlatformThreadParticipant } from '../gateway/platform-threads.js';

export async function platformActivityAccess(ownerId, channelId, threadKey = '', identityId = '') {
  const platform = platformOfConversation(channelId);
  if (!['googlechat', 'msteams'].includes(platform)) return null;
  const entry = await getChannelEntry(channelId);
  if (!entry || entry.disabled || entry.archived || entry.deleted) return null;
  const meta = await getChannelMeta(entry.slug);
  if (!meta || meta.disabled || meta.archived || meta.deleted || meta.botMembership && meta.botMembership !== 'member') return null;
  for (const userId of await activityIdentityIds(ownerId)) {
    if (identityId && userId !== identityId) continue;
    if (threadKey && !isPlatformThreadParticipant(channelId, threadKey, userId)) continue;
    try {
      const check = platform === 'googlechat' ? googleChatWorkspaceContext : teamsWorkspaceContext;
      const context = await check({ channelId, ownerId: userId, slug: entry.slug });
      if (threadKey && !context.userIsAdmin && await getThreadSudo(entry.slug, threadKey)) continue;
      // Linking can be revoked while the native roster request is in flight.
      if (!(await activityIdentityIds(ownerId)).includes(userId)) continue;
      return { ...context, userId, platform };
    } catch { /* Missing membership and disconnected transports fail closed. */ }
  }
  return null;
}

export async function platformActivityThread(ownerId, channelId, threadKey) {
  const row = getPlatformThread(channelId, threadKey);
  if (!row) return null;
  const ids = await activityIdentityIds(ownerId);
  const preferred = ids.includes(row.starter_id) ? await platformActivityAccess(ownerId, channelId, threadKey, row.starter_id) : null;
  const access = preferred || await platformActivityAccess(ownerId, channelId, threadKey);
  return access ? { ...row, activityUserId: access.userId, canComplete: row.starter_id === access.userId } : null;
}

export async function platformActivitySnapshot(ownerId) {
  const rows = [], seen = new Set(), channels = new Map();
  let unavailable = false, truncated = false;
  const candidates = (await activityIdentityIds(ownerId)).flatMap(userId => listPlatformThreadsForUser(userId).map(row => ({ userId, row })))
    .sort((a, b) => Number(b.row.starter_id === b.userId) - Number(a.row.starter_id === a.userId) || b.row.last_message_ms - a.row.last_message_ms);
  for (const { userId, row } of candidates) {
    const key = JSON.stringify([row.channel_id, row.thread_ts]);
    if (seen.has(key)) continue;
    if (rows.length >= 1000) { truncated = true; break; }
    const channelKey = JSON.stringify([row.channel_id, userId]);
    // Coalesce native roster reads within this snapshot only, scoped to the checked identity.
    if (!channels.has(channelKey)) channels.set(channelKey, await platformActivityAccess(ownerId, row.channel_id, '', userId));
    const access = channels.get(channelKey);
    if (!access) { unavailable = true; continue; }
    if (!isPlatformThreadParticipant(row.channel_id, row.thread_ts, userId)) continue;
    if (!access.userIsAdmin && await getThreadSudo(row.slug, row.thread_ts)) continue;
    seen.add(key);
    rows.push({ ...row, activityUserId: userId, canComplete: row.starter_id === userId,
      channelName: `${access.entry.name || 'Conversation'} · ${access.platform === 'googlechat' ? 'Google Chat' : 'Microsoft Teams'}`,
      isDM: Boolean(access.meta.isDM) });
  }
  return { rows, unavailable, truncated };
}
