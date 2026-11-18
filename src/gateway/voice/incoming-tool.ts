import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { incomingCalls } from "./incoming.ts";
interface Context {
  principalTrusted: boolean; apiPrincipal: boolean; agentPrincipal: boolean;
  channelId: string; threadKey: string; createdBy: string;
  requireChannelAccess: () => Promise<boolean>;
  text: (message: string) => { content: { type: "text"; text: string }[] };
}
export function registerIncomingCallTool(server: McpServer, ctx: Context) {
  server.registerTool("call_user", {
    description: "Ring the requesting person's registered iPhone about THIS thread. Requires a human approval card (Auto never bypasses it). "
      + "No arbitrary recipient or conversation may be supplied. The user answers using CallKit; only then does a voice session start. "
      + "Never claim the person answered merely because Apple accepted the push. Tell the user the invitation was sent, then end your turn.",
    inputSchema: { reason: z.string().min(1).max(160).describe("Short non-sensitive reason, shown on the phone's lock screen."),
      in_minutes: z.number().int().min(0).max(10080).optional().describe("One-time delay; the approval is obtained now and delivery survives restarts. Default 0 rings now.") },
  }, async ({ reason, in_minutes = 0 }) => {
    if (!ctx.principalTrusted || ctx.apiPrincipal || ctx.agentPrincipal || !(await ctx.requireChannelAccess())) return ctx.text("Incoming calls require an authenticated conversation member, not an API or agent principal.");
    try {
      const result = await incomingCalls().request({ ownerId: ctx.createdBy, channelId: ctx.channelId, threadTs: ctx.threadKey }, reason, in_minutes);
      if (result.scheduledAt) return ctx.text(`Incoming call scheduled for ${new Date(result.scheduledAt).toISOString()}. It will ring only if access and device registration remain valid.`);
      return ctx.text(`Incoming call invitation sent to ${result.delivered} registered iPhone(s). It expires in 45 seconds; delivery does not prove the person answered.`);
    } catch (e) { return ctx.text(`Call not sent: ${e instanceof Error ? e.message : "unavailable"}`); }
  });
}
