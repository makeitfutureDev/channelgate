import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { incomingCalls } from "../../gateway/voice/incoming.ts";
interface Context {
  principalTrusted: boolean; apiPrincipal: boolean; agentPrincipal: boolean;
  channelId: string; threadKey: string; createdBy: string;
  requireChannelAccess: () => Promise<boolean>;
  text: (message: string) => { content: { type: "text"; text: string }[] };
}
type Caller = Pick<Context, "principalTrusted" | "apiPrincipal" | "agentPrincipal" | "channelId" | "threadKey" | "createdBy">;
const PRINCIPAL = "Incoming calls require an authenticated conversation member, not an API or agent principal.";
const targetOf = (caller: Caller) => ({ ownerId: caller.createdBy, channelId: caller.channelId, threadTs: caller.threadKey });
const reasonOf = (e: unknown) => e instanceof Error ? e.message : "Incoming calls are unavailable.";
/**
 * Why this call cannot be placed right now, or "" when it can. The approval gate asks before it
 * posts a card, so nobody approves a call that an unconfigured install, a missing iPhone or a
 * pending invitation would refuse anyway. Read-only; the handler validates again on approval.
 */
export async function incomingCallProblem(caller: Caller, reason: string, inMinutes = 0): Promise<string> {
  if (!caller.principalTrusted || caller.apiPrincipal || caller.agentPrincipal) return PRINCIPAL;
  try { await incomingCalls().preflight(targetOf(caller), reason, inMinutes); return ""; }
  catch (e) { return reasonOf(e); }
}
export function registerIncomingCallTool(server: McpServer, ctx: Context): void {
  server.registerTool("call_user", {
    description: "Ring the requesting person's registered iPhone about THIS thread. Requires a human approval card (Auto never bypasses it). "
      + "No arbitrary recipient or conversation may be supplied. The user answers using CallKit; only then does a voice session start. "
      + "Never claim the person answered merely because Apple accepted the push. Tell the user the invitation was sent, then end your turn.",
    inputSchema: { reason: z.string().min(1).max(160).describe("Short non-sensitive reason, shown on the phone's lock screen."),
      in_minutes: z.number().int().min(0).max(10080).optional().describe("One-time delay; the approval is obtained now and delivery survives restarts. Default 0 rings now.") },
  }, async ({ reason, in_minutes = 0 }) => {
    // A refusal is an error result: the approval card then reports the failure, never "applied".
    const failed = (message: string) => ({ ...ctx.text(`Couldn't place the call: ${message}`), isError: true });
    if (!ctx.principalTrusted || ctx.apiPrincipal || ctx.agentPrincipal || !(await ctx.requireChannelAccess())) return failed(PRINCIPAL);
    try {
      const result = await incomingCalls().request(targetOf(ctx), reason, in_minutes);
      if (result.scheduledAt) return ctx.text(`Incoming call scheduled for ${new Date(result.scheduledAt).toISOString()}. It will ring only if access and device registration remain valid.`);
      return ctx.text(`Incoming call invitation sent to ${result.delivered} registered iPhone(s). It expires in 45 seconds; delivery does not prove the person answered.`);
    } catch (e) { return failed(reasonOf(e)); }
  });
}
