// Personal token tools for the gateway control MCP server: set/clear the author's own
// Composio and Toolbox tokens, plus the two ENVIRONMENT secret scopes that are not the
// channel's — the author's own and (for admins) the organization's. Split out of
// gateway-server.js — registered via register(server, ctx); the tool contracts are unchanged.
//
// The channel's own secrets stay where they were: the Slack Secrets modal and the admin UI. These
// tools exist because the other two scopes have no channel to hang a modal off — a personal
// secret is set from the author's DM, and an organization one belongs to the deployment.
import { z } from "zod";
import { setUser } from "../../config/store.js";
import { listOrgEnv, listUserEnv, patchOrgEnv, patchUserEnv } from "../../config/scoped-env.js";

// Masked, never valued — the same write-only shape every other secret surface returns.
function renderVars(vars, empty) {
  if (!vars.length) return empty;
  return vars
    .map((v) => `• \`${v.name}\`${v.last4 ? ` (…${v.last4})` : ""}${v.resolvable ? "" : " ⚠️ unresolvable provider"}`)
    .join("\n");
}

export function register(server, ctx) {
  const { createdBy, text, requireAdmin, principalTrusted } = ctx;

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

  // ── YOUR OWN environment secrets ──────────────────────────────────────────────
  // Injected as process environment into runs THIS person authored, in every conversation they
  // talk in, and into nobody else's turn in those same conversations. A signed run capability is
  // what names the author, so an unverified principal gets no personal scope at all — the same
  // rule that withholds the personal Composio token.
  const requireSelf = () => (principalTrusted && createdBy ? "" : "No verified user context — personal secrets can only be changed from your own message.");

  server.registerTool(
    "set_my_secret",
    {
      description:
        "Set one of YOUR OWN environment secrets (e.g. GH_TOKEN). It is injected as an environment " +
        "variable into every run YOU author, in any conversation, and never into anyone else's. A " +
        "conversation's own secret of the same name still wins there. Write-only: nothing can read " +
        "the value back. IMPORTANT: send it in a DM with the bot, never in a shared channel, and " +
        "DELETE the message containing it immediately after.",
      inputSchema: { name: z.string(), value: z.string() },
    },
    async ({ name, value }) => {
      const refusal = requireSelf();
      if (refusal) return text(refusal);
      try {
        const vars = await patchUserEnv(createdBy, { set: { name, value } });
        const saved = vars.find((v) => v.name === String(name || "").trim().toUpperCase());
        return text(`✅ Saved your personal secret \`${saved?.name || name}\`. It'll be injected into runs you author.${DELETE_MSG_WARNING}`);
      } catch (e) {
        return text(`❌ ${e.message}`);
      }
    }
  );

  server.registerTool(
    "remove_my_secret",
    { description: "Remove one of YOUR OWN environment secrets by name.", inputSchema: { name: z.string() } },
    async ({ name }) => {
      const refusal = requireSelf();
      if (refusal) return text(refusal);
      try {
        await patchUserEnv(createdBy, { remove: name });
        return text(`🗑️ Removed your personal secret \`${String(name).trim().toUpperCase()}\`.`);
      } catch (e) {
        return text(`❌ ${e.message}`);
      }
    }
  );

  server.registerTool(
    "list_my_secrets",
    { description: "List the NAMES of YOUR OWN environment secrets (masked — values are never returned).", inputSchema: {} },
    async () => {
      const refusal = requireSelf();
      if (refusal) return text(refusal);
      const vars = await listUserEnv(createdBy);
      return text(`**Your personal secrets**\n${renderVars(vars, "_None set._")}`);
    }
  );

  // ── The ORGANIZATION's environment secrets (admins) ───────────────────────────
  // One credential the whole deployment shares, injected into every conversation's runs. Admin
  // only, because that is exactly its blast radius: every channel, every author admitted there.
  const requireOrgAdmin = async () => ((await requireAdmin()) ? "" : "Only organization admins can change the organization's secrets.");

  server.registerTool(
    "set_org_secret",
    {
      description:
        "ADMINS. Set an ORGANIZATION-WIDE environment secret (e.g. GH_TOKEN). It is injected into " +
        "EVERY conversation's runs, for every author admitted there — use it for a credential the " +
        "whole deployment shares, not for one team's account. A conversation's own secret of the " +
        "same name overrides it there. Write-only: nothing can read the value back. Send it in a " +
        "DM and DELETE the message afterwards.",
      inputSchema: { name: z.string(), value: z.string() },
    },
    async ({ name, value }) => {
      const refusal = await requireOrgAdmin();
      if (refusal) return text(refusal);
      try {
        const vars = patchOrgEnv({ set: { name, value }, actor: createdBy });
        const saved = vars.find((v) => v.name === String(name || "").trim().toUpperCase());
        return text(`✅ Saved the organization secret \`${saved?.name || name}\`. Every conversation's next run receives it.${DELETE_MSG_WARNING}`);
      } catch (e) {
        return text(`❌ ${e.message}`);
      }
    }
  );

  server.registerTool(
    "remove_org_secret",
    { description: "ADMINS. Remove an ORGANIZATION-WIDE environment secret by name.", inputSchema: { name: z.string() } },
    async ({ name }) => {
      const refusal = await requireOrgAdmin();
      if (refusal) return text(refusal);
      try {
        patchOrgEnv({ remove: name, actor: createdBy });
        return text(`🗑️ Removed the organization secret \`${String(name).trim().toUpperCase()}\`.`);
      } catch (e) {
        return text(`❌ ${e.message}`);
      }
    }
  );

  server.registerTool(
    "list_org_secrets",
    { description: "ADMINS. List the NAMES of the organization-wide environment secrets (masked — values are never returned).", inputSchema: {} },
    async () => {
      const refusal = await requireOrgAdmin();
      if (refusal) return text(refusal);
      return text(`**Organization secrets** (every conversation)\n${renderVars(listOrgEnv(), "_None set._")}`);
    }
  );
}
