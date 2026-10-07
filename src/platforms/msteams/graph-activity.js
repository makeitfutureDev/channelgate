// Graph supplies Entra IDs; the Bot Framework roster is the authority for the addressable
// reactor identity. Never run under the original author's permissions on a reaction.
import { createHash } from "node:crypto";
import { activityConversationName } from "./conversation-name.js";
import { makeInbound } from "../inbound.js";
import { quotedReplyId, stripMentionTags } from "./activity.js";

import { teamsGraphReactionAction, teamsGraphReactionCutoverField } from "./reactions.js";

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

export async function normalizeGraphEvents(message, row, { botId, resolveMember, now = Date.now } = {}) {
  if (!message?.id || message.deletedDateTime || message.messageType !== "message") return [];
  const started = Date.parse(row.startedAt);
  if (!Number.isFinite(started)) return [];
  // The inbox retains tombstones for seven days. Only fresh provider events can enter it,
  // so fetching a long-lived message never replays history whose tombstone was collected.
  const since = Math.max(started, now() - 24 * 60 * 60_000);
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
  for (const item of message.messageHistory || []) {
    const action = teamsGraphReactionAction(item.reaction);
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
    const action = teamsGraphReactionAction(item.reaction);
    const stamp = item.modifiedDateTime;
    const cutoverField = teamsGraphReactionCutoverField(item.reaction);
    if (cutoverField) {
      const cutover = Date.parse(row[cutoverField]);
      if (!Number.isFinite(cutover) || !(Date.parse(stamp) > cutover)) continue;
    }
    const actor = userId(item.reaction?.user);
    // A removed reaction must not start a new run when a delayed notification is fetched.
    if (!(message.reactions || []).some(reaction => teamsGraphReactionAction(reaction) === action && userId(reaction.user) === actor)) continue;
    await emit(actor, "reaction", stamp, action);
  }
  return result;
}
