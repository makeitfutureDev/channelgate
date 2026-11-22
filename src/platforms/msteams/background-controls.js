// Teams access to background work: the "Check status" button on a job's started notice, and the
// `/jobs` command listing what is running in this conversation. Same gate as Slack's button and
// /status: an admin, an approved user, or an explicit guest of THIS conversation; the job must
// belong to the conversation Teams' verified envelope names, never one the card data names.
import { getChannelEntry, getChannelMeta, isAdmin, isApproved } from "../../config/store.js";
import { isAuthorized } from "../../gateway/modes.js";
import {
  BACKGROUND_STATUS_ACTION, backgroundJobStatus, backgroundJobsCard, backgroundJobsText,
  backgroundStatusCard, backgroundStatusLines, listBackgroundJobs,
} from "../../gateway/background-status.js";

export function createTeamsBackgroundControls({ connector, status = backgroundJobStatus, list = listBackgroundJobs, log = console } = {}) {
  async function admitted(conversationId, userId) {
    const entry = await getChannelEntry(conversationId);
    const meta = entry ? await getChannelMeta(entry.slug) : null;
    if (!meta) return null;
    const [adminUser, approvedUser] = await Promise.all([isAdmin(userId), isApproved(userId)]);
    return isAuthorized(meta, userId, Boolean(meta.isDM), { isAdminUser: adminUser, isApprovedUser: approvedUser }) ? entry : null;
  }

  const denied = { type: "AdaptiveCard", version: "1.4", body: [{ type: "TextBlock", wrap: true,
    text: "You're not authorized to see this conversation's background work." }] };

  async function onAction(interaction, { respond }) {
    const entry = await admitted(interaction.conversationId, interaction.actorId);
    if (!entry) return respond(denied);
    const current = status({ jobId: interaction.data.id, slug: entry.slug });
    // A legacy Submit client shows no invoke response: answer in the clicker's private chat, which
    // falls back to this conversation only when a private chat cannot be opened (as Slack does).
    if (!interaction.invokeName) {
      await connector.post({ conversationId: interaction.nativeConversationId, threadKey: interaction.threadKey,
        ephemeralTo: interaction.actorId, text: backgroundStatusLines(current).join("\n\n") })
        .catch(error => log.warn?.(`[msteams] background status delivery failed: ${error?.message || error}`));
    }
    return respond(backgroundStatusCard(current));
  }

  // `/jobs`: the conversation's running background work, each with its own status button.
  async function command({ message, reply, replyCard }) {
    if (message.trigger === "reaction" || !/^\/jobs\s*$/i.test(message.text.trim())) return false;
    const entry = await admitted(message.conversationId, message.userId);
    if (!entry) { await reply("You're not authorized to see this conversation's background work."); return true; }
    const jobs = list(entry.slug);
    if (replyCard) {
      try { await replyCard({ card: backgroundJobsCard(jobs), text: backgroundJobsText(jobs) }); return true; }
      catch { /* the text list below is the same information */ }
    }
    await reply(backgroundJobsText(jobs));
    return true;
  }

  return { onAction, command, isAction: action => action === BACKGROUND_STATUS_ACTION };
}
