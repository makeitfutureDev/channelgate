// The harness-switch card: when a turn dies on a replay-safe provider failure and Settings says
// "ask", the thread gets a card with buttons instead of a silent switch. Drives the real Slack
// pipeline against the stub CLIs, then clicks the buttons the way Slack would.
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

process.env.CG_TRANSIENT_RETRY_DELAY_MS = "40";
delete process.env.CG_TRANSIENT_RETRY_ATTEMPTS;
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
ensureTestEnv();
const { useFakeRuntime } = await import("./runtime-fake.js");
await useFakeRuntime();
process.env.PATH = `${path.join(projectRoot, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
process.env.PROGRESS_VIEW = "shimmer";

const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { processMessageEvent, stopRunsInChannel } = await import("../src/slack/message-pipeline.js");
const { resetEngineCooldowns } = await import("../src/gateway/run.js");
const { getThreadEngine } = await import("../src/gateway/thread-engine.js");
const { readEvents } = await import("../src/util/logger.js");
const { busyThreadChoices } = await import("../src/slack/busy-thread-choice.js");
const {
  ENGINE_RETRY_ACTION,
  ENGINE_SWITCH_ACTION,
  createEngineSwitchChoiceStore,
  engineSwitchChoiceBlocks,
  engineSwitchChoiceText,
  engineSwitchChoices,
  handleEngineSwitchChoice,
  registerEngineSwitchChoiceActions,
} = await import("../src/slack/engine-switch-choice.js");

const USER = "U_SWITCH_CHOICE";
const CHANNEL = "D_SWITCH_CHOICE";

function fakeSlack() {
  const posted = [];
  const ephemeral = [];
  const updated = [];
  const deleted = [];
  let seq = 0;
  const ok = async () => ({ ok: true });
  const client = {
    posted, ephemeral, updated, deleted,
    chat: {
      postMessage: async (message) => { posted.push(message); return { ok: true, ts: `bot.${++seq}` }; },
      update: async (message) => { updated.push(message); return { ok: true }; },
      delete: async (message) => { deleted.push(message); return { ok: true }; },
      postEphemeral: async (message) => { ephemeral.push(message); return { ok: true }; },
    },
    users: {
      info: async ({ user }) => ({ user: { id: user, real_name: "Switch User" } }),
      list: async () => ({ members: [{ id: USER, real_name: "Switch User" }], response_metadata: {} }),
    },
    conversations: {
      history: async () => ({ messages: [] }),
      replies: async () => ({ messages: [] }),
      info: async ({ channel }) => ({ channel: { id: channel } }),
      members: async () => ({ members: [USER], response_metadata: {} }),
    },
    apiCall: ok,
    chatStream: ({ channel, thread_ts }) => ({
      ts: `stream.${++seq}`,
      append: ok,
      stop: async ({ markdown_text = "" } = {}) => { posted.push({ channel, thread_ts, text: markdown_text }); return { ok: true }; },
    }),
  };
  return client;
}
const cardOf = (client) => client.posted.find((m) => Array.isArray(m.blocks) && m.blocks.some((b) => b.type === "actions"));
const buttonOf = (card, actionId) => card?.blocks.flatMap((b) => b.elements || []).find((b) => b.action_id === actionId);
const event = (ts, thread, text = "CODEX_STUB_TRANSIENT_ALWAYS") => ({ type: "message", channel: CHANNEL, channel_type: "im", user: USER, text, thread_ts: thread, ts });
const click = (action, client, ts = "bot.card", thread = "") => handleEngineSwitchChoice({
  ack: async () => {},
  body: { user: { id: USER }, channel: { id: CHANNEL }, message: { ts, thread_ts: thread } },
  action,
  client,
}, { processMessage: processMessageEvent });

let entry;
test.before(async () => {
  await setUser(USER, { name: "Switch User", approved: true, isAdmin: false });
  entry = await upsertChannelEntry(CHANNEL, { name: "switch-choice", type: "im", isDM: true });
  await saveChannelMeta(entry.slug, { channelId: CHANNEL, name: entry.name, type: "im", isDM: true, template: "custom", engine: "codex", cleanMode: true, allowNetwork: false });
});

test("the card says what happened in one sentence and offers the two moves", () => {
  const ask = { failedEngine: "codex", otherEngine: "claude", kind: "transient", transientRetries: 2 };
  assert.equal(engineSwitchChoiceText(ask), "⚠️ Codex hit a temporary provider error — retried 2× before giving up. Nothing ran for your message. Switch this thread to Claude, or try Codex again?");
  const buttons = engineSwitchChoiceBlocks("id-1", ask)[1].elements;
  assert.deepEqual(buttons.map((b) => [b.action_id, b.text.text, b.value]), [[ENGINE_SWITCH_ACTION, "Switch to Claude", "id-1"], [ENGINE_RETRY_ACTION, "Try Codex again", "id-1"]]);
  assert.match(engineSwitchChoiceText({ failedEngine: "claude", otherEngine: "codex", kind: "usage_limit" }), /^⚠️ Claude hit its usage limit\. Nothing ran/);
  assert.match(engineSwitchChoiceText({ failedEngine: "codex", otherEngine: "claude", kind: "authentication" }), /Codex could not authenticate/);
  const both = { failedEngine: "codex", otherEngine: "claude", kind: "transient", transientRetries: 2, bothFailed: true, fallbackError: "Claude provider is temporarily unavailable: API Error: 529" };
  assert.match(engineSwitchChoiceText(both), /and Claude could not answer either \(Claude provider is temporarily unavailable: API Error: 529\)\. Nothing ran for your message\. Try again on either harness\?/);
  assert.deepEqual(engineSwitchChoiceBlocks("id-2", both)[1].elements.map((b) => b.text.text), ["Try Codex again", "Try Claude again"]);
});

test("the store shares the table with the busy-thread card but never sees its rows", () => {
  const store = createEngineSwitchChoiceStore();
  const ev = event("4000.001", "4000.001", "x");
  const mine = store.create({ event: ev, options: {}, ask: { failedEngine: "codex", otherEngine: "claude", kind: "transient" } });
  const theirs = busyThreadChoices.create({ event: { ...ev, ts: "4000.002" }, options: {} });
  assert.ok(store.take(theirs, USER, CHANNEL).ok === false, "a busy-thread row is not a harness choice");
  assert.equal(busyThreadChoices.take(mine, USER, CHANNEL).ok, false, "and vice versa");
  assert.equal(store.take(mine, "U_SOMEONE_ELSE", CHANNEL).reason, "owner");
  assert.equal(store.take(mine, USER, CHANNEL).ok, true);
  assert.equal(store.take(mine, USER, CHANNEL).reason, "claimed", "single-shot");
  store.discard(mine);
  busyThreadChoices.discard(theirs);
  assert.equal(store.take(mine, USER, CHANNEL).reason, "expired");
});

test("ask mode: the exhausted failure posts the card; Switch re-runs the message on the other harness and pins the thread", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "codex", engineFallback: true, engineFallbackMode: "ask", engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  const client = fakeSlack();
  const thread = "4000.100";

  await processMessageEvent(event(thread, thread), client, { botUserId: "U_BOT", teamId: "T_SWITCH" });
  const card = cardOf(client);
  assert.ok(card, `expected the harness-switch card, got ${JSON.stringify(client.posted.map((m) => m.text))}`);
  assert.match(card.text, /Codex hit a temporary provider error — retried 2× before giving up\. Nothing ran for your message\. Switch this thread to Claude, or try Codex again\?/);
  assert.ok(!client.posted.some((m) => /Something went wrong/.test(String(m.text || ""))), "the card replaces the bare error line");
  const asked = readEvents({ limit: 50 }).find((e) => e.event === "run_ask_switch" && e.slug === entry.slug);
  assert.ok(asked && asked.to === "claude" && asked.kind === "transient" && asked.transientRetries === 2);

  const outcome = await click(buttonOf(card, ENGINE_SWITCH_ACTION), client, "bot.card", thread);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.engine, "claude");
  assert.equal(outcome.accepted, true);
  assert.ok(client.updated.some((m) => /Switching this thread to Claude/.test(m.text)), "the card acknowledges the click at once");
  assert.deepEqual(client.deleted, [{ channel: CHANNEL, ts: "bot.card" }], "the card is removed once the re-run is accepted");
  assert.ok(client.posted.some((m) => /Stub engine reply/.test(String(m.text || ""))), `Claude answered the original message: ${JSON.stringify(client.posted.map((m) => m.text))}`);
  assert.equal(await getThreadEngine(entry.slug, thread), "claude", "Switch pins the thread to the chosen harness");
});

test("Try again re-runs where it failed; a second failure asks again; a stranger's click is refused", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "codex", engineFallback: true, engineFallbackMode: "ask", engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  const client = fakeSlack();
  const thread = "4000.200";

  await processMessageEvent(event(thread, thread), client, { botUserId: "U_BOT", teamId: "T_SWITCH" });
  const first = cardOf(client);
  assert.ok(first);

  const stranger = await handleEngineSwitchChoice({
    ack: async () => {},
    body: { user: { id: "U_STRANGER" }, channel: { id: CHANNEL }, message: { ts: "bot.card", thread_ts: thread } },
    action: buttonOf(first, ENGINE_RETRY_ACTION),
    client,
  }, { processMessage: processMessageEvent });
  assert.deepEqual({ ok: stranger.ok, reason: stranger.reason }, { ok: false, reason: "owner" });
  assert.match(client.ephemeral.at(-1)?.text || "", /belongs to the person who sent that message/);

  const outcome = await click(buttonOf(first, ENGINE_RETRY_ACTION), client, "bot.card", thread);
  assert.equal(outcome.engine, "codex");
  assert.equal(outcome.accepted, true);
  assert.equal(await getThreadEngine(entry.slug, thread), "", "Try again does not pin the thread");
  const cards = client.posted.filter((m) => Array.isArray(m.blocks) && m.blocks.some((b) => b.type === "actions"));
  assert.equal(cards.length, 2, "the retry failed the same way, so the thread is asked again");
  assert.equal(engineSwitchChoices.take(buttonOf(first, ENGINE_RETRY_ACTION).value, USER, CHANNEL).reason, "expired", "the first card's choice was consumed");
});

test("a stop discards a pending card with its own wording", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "codex", engineFallback: true, engineFallbackMode: "ask", engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  const client = fakeSlack();
  const thread = "4000.300";
  await processMessageEvent(event(thread, thread), client, { botUserId: "U_BOT", teamId: "T_SWITCH" });
  const card = cardOf(client);
  assert.ok(card);

  const stopped = await stopRunsInChannel(client, CHANNEL, entry.slug, USER, thread);
  assert.equal(stopped, 1);
  assert.ok(client.posted.some((m) => /Discarded 1 pending harness-switch prompt\./.test(String(m.text || ""))));
  assert.equal(engineSwitchChoices.take(buttonOf(card, ENGINE_SWITCH_ACTION).value, USER, CHANNEL).reason, "expired");
});

test("auto mode never posts the card: the turn is answered by the other harness", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "codex", engineFallback: true, engineFallbackMode: "auto", engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  const client = fakeSlack();
  const thread = "4000.400";
  await processMessageEvent(event(thread, thread), client, { botUserId: "U_BOT", teamId: "T_SWITCH" });
  assert.equal(cardOf(client), undefined);
  assert.ok(client.posted.some((m) => /retried 2× before giving up — using Claude/.test(String(m.text || "")) || /Stub engine reply/.test(String(m.text || ""))), JSON.stringify(client.posted.map((m) => m.text)));
});

test("Slack registers both harness-switch actions", () => {
  const registered = [];
  registerEngineSwitchChoiceActions({ action: (id, handler) => registered.push({ id, handler }) }, async () => {});
  assert.deepEqual(registered.map(({ id }) => id), [ENGINE_SWITCH_ACTION, ENGINE_RETRY_ACTION]);
});

test("both-engine failure card unwraps provider JSON into a sentence", () => {
  const text = engineSwitchChoiceText({ failedEngine: "claude", otherEngine: "codex", bothFailed: true,
    fallbackError: 'API rejected: {"error":{"message":"Please try again later","code":"overloaded"}}' });
  assert.match(text, /Please try again later/);
  assert.doesNotMatch(text, /\{|"error"|overloaded/);
});
