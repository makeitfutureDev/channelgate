// Browser grants and native file actions repeat current Teams membership and gateway policy.
import { getChannelEntry, getChannelMeta, isAdmin, isApproved } from '../../config/store.js';
import { isAuthorized } from '../../gateway/modes.js';
import { effectiveWorkDir } from '../../gateway/folders.js';
import { liveConnector } from '../live.js';
import { parseConversationId } from '../ids.js';

export async function teamsWorkspaceContext(grant, { connector = liveConnector('msteams') } = {}) {
  const parsed = parseConversationId(grant.channelId);
  if (parsed.platform !== 'msteams' || !grant.ownerId || !connector?.api?.listMembers) throw new Error('Teams workspace is unavailable.');
  const entry = await getChannelEntry(grant.channelId);
  if (!entry || (grant.slug && grant.slug !== entry.slug)) throw new Error('Conversation no longer exists.');
  const meta = await getChannelMeta(entry.slug);
  const userIsAdmin = await isAdmin(grant.ownerId);
  const approved = await isApproved(grant.ownerId);
  if (!meta || !isAuthorized(meta, grant.ownerId, Boolean(meta.isDM), { isAdminUser: userIsAdmin, isApprovedUser: approved })) throw new Error('You are no longer allowed to use this workspace.');
  const members = await connector.api.listMembers(parsed.id);
  if (!members.some(member => member.id === grant.ownerId)) throw new Error('Teams conversation membership could not be confirmed.');
  return { root: effectiveWorkDir(entry.slug, meta), meta, entry, userIsAdmin, userId: grant.ownerId };
}
