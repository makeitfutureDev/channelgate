// Streaming recipients belong to the sender's workspace, which can differ from the bot's
// installation in Slack Connect. This is presentation routing only, never authorization.
const clients = new WeakMap();
const TTL_MS = 15 * 60_000;
export async function resolveStreamRecipientTeam(client, event, fallback = "") {
  if (event?.user_team) return event.user_team;
  if (!event?.user || typeof client.users?.info !== "function") return fallback;
  let cache = clients.get(client);
  if (!cache) { cache = new Map(); clients.set(client, cache); }
  const previous = cache.get(event.user);
  if (previous && previous.until > Date.now()) return previous.team;
  try {
    const response = await client.users.info({ user: event.user });
    if (!response.user?.team_id || response.user.id !== event.user) return fallback;
    if (cache.size >= 1000) cache.clear();
    cache.set(event.user, { team: response.user.team_id, until: Date.now() + TTL_MS });
    return response.user.team_id;
  } catch { return fallback; }
}
