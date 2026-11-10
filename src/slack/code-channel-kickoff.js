// The first turn of a new code channel. The approval click that created the channel runs in the
// daemon, where no Slack event exists for it — so the daemon starts the turn itself with a
// synthetic message from the requester, exactly as a reply posted in that channel would. The
// pipeline applies every usual check (registration, the inherited access policy, the run queue).
import { processMessageEvent } from "./message-pipeline.js";
import { getChannelEntry, getChannelMeta } from "../config/store.js";
import { codeChannelKickoffPrompt, isCodeChannelMeta } from "../gateway/code-channels.js";

export async function kickoffCodeChannel({ channelId, requesterId }, { slack, process = processMessageEvent } = {}) {
  const snapshot = slack?.snapshot?.();
  const client = snapshot?.connected ? slack.getClient?.() : null;
  if (!client) throw new Error("Slack is not connected");
  const entry = await getChannelEntry(channelId);
  const meta = entry ? await getChannelMeta(entry.slug) : null;
  if (!isCodeChannelMeta(meta)) throw new Error("not a code channel");
  if (meta.codeChannel.createdBy !== requesterId) throw new Error("only the requester's own first turn may be started");
  const now = Date.now();
  const event = {
    channel: channelId,
    channel_type: entry.type === "group" ? "group" : "channel",
    user: requesterId,
    text: codeChannelKickoffPrompt(meta.codeChannel),
    ts: `${Math.floor(now / 1000)}.${String(now % 1000).padStart(3, "0")}000`,
    synthetic: "code_channel_kickoff",
  };
  // Not awaited past acceptance: the turn may run for a long time and the approval card only
  // needs to know it was started.
  void process(event, client, { botUserId: snapshot.botUserId || "", teamId: snapshot.teamId || "", bypassMention: true })
    .catch((error) => console.error("[slack] code channel kickoff failed:", error?.message || error));
  return { ok: true };
}

export async function handleCodeChannelIpc(body = {}, deps = {}) {
  if (body?.action === "kickoff") return kickoffCodeChannel(body, deps);
  throw new Error(`unknown code-channel action "${body?.action || ""}"`);
}
