// `send_agent_message`: ask another channel's agent something, on the requester's own access
// (gateway/agent-mail.js). Resolved in the daemon, which owns the live connector, the durable row
// and the gate; the tool only carries the verified identity and the model's text. The reply comes
// back later as a new turn in THIS thread, so the model ends its turn after sending.
import { z } from "zod";

export function register(server, ctx) {
  server.registerTool("send_agent_message", {
    description:
      "Send a question or request to ANOTHER channel's agent, on behalf of the person who asked you. " +
      "Use when the user names a channel (\"ask #sales …\", \"tell the agent in #dev to …\") or when search_agents found a channel " +
      "whose agent can help (its knowledge, memory, files or skills). A channel the directory did not list may still accept: call " +
      "this tool anyway when the user named it; a refusal states the exact failed check, which you relay. " +
      "Calling it posts a card in THIS thread for the requesting person to confirm the exact text; on their click the gateway " +
      "delivers the message as a new thread in that channel, its agent answers there with its own tools and permissions, " +
      "and the reply is brought back into THIS thread as a new turn. So: call it once, tell the user what you asked and that " +
      "they need to approve the card, then END YOUR TURN — never wait or poll. Allowed only where the requesting " +
      "person could post themselves: they must be authorized in that channel and a current member of it and of this conversation. " +
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
    const target = data.to?.name ? `#${String(data.to.name).replace(/^#+/, "")}` : data.to?.slug || to;
    return ctx.text(`💬 Asked the ${target} agent. Its replies land in this thread as new turns; the conversation goes on as long as you keep answering it.`);
  });

  server.registerTool("continue_agent_conversation", {
    description:
      "Continue the agent conversation open in THIS thread. While you are answering the other channel's agent (your turn began with " +
      "\"[agent conversation] … just said\"), call it with NO message: your reply itself is delivered to that agent when this turn ends. " +
      "Do not call it when the other agent delivered the final result — presenting that to the user ends the conversation. From an " +
      "ordinary turn (the user wants to tell the other agent something more), pass `message`: it is delivered now and the reply comes " +
      "back here as a new turn. Only the person the conversation is for can continue it; a conversation closes after its message limit or an hour of silence.",
    inputSchema: {
      message: z.string().max(8200).optional().describe("Omit while answering the other agent. From an ordinary turn, the message to deliver now."),
    },
  }, async ({ message = "" }) => {
    if (ctx.principalTrusted !== true || ctx.apiPrincipal || !ctx.createdBy || !(await ctx.requireChannelAccess())) {
      return ctx.text("Agent conversations can only be continued by the authenticated person they are for.");
    }
    if (!ctx.daemon.available("agent-mail")) return ctx.text("Agent messaging is unavailable: the live conversation connector cannot be reached.");
    let data;
    try {
      data = await ctx.daemon.call("agent-mail", { action: "continue", channelId: ctx.channelId, slug: ctx.slug, createdBy: ctx.createdBy, threadKey: ctx.threadKey, message }, { timeoutMs: 60_000 });
    } catch (e) {
      return ctx.text(`Could not continue: ${e.message}`);
    }
    if (!data?.ok) return ctx.text(`🚫 ${data?.error || "refused"}`);
    return ctx.text(data.mode === "flag"
      ? `✅ Your reply will be delivered to the ${data.to} agent when this turn ends. Write only what it should read.`
      : `💬 Delivered to the ${data.to} agent. Its reply lands in this thread as a new turn.`);
  });
}
