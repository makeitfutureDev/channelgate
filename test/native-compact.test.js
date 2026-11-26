import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { useFakeRuntime, createFakeRuntimeBackend } = await import("./runtime-fake.js");
const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage, resetEngineCooldowns } = await import("../src/gateway/run.js");
const { getSession, saveSession } = await import("../src/gateway/sessions.js");
const { setThreadEngine, getThreadEngine } = await import("../src/gateway/thread-engine.js");
const { shutdownPool } = await import("../src/engines/session-pool.js");
const { processMessageEvent } = await import("../src/slack/message-pipeline.js");
const { listActiveRuns, recoverRuns, recordActiveRun } = await import("../src/gateway/active-runs.js");
const { runQueue } = await import("../src/slack/message-lifecycle.js");
const USER = "U_COMPACT", BOT = "BCOMPACT";
const invocations = [];
const backend = createFakeRuntimeBackend();
let response = "echo";
backend.spawn = (target, spec) => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const warm = spec.args.includes("--input-format");
  const id = spec.args[spec.args.indexOf("-r") + 1];
  const answer = (prompt) => {
    invocations.push({ prompt, args: spec.args, warm, id });
    queueMicrotask(() => {
      if (response === "missing") {
        child.stderr.write("No conversation found with session ID");
        child.emit("close", 1, null);
      } else if (response === "limit") {
        child.stdout.write(JSON.stringify({ type: "assistant", error: "rate_limit", message: { role: "assistant", content: [{ type: "text", text: "Session limit reached; resets at 6am" }] } }) + "\n");
        child.emit("close", 1, null);
      } else {
        if (response === "compacted") child.stdout.write(JSON.stringify({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 2000 } }) + "\n");
        if (response === "local-error") child.stdout.write(JSON.stringify({ type: "assistant", local_command_run: { command: "compact", args: "" }, local_command_outcome: { kind: "failed" }, message: { role: "assistant", content: [{ type: "text", text: "Error: No messages to compact" }] } }) + "\n");
        child.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: ["empty", "compacted", "local-error"].includes(response) ? "" : prompt,
          session_id: id, usage: { input_tokens: response === "empty" ? 0 : 12, output_tokens: response === "empty" ? 0 : 4 } }) + "\n");
        if (!warm) child.emit("close", 0, null);
      }
    });
  };
  if (warm) child.stdin.on("data", data => {
    const msg = JSON.parse(String(data));
    if (msg.type === "user") answer(msg.message.content);
  });
  else answer(spec.args[spec.args.indexOf("-p") + 1]);
  return child;
};
await useFakeRuntime(backend);
let sequence = 0;
async function fixture({ engine = "claude", session = true, pin = "" } = {}) {
  resetEngineCooldowns();
  saveSettings({ engine: "claude", engineEnabled: { claude: true, codex: true }, codexFallback: true, memoryReviewEvery: 0, composioMode: "personal" });
  await setUser(USER, { name: "Compaction tester", approved: true, isAdmin: false });
  const channel = `D_COMPACT_${++sequence}`;
  const entry = await upsertChannelEntry(channel, { name: `compact-${sequence}`, type: "im", isDM: true });
  await saveChannelMeta(entry.slug, { channelId: channel, name: entry.name, type: "im", isDM: true,
    template: "custom", engine, memoryEnabled: true });
  const root = "100.001";
  // Current shared project history: compact must not cross the private/admin history reset gate.
  if (session) await saveSession(entry.slug, root, `compact-session-${sequence}`, engine, undefined,
    JSON.stringify({ backend: "container", scope: "project", history: "channel-v1" }));
  if (pin) await setThreadEngine(entry.slug, root, pin);
  const posted = [];
  const ok = async () => ({ ok: true });
  const client = {
    chat: { postMessage: async m => { posted.push(m); return { ok: true, ts: `bot.${posted.length}` }; }, update: ok },
    apiCall: ok,
    users: { info: async () => ({ user: { real_name: "Compaction tester" } }), list: async () => ({ members: [] }) },
    conversations: { info: async () => ({ channel: { id: channel, is_im: true } }),
      replies: async () => ({ messages: [{ ts: root, user: USER, text: "Prior context must never precede the command" }] }), history: async () => ({ messages: [] }) },
  };
  const args = { channelId: channel, authorId: USER, text: "/compact keep the deployment decisions", threadKey: root, origin: "slack_foreground" };
  const send = (text = args.text, ts = "101.001") => processMessageEvent({ type: "message", channel, channel_type: "im", user: USER,
    text: `<@${BOT}> ${text}`, ts, thread_ts: root }, client, { botUserId: BOT });
  return { entry, channel, root, client, posted, args, send };
}

test.after(() => shutdownPool());
for (const warm of [false, true]) {
  test(`${warm ? "warm stream-json" : "cold -p"}: Slack passes only the native command and resumes its session`, async () => {
    process.env.SESSION_KEEPALIVE = warm ? "30s" : "0";
    response = "echo";
    const f = await fixture();
    const id = await getSession(f.entry.slug, f.root);
    const before = invocations.length;
    await f.send();
    assert.equal(invocations.length, before + 1);
    assert.equal(invocations.at(-1).prompt, f.args.text);
    assert.equal(invocations.at(-1).warm, warm);
    assert.equal(invocations.at(-1).id, id);
    assert.ok(!invocations.at(-1).args.includes("--session-id"));
    assert.equal(await getSession(f.entry.slug, f.root), id);
    if (warm) {
      await f.send("/compact", "102.001");
      assert.equal(invocations.at(-1).prompt, "/compact");
    }
    await f.send("ordinary follow-up", "103.001");
    assert.match(invocations.at(-1).prompt, /Provenance:/);
    assert.match(invocations.at(-1).prompt, /Gateway runtime for THIS attempt/);
    assert.match(invocations.at(-1).prompt, /Gateway container access/);
    assert.match(invocations.at(-1).prompt, /ordinary follow-up/);
    assert.equal(listActiveRuns().length, 0);
  });
}

test("no session, disabled license, or different explicit harness refuses without spawning or minting", async () => {
  for (const kind of ["no-session", "disabled", "other-harness"]) {
    const f = await fixture({ session: kind !== "no-session", pin: kind === "other-harness" ? "codex" : "" });
    const id = await getSession(f.entry.slug, f.root);
    if (kind === "disabled") saveSettings({ engineEnabled: { claude: false, codex: true } });
    const before = invocations.length;
    const result = await runMessage(f.args);
    assert.equal(result.engineRefused, true);
    assert.equal(invocations.length, before);
    assert.equal(await getSession(f.entry.slug, f.root), id);
    assert.match(result.content, kind === "no-session" ? /normal message first/ : kind === "disabled" ? /disabled/ : /Codex doesn't support/);
  }
});

test("Codex Slack refusal is unchanged and the stored Claude owner survives a Codex default", async () => {
  const codex = await fixture({ engine: "codex" });
  const before = invocations.length;
  await codex.send("/compact");
  assert.match(codex.posted.map(m => m.text).join("\n"), /Codex doesn't support `\/compact`/);
  assert.equal(invocations.length, before);
  const claude = await fixture();
  await saveChannelMeta(claude.entry.slug, { channelId: claude.channel, name: claude.entry.name, template: "custom", engine: "codex", isDM: true });
  response = "echo";
  await runMessage({ ...claude.args, preferCold: true });
  assert.equal(invocations.at(-1).prompt, claude.args.text);
});

for (const failure of ["missing", "limit", "empty"]) {
  test(`native ${failure} failure never heals, retries or fails over`, async () => {
    const f = await fixture();
    const id = await getSession(f.entry.slug, f.root);
    const before = invocations.length;
    response = failure;
    await assert.rejects(runMessage({ ...f.args, preferCold: true }));
    assert.equal(invocations.length, before + 1);
    assert.equal(await getSession(f.entry.slug, f.root), id);
    response = "echo";
  });
}

test("queued compact persists bare text and boot recovery dispatches it unchanged", async () => {
  process.env.SESSION_KEEPALIVE = "0";
  response = "echo";
  const f = await fixture();
  const key = `${f.entry.slug}::${f.root}`;
  const blocker = { aborted: false, controller: new AbortController(), authorId: USER, runId: `${key}::blocker` };
  await runQueue.acquire(key, blocker);
  const pending = f.send();
  let stored;
  try {
    for (let tries = 0; tries < 100; tries++) {
      stored = listActiveRuns().find(row => row.channelId === f.channel);
      if (stored) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(stored?.text, f.args.text);
  } finally {
    runQueue.release(key, blocker);
    await pending;
  }
  recordActiveRun(stored.id, stored);
  await recoverRuns([stored], {
    slack: { snapshot: () => ({ connected: true }), getClient: () => f.client },
    deliver: async () => {}, usageRecorder: async () => {},
  });
  assert.equal(invocations.at(-1).prompt, f.args.text);
  assert.equal(listActiveRuns().length, 0);
});


test("compact focus instructions cannot change harness pins", async () => {
  response = "echo";
  const f = await fixture();
  const pin = await getThreadEngine(f.entry.slug, f.root);
  await f.send("/compact use codex details");
  assert.equal(invocations.at(-1).prompt, "/compact use codex details");
  assert.equal(await getThreadEngine(f.entry.slug, f.root), pin);
});

test("historical attachments cannot turn compact into a wrapped model prompt", async () => {
  response = "echo";
  const f = await fixture();
  const previous = { ts: "100.900", user: USER, text: "Earlier upload",
    files: [{ id: "F_COMPACT", name: "history.txt", size: Number.MAX_SAFE_INTEGER, url_private_download: "https://files.slack.test/history" }] };
  f.client.conversations.replies = async args => ({ messages: args.oldest
    ? [{ ts: "101.001", user: USER, text: `<@${BOT}> ${f.args.text}` }]
    : [{ ts: f.root, user: USER, text: "Prior context" }, previous] });
  await f.send();
  assert.equal(invocations.at(-1).prompt, f.args.text);
});


for (const warm of [false, true]) {
  test(`${warm ? "warm" : "cold"}: native boundary and local command errors survive result output`, async () => {
    process.env.SESSION_KEEPALIVE = warm ? "30s" : "0";
    const f = await fixture();
    const id = await getSession(f.entry.slug, f.root);
    const before = invocations.length;
    response = "compacted";
    const result = await runMessage(f.args);
    assert.equal(result.content, "Conversation compacted.");
    response = "local-error";
    const failure = await runMessage(f.args);
    assert.equal(failure.content, "Error: No messages to compact");
    assert.equal(invocations.length, before + 2);
    assert.equal(await getSession(f.entry.slug, f.root), id);
    response = "echo";
  });
}

test("automatic and child compaction boundaries do not prove native command success", async () => {
  const { createStreamConsumer } = await import("../src/engines/stream.js");
  const events = [], deltas = [];
  const stream = createStreamConsumer({ onEvent: event => events.push(event), onDelta: text => deltas.push(text) });
  stream.consume({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto" } });
  stream.consume({ type: "system", subtype: "compact_boundary", parent_tool_use_id: "child", compact_metadata: { trigger: "manual" } });
  stream.consume({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Completed ordinary assistant message" }] } });
  stream.consume({ type: "result", subtype: "success", result: "", local_command: "compact" });
  assert.equal(stream.text, "");
  assert.deepEqual(deltas, []);
  assert.deepEqual(events.filter(event => event.kind === "compaction"), [{ kind: "compaction", trigger: "auto" }]);
});
