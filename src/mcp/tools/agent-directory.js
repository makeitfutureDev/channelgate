// Discovery is resolved in the daemon, which owns the live chat connector. The same route
// serves socket-backed container tools and host stdio tools; neither accepts caller identity
// or a destination conversation from model-supplied arguments.
import { z } from "zod";
import { patchChannelMeta } from "../../config/store.js";
import { sanitizeAgentDirectoryProfile } from "../../gateway/agent-directory.js";
import { logEvent } from "../../util/logger.js";

export function register(server, ctx) {
  server.registerTool("search_agents", {
    description: "Find existing channel agents that can help with a task, or list agents with an empty query. Returns channel links, purposes, examples and active shared skills. Live membership and reply-audience checks filter every result; DMs, group DMs and personal skills are never directory entries. Recommendations do not send or delegate work. Use nextOffset for another page.",
    inputSchema: {
      query: z.string().max(500).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).max(10000).optional(),
    },
  }, async ({ query = "", limit = 20, offset = 0 }) => {
    if (ctx.principalTrusted !== true || ctx.apiPrincipal || !(await ctx.requireChannelAccess())) {
      return ctx.text("Agent discovery requires an authenticated conversation member with current channel access.");
    }
    if (!ctx.daemon.available("agent-directory")) return ctx.text("Agent discovery is unavailable: the live conversation connector cannot be reached.");
    try {
      const result = await ctx.daemon.call("agent-directory", { query, limit, offset, createdBy: ctx.createdBy, channelId: ctx.channelId }, { timeoutMs: 60_000 });
      return ctx.text(JSON.stringify(result));
    } catch {
      return ctx.text("Agent discovery is unavailable. No channel information was returned; try again when the conversation connector is available.");
    }
  });

  server.registerTool("set_channel_agent_profile", {
    description: "CHANNEL MANAGERS / ADMINS. Describe THIS channel's agent for specialist recommendations: a short purpose, example tasks, and whether to hide it from discovery. Omitted fields stay unchanged; empty text/array clears that field. Does not publish private channels to a wider audience or change skills/access. Announce the saved profile in your reply.",
    inputSchema: {
      description: z.string().max(600).optional(),
      examples: z.array(z.string().max(160)).max(6).optional(),
      hidden: z.boolean().optional(),
    },
  }, async (args) => {
    if (ctx.principalTrusted !== true || ctx.apiPrincipal || !(await ctx.requireChannelAccess()) || !(await ctx.requireManage())) {
      return ctx.text("Only this channel's authenticated managers or admins with current channel access can edit its agent profile.");
    }
    const changes = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
    if (!Object.keys(changes).length) return ctx.text("Supply a description, examples, or hidden setting. Nothing was changed.");
    const next = await patchChannelMeta(ctx.slug, (meta) => meta
      ? { agentDirectory: sanitizeAgentDirectoryProfile({ ...meta.agentDirectory, ...changes }) }
      : null);
    if (!next) return ctx.text("Channel isn't set up yet. Nothing was changed.");
    await logEvent("agent_directory_profile_changed", { channel: ctx.channelId, author: ctx.createdBy, slug: ctx.slug, keys: Object.keys(changes) });
    return ctx.text(`Agent profile saved for this channel. Discovery uses it on the next lookup.\n${JSON.stringify(next.agentDirectory)}`);
  });
}
