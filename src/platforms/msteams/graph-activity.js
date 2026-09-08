// Graph supplies Entra IDs; the Bot Framework roster is the authority for the addressable
// reactor identity. Never run under the original author's permissions on a reaction.
import { createHash } from "node:crypto";
import { makeInbound } from "../inbound.js";
import { isRobotReaction, quotedReplyId, stripMentionTags } from "./activity.js";

const digest = parts => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const userId = identity => String(identity?.user?.id || "");
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
  async function emit(actorId, trigger, stamp) {
    if (!actorId) return;
    if (!members.has(actorId)) members.set(actorId, await resolveMember(actorId));
    const member = members.get(actorId);
    if (!member?.id || member.id === botId) return;
    const eventId = digest([row.conversationId, message.id, trigger, actorId, stamp]);
    const reaction = trigger === "reaction";
    result.push(makeInbound({
      platform: "msteams", conversationId: conversation.id, conversationName: conversation.name,
      kind, threadKey: kind === "channel" ? String(message.replyToId || message.id) : "",
      messageId: reaction ? `reaction:${eventId}` : String(message.id),
      replyToId: reaction ? String(message.id) : quotedReplyId({ text: message.body?.content }),
      trigger, userId: member.id, userName: member.name, userEmail: member.email,
      text: reaction && ownBot ? "Continue the task from this message." : body || ((message.attachments || []).length ? "Handle the attached message." : ""),
      mentionsBot,
      // Graph attachment retrieval has a separate permission path. Preserve descriptors so the
      // shared attachment sink reports unavailable files instead of silently dropping them.
      attachments: (message.attachments || []).map(file => ({ name: String(file.name || "attachment"), contentType: String(file.contentType || "application/octet-stream"), download: null })),
      raw: { eventId, aadObjectId: actorId, tenantId: context.channelData?.tenant?.id || "",
        serviceUrl: context.serviceUrl || "", teamId: context.channelData?.team?.aadGroupId || "" },
    }));
  }
  // lastModifiedDateTime changes for reactions too; only lastEditedDateTime represents an edit.
  const edited = Date.parse(message.lastEditedDateTime);
  if (!application && (kind === "dm" || mentionsBot) && edited > since) {
    await emit(userId(message.from), "edit", message.lastEditedDateTime);
  }
  for (const item of message.messageHistory || []) {
    if (item.actions !== "reactionAdded" || !isRobotReaction(item.reaction?.reactionType)) continue;
    const stamp = item.modifiedDateTime;
    if (!(Date.parse(stamp) > since)) continue;
    const actor = userId(item.reaction?.user);
    // A removed reaction must not start a new run when a delayed notification is fetched.
    if (!(message.reactions || []).some(reaction => isRobotReaction(reaction.reactionType) && userId(reaction.user) === actor)) continue;
    await emit(actor, "reaction", stamp);
  }
  return result;
}
