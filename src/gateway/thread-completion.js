// Check Slack at delivery time: reaction events may predate tracking or be missed while offline.
// A root ✅ stays closed; a reply ✅ closes only while that reply remains the latest message.
const checked = (message) => message?.reactions?.some(
  (reaction) => reaction.name === "white_check_mark" && reaction.count > 0,
);

export async function threadHasCompletionReaction(client, channelId, threadTs) {
  let cursor;
  let latest;
  const seen = new Set();
  do {
    const page = await client.conversations.replies({
      channel: channelId, ts: threadTs, limit: 100, ...(cursor ? { cursor } : {}),
    });
    if (page.ok === false || !Array.isArray(page.messages) || !page.messages.length) {
      throw new Error("Unable to verify thread completion reactions");
    }
    for (const message of page.messages) {
      if (message.ts === threadTs && checked(message)) return true;
      if (!latest || Number(message.ts) > Number(latest.ts)) latest = message;
    }
    cursor = page.response_metadata?.next_cursor?.trim();
    if ((page.has_more && !cursor) || (cursor && seen.has(cursor))) {
      throw new Error("Incomplete thread completion reaction pagination");
    }
    if (cursor) seen.add(cursor);
  } while (cursor);
  return Boolean(checked(latest));
}
