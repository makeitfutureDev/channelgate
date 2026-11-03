// Recover membership events missed during downtime. Absence is evidence only after the calling
// bot's ENTIRE users.conversations listing has been read; errors never archive conversations.
import { listChannels, patchChannelMeta } from "../config/store.js";
import { isSlackMembershipChannel, invalidateSlackMembership, slackMembershipEpoch, confirmSlackMembership } from "../gateway/channel-membership.js";
import { botMembershipActivity, withChannelMembershipLock } from "./members.js";

// A membership list is valid only when pagination completes. Never infer absence from a partial page.
export async function readBotMemberships(client) {
  const members = new Set();
  const cursors = new Set();
  let cursor = "";
  let pages = 0;
  do {
    if (++pages > 1000) throw new Error("Slack membership listing exceeded its pagination bound");
    const page = await client.users.conversations({ types: "public_channel,private_channel,mpim", exclude_archived: false, limit: 200,
      ...(cursor ? { cursor } : {}) });
    if (page?.ok === false || !Array.isArray(page?.channels)) throw new Error("Slack returned an incomplete membership listing");
    for (const channel of page.channels) {
      if (!channel || !/^[CG][A-Z0-9_]+$/.test(channel.id || "")) throw new Error("Slack returned invalid membership metadata");
      members.add(channel.id);
    }
    const next = page.response_metadata?.next_cursor ?? "";
    if (typeof next !== "string") throw new Error("Slack returned an invalid membership cursor");
    cursor = next.trim();
    if (cursor && cursors.has(cursor)) throw new Error("Slack repeated a membership cursor");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return members;
}

export function createBotMembershipRecovery({
  slack, channels = listChannels, patch = patchChannelMeta,
  onArchived = () => {}, onVerified = () => {}, log = console.warn,
  retryMs = 30_000, intervalMs = 5 * 60_000,
} = {}) {
  let preparation = Promise.resolve();
  let running = null;
  let timer = null;
  let stopped = false;
  const schedule = (delay) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void reconcile(); }, delay);
    timer.unref?.();
  };
  function invalidate() {
    const epoch = invalidateSlackMembership(); // synchronous: no propagation during reconnect
    clearTimeout(timer);
    preparation = preparation.catch(() => {}).then(async () => {
      for (const row of await channels()) {
        if (epoch !== slackMembershipEpoch()) return;
        if (!isSlackMembershipChannel({ ...row.meta, channelId: row.channelId })) continue;
        await patch(row.slug, (current) => current && epoch === slackMembershipEpoch() && current.botMembership !== "pending"
          ? { botMembership: "pending" } : null);
      }
    });
    return preparation;
  }
  async function pass() {
    await preparation;
    const client = slack?.getClient?.();
    if (!client || !slack?.snapshot?.().connected) {
      schedule(retryMs);
      return { ok: false, deferred: true, reason: "disconnected" };
    }
    const epoch = slackMembershipEpoch();
    const activity = botMembershipActivity();
    const fresh = () => !stopped && epoch === slackMembershipEpoch() && activity === botMembershipActivity();
    try {
      const members = await readBotMemberships(client);
      if (!fresh()) { schedule(retryMs); return { ok: false, deferred: true, reason: "superseded" }; }
      const result = { ok: true, archived: [], restored: [], verified: [] };
      for (const row of await channels()) {
        if (!isSlackMembershipChannel({ ...row.meta, channelId: row.channelId })) continue;
        if (!fresh()) { schedule(retryMs); return { ...result, ok: false, deferred: true, reason: "superseded" }; }
        await withChannelMembershipLock(row.channelId, async () => {
          let accepted = false;
          let wasArchived = false;
          const member = members.has(row.channelId);
          const next = await patch(row.slug, (current) => {
            if (!current || !fresh()) return null;
            accepted = true;
            wasArchived = Boolean(current.archived);
            if (current.botMembership === (member ? "member" : "absent") && wasArchived === !member) return null;
            return { botMembership: member ? "member" : "absent", archived: !member,
              archivedAt: member ? null : current.archivedAt || new Date().toISOString(),
              archivedReason: member ? null : "bot_removed" };
          });
          if (!accepted || !fresh()) return;
          if (member) {
            confirmSlackMembership(row.channelId, epoch);
            result.verified.push(row.slug);
            if (wasArchived) result.restored.push(row.slug);
          } else {
            result.archived.push(row.slug);
            if (!wasArchived) await onArchived(row, next);
          }
        });
      }
      if (!fresh()) { schedule(retryMs); return { ...result, ok: false, deferred: true, reason: "superseded" }; }
      await onVerified(result);
      schedule(intervalMs);
      return result;
    } catch (error) {
      // A previously verified connection is no authority for a new failed snapshot. Pause
      // propagation until a complete retry succeeds, without interpreting the failure as absence.
      if (fresh()) await invalidate().catch(() => {});
      log(`[slack] membership verification deferred: ${error?.message || error}`);
      const retryAfter = Number(error?.retryAfter || error?.data?.retry_after || 0) * 1000;
      schedule(Math.max(retryMs, Number.isFinite(retryAfter) ? retryAfter : 0));
      return { ok: false, deferred: true, reason: "verification_failed" };
    }
  }
  function reconcile() {
    if (stopped) return Promise.resolve({ ok: false, deferred: true, reason: "stopped" });
    if (!running) running = pass().catch((error) => {
      log(`[slack] membership preparation deferred: ${error?.message || error}`);
      schedule(retryMs);
      return { ok: false, deferred: true, reason: "preparation_failed" };
    }).finally(() => { running = null; });
    return running;
  }
  function stop() { stopped = true; clearTimeout(timer); }
  return { invalidate, reconcile, stop };
}
