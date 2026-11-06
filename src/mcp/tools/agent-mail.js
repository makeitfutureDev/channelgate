// `send_agent_message`: ask another channel's agent something, on the requester's own access
// (gateway/agent-mail.js). Resolved in the daemon, which owns the live connector, the durable row
// and the gate; the tool only carries the verified identity and the model's text. The reply comes
// back later as a new turn in THIS thread, so the model ends its turn after sending.
import { z } from "zod";

export function register(server, ctx) {
  server.registerTool("send_agent_message", {
    description:
      "Send a question or request to ANOTHER channel's agent, on behalf of the person who asked you. " +
      "Use after search_agents found a channel whose agent can help (its knowledge, memory, files or skills). " +
      "Calling it posts a card in THIS thread for the requesting person to confirm the exact text; on their click the gateway " +
      "delivers the message as a new thread in that channel, its agent answers there with its own tools and permissions, " +
      "and the reply is brought back into THIS thread as a new turn. So: call it once, tell the user what you asked and that " +
      "they need to approve the card, then END YOUR TURN — never wait or poll. Allowed only where the requesting " +
      "person could post themselves: they must be authorized and a current member of that channel, everyone who can " +
      "read this conversation must belong to it too, and that channel's manager must have switched acceptsMessages on. " +
      "One message in flight per thread and channel, a few per hour. Text only (≤ 8000 characters): say what you need, " +
      "the context, and the shape of the answer you want.",
    inputSchema: {
      to: z.string().min(1).max(200).describe("The target channel: the channelId or exact name a search_agents result returned."),
      message: z.string().min(1).max(8200).describe("The self-contained question or request, with the context the other agent needs."),
    },
  }, async ({ to, message }) => {
    if (ctx.principalTrusted !== true || ctx.apiPrincipal || !ctx.createdBy || !(await ctx.requireChannelAccess())) {
      return ctx.text("Agent messages can only be sent by an authenticated conversation member with current channel access (not from an API run or another agent's delivered message).");
    }
    if (!ctx.daemon.available("agent-mail")) return ctx.text("Agent messaging is unavailable: the live conversation connector cannot be reached.");
    let data;
    try {
      data = await ctx.daemon.call("agent-mail", { channelId: ctx.channelId, slug: ctx.slug, createdBy: ctx.createdBy, threadKey: ctx.threadKey, origin: ctx.origin, to, message }, { timeoutMs: 60_000 });
    } catch (e) {
      return ctx.text(`Agent message not sent: ${e.message}`);
    }
    if (!data?.ok) return ctx.text(`🚫 Agent message not sent: ${data?.error || "refused"}`);
    const target = data.to?.name ? `#${data.to.name}` : data.to?.slug || to;
    return ctx.text(`📨 Sent to the agent in ${target} (message ${data.id}). Its reply will be posted in this thread as a new turn when it arrives.`);
  });
}
