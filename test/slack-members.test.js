import test from "node:test";
import assert from "node:assert/strict";
import {
  filterConversationHumanMemberIds,
  handleMemberLeftChannel,
  listConversationMemberIds,
  listConversationMemberRoster,
  removeChannelGuestGrant,
} from "../src/slack/members.js";

test("conversation member ids paginate, preserve Slack order, and remove duplicates", async () => {
  const requests = [];
  const client = {
    conversations: {
      members: async (request) => {
        requests.push(request);
        if (!request.cursor) {
          return {
            members: ["U_INTERNAL", "U_EXTERNAL", "U_INTERNAL"],
            response_metadata: { next_cursor: "page-2" },
          };
        }
        return {
          members: ["U_THIRD", "U_EXTERNAL"],
          response_metadata: { next_cursor: "" },
        };
      },
    },
  };

  assert.deepEqual(
    await listConversationMemberIds(client, "C_CHANNEL"),
    ["U_INTERNAL", "U_EXTERNAL", "U_THIRD"],
  );
  assert.deepEqual(requests, [
    { channel: "C_CHANNEL", limit: 200 },
    { channel: "C_CHANNEL", limit: 200, cursor: "page-2" },
  ]);
});

test("conversation roster includes internal and external humans and excludes bots and deleted users", async () => {
  const users = {
    U_INTERNAL: {
      id: "U_INTERNAL",
      name: "internal.handle",
      real_name: "Internal Real",
      profile: { display_name: "Internal Display", real_name: "Internal Profile" },
    },
    U_EXTERNAL: {
      id: "U_EXTERNAL",
      name: "external.handle",
      is_stranger: true,
      profile: { display_name: "", real_name: "External Person" },
    },
    U_RESTRICTED: {
      id: "U_RESTRICTED",
      name: "restricted.handle",
      is_restricted: true,
      profile: { display_name: "Restricted Guest" },
    },
    U_FOREIGN: {
      id: "U_FOREIGN",
      team_id: "T_FOREIGN",
      name: "foreign.handle",
      is_stranger: false,
      profile: { display_name: "Foreign Member" },
    },
    U_BOT: {
      id: "U_BOT",
      name: "build-bot",
      is_bot: true,
      profile: { display_name: "Build Bot" },
    },
    U_DELETED: {
      id: "U_DELETED",
      name: "former-user",
      deleted: true,
      profile: { display_name: "Former User" },
    },
    USLACKBOT: {
      id: "USLACKBOT",
      name: "slackbot",
      profile: { display_name: "Slackbot" },
    },
  };
  const client = {
    conversations: {
      members: async () => ({
        members: Object.keys(users),
        response_metadata: { next_cursor: "" },
      }),
    },
    users: {
      info: async ({ user }) => ({ user: users[user] }),
    },
  };

  assert.deepEqual(await listConversationMemberRoster(client, "C_CHANNEL", { teamId: "T_HOME" }), [
    { id: "U_EXTERNAL", name: "External Person", isExternal: true },
    { id: "U_FOREIGN", name: "Foreign Member", isExternal: true },
    { id: "U_INTERNAL", name: "Internal Display", isExternal: false },
    { id: "U_RESTRICTED", name: "Restricted Guest", isExternal: false },
  ]);
});

test("conversation roster uses the bulk workspace directory and supplements missing Slack Connect users", async () => {
  const infoLookups = [];
  const client = {
    conversations: {
      members: async () => ({
        members: ["U_LOCAL", "U_REMOTE"],
        response_metadata: { next_cursor: "" },
      }),
    },
    users: {
      list: async () => ({
        members: [{
          id: "U_LOCAL",
          team_id: "T_HOME",
          profile: { display_name: "Local Person" },
        }],
        response_metadata: { next_cursor: "" },
      }),
      info: async ({ user }) => {
        infoLookups.push(user);
        return {
          user: {
            id: user,
            team_id: "T_REMOTE",
            profile: { display_name: "Remote Person" },
          },
        };
      },
    },
  };

  assert.deepEqual(await listConversationMemberRoster(client, "C_CHANNEL", { teamId: "T_HOME" }), [
    { id: "U_LOCAL", name: "Local Person", isExternal: false },
    { id: "U_REMOTE", name: "Remote Person", isExternal: true },
  ]);
  assert.deepEqual(infoLookups, ["U_REMOTE"]);
});

test("guest-save validation resolves only submitted IDs that are still conversation members", async () => {
  const infoLookups = [];
  const users = {
    U_MEMBER: {
      id: "U_MEMBER",
      profile: { display_name: "Current Member" },
    },
    U_BOT: {
      id: "U_BOT",
      is_bot: true,
      profile: { display_name: "Channel Bot" },
    },
  };
  const client = {
    conversations: {
      members: async () => ({
        members: ["U_MEMBER", "U_BOT", "U_UNASKED"],
        response_metadata: { next_cursor: "" },
      }),
    },
    users: {
      info: async ({ user }) => {
        infoLookups.push(user);
        return { user: users[user] };
      },
    },
  };

  assert.deepEqual(await filterConversationHumanMemberIds(
    client,
    "C_CHANNEL",
    ["U_STALE", "U_BOT", "U_MEMBER", "U_MEMBER"],
  ), ["U_MEMBER"]);
  assert.deepEqual(infoLookups, ["U_MEMBER", "U_BOT"]);
});

test("departed member cleanup removes only that guest grant and preserves other metadata", async () => {
  const entry = { channelId: "C_CHANNEL", slug: "customer-channel" };
  let stored = {
    channelId: "C_CHANNEL",
    allowedUsers: ["U_KEEP", "U_LEAVE"],
    allowedMcps: [{ name: "shared-tools" }],
    nudges: true,
  };
  let provisioned = null;
  const deps = {
    getChannelEntry: async (channelId) => channelId === entry.channelId ? entry : null,
    patchChannelMeta: async (slug, derive) => {
      if (slug !== entry.slug) return null;
      const partial = derive(stored);
      if (partial == null) return null;
      stored = { ...stored, ...partial };
      return stored;
    },
    ensureChannelFolder: async (slug, next) => {
      provisioned = { slug, next };
    },
  };

  assert.equal(await removeChannelGuestGrant("C_CHANNEL", "U_LEAVE", deps), true);
  assert.deepEqual(stored, {
    channelId: "C_CHANNEL",
    allowedUsers: ["U_KEEP"],
    allowedMcps: [{ name: "shared-tools" }],
    nudges: true,
  });
  assert.deepEqual(provisioned, { slug: entry.slug, next: stored });

  provisioned = null;
  assert.equal(await removeChannelGuestGrant("C_CHANNEL", "U_UNKNOWN", deps), false);
  assert.equal(provisioned, null);
});

test("member-left lifecycle removes the departed user's channel guest grant", async () => {
  let stored = { allowedUsers: ["U_KEEP", "U_LEAVE"], memory: true };
  const deps = {
    getChannelEntry: async () => ({ slug: "customer-channel" }),
    patchChannelMeta: async (_slug, derive) => {
      const partial = derive(stored);
      if (partial == null) return null;
      stored = { ...stored, ...partial };
      return stored;
    },
    ensureChannelFolder: async () => {},
  };

  assert.equal(await handleMemberLeftChannel({
    channel: "C_CHANNEL",
    user: "U_LEAVE",
  }, deps), true);
  assert.deepEqual(stored, { allowedUsers: ["U_KEEP"], memory: true });
  assert.equal(await handleMemberLeftChannel({ channel: "", user: "U_KEEP" }, deps), false);
});
