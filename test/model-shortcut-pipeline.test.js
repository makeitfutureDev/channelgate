import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { getThreadEngine, getThreadModel, getThreadEffort, setThreadEffort } = await import("../src/gateway/thread-engine.js");
const { processMessageEvent } = await import("../src/slack/message-pipeline.js");

const USER = "U_SHORTCUT";
const BOT = "BSHORTCUT";
const CHANNEL = "D_SHORTCUT";
const messages = [];
const client = {
  chat: { postMessage: async (message) => { messages.push(message); return { ok: true, ts: "bot.1" }; } },
  apiCall: async () => ({ ok: true }),
  conversations: {
    info: async () => ({ channel: { id: CHANNEL, is_im: true } }),
    replies: async () => ({ messages: [] }),
    history: async () => ({ messages: [] }),
  },
};

test("colon mention switches a DM thread and clears an old effort pin", async () => {
  await setUser(USER, { name: "Shortcut User", approved: true, isAdmin: false });
  const entry = await upsertChannelEntry(CHANNEL, { name: "shortcut-dm", type: "im", isDM: true });
  await saveChannelMeta(entry.slug, { channelId: CHANNEL, name: entry.name, type: "im", isDM: true, template: "custom", engine: "claude" });
  saveSettings({ modelShortcuts: { astra: { engine: "codex", model: "gpt-6-astra" } } });
  await setThreadEffort(entry.slug, "123.001", "high");
  await processMessageEvent({ type: "message", channel: CHANNEL, channel_type: "im", user: USER, text: `<@${BOT}>:astra`, ts: "123.001" }, client, { botUserId: BOT });
  assert.equal(await getThreadEngine(entry.slug, "123.001"), "codex");
  assert.equal(await getThreadModel(entry.slug, "123.001"), "gpt-6-astra");
  assert.equal(await getThreadEffort(entry.slug, "123.001"), "");
  assert.match(messages.at(-1).text, /gpt-6-astra/);
});

test("unknown shortcut cannot change the thread", async () => {
  const entry = await upsertChannelEntry(CHANNEL, { name: "shortcut-dm", type: "im", isDM: true });
  await processMessageEvent({ type: "message", channel: CHANNEL, channel_type: "im", user: USER, text: `<@${BOT}>:unknown`, ts: "123.002" }, client, { botUserId: BOT });
  assert.equal(await getThreadEngine(entry.slug, "123.002"), "");
  assert.match(messages.at(-1).text, /Unknown model shortcut/);
});
