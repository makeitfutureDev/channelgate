// The follow-up digest reminds a person only about threads where the AI spoke LAST. Its passive
// observer (app.js observeForFollowups) can never see the gateway's own posts: Bolt's default
// `ignoreSelf` middleware drops every event whose `user` is the bot before any listener runs. So
// no thread ever had the bot as its last author and the digest went silent for every user. The
// gateway must record its own answer when it delivers it.
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.env.PATH = `${path.join(projectRoot, "test", "fixtures", "prompt-echo")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
process.env.PROGRESS_VIEW = "shimmer";
const scratch = ensureTestEnv();
process.env.CG_WORKSPACE_DIR = path.join(scratch, "workspaces");

const { useFakeRuntime } = await import("./runtime-fake.js");
await useFakeRuntime();

const { setUser } = await import("../src/config/store.js");
const { processMessageEvent } = await import("../src/slack/message-pipeline.js");
const { recordActivity, pendingForUser, recordGatewayReply } = await import("../src/gateway/followups.js");

const BOT = "UFUBOT1";
const USER = "UFUHUMAN1";

function fakeSlack(channelInfo) {
  const posted = [];
  let seq = 0;
  const ok = async () => ({ ok: true });
  return {
    posted,
    chat: {
      postMessage: async (message) => {
        posted.push(message);
        return { ok: true, ts: `9${++seq}.000` };
      },
      update: ok,
      delete: ok,
      postEphemeral: ok,
    },
    users: {
      info: async ({ user }) => ({ user: { id: user, real_name: "Follow Up" } }),
      list: async () => ({ members: [{ id: USER, real_name: "Follow Up" }], response_metadata: {} }),
    },
    conversations: {
      history: async () => ({ messages: [] }),
      replies: async () => ({ messages: [] }),
      info: async ({ channel }) => ({ channel: { id: channel, ...channelInfo } }),
      members: async () => ({ members: [USER, BOT], response_metadata: {} }),
    },
    apiCall: ok,
  };
}

test("a delivered channel answer makes the thread pending for the human who asked", async () => {
  await setUser(USER, { name: "Follow Up", approved: true, admin: true });
  const channel = "C_FU_PUBLIC";
  const event = {
    type: "message",
    channel,
    channel_type: "channel",
    user: USER,
    text: `<@${BOT}> what is the status?`,
    ts: "5000.001",
  };
  const client = fakeSlack({ name: "fu-public", is_channel: true, is_member: true });
  // What the passive observer records for the human's message (it does see human posts).
  recordActivity({ channelId: channel, slug: "fu-public", channelName: "fu-public", threadTs: event.ts, userId: USER, isBot: false, aiTurn: true, text: event.text, tsMs: 5000_001 });
  assert.deepEqual(pendingForUser(USER, BOT), [], "before the answer, the human spoke last");

  await processMessageEvent(event, client, { botUserId: BOT, teamId: "T_FU" });

  assert.ok(client.posted.some((m) => m.thread_ts === event.ts), `the answer is delivered in the thread, got ${JSON.stringify(client.posted)}`);
  const pending = pendingForUser(USER, BOT);
  assert.deepEqual(pending.map((r) => [r.channelId, r.threadTs, r.lastAuthorId]), [[channel, event.ts, BOT]],
    "the gateway's own answer must be recorded as the last turn");
});

test("recordGatewayReply never tracks DMs and needs a bot identity", () => {
  recordActivity({ channelId: "D_FU", slug: "dm", channelName: "dm", threadTs: "6000.001", userId: USER, isBot: false, aiTurn: true, text: "hi", tsMs: 6000_001 });
  recordGatewayReply({ channelId: "D_FU", slug: "dm", threadTs: "6000.001", botUserId: BOT, isDM: true, tsMs: 6000_002 });
  recordActivity({ channelId: "C_FU_X", slug: "x", channelName: "x", threadTs: "7000.001", userId: USER, isBot: false, aiTurn: true, text: "hi", tsMs: 7000_001 });
  recordGatewayReply({ channelId: "C_FU_X", slug: "x", threadTs: "7000.001", botUserId: "", tsMs: 7000_002 });
  assert.equal(pendingForUser(USER, BOT).some((r) => r.channelId === "D_FU" || r.channelId === "C_FU_X"), false);
});
