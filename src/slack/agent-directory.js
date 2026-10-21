// Metadata and membership only: the specialist directory never reads conversation history.
const MAX_MEMBER_PAGES = 50;
const MEMBER_PAGE_SIZE = 200;

export function createSlackAgentDirectory(client) {
  return {
    async describeConversation({ conversationId }) {
      const response = await client.conversations.info({ channel: conversationId });
      const channel = response?.channel;
      if (response?.ok === false || !channel || channel.id !== conversationId) return null;
      // Missing kind/privacy flags are not evidence of a public channel.
      const type = channel.is_im === true ? "im"
        : channel.is_mpim === true ? "mpim"
          : (channel.is_channel === true || channel.is_group === true)
            && typeof channel.is_private === "boolean"
            ? (channel.is_private ? "group" : "channel") : "";
      if (!type) return null;
      return {
        name: channel.name || "",
        purpose: channel.purpose?.value || "",
        topic: channel.topic?.value || "",
        url: `https://slack.com/app_redirect?channel=${encodeURIComponent(conversationId)}`,
        type,
        isDM: type === "im",
        isGroupDM: type === "mpim",
        private: type !== "channel",
        shared: channel.is_shared === true || channel.is_ext_shared === true || channel.is_org_shared === true,
        archived: channel.is_archived === true,
      };
    },

    async conversationMembers({ conversationId }) {
      const members = new Set();
      const cursors = new Set();
      let cursor = "";
      for (let page = 0; page < MAX_MEMBER_PAGES; page += 1) {
        const response = await client.conversations.members({
          channel: conversationId, limit: MEMBER_PAGE_SIZE, ...(cursor ? { cursor } : {}),
        });
        if (response?.ok === false || !Array.isArray(response?.members)) return null;
        for (const member of response.members) {
          if (typeof member !== "string" || !member) return null;
          members.add(member);
        }
        const next = response.response_metadata?.next_cursor;
        if (!next) return [...members];
        if (typeof next !== "string" || cursors.has(next)) return null;
        cursors.add(next);
        cursor = next;
      }
      // A truncated roster cannot prove that the audience is safe.
      return null;
    },
  };
}
