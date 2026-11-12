// Only checkmark reactions complete work. Emoji thumbs-up is distinct from answer feedback.
export function isCompletionReaction(name) {
  return ["white_check_mark", "heavy_check_mark"].includes(String(name || "").split("::")[0]);
}

export const messageHasCompletionReaction = (message) => Boolean(message?.reactions?.some(
  (reaction) => isCompletionReaction(reaction.name) && reaction.count > 0,
));
