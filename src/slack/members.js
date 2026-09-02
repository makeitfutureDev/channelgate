// Live Slack conversation membership boundary shared by the Socket Mode lifecycle and Admin API.
// `allowedUsers` is the explicit per-channel guest override, so every write of that list must be
// constrained to people who are still members of the conversation.
import {
  getChannelEntry,
  patchChannelMeta,
} from "../config/store.js";
import { ensureChannelFolder } from "../gateway/folders.js";

const MEMBER_PAGE_SIZE = 200;
const USER_LOOKUP_BATCH = 8;
const membershipMutationTails = new Map();

export async function listConversationMemberIds(client, channelId) {
  const ids = [];
  const seen = new Set();
  let cursor = "";
  do {
    const response = await client.conversations.members({
      channel: channelId,
      limit: MEMBER_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    for (const id of response.members ?? []) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    cursor = response.response_metadata?.next_cursor || "";
  } while (cursor);
  return ids;
}

function displayName(user, fallbackId) {
  const profile = user?.profile || {};
  return profile.display_name
    || profile.display_name_normalized
    || profile.real_name
    || profile.real_name_normalized
    || user?.real_name
    || user?.name
    || fallbackId;
}

function normalizedHuman(user, fallbackId, teamId = "") {
  if (!user || user.deleted || user.is_bot || user.id === "USLACKBOT" || fallbackId === "USLACKBOT") {
    return null;
  }
  return {
    id: user.id || fallbackId,
    name: displayName(user, fallbackId),
    isExternal: Boolean(
      user.is_stranger
      || user.is_external
      || (teamId && user.team_id && user.team_id !== teamId),
    ),
  };
}

async function lookupUsers(client, ids) {
  const users = new Map();
  for (let offset = 0; offset < ids.length; offset += USER_LOOKUP_BATCH) {
    const batch = ids.slice(offset, offset + USER_LOOKUP_BATCH);
    const responses = await Promise.all(batch.map((user) => client.users.info({ user })));
    for (let index = 0; index < responses.length; index++) {
      if (responses[index]?.user) users.set(batch[index], responses[index].user);
    }
  }
  return users;
}

async function listWorkspaceUsers(client) {
  const users = new Map();
  let cursor = "";
  do {
    const response = await client.users.list({
      limit: MEMBER_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    for (const user of response.members ?? []) {
      if (user?.id) users.set(user.id, user);
    }
    cursor = response.response_metadata?.next_cursor || "";
  } while (cursor);
  return users;
}

function sortedRoster(ids, users, teamId) {
  const roster = ids
    .map((id) => normalizedHuman(users.get(id), id, teamId))
    .filter(Boolean);
  return roster.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
}

export async function listConversationMemberRoster(client, channelId, { teamId = "" } = {}) {
  const ids = await listConversationMemberIds(client, channelId);
  const users = typeof client.users.list === "function"
    ? await listWorkspaceUsers(client)
    : new Map();
  const missing = ids.filter((id) => !users.has(id));
  for (const [id, user] of await lookupUsers(client, missing)) users.set(id, user);
  return sortedRoster(ids, users, teamId);
}

export async function filterConversationHumanMemberIds(
  client,
  channelId,
  requestedIds,
  { teamId = "" } = {},
) {
  const requested = new Set((requestedIds || []).map(String));
  const currentIds = await listConversationMemberIds(client, channelId);
  const candidates = currentIds.filter((id) => requested.has(id));
  const users = await lookupUsers(client, candidates);
  return sortedRoster(candidates, users, teamId).map((member) => member.id);
}

export async function withChannelMembershipLock(channelId, work) {
  const key = String(channelId || "");
  const previous = membershipMutationTails.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  membershipMutationTails.set(key, current);
  await previous.catch(() => {});
  try {
    return await work();
  } finally {
    release();
    if (membershipMutationTails.get(key) === current) membershipMutationTails.delete(key);
  }
}

const cleanupDeps = {
  getChannelEntry,
  patchChannelMeta,
  ensureChannelFolder,
};

export async function removeChannelGuestGrant(channelId, userId, deps = cleanupDeps) {
  const entry = await deps.getChannelEntry(channelId);
  if (!entry) return false;
  const next = await deps.patchChannelMeta(entry.slug, (current) => {
    if (!current || !Array.isArray(current.allowedUsers) || !current.allowedUsers.includes(userId)) {
      return null;
    }
    return { allowedUsers: current.allowedUsers.filter((id) => id !== userId) };
  });
  if (!next) return false;
  await deps.ensureChannelFolder(entry.slug, next);
  return true;
}

export async function handleMemberLeftChannel(event, deps = cleanupDeps) {
  if (!event?.channel || !event?.user) return false;
  return withChannelMembershipLock(
    event.channel,
    () => removeChannelGuestGrant(event.channel, event.user, deps),
  );
}
