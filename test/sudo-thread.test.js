// `/sudo` is a thread-scoped escape hatch, not a channel mode. Only a current organization admin
// may set it or speak in the thread once set; the gate runs before hydration and process spawn.
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
process.env.PATH = `${fileURLToPath(new URL("./fixtures", import.meta.url))}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
process.env.PROGRESS_VIEW = "shimmer";

const { setUser, getChannelEntry, upsertChannelEntry, saveChannelMeta, defaultChannelMeta } = await import("../src/config/store.js");
const { getThreadSudo, setThreadSudo } = await import("../src/gateway/thread-engine.js");
const { processMessageEvent } = await import("../src/slack/message-pipeline.js");
const { runMessage, setRuntimeResolver } = await import("../src/gateway/run.js");
const { saveSettings } = await import("../src/config/settings.js");
const { resolveRuntime } = await import("../src/runtimes/resolve.js");
const { hostBackend } = await import("../src/runtimes/host.js");
const { runQueue } = await import("../src/slack/message-lifecycle.js");
const { getSessionRuntime } = await import("../src/gateway/sessions.js");
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
    users: { info: async ({ user }) => ({ user: { id: user, real_name: user } }), list: async () => ({ members: [] }) },
    conversations: {
      history: async () => { reads.history += 1; return { messages: [] }; },
      replies: async () => { reads.replies += 1; return { messages: [] }; },
      info: async ({ channel }) => ({ channel: { id: channel, is_im: true } }),
      members: async () => ({ members: [ADMIN, MEMBER], response_metadata: {} }),
    },
    chatStream: ({ channel, thread_ts }) => {
      let text = "";
      return { ts: "stream.1", append: async ({ markdown_text = "" }) => { text += markdown_text; },
        stop: async ({ markdown_text = "" } = {}) => { posted.push({ channel, thread_ts, text: text + markdown_text }); return { ok: true }; } };
    },
    apiCall: ok,
  };
}

function send(client, user, text, ts, threadTs = "") {
  return processMessageEvent({
    type: "message", channel: CHANNEL, channel_type: "im", user, text, ts,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  }, client, { botUserId: "UBOT", teamId: "T_SUDO" });
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


test("inline sudo runs the same formatted request on the real host backend for both engines", async (t) => {
  saveSettings({ memoryReviewEvery: 0, engineFallback: false });
  const spawns = [];
  setRuntimeResolver((slug, meta, options) => {
    const target = resolveRuntime(slug, meta, options);
    assert.equal(target.backend, "host");
    return { ...target, runtime: { ...hostBackend, spawn: (resolved, spec) => {
      spawns.push({ args: spec.args, backend: resolved.backend });
      return hostBackend.spawn(resolved, spec);
    } } };
  });
  t.after(() => setRuntimeResolver(null));
  const entry = await getChannelEntry(CHANNEL);
  for (const [i, engine] of ["claude", "codex"].entries()) {
    await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId: CHANNEL, type: "im", isDM: true }), engine });
    const root = `520${i}.001`;
    const client = fakeSlack();
    const task = `inline-${engine}: inspect this exactly:\n\`\`\`text\na  b\n\`\`\``;
    const before = spawns.length;
    await send(client, ADMIN, `<@UBOT> /sudo ${task}`, root);
    assert.equal(spawns.length, before + 1, client.posted.map(m => m.text).join("\n"));
    assert.ok(spawns.at(-1).args.some(arg => arg.includes(task)), "the CLI receives the original multiline prompt");
    assert.equal(await getThreadSudo(entry.slug, root), true);
    assert.equal(await getThreadSudo(entry.slug, `${root}-other`), false);
    assert.equal((await getSessionRuntime(entry.slug, root)).backend, "host");
    assert.match(client.posted.map(m => m.text).join("\n"), /This request and later admin messages run/);
    await send(client, ADMIN, "/sudo on another inline request", `${root}2`, root);
    assert.equal(spawns.length, before + 2, "an already enabled thread still runs each new inline task");
    assert.ok(spawns.at(-1).args.some(arg => arg.includes("another inline request")));
  }
});

test("non-admin inline sudo rejects before hydration, including current attachments", async () => {
  const client = fakeSlack();
  const before = { ...client.reads };
  await processMessageEvent({ type: "message", channel: CHANNEL, channel_type: "im", user: MEMBER,
    text: "/sudo inspect the attachment", ts: "5300.001", files: [{ id: "FSUDO", name: "example.txt" }] },
    client, { botUserId: "UBOT" });
  assert.deepEqual(client.reads, before);
  assert.equal(client.posted.at(-1).text, "Only organization admins can use `/sudo`.");
  const entry = await getChannelEntry(CHANNEL);
  assert.equal(await getThreadSudo(entry.slug, "5300.001"), false);
});

test("inline sudo refuses a busy boundary change and malformed off/status without submitting work", async () => {
  const entry = await getChannelEntry(CHANNEL);
  const client = fakeSlack();
  const key = `${entry.slug}::5400.001`;
  const blocker = { aborted: false, controller: new AbortController(), authorId: ADMIN, runId: `${key}::blocker` };
  await runQueue.acquire(key, blocker);
  try {
    await send(client, ADMIN, "/sudo inspect host", "5400.002", "5400.001");
    assert.match(client.posted.at(-1).text, /running or queued work/);
    assert.equal(await getThreadSudo(entry.slug, "5400.001"), false);
    assert.equal(runQueue.count(key), 1);
  } finally { runQueue.release(key, blocker); }
  for (const [i, command] of ["/sudo off do work", "/sudo status do work"].entries()) {
    await send(client, ADMIN, command, `5410.00${i}`);
    assert.match(client.posted.at(-1).text, /Use.*sudo <message>/);
    assert.equal(await getThreadSudo(entry.slug, `5410.00${i}`), false);
  }
});
