// Graph supplies Entra IDs; the Bot Framework roster is the authority for the addressable
// reactor identity. Never run under the original author's permissions on a reaction.
import { createHash } from "node:crypto";
import { activityConversationName } from "./conversation-name.js";
import { makeInbound } from "../inbound.js";
import { quotedReplyId, stripMentionTags } from "./activity.js";

import { teamsGraphReactionAction, teamsGraphReactionKey, teamsGraphReactionCutoverField, teamsActivationFingerprint, DEFAULT_TEAMS_ACTIVATION_REACTIONS } from "./reactions.js";

const digest = parts => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const userId = identity => String(identity?.user?.id || "");
// Graph chatMessageActions is a flags enum. A removal (or an unknown combined flag) wins over
// addition so an ambiguous/latest transition cannot replay an earlier destructive control.
function reactionTransition(value) {
  const flags = String(value || "").split(",").map(flag => flag.trim());
  if (flags.includes("reactionRemoved")) return "removed";
  if (!flags.includes("reactionAdded")) return "";
  return flags.every(flag => flag === "reactionAdded") ? "added" : "removed";
}
function plainBody(body) {
  let text = stripMentionTags(body?.content);
  if (String(body?.contentType).toLowerCase() === "html") {
    text = text.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/(?:p|div)>/gi, "\n").replace(/<[^>]*>/g, "");
    text = text.replace(/&(lt|gt|amp|quot|apos|nbsp);/g, (_, entity) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " " })[entity]);
  }
  return text.trim();
}

export async function normalizeGraphEvents(message, row, { botId, resolveMember, now = Date.now, activationReactions = DEFAULT_TEAMS_ACTIVATION_REACTIONS, activationVersion } = {}) {
  if (!message?.id || message.deletedDateTime || message.messageType !== "message") return [];
  const started = Date.parse(row.startedAt);
  if (!Number.isFinite(started)) return [];
  // The inbox retains tombstones for seven days. Only fresh provider events can enter it,
  // so fetching a long-lived message never replays history whose tombstone was collected.
  const currentTime = now();
  const since = Math.max(started, currentTime - 24 * 60 * 60_000);
  const snapshotCutoff = Date.parse(row.reactionSnapshotsStartedAt);
  function snapshotIdentity(reaction) {
    const at = typeof reaction?.createdDateTime === 'string' ? Date.parse(reaction.createdDateTime) : NaN;
    return Number.isFinite(snapshotCutoff) && at > snapshotCutoff;
  }
  function freshSnapshot(reaction) {
    const at = Date.parse(reaction?.createdDateTime);
    return snapshotIdentity(reaction) && at > since && at <= currentTime;
  }
  const context = row.context || {};
  const conversation = context.conversation || {};
  const kind = ({ personal: "dm", groupchat: "group", channel: "channel" })[String(conversation.conversationType).toLowerCase()];
  if (!kind || !conversation.id) return [];
  const appId = String(botId || "").replace(/^28:/, "");
  const application = message.from?.application?.id;
  const ownBot = Boolean(appId) && [appId, botId].includes(application);
  // Other agents are never silently invoked through their output.
  if (application && !ownBot) return [];
  const mentionsBot = Boolean(appId) && (message.mentions || []).some(mention =>
    [appId, botId].includes(mention?.mentioned?.application?.id) ||
    [appId, botId].includes(mention?.mentioned?.user?.id));
  const body = plainBody(message.body);
  const result = [];
  const members = new Map();
  async function emit(actorId, trigger, stamp, reactionAction = "") {
    if (!actorId) return;
    if (!members.has(actorId)) members.set(actorId, await resolveMember(actorId));
    const member = members.get(actorId);
    if (!member?.id || member.id === botId) return;
    // Preserve existing edit/robot dedup identities across the upgrade; only new controls need
    // the extra intent field to distinguish reactions delivered with the same provider timestamp.
    const identity = [row.conversationId, message.id, trigger, actorId, stamp];
    if (reactionAction && reactionAction !== "engage") identity.push(reactionAction);
    const eventId = digest(identity);
    const reaction = trigger === "reaction";
    result.push(makeInbound({
      platform: "msteams", conversationId: conversation.id, conversationName: activityConversationName(context),
      kind, threadKey: kind === "channel" ? String(message.replyToId || message.id) : "",
      messageId: reaction ? `reaction:${eventId}` : String(message.id),
      replyToId: reaction ? String(message.id) : quotedReplyId({ text: message.body?.content }),
      trigger, reactionAction, userId: member.id, userName: member.name, userEmail: member.email,
      text: reaction && ownBot ? "Continue the task from this message." : body || ((message.attachments || []).length ? "Handle the attached message." : ""),
      mentionsBot,
      // Graph attachment retrieval has a separate permission path. Preserve descriptors so the
      // shared attachment sink reports unavailable files instead of silently dropping them.
      attachments: (message.attachments || []).map(file => ({ name: String(file.name || "attachment"), contentType: String(file.contentType || "application/octet-stream"), download: null, ...(file.contentUrl ? { reference: { contentUrl: file.contentUrl } } : {}) })),
      raw: { context, eventId, aadObjectId: actorId, tenantId: context.channelData?.tenant?.id || "",
        serviceUrl: context.serviceUrl || "", teamId: context.channelData?.team?.aadGroupId || "" },
    }));
  }
  // lastModifiedDateTime changes for reactions too; only lastEditedDateTime represents an edit.
  const edited = Date.parse(message.lastEditedDateTime);
  if (!application && (kind === "dm" || mentionsBot) && edited > since) {
    await emit(userId(message.from), "edit", message.lastEditedDateTime);
  }
  // Only the newest transition for each reactor/intent can act. A re-added reaction must not
  // replay an earlier addition from the same fetched history (especially an earlier stop).
  const latest = new Map();
  const history = message.messageHistory;
  // Channel Graph responses can omit history while exposing each present reaction's provider
  // creation time. That proves a fresh activation, never a destructive control. Existing
  // history (including removals/unknown flags) remains authoritative. No message update time
  // is substituted for an addition, and the persisted upgrade cutoff excludes older snapshots.
  const additions = history === undefined || (Array.isArray(history) && !history.length)
    ? (message.reactions || []).filter(reaction => teamsGraphReactionAction(reaction, activationReactions) === 'engage' && freshSnapshot(reaction))
      .map(reaction => ({ actions: 'reactionAdded', modifiedDateTime: reaction.createdDateTime, reaction }))
    : Array.isArray(history) ? history : [];
  for (const item of additions) {
    const action = teamsGraphReactionAction(item.reaction, activationReactions);
    const transition = reactionTransition(item.actions);
    if (!transition || !action) continue;
    const actor = userId(item.reaction?.user);
    const at = Date.parse(item.modifiedDateTime);
    if (!actor || !(at > since)) continue;
    const key = JSON.stringify([actor, action]);
    const previousAt = Date.parse(latest.get(key)?.modifiedDateTime);
    if (!latest.has(key) || at > previousAt || (at === previousAt && transition === "removed")) latest.set(key, { ...item, transition });
  }
  for (const item of latest.values()) {
    if (item.transition !== "added") continue;
    const action = teamsGraphReactionAction(item.reaction, activationReactions);
    let stamp = item.modifiedDateTime;
    const actor = userId(item.reaction?.user);
    const candidates = (message.reactions || []).filter(reaction => teamsGraphReactionAction(reaction, activationReactions) === action
      && teamsGraphReactionKey(reaction) === teamsGraphReactionKey(item.reaction) && userId(reaction.user) === actor);
    const created = reaction => Number.isFinite(Date.parse(reaction?.createdDateTime)) ? Date.parse(reaction.createdDateTime) : -Infinity;
    const ordered = candidates.toSorted((a, b) => created(b) - created(a)
      || String(a.reactionType).localeCompare(String(b.reactionType)));
    const itemCreated = created(item.reaction);
    // Synthetic additions keep their exact current reaction. History may use an equivalent
    // emoji ID, so prefer its provider creation time, otherwise the closest prior addition.
    // Multiple Like/skin-tone variants must never depend on current-array order.
    const present = candidates.includes(item.reaction) ? item.reaction
      : ordered.find(reaction => itemCreated !== -Infinity && created(reaction) === itemCreated)
        || ordered.find(reaction => created(reaction) <= Date.parse(stamp)) || ordered[0];
    // A removed reaction must not start a new run when a delayed notification is fetched.
    if (!present) continue;
    // New snapshot-capable additions use one provider identity even if history later appears
    // with a later message-modification timestamp. Legacy history IDs and control IDs stay intact.
    if (action === 'engage' && snapshotIdentity(present)) {
      if (Date.parse(present.createdDateTime) > Date.parse(stamp)) continue;
      stamp = new Date(Date.parse(present.createdDateTime)).toISOString();
      // Identity must not switch back to modification time as its creation ages out of the
      // freshness window. Reject an expired/future addition instead of giving it another ID.
      if (!(Date.parse(stamp) > since && Date.parse(stamp) <= currentTime)) continue;
    }
    if (action === 'engage') {
      if (activationVersion !== undefined && row.activationReactionsVersion !== activationVersion) continue;
      const fingerprint = teamsActivationFingerprint(activationReactions);
      const custom = fingerprint !== teamsActivationFingerprint();
      // A custom selection requires a persisted cutoff. Legacy default rows retain their
      // existing identities; prepared production rows always carry the configuration version.
      if (custom || row.activationReactionsFingerprint !== undefined) {
        if (row.activationReactionsFingerprint !== fingerprint
          || !(Date.parse(stamp) > Date.parse(row.activationReactionsStartedAt))) continue;
      }
    }
    const cutoverField = teamsGraphReactionCutoverField(item.reaction);
    if (cutoverField) {
      const cutover = Date.parse(row[cutoverField]);
      if (!Number.isFinite(cutover) || !(Date.parse(stamp) > cutover)) continue;
    }
    await emit(actor, "reaction", stamp, action);
  }
  return result;
}
