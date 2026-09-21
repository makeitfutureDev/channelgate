import { getChannelEntry, getChannelMeta, isAdmin, isApproved } from "../config/store.js";
import { isAuthorized } from "./modes.js";
import { platformSupports } from "../platforms/registry.js";
import { listConversationMemberIds } from "../slack/members.js";

// Rechecked on opening, saving, submitting, queue promotion and restart recovery. A Slack
// interaction proves who clicked, but an old card does not prove current conversation access.
export async function assertQuestionAccess(record, client, { timeoutMs = 0 } = {}) {
  if (timeoutMs > 0) {
    let timer;
    try {
      return await Promise.race([
        assertQuestionAccess(record, client),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Access verification took too long. Please try again.")), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  const entry = await getChannelEntry(record.channelId);
  if (!entry || entry.slug !== record.slug || !record.authorId) throw new Error("This question's conversation is no longer available.");
  const meta = await getChannelMeta(record.slug);
  if (platformSupports(meta?.platform, "richCards") !== "block-kit" || !platformSupports(meta?.platform, "modals")) throw new Error("Question forms are not supported on this surface.");
  const [admin, approved] = await Promise.all([isAdmin(record.authorId), isApproved(record.authorId)]);
  if (!isAuthorized(meta, record.authorId, Boolean(entry.isDM), { isAdminUser: admin, isApprovedUser: approved })) throw new Error("You no longer have access to answer questions in this conversation.");
  const members = await listConversationMemberIds(client, record.channelId);
  if (!members.includes(record.authorId)) throw new Error("Only current conversation members can answer these questions.");
  return meta;
}
