// Repeat gateway policy after Google's roster request; grants never select another workspace.
import { getChannelEntry, getChannelMeta, getUser, getUsers, isAdmin, isApproved } from '../../config/store.js';
import { isAuthorized } from '../../gateway/modes.js';
import { effectiveWorkDir } from '../../gateway/folders.js';
import { liveConnector } from '../live.js';
import { parseConversationId } from '../ids.js';
import { isSpaceName } from './api.js';
import { controlError } from './cards.js';

export async function googleChatWorkspaceContext(grant, { connector = liveConnector('googlechat') } = {}) {
  const parsed = parseConversationId(grant.channelId);
  if (parsed.platform !== 'googlechat' || !isSpaceName(parsed.id) || !grant.ownerId || !connector?.api?.listMembers) throw controlError('Google Chat workspace is unavailable.');
  const currentAccess = async () => {
    const entry = await getChannelEntry(grant.channelId);
    if (!entry || grant.slug && grant.slug !== entry.slug) throw controlError('Conversation no longer exists.');
    const meta = await getChannelMeta(entry.slug);
    const userIsAdmin = await isAdmin(grant.ownerId);
    const approved = await isApproved(grant.ownerId);
    if (!meta || !isAuthorized(meta, grant.ownerId, Boolean(meta.isDM), { isAdminUser: userIsAdmin, isApprovedUser: approved })) throw controlError('You are no longer allowed to use this workspace.');
    return { entry, meta, userIsAdmin };
  };
  await currentAccess();
  const user = await getUser(grant.ownerId);
  const resource = user?.googleChatUserName || grant.ownerId;
  const members = await connector.api.listMembers(parsed.id);
  if (!members.some(member => member.id === resource || member.id === grant.ownerId || member.email === grant.ownerId)) throw controlError('Google Chat space membership could not be confirmed.');
  const { entry, meta, userIsAdmin } = await currentAccess();
  const aliases = new Map();
  for (const [id, known] of Object.entries(await getUsers())) {
    if (!known.googleChatUserName) continue;
    // An ambiguous resource alias must never give one user's grant to another user.
    aliases.set(known.googleChatUserName, aliases.has(known.googleChatUserName) ? null : id);
  }
  return { root: effectiveWorkDir(entry.slug, meta), entry, meta, userIsAdmin, userId: grant.ownerId,
    members: members.map(member => {
      const mapped = member.email || aliases.get(member.id) || (member.id === resource ? grant.ownerId : '');
      return { ...member, resourceName: member.id, id: mapped || member.id, selectable: Boolean(mapped) };
    }) };
}
