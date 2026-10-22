import { questionInput } from "../../gateway/questions.js";
import { postQuestions } from "../../slack/questions.js";
import { isSlackTs } from "../../slack/thread-keys.js";

export function register(server, ctx, { post = postQuestions } = {}) {
  // Schedules keep their creator as the recipient. Their signed display address is separate
  // from the synthetic engine session; an empty address creates a new thread with the card.
  const scheduled = ctx.origin === "schedule" || (ctx.questionThreadKey !== undefined && ["slack_foreground", "recovery"].includes(ctx.origin));
  if ((!scheduled && ctx.origin !== "slack_foreground") || !ctx.principalTrusted || !ctx.createdBy ||
    (!scheduled && !isSlackTs(ctx.threadKey)) ||
    (scheduled && ctx.questionThreadKey !== "" && !isSlackTs(ctx.questionThreadKey))) return;
  server.registerTool("ask_questions", {
    description: "Ask the requesting user clarification questions in this Slack thread using interactive cards or a paginated form. " +
      "Supply custom option labels/values; single (up to 4 options), multi (up to 10), or text questions; custom text answers are enabled by default. " +
      "Returns a saved pending request, NOT user answers. Continue only independent work or end this turn; the gateway queues a continuation with answers after the user clicks Submit. " +
      "Do not poll or assume a selected/default answer. Use request_approval for permission to execute actions, not this tool.",
    inputSchema: questionInput,
  }, async (args) => {
    try {
      const record = await post({ channelId: ctx.channelId, threadKey: scheduled ? ctx.questionThreadKey : ctx.threadKey, authorId: ctx.createdBy, slug: ctx.slug,
        ...(scheduled ? { sessionThreadKey: ctx.threadKey, sourceSudo: ctx.sudoSchedule === true } : {}) }, args);
      return ctx.text(`Questions posted (request ${record.id}). Awaiting the requesting user's Submit. Drafts survive restarts; the gateway will continue this thread with the answers. Continue independent work or end this turn. Do not poll, invent answers, or perform work that depends on them.`);
    } catch (error) { return { ...ctx.text(`Could not post questions: ${error.message}`), isError: true }; }
  });
}
