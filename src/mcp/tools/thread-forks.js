import { z } from "zod";
import { platformOfConversation } from "../../platforms/ids.js";
import { capabilitiesFor, platformOr, platformSupports } from "../../platforms/registry.js";
import { threadForkOrigin } from "../../gateway/thread-fork-approvals.js";

export function register(server, ctx) {
  const platform = platformOfConversation(ctx.channelId);
  if (ctx.toolset !== "full" || ctx.principalTrusted !== true || !ctx.origin || ctx.origin !== threadForkOrigin(platform) || !platformSupports(platform, "threadForks")) return;
  // Where every conversation has threads (Slack) the tool exists only in a real thread. Where only
  // some do (Google Chat), it stays registered so a call from a DM, a group chat or an unthreaded
  // space is refused with the reason instead of the model guessing why it has no such tool.
  if (!capabilitiesFor(platform).mixedThreading && !platformOr(platform).validDeliveryThread?.(ctx.threadKey, ctx.channelId)) return;
  server.registerTool("propose_thread_forks", {
    description: "Propose 1–10 separate discussion threads from THIS thread's context. Use when the user asks to split topics or fork each topic. Supply each title and exact opening prompt. One durable card lists the entire batch; the requester or an admin must approve, even in Auto mode. Return pending and end your turn: the daemon creates the forks after approval and after the source turn finishes, then posts links here. No child exists before approval. Keep the whole proposal under 2400 characters. Do not call /fork through shell or post fake user messages.",
    inputSchema: { forks: z.array(z.object({ title: z.string().min(1).max(100), prompt: z.string().min(1).max(2000) })).min(1).max(10) },
  }, async () => ctx.text("Fork proposals execute only through their saved approval."));
}
