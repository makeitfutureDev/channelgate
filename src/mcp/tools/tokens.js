// Personal token tools for the gateway control MCP server: set/clear the author's own
// Composio and Toolbox tokens. Split out of gateway-server.js — registered
// via register(server, ctx); the tool contracts are unchanged.
import { z } from "zod";
import { setUser } from "../../config/store.js";

export function register(server, ctx) {
  const { createdBy, text } = ctx;

  // ── Personal Composio token (any user, for themselves) ─────────────────────────
  // Token-entry tools: the secret arrives inside a Slack message, so it sits in Slack history (and
  // search) until the author deletes that message. Harden what we control: the saved token is NEVER
  // echoed back (not even a masked tail) and the reply tells the user to delete the source message
  // NOW. A DM-modal/web-only entry flow would remove the exposure entirely — out of scope here.
  const DELETE_MSG_WARNING =
    "\n⚠️ Now DELETE the Slack message that contained the token — it stays readable in Slack " +
    "history (and search) for everyone in this conversation until you do.";

  server.registerTool(
    "set_my_composio_token",
    {
      description:
        "Set YOUR OWN personal Composio token (x-consumer-api-key) so your messages can use your " +
        "Composio tools. IMPORTANT: send it in a DM with the bot, never in a shared channel, and " +
        "DELETE the message containing the token immediately after — it stays readable in Slack " +
        "history until you do. Use clear_my_composio_token to remove it.",
      inputSchema: { token: z.string() },
    },
    async ({ token }) => {
      if (!createdBy) return text("No user context — can't set a token here.");
      const t = (token || "").trim();
      if (t.length < 6) return text("That doesn't look like a valid Composio token.");
      await setUser(createdBy, { composioToken: t });
      return text(`✅ Saved your Composio token. It'll be used for your messages.${DELETE_MSG_WARNING}`);
    }
  );

  server.registerTool(
    "clear_my_composio_token",
    { description: "Remove YOUR OWN Composio token.", inputSchema: {} },
    async () => {
      if (!createdBy) return text("No user context.");
      await setUser(createdBy, { composioToken: "" });
      return text("🗑️ Removed your Composio token.");
    }
  );

  // ── Personal Toolbox token (any user, for themselves) ───────────────────────────
  server.registerTool(
    "set_my_toolbox_token",
    {
      description:
        "Set YOUR OWN personal Toolbox (makeitfuture-toolbox) access token so your messages can use " +
        "your Toolbox tools. It's sent as an Authorization: Bearer token. IMPORTANT: send it in a DM " +
        "with the bot, never in a shared channel, and DELETE the message containing the token " +
        "immediately after — it stays readable in Slack history until you do. Use " +
        "clear_my_toolbox_token to remove it.",
      inputSchema: { token: z.string() },
    },
    async ({ token }) => {
      if (!createdBy) return text("No user context — can't set a token here.");
      const t = (token || "").trim();
      if (t.length < 6) return text("That doesn't look like a valid Toolbox token.");
      await setUser(createdBy, { toolboxToken: t });
      return text(`✅ Saved your Toolbox token. It'll be used for your messages.${DELETE_MSG_WARNING}`);
    }
  );

  server.registerTool(
    "clear_my_toolbox_token",
    { description: "Remove YOUR OWN Toolbox token.", inputSchema: {} },
    async () => {
      if (!createdBy) return text("No user context.");
      await setUser(createdBy, { toolboxToken: "" });
      return text("🗑️ Removed your Toolbox token.");
    }
  );
}
