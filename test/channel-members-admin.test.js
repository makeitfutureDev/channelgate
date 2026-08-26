import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";
import { handleMemberLeftChannel } from "../src/slack/members.js";

ensureTestEnv();

const { createAdminRouter } = await import("../src/web/routes/admin.js");
const {
  defaultChannelMeta,
  getChannelMeta,
  saveChannelMeta,
  upsertChannelEntry,
} = await import("../src/config/store.js");

const channelId = "C_MEMBER_ADMIN";
const entry = await upsertChannelEntry(channelId, {
  name: "member-admin-test",
  type: "channel",
  isDM: false,
});

const slackUsers = {
  U_MEMBER: {
    id: "U_MEMBER",
    name: "member.handle",
    profile: { display_name: "Member Person" },
  },
  U_EXTERNAL: {
    id: "U_EXTERNAL",
    name: "external.handle",
    is_stranger: true,
    profile: { real_name: "External Person" },
  },
  U_BOT: {
    id: "U_BOT",
    name: "channel-bot",
    is_bot: true,
    profile: { display_name: "Channel Bot" },
  },
};

let clientMode = "connected";
let userInfoReached = null;
let continueUserInfo = null;
let userInfoGate = null;
const client = {
  conversations: {
    members: async () => {
      if (clientMode === "upstream-error") throw new Error("missing conversations:read");
      return {
        members: ["U_MEMBER", "U_EXTERNAL", "U_BOT"],
        response_metadata: { next_cursor: "" },
      };
    },
  },
  users: {
    info: async ({ user }) => {
      if (clientMode === "paused-user-info") {
        userInfoReached?.();
        await userInfoGate;
      }
      return { user: slackUsers[user] };
    },
  },
};
const slack = {
  getClient: () => clientMode === "disconnected" ? null : client,
  snapshot: () => ({
    status: clientMode === "disconnected" ? "disconnected" : "connected",
    connected: clientMode !== "disconnected",
    teamId: "T_HOME",
  }),
};

const app = express();
app.use(express.json());
app.use(createAdminRouter({ slack }));
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

beforeEach(async () => {
  clientMode = "connected";
  userInfoReached = null;
  continueUserInfo = null;
  userInfoGate = null;
  await saveChannelMeta(entry.slug, {
    ...defaultChannelMeta({
      channelId,
      name: "member-admin-test",
      type: "channel",
      isDM: false,
    }),
    allowedUsers: ["U_MEMBER", "U_STALE"],
  });
});

async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, json: await response.json() };
}

test("channel members endpoint returns only the selected conversation's current humans", async () => {
  const result = await request(`/channels/${channelId}/members`);

  assert.equal(result.response.status, 200);
  assert.deepEqual(result.json, {
    members: [
      { id: "U_EXTERNAL", name: "External Person", isExternal: true },
      { id: "U_MEMBER", name: "Member Person", isExternal: false },
    ],
  });
});

test("channel save persists only submitted users who are current human members", async () => {
  const result = await request(`/channels/${channelId}/meta`, {
    method: "PUT",
    body: {
      allowedUsers: ["U_STALE", "U_EXTERNAL", "U_MEMBER", "U_BOT", "U_EXTERNAL"],
      nudges: true,
    },
  });

  assert.equal(result.response.status, 200);
  assert.deepEqual(result.json.meta.allowedUsers, ["U_EXTERNAL", "U_MEMBER"]);
  assert.deepEqual((await getChannelMeta(entry.slug)).allowedUsers, ["U_EXTERNAL", "U_MEMBER"]);
  assert.equal((await getChannelMeta(entry.slug)).nudges, true);
});

test("disconnected Slack disables roster writes but unrelated saves preserve existing grants", async () => {
  clientMode = "disconnected";

  const roster = await request(`/channels/${channelId}/members`);
  assert.equal(roster.response.status, 503);
  assert.match(roster.json.error, /Slack is disconnected/i);

  const unrelated = await request(`/channels/${channelId}/meta`, {
    method: "PUT",
    body: { nudges: true },
  });
  assert.equal(unrelated.response.status, 200);
  assert.deepEqual(unrelated.json.meta.allowedUsers, ["U_MEMBER", "U_STALE"]);

  const attemptedRosterWrite = await request(`/channels/${channelId}/meta`, {
    method: "PUT",
    body: { allowedUsers: ["U_MEMBER"] },
  });
  assert.equal(attemptedRosterWrite.response.status, 503);
  assert.deepEqual((await getChannelMeta(entry.slug)).allowedUsers, ["U_MEMBER", "U_STALE"]);
});

test("Slack roster failures return an explicit upstream error and do not change grants", async () => {
  clientMode = "upstream-error";

  const roster = await request(`/channels/${channelId}/members`);
  assert.equal(roster.response.status, 502);
  assert.match(roster.json.error, /Could not load this channel's Slack members/i);

  const attemptedRosterWrite = await request(`/channels/${channelId}/meta`, {
    method: "PUT",
    body: { allowedUsers: ["U_MEMBER"] },
  });
  assert.equal(attemptedRosterWrite.response.status, 502);
  assert.deepEqual((await getChannelMeta(entry.slug)).allowedUsers, ["U_MEMBER", "U_STALE"]);
});

test("a concurrent member-left event wins over an in-flight validated guest save", async () => {
  clientMode = "paused-user-info";
  let reachedResolve;
  const reached = new Promise((resolve) => {
    reachedResolve = resolve;
  });
  userInfoReached = reachedResolve;
  userInfoGate = new Promise((resolve) => {
    continueUserInfo = resolve;
  });

  const save = request(`/channels/${channelId}/meta`, {
    method: "PUT",
    body: { allowedUsers: ["U_MEMBER", "U_EXTERNAL"] },
  });
  await reached;

  const departed = handleMemberLeftChannel({
    channel: channelId,
    user: "U_EXTERNAL",
  });
  continueUserInfo();

  const saved = await save;
  assert.equal(saved.response.status, 200);
  assert.equal(await departed, true);
  assert.deepEqual((await getChannelMeta(entry.slug)).allowedUsers, ["U_MEMBER"]);
});
