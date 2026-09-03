// License tools for the gateway control MCP server: read the deployment's license state (anyone
// allowed in the channel) and set/clear the key (admins only, behind the control-plane approval
// gate in gateway-server.js — a license key is persistent gateway state, exactly the class of
// change injected content must never be able to make on the model's authority).
//
// The KEY VALUE is never echoed back, not even masked: it arrives inside a chat message, so it is
// already in that conversation's history until the author deletes it, and repeating it would put
// it in a second place.
import { z } from "zod";
import { clearLicenseKey, getLicenseStatus, setLicenseKey, verifyLicense } from "../../ee/license.js";
import { conversationUsage, usageTotals } from "../../ee/limits.js";

const fmtLimit = (v) => (v === null ? "unlimited" : String(v));

export function renderLicenseStatus(status, totals) {
  const lines = [
    `*ChannelGate license*`,
    `• state: \`${status.state}\`${status.banner ? ` — ${status.banner.text}` : ""}`,
    `• tier: ${status.tier}${status.organization ? ` (${status.organization})` : ""}`,
    `• key: ${status.hasLicenseKey ? `…${status.licenseKeyLast4} (${status.licenseKeySource})` : "none"}`,
    `• conversations: ${fmtLimit(status.limits.conversations)} · AI messages per conversation per month: ${fmtLimit(status.limits.messagesPerConversationPerMonth)}`,
    `• last verified: ${status.verifiedAt || "never"}${status.nextCheckAt ? ` · next check: ${status.nextCheckAt}` : ""}`,
  ];
  if (status.expiresAt) lines.push(`• expires: ${status.expiresAt}`);
  if (totals) lines.push(`• this month (${totals.month}): ${totals.runs} AI message(s) across ${totals.conversations} conversation(s)`);
  return lines.join("\n");
}

export function register(server, ctx) {
  const { text, requireAdmin } = ctx;

  // Read-only, so anyone allowed to talk in the channel may ask. "Why did the bot refuse in the
  // other channel?" is a question a non-admin has every reason to ask, and the answer contains no
  // secret — only the tier, the limits, and the last four characters of the key.
  server.registerTool(
    "get_license_status",
    {
      description:
        "Show this ChannelGate deployment's license state: tier, the active conversation and " +
        "monthly-message limits, when the key was last verified, and this month's usage. Use it to " +
        "explain why a conversation was refused or is near its limit. Never reveals the key itself.",
      inputSchema: {},
    },
    async () => {
      const status = getLicenseStatus();
      const totals = usageTotals();
      const top = conversationUsage({ limit: 5 });
      const busiest = top.length
        ? `\n• busiest conversations this month: ${top.map((c) => `${c.runs}`).join(", ")} run(s)`
        : "";
      return text(`${renderLicenseStatus(status, totals)}${busiest}\n\nManage the key in the admin UI under Settings → License, or with set_license_key (admins only).`);
    }
  );

  server.registerTool(
    "set_license_key",
    {
      description:
        "Set this deployment's ChannelGate license key (ADMINS ONLY). Send it in a DM with the " +
        "bot, never in a shared channel, and DELETE the message containing the key immediately " +
        "after — it stays readable in chat history until you do. The key is verified against the " +
        "ChannelGate platform right away; the new tier applies to the next run.",
      inputSchema: { key: z.string() },
    },
    async ({ key }) => {
      if (!(await requireAdmin())) return text("🚫 Only gateway admins can set the license key. Nothing was changed.");
      const value = String(key || "").trim();
      if (value.length < 8) return text("That doesn't look like a ChannelGate license key. Nothing was changed.");
      setLicenseKey(value, { verify: false });
      const result = await verifyLicense();
      return text(
        `✅ Saved the license key (…${value.slice(-4)}) and verified it: \`${result.outcome}\`.\n\n` +
          `${renderLicenseStatus(getLicenseStatus(), usageTotals())}\n\n` +
          "⚠️ Now DELETE the message that contained the key — it stays readable in chat history (and search) until you do."
      );
    }
  );

  server.registerTool(
    "clear_license_key",
    {
      description:
        "Remove this deployment's ChannelGate license key (ADMINS ONLY). The deployment falls back " +
        "to the no-key limits: one conversation per UTC month, 500 AI messages in it.",
      inputSchema: {},
    },
    async () => {
      if (!(await requireAdmin())) return text("🚫 Only gateway admins can clear the license key. Nothing was changed.");
      clearLicenseKey();
      return text(`🗑️ Removed the license key.\n\n${renderLicenseStatus(getLicenseStatus(), usageTotals())}`);
    }
  );
}
