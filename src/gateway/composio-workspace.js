// The workspace half of a Composio SDK identity, for whichever surface the subject belongs to: the
// Slack team for Slack users and channels, the Entra tenant for Microsoft Teams ones, the Chat
// app's Google Cloud project for Google Chat ones. Every caller that names a Composio identity (a
// run, the inventory, Activity connections) asks here, so a person is the same Composio user
// everywhere.
import { googleChatProjectId, resolveTeamsConfig } from "../config/settings.js";
import { getUser } from "../config/store.js";
import { composioSubjectPlatform } from "../ee/composio-sessions.js";

const GOOGLE_CHAT_USER = /^users\/[A-Za-z0-9_-]{1,128}$/;

export function composioWorkspaceId({ kind = "", id = "", slackTeamId = "" } = {}) {
  const platform = composioSubjectPlatform({ kind, id });
  if (platform === "msteams") return resolveTeamsConfig().tenantId;
  if (platform === "googlechat") return googleChatProjectId();
  return String(slackTeamId || process.env.CG_SLACK_TEAM_ID || "").trim();
}

// What to tell a person when that workspace is unknown.
export function composioWorkspaceMissing({ kind = "", id = "" } = {}) {
  const platform = composioSubjectPlatform({ kind, id });
  if (platform === "msteams") return "The Microsoft Teams tenant ID required for Composio SDK connections is not configured (Settings → Microsoft Teams).";
  if (platform === "googlechat") return "The Google Cloud project ID required for Composio SDK connections is not available: save a Google Chat service-account key that contains its project_id (Settings → Google Chat).";
  return "The Slack workspace identity required for Composio SDK connections is not available.";
}

export const GOOGLE_CHAT_AUTHOR_UNRECORDED = "The Google Chat account ID of this person is not recorded yet. It is recorded when they send the app a message in Google Chat.";

// The workspace and the subject a Composio identity is named from. Slack and Teams subjects are
// their ids unchanged. A Google Chat author is known to the gateway by e-mail, but is named to
// Composio by the immutable `users/<id>` the transport records from Google's own events on every
// message and card click (`googleChatUserName`): an address can be renamed or reassigned to
// another person, and must never carry connected accounts with it. No recorded resource → no
// subject (`missing` says why); never a guess and never the e-mail.
export async function composioSubject({ kind = "", id = "", slackTeamId = "" } = {}, { loadUser = getUser } = {}) {
  const workspaceId = composioWorkspaceId({ kind, id, slackTeamId });
  let subject = String(id || "").trim();
  const googleChatAuthor = kind === "user" && composioSubjectPlatform({ kind, id: subject }) === "googlechat";
  if (googleChatAuthor && !GOOGLE_CHAT_USER.test(subject)) {
    const record = await loadUser(subject);
    subject = GOOGLE_CHAT_USER.test(record?.googleChatUserName || "") ? record.googleChatUserName : "";
  }
  const missing = !workspaceId ? composioWorkspaceMissing({ kind, id })
    : !subject ? (googleChatAuthor ? GOOGLE_CHAT_AUTHOR_UNRECORDED : "The Composio identity for this conversation is not available.") : "";
  return { workspaceId, id: subject, missing };
}
