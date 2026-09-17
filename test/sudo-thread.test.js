// `/sudo` is a thread-scoped escape hatch, not a channel mode. Only a current organization admin
// may set it or speak in the thread once set; the gate runs before hydration and process spawn.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { setUser, getChannelEntry, upsertChannelEntry, saveChannelMeta, defaultChannelMeta } = await import("../src/config/store.js");
const { getThreadSudo, setThreadSudo } = await import("../src/gateway/thread-engine.js");
const { processMessageEvent } = await import("../src/slack/message-pipeline.js");
const { runMessage } = await import("../src/gateway/run.js");
const { readEvents } = await import("../src/util/logger.js");

const ADMIN = "U_SUDO_ADMIN";
const MEMBER = "U_SUDO_MEMBER";
const CHANNEL = "D_SUDO_THREAD";

function fakeSlack() {
  const posted = [];
  const reads = { history: 0, replies: 0 };
  const ok = async () => ({ ok: true });
  return {
    posted,
    reads,
    chat: {
      postMessage: async (message) => { posted.push(message); return { ok: true, ts: `bot.${posted.length}` }; },
      update: ok,
      delete: ok,
      postEphemeral: async (message) => { posted.push(message); return { ok: true }; },
    },
    users: { info: async ({ user }) => ({ user: { id: user, real_name: user } }) },
    conversations: {
      history: async () => { reads.history += 1; return { messages: [] }; },
      replies: async () => { reads.replies += 1; return { messages: [] }; },
      info: async ({ channel }) => ({ channel: { id: channel, is_im: true } }),
      members: async () => ({ members: [ADMIN, MEMBER], response_metadata: {} }),
    },
    apiCall: ok,
  };
}

function send(client, user, text, ts, threadTs = "") {
  return processMessageEvent({
    type: "message", channel: CHANNEL, channel_type: "im", user, text, ts,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  }, client, { botUserId: "U_BOT", teamId: "T_SUDO" });
}

test("sudo is admin-only, sticky to one thread, audited, and rejects members before hydration", async () => {
  await setUser(ADMIN, { name: "Admin", isAdmin: true, approved: true });
  await setUser(MEMBER, { name: "Member", isAdmin: false, approved: true });
  const client = fakeSlack();

  await send(client, ADMIN, "/sudo", "5000.001");
  const entry = await getChannelEntry(CHANNEL);
  assert.equal(await getThreadSudo(entry.slug, "5000.001"), true);
  assert.match(client.posted.at(-1).text, /Sudo enabled.*directly on the gateway host/is);
  const change = readEvents({ limit: 100 }).find((event) => event.event === "sudo_thread_changed" && event.slug === entry.slug);
  assert.equal(change.author, ADMIN);
  assert.equal(change.enabled, true);

  const readsBefore = { ...client.reads };
  await send(client, MEMBER, "/help", "5000.002", "5000.001");
  assert.equal(client.reads.history, readsBefore.history, "rejected traffic does not hydrate the message");
  assert.equal(client.reads.replies, readsBefore.replies, "rejected traffic does not read the thread");
  assert.equal(client.posted.at(-1).text, "⛔ This is a sudo thread. Only organization admins can send messages or run work here.");

  await send(client, ADMIN, "/sudo off", "5000.003", "5000.001");
  assert.equal(await getThreadSudo(entry.slug, "5000.001"), false);
  assert.match(client.posted.at(-1).text, /Sudo disabled/);
});

test("an approved non-admin cannot activate sudo", async () => {
  const client = fakeSlack();
  await send(client, MEMBER, "/sudo", "5100.001");
  const entry = await getChannelEntry(CHANNEL);
  assert.equal(await getThreadSudo(entry.slug, "5100.001"), false);
  assert.equal(client.posted.at(-1).text, "Only organization admins can use `/sudo`.");
});

test("the run orchestrator independently refuses non-admin work in a sudo thread", async () => {
  const channelId = "D_SUDO_CORE";
  const entry = await upsertChannelEntry(channelId, { name: "sudo-core", type: "im", isDM: true, platform: "slack" });
  await saveChannelMeta(entry.slug, defaultChannelMeta({ channelId, name: "sudo-core", type: "im", isDM: true, platform: "slack" }));
  await setThreadSudo(entry.slug, "core-thread", true);
  const result = await runMessage({
    channelId,
    authorId: MEMBER,
    text: "run a command",
    threadKey: "core-thread",
    origin: "background_agent",
  });
  assert.equal(result.accessRefused, true);
  assert.equal(result.sudoThread, true);
  assert.match(result.content, /Only organization admins/);

  const spoofedAdmin = await runMessage({
    channelId,
    authorId: ADMIN,
    text: "run a command",
    threadKey: "core-thread",
    origin: "api_foreground",
    untrustedPrincipal: true,
  });
  assert.equal(spoofedAdmin.accessRefused, true, "a run-API caller cannot gain host access by naming an admin");
  assert.equal(spoofedAdmin.sudoThread, true);
});
