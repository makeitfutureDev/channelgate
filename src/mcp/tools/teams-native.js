// File delivery uses the native controls in the current Teams conversation.
import { z } from "zod";
import { platformOfConversation } from "../../platforms/ids.js";
import { liveConnector } from "../../platforms/live.js";
import { platformOr } from '../../platforms/registry.js';

export function register(server, ctx) {
  const { channelId, slug, createdBy, text } = ctx;
  const platform = platformOfConversation(channelId);
  const adapter = platformOr(platform);
  if (!adapter.workspaceAccess || !['adaptive-cards', 'cards-v2'].includes(adapter.capabilities.richCards)) return;
  server.registerTool(
    "share_file",
    {
      description: `Send a workspace file into THIS ${adapter.label} conversation as native private file controls. ` +
        "The requester can preview text and download the complete file from these controls. " +
        "Use when asked to send or attach a file here. No Composio account or public file link is needed. " +
        "Requires the gateway Public URL for authenticated browser downloads. Does not upload to OneDrive.",
      inputSchema: { path: z.string().describe("File path relative to this conversation's working folder.") },
    },
    async ({ path: relative }) => {
      try {
        if (!await ctx.requireChannelAccess()) return text("You are no longer allowed to use this workspace.");
        const connector = liveConnector(platform);
        if (!connector?.shareFile || connector.ready?.() === false) return text(`${adapter.label} file delivery is unavailable; reconnect it and try again.`);
        await connector.shareFile({ channelId, slug, authorId: createdBy, threadKey: ctx.threadKey, relative });
        return text(`Posted Open file controls in this ${adapter.label} conversation. Use them to preview and download the complete file. No public link was created.`);
      } catch (error) { return text(`Couldn't share the file: ${String(error?.message || "failed").replace(/\s+/g, " ").trim()}`); }
    },
  );
}
