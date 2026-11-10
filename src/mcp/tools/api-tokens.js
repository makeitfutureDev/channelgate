// Channel-level user API tokens, from inside the conversation (src/gateway/api-tokens.js).
//
// A token belongs to THIS conversation and to the person who asked for it; a run it starts acts as
// that person with their live rank. So creating one needs a verified human author (a Slack-
// authenticated turn — never the API principal or a daemon-owned run) who is authorized here.
// Listing shows the caller their own tokens; a channel manager or an admin sees every token of
// the conversation. Revoking follows the same rule. The value is returned exactly once, inside
// this tool result, and is never logged, stored or echoed again — not even its tail.
import { z } from "zod";
import { createApiToken, curlExample, getApiToken, listApiTokens, revokeApiToken } from "../../gateway/api-tokens.js";
import { getSettings } from "../../config/settings.js";
import { logEvent } from "../../util/logger.js";

function fmt(t) {
  const when = (v) => (v ? String(v).slice(0, 16).replace("T", " ") : "never");
  return `• #${t.id} \`${t.name}\` (${t.prefix}…${t.last4}) — created by <@${t.createdBy}> ${when(t.createdAt)}, last used ${when(t.lastUsedAt)}${t.revoked ? `, REVOKED ${when(t.revokedAt)}` : ""}`;
}

export function register(server, ctx) {
  const { channelId, slug, createdBy, text, principalTrusted, requireManage, requireChannelAccess } = ctx;

  const personOnly = async () => {
    if (!principalTrusted || !createdBy) return "Only a person working in this conversation (a Slack-authenticated author) can own an API token — not an API run or a scheduled one.";
    if (!channelId || !slug) return "No conversation context — tokens belong to one registered conversation.";
    if (!(await requireChannelAccess())) return "You are not authorized in this conversation.";
    return "";
  };

  server.registerTool(
    "create_api_token",
    {
      description:
        "Create a personal HTTP run API token for THIS conversation. Runs started with it act as YOU " +
        "(your current role, your authorization here, your personal connections), are bound to this " +
        "conversation, and stop working when you revoke the token or lose access. The value is shown ONCE.",
      inputSchema: { name: z.string().describe("A short label, e.g. 'Make.com invoice flow'") },
    },
    async ({ name }) => {
      const refusal = await personOnly();
      if (refusal) return text(refusal);
      let minted;
      try {
        minted = createApiToken({ name, channelId, slug, createdBy });
      } catch (e) {
        return text(`Could not create the token: ${e.message}`);
      }
      await logEvent("api_token_created", { channel: channelId, slug, id: minted.record.id, name: minted.record.name, author: createdBy });
      const base = String(getSettings().publicUrl || "").trim();
      return text(
        `✅ Token \`${minted.record.name}\` (#${minted.record.id}) created for this conversation, acting as <@${createdBy}>.\n\n` +
        `Copy it now — it is shown only this once and the gateway keeps no copy:\n\`${minted.token}\`\n\n` +
        "Example:\n```\n" + curlExample(base, minted.token) + "\n```\n" +
        "Runs it starts are posted in this channel as threads. Revoke it any time with `revoke_api_token`." +
        (base ? "" : "\n(No public URL is configured in Settings; replace <your-gateway> with the gateway's address.)"),
      );
    },
  );

  server.registerTool(
    "list_api_tokens",
    {
      description: "List the HTTP run API tokens of this conversation: your own, or every token here when you manage the channel or are an admin. Names and last four characters only — never a value.",
      inputSchema: {},
    },
    async () => {
      const refusal = await personOnly();
      if (refusal) return text(refusal);
      const manager = await requireManage();
      const tokens = listApiTokens(manager ? { channelId } : { channelId, createdBy });
      if (!tokens.length) return text(manager ? "No API tokens exist for this conversation." : "You have no API tokens in this conversation. `create_api_token` makes one.");
      return text(`${manager ? "API tokens of this conversation" : "Your API tokens in this conversation"}:\n${tokens.map(fmt).join("\n")}`);
    },
  );

  server.registerTool(
    "revoke_api_token",
    {
      description: "Revoke one of this conversation's HTTP run API tokens by id (your own; a channel manager or admin may revoke any token of the conversation). The next call with it answers 401.",
      inputSchema: { id: z.number().int().describe("The token id from list_api_tokens") },
    },
    async ({ id }) => {
      const refusal = await personOnly();
      if (refusal) return text(refusal);
      const token = getApiToken(id);
      if (!token || token.channelId !== channelId) return text("No such token in this conversation.");
      if (token.createdBy !== createdBy && !(await requireManage())) return text("Only the token's owner, a channel manager or an admin can revoke it.");
      if (token.revoked) return text(`Token #${token.id} \`${token.name}\` is already revoked.`);
      revokeApiToken(id);
      await logEvent("api_token_revoked", { channel: channelId, slug, id: token.id, name: token.name, owner: token.createdBy, author: createdBy });
      return text(`✅ Token #${token.id} \`${token.name}\` revoked. The next request with it is refused.`);
    },
  );
}
