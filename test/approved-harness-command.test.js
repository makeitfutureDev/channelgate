// The typed `/harnesses` command: a channel's Approved harnesses list read and set from chat on
// every surface (Slack in-thread commands; the Teams / Google Chat text controls). It is the same
// function as `set_channel_approved_harnesses` (src/gateway/approved-harnesses.js), so it holds the
// same rules — admin only for a change, the Enterprise entitlement, never a list without the
// license the channel runs on, one audit row — and starts no engine.
import test from "node:test";
import assert from "node:assert/strict";
import { clearTestLicense, ensureTestEnv, testLicenseEnv } from "./helpers.js";

ensureTestEnv();
const { useFakeRuntime } = await import("./runtime-fake.js");
const runtime = await useFakeRuntime();

const { readEvents } = await import("../src/util/logger.js");
const { defaultChannelMeta, getChannelMeta, saveChannelMeta, upsertChannelEntry, setUser } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { createLicense, deleteLicense } = await import("../src/config/engine-licenses.js");
const { parseApprovedHarnessesArg, runApprovedHarnessesCommand } = await import("../src/gateway/approved-harnesses.js");
const { parseSlashCommand } = await import("../src/slack/message-normalize.js");
const { createConversationControls } = await import("../src/platforms/conversation-controls.js");
const { processMessageEvent } = await import("../src/slack/message-pipeline.js");
const { HELP_TEXT } = await import("../src/slack/help.js");
const { GOOGLE_CHAT_CONTROL_COMMAND } = await import("../src/platforms/googlechat/events.js");

const ADMIN = "U_HCMD_ADMIN";
const MEMBER = "U_HCMD_MEMBER";
await setUser(ADMIN, { name: "Harness Admin", isAdmin: true, approved: true });
await setUser(MEMBER, { name: "Harness Member", isAdmin: false, approved: true });
saveSettings({ engine: "claude", engineEnabled: { claude: true, codex: true } });
testLicenseEnv({ tier: "enterprise" });

let seq = 0;
async function channel(extra = {}) {
  const channelId = `C_HCMD_${++seq}`;
  const entry = await upsertChannelEntry(channelId, { name: `harness-cmd-${seq}`, type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId, name: entry.name, type: "channel", isDM: false }), engine: "claude", template: "custom", ...extra });
  const events = () => readEvents({ limit: 300 }).filter((e) => e.event === "channel_meta_changed" && e.slug === entry.slug);
  return { channelId, entry, events, policy: async () => (await getChannelMeta(entry.slug)).approvedEngines ?? null };
}

test("the argument: bare shows, a word for 'everything' clears, entries split on commas so names keep spaces", () => {
  assert.equal(parseApprovedHarnessesArg(""), "");
  assert.equal(parseApprovedHarnessesArg("  "), "");
  for (const word of ["all", "ALL", "any", "none", "unrestricted"]) assert.equal(parseApprovedHarnessesArg(word), "all");
  assert.deepEqual(parseApprovedHarnessesArg("harness:claude, Team seat ,, codex"), ["harness:claude", "Team seat", "codex"]);
  assert.deepEqual(parseApprovedHarnessesArg("Codex · Team seat\nclaude"), ["Codex · Team seat", "claude"]);
  assert.deepEqual(parseSlashCommand("/harnesses harness:claude, Team seat"), { cmd: "harnesses", arg: "harness:claude, Team seat" });
  assert.ok(GOOGLE_CHAT_CONTROL_COMMAND.test("/harnesses all"), "Google Chat routes it as a control, not a prompt");
  assert.match(HELP_TEXT, /`\/harnesses`/);
});

test("the shared command: an admin sets it by license name, it is audited as a chat command, a member only reads", async () => {
  const f = await channel();
  const seat = createLicense({ kind: "codex-login", label: "Team seat", type: "business" });
  saveSettings({ engineEnabled: { [seat.id]: true } });
  try {
    const meta = await getChannelMeta(f.entry.slug);
    const run = (actor, isAdmin, arg) => runApprovedHarnessesCommand({ arg, meta, slug: f.entry.slug, channelId: f.channelId, actor, source: "slack-command", isAdmin });

    assert.match(await run(MEMBER, false, "all"), /Only organization admins/);
    assert.equal(await f.policy(), null);
    assert.equal(f.events().length, 0);

    assert.match(await run(ADMIN, true, "harness:claude, Team seat"), /✅ Approved for this channel: Claude Code \(any license\), Team seat\./);
    assert.deepEqual(await f.policy(), ["harness:claude", seat.id]);
    const [event] = f.events();
    assert.deepEqual(event.keys, ["approvedEngines"]);
    assert.equal(event.actor, ADMIN);
    assert.equal(event.source, "slack-command");

    const shown = await run(MEMBER, false, "");
    assert.match(shown, /Approved here: Claude Code \(any license\), Team seat\./);
    assert.match(shown, /Only an organization admin can change this list/);
    assert.ok(!shown.includes("harness:codex"), "the approvable inventory is an admin's list");
    assert.match(await run(ADMIN, true, ""), /`\/harnesses <entry>, <entry>…`[\s\S]*`harness:codex` — Codex \(any license\)/);
  } finally {
    await deleteLicense(seat.id);
  }
});

test("the shared command refuses what the tool refuses, and writes nothing", async () => {
  const f = await channel();
  const run = (arg) => runApprovedHarnessesCommand({ arg, meta: null, slug: f.entry.slug, channelId: f.channelId, actor: ADMIN, source: "chat-command", isAdmin: true });
  assert.match(await run("harness:codex"), /Nothing was changed: this channel currently runs on Claude, which that list leaves out/);
  assert.match(await run("claude, no-such-seat"), /Nothing was changed: "no-such-seat" is not an entry I can approve/);
  assert.equal(await f.policy(), null);
  await run("claude");
  clearTestLicense();
  try {
    assert.match(await run("all"), /Nothing was changed: .*requires an active Enterprise license/);
    assert.deepEqual(await f.policy(), ["claude"], "a downgrade never widens a restriction");
  } finally {
    testLicenseEnv({ tier: "enterprise" });
  }
  assert.equal(f.events().length, 1, "only the one accepted change is audited");
});

test("Teams and Google Chat text controls: /harnesses is answered by the gateway with the author's current role", async () => {
  const f = await channel();
  const controls = createConversationControls();
  const meta = await getChannelMeta(f.entry.slug);
  const say = async (userId, text, authorIsAdmin) => {
    const replies = [];
    const handled = await controls.command({
      message: { text, conversationId: f.channelId, userId, trigger: "message" }, sessionKey: "s1", slug: f.entry.slug,
      meta, authorIsAdmin, reply: async (t) => { replies.push(t); },
    });
    return { handled, text: replies.join("\n") };
  };
  const member = await say(`teams:${MEMBER}`, "/harnesses claude", false);
  assert.equal(member.handled, true);
  assert.match(member.text, /Only organization admins/);
  assert.equal(await f.policy(), null);

  const admin = await say(`teams:${ADMIN}`, "/harnesses claude, harness:codex", true);
  assert.match(admin.text, /✅ Approved for this channel: Codex \(any license\), Claude\./);
  assert.deepEqual(await f.policy(), ["harness:codex", "claude"], "stored in the canonical order");
  const [event] = f.events();
  assert.equal(event.actor, `teams:${ADMIN}`);
  assert.equal(event.source, "chat-command");

  assert.match((await say(`teams:${MEMBER}`, "/HARNESSES", false)).text, /Approved here: Codex \(any license\), Claude\./);
  assert.match((await say(`teams:${MEMBER}`, "/help", false)).text, /\/harnesses \[all\|entry/);
});

test("Slack: a typed /harnesses in a thread is a control command — answered, audited, and no engine starts", async () => {
  const f = await channel();
  const BOT = "BHCMD";
  const messages = [];
  const client = {
    chat: { postMessage: async (message) => { messages.push(message); return { ok: true, ts: "bot.1" }; }, update: async () => ({ ok: true }) },
    apiCall: async () => ({ ok: true }),
    users: { info: async ({ user }) => ({ user: { id: user, real_name: "Harness Person" } }), list: async () => ({ members: [] }) },
    conversations: { info: async () => ({ channel: { id: f.channelId, is_channel: true, is_member: true } }), replies: async () => ({ messages: [] }), history: async () => ({ messages: [] }), members: async () => ({ members: [ADMIN, MEMBER], response_metadata: {} }) },
  };
  const spawned = runtime.calls.spawn.length;
  const say = (user, text, ts) => processMessageEvent({ type: "message", channel: f.channelId, channel_type: "channel", user, text: `<@${BOT}> ${text}`, ts }, client, { botUserId: BOT });

  await say(MEMBER, "/harnesses harness:claude", "1910.001");
  assert.match(messages.at(-1).text, /Only organization admins/);
  assert.equal(await f.policy(), null);

  await say(ADMIN, "/harnesses harness:claude", "1910.002");
  assert.match(messages.at(-1).text, /✅ Approved for this channel: Claude Code \(any license\)\./);
  assert.deepEqual(await f.policy(), ["harness:claude"]);
  const [event] = f.events();
  assert.equal(event.actor, ADMIN);
  assert.equal(event.source, "slack-command");

  await say(MEMBER, "/harnesses", "1910.003");
  assert.match(messages.at(-1).text, /Approved here: Claude Code \(any license\)\./);
  assert.equal(runtime.calls.spawn.length, spawned, "a control command starts no engine");
});
