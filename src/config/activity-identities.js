// Explicit presentation-only links. These never resolve authentication, roles, tokens or run authors.
import { getUser, setUser } from './store.js';
import { getDb, fromJson } from '../db/index.js';

const approved = user => Boolean(user?.approved || user?.isAdmin);
const links = user => Array.isArray(user?.activityIdentities) ? user.activityIdentities : [];

export function activityIdentityPlatform(id, user) {
  if (user?.platform === 'googlechat' || user?.platform === 'msteams') return user.platform;
  if (/^users\/[A-Za-z0-9_-]+$/.test(id) || /^users\/[A-Za-z0-9_-]+$/.test(user?.googleChatUserName || '')) return 'googlechat';
  if (/^29:[^\s]+$/.test(id)) return 'msteams';
  return '';
}

function usersSnapshot() {
  return new Map(getDb().prepare('SELECT user_id, data FROM users').all().map(row => [row.user_id, fromJson(row.data, {})]));
}

function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status, code: 'invalid_activity_identities' });
}

// Reads re-check live approval and assignment, so revoked/deleted identities stop contributing.
export async function activityIdentityIds(ownerId) {
  const users = usersSnapshot();
  const owner = users.get(ownerId);
  if (!approved(owner)) return [ownerId];
  if ([...users].some(([id, user]) => id !== ownerId && links(user).includes(ownerId))) return [ownerId];
  const ids = links(owner).filter(id => id !== ownerId && approved(users.get(id)) && activityIdentityPlatform(id, users.get(id))
    && !links(users.get(id)).length
    && ![...users].some(([other, user]) => other !== ownerId && links(user).includes(id)));
  return [ownerId, ...new Set(ids)];
}

export async function setActivityIdentities(ownerId, ids) {
  if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !id || id !== id.trim())) {
    throw invalid('Activity identities must be a list of exact user IDs (at most 100).');
  }
  const normalized = [...new Set(ids)];
  if (normalized.includes(ownerId)) throw invalid('A user already owns their own Activity.');
  // setUser holds the write lock while this callback validates every assignment and writes one field.
  await setUser(ownerId, current => {
    if (!current || (normalized.length && !approved(current))) throw invalid('The Activity owner must be an existing approved user.');
    const users = usersSnapshot();
    if (normalized.length && [...users].some(([id, user]) => id !== ownerId && links(user).includes(ownerId))) {
      throw invalid('This user is already linked to another Activity owner. Unlink it first.', 409);
    }
    for (const id of normalized) {
      const user = users.get(id);
      if (!user || !approved(user) || !activityIdentityPlatform(id, user)) {
        throw invalid('Choose an existing approved Google Chat or Microsoft Teams user.');
      }
      if (links(user).length || [...users].some(([other, record]) => other !== ownerId && links(record).includes(id))) {
        throw invalid('This identity already owns linked Activity accounts or belongs to another Activity owner. Unlink it first.', 409);
      }
    }
    return { activityIdentities: normalized };
  });
  return (await getUser(ownerId)).activityIdentities;
}
