import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { useFakeRuntime } = await import("./runtime-fake.js");
await useFakeRuntime();
process.env.PATH = `${fileURLToPath(new URL("./fixtures", import.meta.url))}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { processMessageEvent } = await import("../src/slack/message-pipeline.js");
saveSettings({ memoryReviewEvery: 0, composioMode: "personal" });
const BOT = "UMENTIONPREF";
let sequence = 0;
for (const engine of ["claude", "codex"]) {
  for (const isDM of [false, true]) {
    test(`Slack ${engine} pipeline resolves each author's preference with DM=${isDM}`, async () => {
      const channel = `${isDM ? "D" : "C"}_MENTION_${engine.toUpperCase()}`;
      const userId = `U_MENTION_${engine.toUpperCase()}_${isDM}`;
      const otherId = `${userId}_OTHER`;
      const type = isDM ? "im" : "channel";
      const entry = await upsertChannelEntry(channel, { name: channel, type, isDM });
      await saveChannelMeta(entry.slug, { channelId: channel, name: channel, type, isDM, engine, access: "approved", allowedUsers: [], template: "custom" });
      await setUser(userId, { name: "Preference fixture", approved: true });
      await setUser(otherId, { approved: true, replyMentions: true });
      const sent = [];
      const ok = async () => ({ ok: true });
      const client = {
        apiCall: ok,
        chat: { postMessage: async message => { sent.push(message.text || ""); return { ok: true, ts: `8000.${++sequence}` }; }, update: ok, delete: ok, postEphemeral: ok },
        users: { info: async ({ user }) => ({ user: { id: user, real_name: "Preference fixture" } }), list: async () => ({ members: [] }) },
        conversations: { info: async () => ({ channel: { id: channel, is_im: isDM } }), members: async () => ({ members: [userId, otherId], response_metadata: {} }), history: async () => ({ messages: [] }), replies: async () => ({ messages: [], response_metadata: {} }) },
        chatStream: () => {
          let text = "";
          return { ts: `8000.${++sequence}`, append: async ({ markdown_text = "" }) => { text += markdown_text; },
            stop: async ({ markdown_text = "" } = {}) => { sent.push(text + markdown_text); return { ok: true }; } };
        },
      };
      for (const enabled of [false, true, false]) {
        if (enabled) await setUser(userId, { replyMentions: true });
        else if (sent.length) await setUser(userId, { replyMentions: false });
        sent.length = 0;
        const ts = `8100.${++sequence}`;
        await processMessageEvent({ type: "message", channel, channel_type: type, user: userId, text: `<@${BOT}> say hello`, ts }, client, { botUserId: BOT, teamId: "T_PREF" });
        const text = sent.join("\n");
        assert.match(text, /stub.*reply|Stub engine reply/i, "the real pipeline delivers an answer from the fake engine");
        assert.equal(text.includes(`<@${userId}>`), enabled && !isDM);
        assert.ok(!text.includes(`<@${otherId}>`));
      }
    });
  }
}

test("pipeline discovery joins original authors but ignores synthetic reaction/edit requesters before hydration", async () => {
  const { indexSlackThread, isSlackThreadParticipant, setSlackThreadHidden, getSlackThreadParticipant } = await import("../src/gateway/slack-threads.js");
  const channel = "C_PARTICIPATION_PIPE", owner = "U_PIPE_OWNER", actor = "U_PIPE_ACTOR", rootTs = "9000.000001";
  const entry = await upsertChannelEntry(channel, { name: channel, type: "channel" });
  await saveChannelMeta(entry.slug, { channelId: channel, type: "channel", engine: "codex", access: "approved", template: "custom" });
  for (const userId of [owner, actor]) await setUser(userId, { approved: true });
  const root = { ts: rootTs, user: owner, text: "Shared work" };
  indexSlackThread({ channelId: channel, slug: entry.slug, root, agentEngaged: true });
  const ok = async () => ({ ok: true });
  const client = { apiCall: ok,
    chat: { postMessage: async () => ({ ok: true, ts: `9100.${++sequence}` }), update: ok, delete: ok, postEphemeral: ok },
    users: { info: async ({ user }) => ({ user: { id: user, real_name: "Fixture" } }), list: async () => ({ members: [] }) },
    conversations: { info: async () => ({ channel: { id: channel } }), members: async () => ({ members: [owner, actor] }),
      history: async () => ({ messages: [] }), replies: async () => ({ messages: [root], response_metadata: {} }) },
    chatStream: () => ({ ts: `9200.${++sequence}`, append: ok, stop: ok }) };
  const send = (extra = {}) => processMessageEvent({ channel, channel_type: "channel", user: actor,
    text: `<@${BOT}> reply briefly`, ts: (Date.now() / 1000 + ++sequence).toFixed(6), thread_ts: rootTs, ...extra }, client,
    { botUserId: BOT, teamId: "T_PREF", bypassMention: true });
  await send();
  assert.equal(isSlackThreadParticipant(channel, rootTs, actor), false, "synthetic requester is not an original-message author");
  await send({ type: "message" });
  assert.equal(isSlackThreadParticipant(channel, rootTs, actor), true);
  setSlackThreadHidden(channel, rootTs, actor, true);
  await send();
  assert.ok(getSlackThreadParticipant(channel, rootTs, actor).hidden_ms > 0, "synthetic newer timestamp cannot restore");
  await send({ type: "message" });
  assert.equal(getSlackThreadParticipant(channel, rootTs, actor).hidden_ms, 0);
});
