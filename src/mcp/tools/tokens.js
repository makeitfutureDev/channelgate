// Personal token tools for the gateway control MCP server: set/clear the author's own
// Composio and Toolbox tokens, plus the ENVIRONMENT secrets — one listing across all three
// scopes and one setter/remover for the two that have no channel to hang a modal off (a
// personal secret is set from the author's DM, an organization one belongs to the deployment).
// Split out of gateway-server.js — registered via register(server, ctx).
//
// The channel's own secrets are WRITTEN where they were: the Slack Secrets modal and the admin UI.
import { z } from "zod";
import { setUser } from "../../config/store.js";
import { revokeRemoteMcpsForAuthor } from "../remote-mcp-registry.js";
import { listOrgEnv, listUserEnv, patchOrgEnv, patchUserEnv } from "../../config/scoped-env.js";
import { listChannelEnv } from "../../config/channel-env.js";

// Masked, never valued — the same write-only shape every other secret surface returns.
function renderVars(vars, empty) {
  if (!vars.length) return empty;
  return vars
    .map((v) => `• \`${v.name}\`${v.last4 ? ` (…${v.last4})` : ""}${v.provider && v.provider !== "local" ? ` via ${v.provider}` : ""}${v.setBy ? ` — set by <@${v.setBy}>` : ""}${v.resolvable ? "" : " ⚠️ unresolvable provider"}`)
    .join("\n");
}

export function register(server, ctx) {
  const { createdBy, text, requireAdmin, principalTrusted, loadMeta } = ctx;

  // ── Personal Composio token (any user, for themselves) ─────────────────────────
  // Token-entry tools: the secret arrives inside a Slack message, so it sits in Slack history (and
  // search) until the author deletes that message. Harden what we control: the saved token is NEVER
  // echoed back (not even a masked tail) and the reply tells the user to delete the source message
  // NOW. A DM-modal/web-only entry flow would remove the exposure entirely — out of scope here.
  // Personal tokens belong to a verified person. An HTTP run API turn names an author it never
  // proved, so it acts as the API principal and has no personal record to write.
  const NO_PERSONAL_CONTEXT = "No verified user context — personal tokens can only be changed from your own Slack message.";
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
      if (!principalTrusted || !createdBy) return text(NO_PERSONAL_CONTEXT);
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
      if (!principalTrusted || !createdBy) return text(NO_PERSONAL_CONTEXT);
      await setUser(createdBy, { composioToken: "" });
      // A container run relays the token daemon-side for the life of its capability; a removed
      // token must stop working now, not in six hours (src/mcp/remote-mcp-registry.js).
      revokeRemoteMcpsForAuthor(createdBy);
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
      if (!principalTrusted || !createdBy) return text(NO_PERSONAL_CONTEXT);
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
      if (!principalTrusted || !createdBy) return text(NO_PERSONAL_CONTEXT);
      await setUser(createdBy, { toolboxToken: "" });
      revokeRemoteMcpsForAuthor(createdBy); // same reason as clear_my_composio_token
      return text("🗑️ Removed your Toolbox token.");
    }
  );

  // ── YOUR OWN environment secrets ──────────────────────────────────────────────
  // Injected as process environment into runs THIS person authored, in every conversation they
  // talk in, and into nobody else's turn in those same conversations. A signed run capability is
  // what names the author, so an unverified principal gets no personal scope at all — the same
  // rule that withholds the personal Composio token.
  const requireSelf = () => (principalTrusted && createdBy ? "" : "No verified user context — personal secrets can only be changed from your own message.");

  // ── Environment secrets: ONE tool per verb, the scope is an argument ─────────────
  // Three scopes (organization → personal → conversation, most specific wins) but one mental
  // model, so the listing is one call that shows everything a run receives, filterable. Values
  // never come back through any of these — a secret is what a run's PROCESS gets, never what the
  // model's context gets — only names, providers, masked tails and who set them. Writes stay
  // where they were: personal (self) and organization (admins, approval-gated); a conversation's
  // own secrets are set in its Secrets modal or the admin UI, never pasted into a shared channel.
  const SCOPES = ["organization", "personal", "conversation"];
  const scopeOf = (value, fallback) => {
    const scope = String(value || fallback).trim().toLowerCase();
    if (scope === "org") return "organization";
    if (scope === "channel" || scope === "chat") return "conversation";
    if (scope === "my" || scope === "user" || scope === "own") return "personal";
    return scope;
  };
  const requireOrgAdmin = async () => ((await requireAdmin()) ? "" : "Only organization admins can change the organization's secrets.");

  server.registerTool(
    "list_secrets",
    {
      description:
        "List the environment secrets a run in this conversation receives — NAMES only, with the " +
        "provider, a masked tail and who set them; values are never returned by anything. `scope` " +
        "filters: `organization` (shared by every conversation), `personal` (yours, injected only " +
        "into runs you author), `conversation` (this conversation's own), or `all` (default). Live: " +
        "a secret added a moment ago is listed at once, even though a process that already started " +
        "keeps the environment it started with.",
      inputSchema: { scope: z.enum(["all", "organization", "personal", "conversation", "org", "channel", "my"]).optional() },
    },
    async ({ scope } = {}) => {
      const wanted = scopeOf(scope, "all");
      const sections = [];
      const admin = await requireAdmin();
      if (wanted === "all" || wanted === "organization") {
        // Every run is told the organization NAMES in its prompt already; the tails and authors
        // are the admin surface's, like the UI.
        const vars = listOrgEnv().map((v) => (admin ? v : { name: v.name, provider: v.provider, resolvable: v.resolvable }));
        sections.push(`**Organization** (every conversation)\n${renderVars(vars, "_None set._")}`);
      }
      if (wanted === "all" || wanted === "personal") {
        const refusal = requireSelf();
        sections.push(`**Personal** (yours; only runs you author)\n${refusal ? `_${refusal}_` : renderVars(await listUserEnv(createdBy), "_None set._")}`);
      }
      if (wanted === "all" || wanted === "conversation") {
        const meta = (await loadMeta?.()) || {};
        sections.push(`**This conversation**\n${renderVars(listChannelEnv(meta), "_None set — the Secrets modal (/secrets) or the admin UI adds one._")}`);
      }
      if (!sections.length) return text(`Unknown scope \`${scope}\`. Use one of: all, ${SCOPES.join(", ")}.`);
      return text(`${sections.join("\n\n")}\n\n_Most specific wins when names collide: conversation over personal over organization. A process that already started keeps its environment; a new one has these._`);
    }
  );

  server.registerTool(
    "set_secret",
    {
      description:
        "Set an environment secret. `scope`: `personal` (default) = YOUR OWN, injected into every " +
        "run you author in any conversation and never into anyone else's; `organization` (ADMINS) = " +
        "shared by EVERY conversation's runs — for a credential the whole deployment uses, not one " +
        "team's account. A conversation's own secret of the same name still wins there. Write-only: " +
        "nothing can read the value back. IMPORTANT: send it in a DM with the bot, never in a shared " +
        "channel, and DELETE the message containing it immediately after. A conversation's own " +
        "secrets are set in its Secrets modal or the admin UI, not here.",
      inputSchema: { name: z.string(), value: z.string(), scope: z.enum(["personal", "organization", "my", "org"]).optional() },
    },
    async ({ name, value, scope }) => {
      const target = scopeOf(scope, "personal");
      try {
        if (target === "organization") {
          const refusal = await requireOrgAdmin();
          if (refusal) return text(refusal);
          const vars = patchOrgEnv({ set: { name, value }, actor: createdBy });
          const saved = vars.find((v) => v.name === String(name || "").trim().toUpperCase());
          return text(`✅ Saved the organization secret \`${saved?.name || name}\`. Every conversation's next run receives it.${DELETE_MSG_WARNING}`);
        }
        if (target !== "personal") return text(`\`set_secret\` writes the personal or organization scope; a conversation's own secrets are set in its Secrets modal or the admin UI.`);
        const refusal = requireSelf();
        if (refusal) return text(refusal);
        const vars = await patchUserEnv(createdBy, { set: { name, value } });
        const saved = vars.find((v) => v.name === String(name || "").trim().toUpperCase());
        return text(`✅ Saved your personal secret \`${saved?.name || name}\`. It'll be injected into runs you author.${DELETE_MSG_WARNING}`);
      } catch (e) {
        return text(`❌ ${e.message}`);
      }
    }
  );

  server.registerTool(
    "remove_secret",
    {
      description: "Remove an environment secret by name. `scope`: `personal` (default) = YOUR OWN; `organization` (ADMINS) = the organization-wide one — every conversation stops receiving it.",
      inputSchema: { name: z.string(), scope: z.enum(["personal", "organization", "my", "org"]).optional() },
    },
    async ({ name, scope }) => {
      const target = scopeOf(scope, "personal");
      const shown = String(name || "").trim().toUpperCase();
      try {
        if (target === "organization") {
          const refusal = await requireOrgAdmin();
          if (refusal) return text(refusal);
          patchOrgEnv({ remove: name, actor: createdBy });
          return text(`🗑️ Removed the organization secret \`${shown}\`.`);
        }
        if (target !== "personal") return text(`\`remove_secret\` removes a personal or organization secret; a conversation's own are managed in its Secrets modal or the admin UI.`);
        const refusal = requireSelf();
        if (refusal) return text(refusal);
        await patchUserEnv(createdBy, { remove: name });
        return text(`🗑️ Removed your personal secret \`${shown}\`.`);
      } catch (e) {
        return text(`❌ ${e.message}`);
      }
    }
  );
}
