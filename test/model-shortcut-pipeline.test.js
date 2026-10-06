import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

ensureTestEnv();
const { useFakeRuntime } = await import("./runtime-fake.js");
const runtime = await useFakeRuntime();
process.env.PATH = `${fileURLToPath(new URL("./fixtures", import.meta.url))}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
process.env.PROGRESS_VIEW = "shimmer";
const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { getThreadEngine, getThreadModel, getThreadEffort, setThreadEffort } = await import("../src/gateway/thread-engine.js");
const { processMessageEvent } = await import("../src/slack/message-pipeline.js");
const { stripMentions } = await import("../src/slack/message-normalize.js");
const { parseModelShortcut } = await import("../src/config/model-shortcuts.js");

const USER = "U_SHORTCUT";
const BOT = "BSHORTCUT";
const CHANNEL = "D_SHORTCUT";
const messages = [];
const client = {
  chat: { postMessage: async (message) => { messages.push(message); return { ok: true, ts: "bot.1" }; }, update: async () => ({ ok: true }) },
  apiCall: async () => ({ ok: true }),
  users: { info: async ({ user }) => ({ user: { id: user, real_name: "Shortcut User" } }), list: async () => ({ members: [] }) },
  chatStream: ({ channel, thread_ts }) => {
    let text = "";
    return { ts: "stream.1", append: async ({ markdown_text = "" }) => { text += markdown_text; },
      stop: async ({ markdown_text = "" } = {}) => { messages.push({ channel, thread_ts, text: text + markdown_text }); return { ok: true }; } };
  },
  conversations: {
    info: async () => ({ channel: { id: CHANNEL, is_im: true } }),
    replies: async () => ({ messages: [] }),
    history: async () => ({ messages: [] }),
  },
};

test("Slack's inserted space before :astra switches a DM thread and clears an old effort pin", async () => {
  await setUser(USER, { name: "Shortcut User", approved: true, isAdmin: false });
  const entry = await upsertChannelEntry(CHANNEL, { name: "shortcut-dm", type: "im", isDM: true });
  await saveChannelMeta(entry.slug, { channelId: CHANNEL, name: entry.name, type: "im", isDM: true, template: "custom", engine: "claude" });
  saveSettings({ modelShortcuts: { astra: { engine: "codex", model: "gpt-6-astra" } } });
  await setThreadEffort(entry.slug, "123.001", "high");
  assert.equal(stripMentions(`<@${BOT}> :astra`, BOT), ":astra");
  assert.deepEqual(parseModelShortcut(stripMentions(`<@${BOT}> :astra review this`, BOT)), { name: "astra", task: "review this" });
  await processMessageEvent({ type: "message", channel: CHANNEL, channel_type: "im", user: USER, text: `<@${BOT}> :astra`, ts: "123.001" }, client, { botUserId: BOT });
  assert.equal(await getThreadEngine(entry.slug, "123.001"), "codex");
  assert.equal(await getThreadModel(entry.slug, "123.001"), "gpt-6-astra");
  assert.equal(await getThreadEffort(entry.slug, "123.001"), "");
  assert.match(messages.at(-1).text, /gpt-6-astra/);
});

test("unknown shortcut cannot change the thread", async () => {
  const entry = await upsertChannelEntry(CHANNEL, { name: "shortcut-dm", type: "im", isDM: true });
  await processMessageEvent({ type: "message", channel: CHANNEL, channel_type: "im", user: USER, text: `<@${BOT}> :unknown`, ts: "123.002" }, client, { botUserId: BOT });
  assert.equal(await getThreadEngine(entry.slug, "123.002"), "");
  assert.match(messages.at(-1).text, /Unknown model shortcut/);
});

test("shortcut tasks start and resume the mapped model, switch engines, and strip the prefix on card retries", async () => {
  const entry = await upsertChannelEntry(CHANNEL, { name: "shortcut-dm", type: "im", isDM: true });
  saveSettings({ modelShortcuts: { astra: { engine: "codex", model: "gpt-6-astra" }, opus: { engine: "claude", model: "claude-opus-5-5" } } });
  const send = (text, ts, extra = {}) => processMessageEvent({ type: "message", channel: CHANNEL, channel_type: "im", user: USER, text, ts, thread_ts: "124.001" }, client, { botUserId: BOT, ...extra });
  await send(`<@${BOT}> :astra first task`, "124.001");
  assert.ok(messages.some((m) => /Codex stub reply.*model=gpt-6-astra/.test(m.text)), JSON.stringify(messages));
  assert.equal(await getThreadModel(entry.slug, "124.001"), "gpt-6-astra");
  saveSettings({ modelShortcuts: { astra: { engine: "codex", model: "gpt-6.1-sol" }, opus: { engine: "claude", model: "claude-opus-5-5" } } });
  await send("continue", "124.002");
  assert.ok(messages.some((m) => /Codex stub reply.*resume=yes.*model=gpt-6-astra/.test(m.text)), "repointing a name must not change a thread's resolved pin");
  await send(`<@${BOT}> :opus next task`, "124.003");
  assert.equal(await getThreadEngine(entry.slug, "124.001"), "claude");
  assert.ok(messages.some((m) => /Stub engine reply.*model=claude-opus-5-5/.test(m.text)), "a new Claude process uses the shortcut's model");
  await send(`<@${BOT}> :opus next task`, "124.004", { engineChoice: "claude" });
  const retryPrompt = runtime.calls.spawn.at(-1).args.find((arg) => arg.includes("next task"));
  assert.ok(retryPrompt, "a card retry still sends the task to the engine");
  assert.doesNotMatch(retryPrompt, /:opus/, "the shortcut prefix is stripped from a card retry");
});

test("runtime permission, disabled engine and dedicated Codex login refuse a shortcut before changing pins", async () => {
  const channel = "CSHORTCUT";
  const entry = await upsertChannelEntry(channel, { name: "shortcut-channel", type: "channel", isDM: false });
  const meta = { channelId: channel, name: entry.name, type: "channel", isDM: false, template: "custom", allowedUsers: [USER], engine: "claude" };
  await saveChannelMeta(entry.slug, meta);
  const shortcuts = { astra: { engine: "codex", model: "gpt-6-astra" }, opus: { engine: "claude", model: "claude-opus-5-5" } };
  const send = (name, ts) => processMessageEvent({ type: "message", channel, channel_type: "channel", user: USER, text: `<@${BOT}> :${name}`, ts }, client, { botUserId: BOT });
  saveSettings({ modelShortcuts: shortcuts, modelChangeAccess: "admins" });
  await send("astra", "125.001");
  assert.match(messages.at(-1).text, /Only admins/);
  assert.equal(await getThreadEngine(entry.slug, "125.001"), "");
  saveSettings({ modelChangeAccess: "users", engineEnabled: { claude: true, codex: false } });
  await send("astra", "125.002");
  assert.match(messages.at(-1).text, /enabled engine/);
  assert.equal(await getThreadModel(entry.slug, "125.002"), "");
  saveSettings({ engineEnabled: { claude: true, codex: true } });
  await saveChannelMeta(entry.slug, { ...meta, codexAuthSource: "channel", engine: "codex" });
  await send("opus", "125.003");
  assert.match(messages.at(-1).text, /engine stays Codex/);
  assert.equal(await getThreadEngine(entry.slug, "125.003"), "");
});
