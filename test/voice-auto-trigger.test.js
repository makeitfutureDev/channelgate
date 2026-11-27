import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
process.env.PATH = `${fileURLToPath(new URL("./fixtures", import.meta.url))}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
process.env.PROGRESS_VIEW = "shimmer";
const { useFakeRuntime } = await import("./runtime-fake.js");
const backend = await useFakeRuntime();
const { saveSettings } = await import("../src/config/settings.js");
const { setUser, getUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { processMessageEvent } = await import("../src/slack/message-pipeline.js");
const { isVoiceAutoStartCandidate, isLatestAgentInThread, shouldAutoStartVoice } = await import("../src/slack/voice-auto-trigger.js");
const { VOICE_AUTO_START_HOME_TOGGLE_ACTION, voiceAutoStartHomeBlocks, registerVoiceAutoStartHomeActions } = await import("../src/slack/home-voice-auto-start.js");

const BOT = "U_VBOT";
const clip = { id: "F_AUTO_VOICE", name: "voice.webm", mimetype: "audio/webm", transcription: { status: "complete", preview: { content: "Please say hello.", has_more: false } } };
const reply = (extra = {}) => ({ type: "message", subtype: "file_share", channel: "C_VAUTO", channel_type: "channel", user: "U_VOICER", text: "", files: [clip], ts: "5000.002", thread_ts: "5000.000", ...extra });
const repliesClient = (pages) => {
  const calls = [];
  return { calls, conversations: { replies: async (args) => {
    calls.push(args);
    const index = args.cursor ? Number(args.cursor) : 0;
    const page = pages[index];
    if (page instanceof Error) throw page;
    return { messages: page, response_metadata: { next_cursor: index + 1 < pages.length ? String(index + 1) : "" } };
  } } };
};

test("only an un-mentioned voice-clip reply inside a channel thread is a candidate", () => {
  assert.equal(isVoiceAutoStartCandidate(reply()), true);
  assert.equal(isVoiceAutoStartCandidate(reply({ subtype: undefined })), true);
  assert.equal(isVoiceAutoStartCandidate(reply({ files: [{ name: "memo.m4a" }] })), true, "audio by extension");
  assert.equal(isVoiceAutoStartCandidate(reply({ channel_type: "group" })), true);
  const refused = {
    "top-level message": reply({ thread_ts: undefined }),
    "thread root itself": reply({ thread_ts: "5000.002" }),
    "direct message": reply({ channel_type: "im" }),
    "no files": reply({ files: undefined }),
    "image only": reply({ files: [{ name: "shot.png", mimetype: "image/png" }] }),
    "video clip": reply({ files: [{ name: "clip.mp4", mimetype: "video/mp4" }] }),
    "mentions a person": reply({ text: "for <@U0COLLEAG1>" }),
    "bot author": reply({ bot_id: "B1" }),
    "app author": reply({ app_id: "A1" }),
    "no author": reply({ user: undefined }),
    "edited message": reply({ subtype: "message_changed" }),
  };
  for (const [label, event] of Object.entries(refused)) assert.equal(isVoiceAutoStartCandidate(event), false, label);
  assert.equal(isVoiceAutoStartCandidate(null), false);
});

test("the thread must have this agent as its most recent agent speaker", async () => {
  const human = (ts) => ({ ts, user: "U_HUMAN", text: "hi" });
  const self = (ts) => ({ ts, user: BOT, bot_id: "B_SELF", text: "answer" });
  const other = (ts) => ({ ts, bot_id: "B_OTHER", subtype: "bot_message", text: "other agent" });
  const check = (pages, extra = {}) => isLatestAgentInThread(repliesClient(pages), { channelId: "C", threadTs: "1", botUserId: BOT, excludeTs: "9", ...extra });
  assert.equal(await check([[human("1"), self("2"), human("3")]]), true);
  assert.equal(await check([[human("1"), self("2"), other("3")]]), false, "another agent spoke after us");
  assert.equal(await check([[human("1"), other("2"), self("3")]]), true, "we spoke after the other agent");
  assert.equal(await check([[human("1"), human("2")]]), false, "a thread we never spoke in");
  assert.equal(await check([[human("1"), self("2")], [other("3")]]), false, "the walk follows the cursor to the end");
  assert.equal(await check([[human("1"), self("2")], [human("3")]]), true);
  assert.equal(await check(Array.from({ length: 6 }, () => [self("2")])), false, "an over-long thread fails closed");
  assert.equal(await check([new Error("ratelimited")]), false, "an unreadable thread fails closed");
  assert.equal(await check([[self("2"), { ts: "9", app_id: "A_X", text: "trigger" }]]), true, "the trigger message itself is excluded");
  assert.equal(await isLatestAgentInThread(null, { channelId: "C", threadTs: "1", botUserId: BOT }), false);
  assert.equal(await isLatestAgentInThread(repliesClient([[self("2")]]), { channelId: "C", threadTs: "1", botUserId: "" }), false);
});

test("the author's own setting decides, and it is off by default", async () => {
  const client = repliesClient([[{ ts: "5000.000", user: "U_VOICER" }, { ts: "5000.001", user: BOT }]]);
  const users = { U_ON: { voiceAutoStart: true }, U_OFF: { voiceAutoStart: false }, U_UNSET: {} };
  const loadUser = async (id) => users[id] || null;
  assert.equal(await shouldAutoStartVoice(reply({ user: "U_ON" }), client, { botUserId: BOT, loadUser }), true);
  for (const user of ["U_OFF", "U_UNSET", "U_MISSING"]) {
    assert.equal(await shouldAutoStartVoice(reply({ user }), client, { botUserId: BOT, loadUser }), false, user);
  }
  assert.equal(await shouldAutoStartVoice(reply({ user: "U_ON", thread_ts: undefined }), client, { botUserId: BOT, loadUser }), false);
  const before = client.calls.length;
  await shouldAutoStartVoice(reply({ user: "U_OFF" }), client, { botUserId: BOT, loadUser });
  assert.equal(client.calls.length, before, "an opted-out author costs no Slack API call");
});

function slack(threadMessages) {
  const posts = []; let seq = 0;
  const ok = async () => ({ ok: true });
  const client = {
    posts,
    apiCall: ok,
    chat: { async postMessage(p) { posts.push(p); return { ok: true, ts: `6000.${++seq}` }; }, update: ok, delete: ok, postEphemeral: ok },
    users: { info: async ({ user }) => ({ user: { id: user, real_name: "Voice fixture" } }), list: async () => ({ members: [], response_metadata: {} }) },
    conversations: {
      info: async ({ channel }) => ({ channel: { id: channel } }),
      members: async () => ({ members: ["U_VOICER"], response_metadata: {} }),
      history: async () => ({ messages: [] }),
      replies: async () => ({ messages: threadMessages(), response_metadata: {} }),
    },
  };
  client.chatStream = ({ channel, thread_ts }) => {
    let text = "";
    return { ts: `stream.${++seq}`, append: async ({ markdown_text = "" }) => { text += markdown_text; }, stop: async ({ markdown_text = "" } = {}) => { posts.push({ channel, thread_ts, text: text + markdown_text }); return { ok: true }; } };
  };
  return client;
}

let sequence = 0;
for (const engine of ["claude", "codex"]) {
  test(`${engine}: an opted-in author's voice reply in this agent's thread starts a turn without a mention`, async () => {
    saveSettings({ engine, whisperEnabled: false, slackBotToken: "xoxb-test-voice-auto", composioMode: "personal", memoryReviewEvery: 0 });
    const channel = `C_VAUTO_${engine.toUpperCase()}`;
    const entry = await upsertChannelEntry(channel, { name: channel, type: "channel" });
    await saveChannelMeta(entry.slug, { channelId: channel, name: channel, type: "channel", engine, access: "approved", allowedUsers: [], template: "custom" });
    await setUser("U_VOICER", { name: "Voicer", approved: true, voiceAutoStart: false });
    const root = { ts: "5100.000", user: "U_VOICER", text: "start" };
    let thread = [root, { ts: "5100.001", user: BOT, bot_id: "B_SELF", text: "earlier answer" }];
    const client = slack(() => thread);
    const send = (extra = {}) => processMessageEvent(reply({ channel, ts: `5100.${String(++sequence).padStart(3, "0")}9`, thread_ts: root.ts, ...extra }), client, { botUserId: BOT, teamId: "T_VAUTO", dedupeTrigger: true });
    const spawned = () => backend.calls.spawn.length;

    let before = spawned();
    await send();
    assert.equal(spawned(), before, "setting off: nothing starts");
    assert.equal(client.posts.length, 0, "setting off: nothing is posted");

    await setUser("U_VOICER", { voiceAutoStart: true });
    before = spawned();
    await send();
    assert.ok(spawned() > before, "setting on: the turn starts");
    const transcript = client.posts.findIndex((p) => p.blocks?.[0]?.text?.type === "plain_text");
    const answer = client.posts.findIndex((p) => /[Ss]tub.*reply/.test(p.text || ""));
    assert.ok(transcript >= 0 && answer > transcript, JSON.stringify(client.posts));
    assert.equal(client.posts[answer].thread_ts, root.ts);
    assert.match(client.posts[answer].text, engine === "codex" ? /Codex stub reply/ : /Stub engine reply/);

    client.posts.length = 0;
    before = spawned();
    await send({ thread_ts: undefined });
    assert.equal(spawned(), before, "a top-level clip never starts a turn");
    await send({ text: "for <@U0COLLEAG1>" });
    assert.equal(spawned(), before, "a clip addressed to a person never starts a turn");
    thread = [...thread, { ts: "5100.002", bot_id: "B_OTHER", subtype: "bot_message", text: "another agent" }];
    await send();
    assert.equal(spawned(), before, "another agent spoke last: this one stays out");
    assert.equal(client.posts.length, 0);
    assert.equal((await getUser("U_VOICER")).voiceAutoStart, true);
  });
}

test("Home toggle changes only the clicking user's own setting", async () => {
  for (const enabled of [false, true]) {
    const block = voiceAutoStartHomeBlocks({ enabled })[0];
    assert.match(block.text.text, enabled ? /— on/ : /— off/);
    assert.equal(block.accessory.action_id, VOICE_AUTO_START_HOME_TOGGLE_ACTION);
    assert.equal(block.accessory.value, enabled ? "off" : "on");
  }
  assert.equal(voiceAutoStartHomeBlocks()[0].accessory.value, "on", "off by default");
  let handler;
  registerVoiceAutoStartHomeActions({ action: (id, fn) => { assert.equal(id, VOICE_AUTO_START_HOME_TOGGLE_ACTION); handler = fn; } }, {
    publishHome: async (_client, userId) => published.push(userId),
  });
  const published = [];
  await setUser("U_HOME_SELF", { name: "Self", replyMentions: true });
  await setUser("U_HOME_OTHER", { name: "Other" });
  for (const value of ["on", "off"]) {
    await handler({ ack: async () => {}, body: { user: { id: "U_HOME_SELF" }, userId: "U_HOME_OTHER" }, action: { value }, client: {} });
    assert.equal((await getUser("U_HOME_SELF")).voiceAutoStart, value === "on");
    assert.equal((await getUser("U_HOME_SELF")).replyMentions, true, "other fields survive");
    assert.notEqual((await getUser("U_HOME_OTHER")).voiceAutoStart, true);
  }
  await handler({ ack: async () => {}, body: { user: { id: "U_HOME_SELF" } }, action: { value: "surprise" }, client: {} });
  assert.equal((await getUser("U_HOME_SELF")).voiceAutoStart, false);
  assert.deepEqual(published, ["U_HOME_SELF", "U_HOME_SELF"]);
});
