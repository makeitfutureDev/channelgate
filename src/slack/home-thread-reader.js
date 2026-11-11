// Cache Slack evidence, never a viewer's authorization or a finished Home view.
import { createSemaphore } from "../util/semaphore.js";
import { getSlackThread } from "../gateway/slack-threads.js";
import { inspectThreadCompletion } from "../gateway/thread-completion.js";

export const HOME_READ_CONCURRENCY = 4;
export const HOME_INSPECTION_TTL_MS = 30_000;

export function createHomeThreadReader({ now = Date.now, ttlMs = HOME_INSPECTION_TTL_MS, maxEntries = 500 } = {}) {
  const clients = new WeakMap();
  const stateFor = (client) => {
    if (!clients.has(client)) clients.set(client, { slots: createSemaphore(HOME_READ_CONCURRENCY), inspections: new Map(), links: new Map() });
    return clients.get(client);
  };
  const cached = async (state, entries, key, signature, ttl, force, work) => {
    const existing = entries.get(key);
    if (!force && existing?.signature === signature && (existing.pending || now() - existing.at < ttl)) {
      entries.delete(key); entries.set(key, existing);
      return existing.promise;
    }
    const entry = { signature, at: now(), pending: true };
    entry.promise = (async () => {
      const release = await state.slots.acquire();
      try { const value = await work(); entry.at = now(); entry.pending = false; return value; }
      catch (error) { if (entries.get(key) === entry) entries.delete(key); throw error; }
      finally { release(); }
    })();
    entries.set(key, entry);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    return entry.promise;
  };
  return {
    concurrency: HOME_READ_CONCURRENCY,
    inspect(client, channelId, threadTs, { force = false } = {}) {
      const row = getSlackThread(channelId, threadTs);
      const signature = JSON.stringify(row && [row.starter_id, row.title, row.updated_ms, row.last_message_ms,
        row.done_ms, row.root_done, row.root_reaction_ms]);
      const state = stateFor(client);
      return cached(state, state.inspections, `${channelId}:${threadTs}`, signature, ttlMs, force,
        () => inspectThreadCompletion(client, channelId, threadTs));
    },
    permalink(client, channelId, threadTs) {
      const state = stateFor(client);
      return cached(state, state.links, `${channelId}:${threadTs}`, "link", Infinity, false, async () => {
        const link = await client.chat.getPermalink({ channel: channelId, message_ts: threadTs });
        if (!/^https:\/\//.test(link?.permalink || "")) throw new Error("Thread permalink unavailable");
        return link;
      });
    },
  };
}
