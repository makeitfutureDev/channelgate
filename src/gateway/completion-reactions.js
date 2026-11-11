// Slack aliases and skin-tone variants share one completion meaning across Activity/reminders.
export function isCompletionReaction(name) {
  return ["white_check_mark", "heavy_check_mark", "+1", "thumbsup"].includes(String(name || "").split("::")[0]);
}

export const messageHasCompletionReaction = (message) => Boolean(message?.reactions?.some(
  (reaction) => isCompletionReaction(reaction.name) && reaction.count > 0,
));
