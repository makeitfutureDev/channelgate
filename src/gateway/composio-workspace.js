// The workspace half of a Composio SDK identity, for whichever surface the subject belongs to: the
// Slack team for Slack users and channels, the Entra tenant for Microsoft Teams ones. Every caller
// that names a Composio identity (a run, the inventory, Activity connections) asks here, so a
// Teams author is the same Composio user everywhere.
import { resolveTeamsConfig } from "../config/settings.js";
import { composioSubjectPlatform } from "../ee/composio-sessions.js";

export function composioWorkspaceId({ kind = "", id = "", slackTeamId = "" } = {}) {
  if (composioSubjectPlatform({ kind, id }) === "msteams") return resolveTeamsConfig().tenantId;
  return String(slackTeamId || process.env.CG_SLACK_TEAM_ID || "").trim();
}

// What to tell a person when that workspace is unknown.
export function composioWorkspaceMissing({ kind = "", id = "" } = {}) {
  return composioSubjectPlatform({ kind, id }) === "msteams"
    ? "The Microsoft Teams tenant ID required for Composio SDK connections is not configured (Settings → Microsoft Teams)."
    : "The Slack workspace identity required for Composio SDK connections is not available.";
}
