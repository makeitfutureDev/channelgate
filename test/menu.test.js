import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { useFakeRuntime } = await import("./runtime-fake.js");
const runtime = await useFakeRuntime();
const { setUser, upsertChannelEntry, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");
const { saveSession, getSessionMap, clearSession } = await import("../src/gateway/sessions.js");
const { setThreadEngine, setThreadClean } = await import("../src/gateway/thread-engine.js");
const { handleMenuCommand, handleMenuResumeAction } = await import("../src/slack/app.js");
const { processMessageEvent } = await import("../src/slack/message-pipeline.js");
const { buildMenuCard } = await import("../src/slack/menu.js");
const { readEvents } = await import("../src/util/logger.js");
let sequence = 0;
async function fixture({ approved = true, dm = false } = {}) {
  const channel = `${dm ? "D" : "C"}MENU${++sequence}`;
  const user = `UMENU${sequence}`;
  const entry = await upsertChannelEntry(channel, { name: `menu-${sequence}`, type: dm ? "im" : "channel" });
  await saveChannelMeta(entry.slug, { ...await getChannelMeta(entry.slug), isDM: dm, allowedUsers: [] });
  await setUser(user, { name: "Menu tester", approved });
  const sent = [], opened = [];
  let acked = false;
  const client = {
    chat: { postMessage: async m => { sent.push(m); return { ok: true, ts: "900.1" }; }, postEphemeral: async m => { sent.push(m); return { ok: true }; } },
    views: { open: async m => { opened.push(m); return { ok: true }; } },
    conversations: { members: async () => ({ members: [user], response_metadata: {} }), replies: async () => ({ messages: [] }), history: async () => ({ messages: [] }) },
    users: { info: async () => ({ user: { real_name: "Menu tester" } }) },
  };
  return { channel, user, entry, client, sent, opened,
    args: { command: { channel_id: channel, user_id: user }, client, ack: async () => { acked = true; }, respond: async m => { assert.ok(acked); sent.push(m); } } };
}
function assertCard(message, channel, user, thread = "") {
  assert.equal(message.blocks.length, 1);
  assert.equal(message.blocks[0].type, "actions");
  assert.deepEqual(message.blocks[0].elements.map(b => b.text.text), ["💻 Resume", "📂 Files", "🔑 Secrets", "⚙️ Settings"]);
  for (const button of message.blocks[0].elements) {
    const value = JSON.parse(button.value);
    assert.equal(value.c, channel); assert.equal(value.u, user); assert.equal(value.t, thread);
  }
}
for (const dm of [false, true]) test(`/menu returns only four buttons in ${dm ? "DM" : "channel"} without a session`, async () => {
  const f = await fixture({ dm });
  await handleMenuCommand(f.args);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].response_type, "ephemeral");
  assertCard(f.sent[0], f.channel, f.user);
  assert.deepEqual(await getSessionMap(f.entry.slug), {});
});
test("unapproved users receive no menu in channels or DMs", async () => {
  for (const dm of [false, true]) {
    const f = await fixture({ approved: false, dm });
    await handleMenuCommand(f.args);
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].blocks, undefined);
    assert.match(f.sent[0].text, /not authorized/);
  }
});
test("typed menu preserves thread, mention gate, and bypasses the engine", async () => {
  for (const dm of [false, true]) {
    const f = await fixture({ dm });
    const event = { channel: f.channel, channel_type: dm ? "im" : "channel", user: f.user, ts: "102.1", thread_ts: "100.1", text: "/menu" };
    if (!dm) { await processMessageEvent(event, f.client, { botUserId: "BMENU" }); assert.equal(f.sent.length, 0); }
    await processMessageEvent({ ...event, text: dm ? "/menu" : "<@BMENU> /menu" }, f.client, { botUserId: "BMENU" });
    assert.equal(f.sent.length, 1); assertCard(f.sent[0], f.channel, f.user, "100.1");
    assert.equal(f.sent[0].thread_ts, "100.1");
    assert.equal(readEvents({ limit: 1000 }).filter(e => e.event === "run_start" && e.channel === f.channel).length, 0);
  }
});
async function click(f, { thread = "100.1", user = f.user, channel = f.channel } = {}) {
  await handleMenuResumeAction({ ack: async () => {}, client: f.client,
    body: { channel: { id: channel }, user: { id: user }, trigger_id: "trigger" },
    action: buildMenuCard(f.channel, thread, f.user).blocks[0].elements[0] });
}
test("Resume never selects another thread and reads cleared state on click", async () => {
  const f = await fixture();
  await saveSession(f.entry.slug, "other", "other-session", "claude");
  await click(f, { thread: "" }); assert.match(JSON.stringify(f.opened.at(-1)), /Open a conversation thread/);
  await click(f); assert.match(JSON.stringify(f.opened.at(-1)), /No session/);
  await saveSession(f.entry.slug, "100.1", "old-session", "claude");
  await clearSession(f.entry.slug, "100.1");
  await click(f); assert.match(JSON.stringify(f.opened.at(-1)), /No session/);
  assert.equal(JSON.stringify(f.opened).includes("other-session"), false);
});
for (const engine of ["claude", "codex"]) test(`Resume uses stored ${engine} owner and container command`, async () => {
  const f = await fixture();
  await saveSession(f.entry.slug, "100.1", "menu-session", engine);
  await setThreadEngine(f.entry.slug, "100.1", engine === "claude" ? "codex" : "claude");
  await click(f);
  const view = JSON.stringify(f.opened[0]);
  assert.match(view, /menu-session/); assert.match(view, new RegExp(engine)); assert.match(view, /exec/);
});
test("Resume uses the per-thread clean workspace", async () => {
  const f = await fixture();
  await saveSession(f.entry.slug, "100.1", "clean-session", "claude");
  await setThreadClean(f.entry.slug, "100.1", true);
  await click(f);
  const { effectiveWorkDir } = await import("../src/gateway/folders.js");
  const cleanDir = effectiveWorkDir(f.entry.slug, { ...await getChannelMeta(f.entry.slug), cleanMode: true });
  assert.ok(f.opened[0].view.blocks[0].text.text.includes(cleanDir));
});
test("Resume rechecks requester, channel, authorization and membership", async () => {
  for (const kind of ["user", "channel", "revoked", "membership"]) {
    const f = await fixture();
    if (kind === "revoked") await setUser(f.user, { approved: false });
    if (kind === "membership") f.client.conversations.members = async () => ({ members: [], response_metadata: {} });
    await click(f, kind === "user" ? { user: "FOREIGN" } : kind === "channel" ? { channel: "FOREIGN" } : {});
    assert.equal(f.opened.length, 0, kind); assert.equal(f.sent.length, 1, kind);
  }
});
test("manifest and Bolt expose native menu controls", () => {
  const manifest = JSON.parse(readFileSync(new URL("../slack-app-manifest.json", import.meta.url)));
  assert.ok(manifest.features.slash_commands.some(c => c.command === "/menu"));
  const source = readFileSync(new URL("../src/slack/app.js", import.meta.url), "utf8");
  assert.match(source, /app.command\("\/menu", handleMenuCommand\)/);
  assert.match(source, /app.action\(MENU_RESUME_ACTION_ID, handleMenuResumeAction\)/);
  assert.equal(runtime.calls.spawn.length, 0);
  assert.equal(runtime.calls.ensureUp.length, 0);
});
