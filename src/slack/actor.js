// The clicking/submitting Slack user of an interaction payload. Slack always sends this id as a
// non-empty string; anything else (a number, object or array) is a malformed callback, and
// returning "" makes every Home handler's existing `if (!userId) return` refuse it before a load,
// a publication or a user-record write.
export function slackActorId(body) {
  const id = body?.user?.id;
  return typeof id === "string" ? id : "";
}
