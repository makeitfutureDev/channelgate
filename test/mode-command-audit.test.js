// `/mode admin` typed in Slack turns the sandbox off for a whole conversation. It used to persist
// the new flags and reply "✅ Mode set" with no row in `events` at all — the same posture change made
// in the admin UI is audited, so the chat path must be too, naming the person who typed it.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { setUser } = await import("../src/config/store.js");
const { getChannelEntry, getChannelMeta } = await import("../src/config/store.js");
const { processMessageEvent } = await import("../src/slack/message-pipeline.js");
const { readEvents } = await import("../src/util/logger.js");

const USER = "U_MODE_AUDIT";
const CHANNEL = "D_MODE_AUDIT";

function fakeSlack() {
  const posted = [];
  const ok = async () => ({ ok: true });
  return {
    posted,
    chat: {
      postMessage: async (message) => { posted.push(message); return { ok: true, ts: `bot.${posted.length}` }; },
      update: ok,
      delete: ok,
      postEphemeral: async (message) => { posted.push(message); return { ok: true }; },
    },
    users: {
      info: async ({ user }) => ({ user: { id: user, real_name: "Mode Admin" } }),
      list: async () => ({ members: [{ id: USER, real_name: "Mode Admin" }], response_metadata: {} }),
    },
    conversations: {
      history: async () => ({ messages: [] }),
      replies: async () => ({ messages: [] }),
      info: async ({ channel }) => ({ channel: { id: channel } }),
      members: async () => ({ members: [USER], response_metadata: {} }),
    },
    apiCall: ok,
  };
}

const modeEvents = (slug) => readEvents({ limit: 200 }).filter((e) => e.event === "channel_meta_changed" && e.slug === slug);

test("a /mode switch typed in chat is audited with the author who typed it", async () => {
  await setUser(USER, { name: "Mode Admin", isAdmin: true, approved: true });
  const client = fakeSlack();
  const send = (text, ts) =>
    processMessageEvent({ type: "message", channel: CHANNEL, channel_type: "im", user: USER, text, ts }, client, { botUserId: "U_BOT", teamId: "T_MODE" });

  // The first message registers the conversation; the mode switch is the one under test.
  await send("/mode", "4000.001");
  const entry = await getChannelEntry(CHANNEL);
  assert.ok(entry, "the conversation is registered");
  const before = modeEvents(entry.slug).length;

  await send("/mode bash", "4000.002");
  assert.equal((await getChannelMeta(entry.slug)).allowBash, true, "the switch still applies");

  const events = modeEvents(entry.slug);
  assert.equal(events.length, before + 1, "exactly one row for the switch");
  const e = events[0];
  assert.equal(e.actor, USER, "the trail names the person who typed it");
  assert.equal(e.author, USER);
  assert.equal(e.source, "slack-command");
  assert.deepEqual(e.changes.allowBash, { from: false, to: true });
  assert.equal(e.changes.profile.to, "worker", "the UI preset moves with it");

  // Reading the current mode (`/mode` with no argument) changes nothing and must log nothing.
  const quiet = modeEvents(entry.slug).length;
  await send("/mode", "4000.003");
  assert.equal(modeEvents(entry.slug).length, quiet, "a read-only /mode writes no audit row");
});
