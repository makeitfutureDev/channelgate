import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureBin = path.join(projectRoot, "test", "fixtures");
const scratch = ensureTestEnv();
const { useFakeRuntime: __useFakeRuntime } = await import("./runtime-fake.js");
await __useFakeRuntime();
process.env.PATH = `${fixtureBin}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
process.env.PROGRESS_VIEW = "shimmer";

const { setUser } = await import("../src/config/store.js");
const { processMessageEvent, runDeathRecovery } = await import("../src/slack/message-pipeline.js");
const { runClaude } = await import("../src/engines/claude.js");

function fakeSlack() {
  const posted = [];
  let seq = 0;
  const ok = async () => ({ ok: true });
  const client = {
    posted,
    chat: {
      postMessage: async (message) => {
        posted.push(message);
        return { ok: true, ts: `bot.${++seq}` };
      },
      update: ok,
      postEphemeral: ok,
    },
    users: {
      info: async ({ user }) => ({ user: { id: user, real_name: "E2E User" } }),
      list: async () => ({ members: [{ id: "U_E2E", real_name: "E2E User" }], response_metadata: {} }),
    },
    conversations: {
      history: async () => ({ messages: [] }),
      replies: async () => ({ messages: [], response_metadata: {} }),
    },
    apiCall: ok,
  };
  client.chatStream = ({ channel, thread_ts }) => {
    let streamed = "";
    return {
      ts: `stream.${++seq}`,
      append: async ({ markdown_text = "" }) => { streamed += markdown_text; },
      stop: async ({ markdown_text = "" } = {}) => {
        posted.push({ channel, thread_ts, text: streamed + markdown_text });
        return { ok: true };
      },
    };
  };
  return client;
}

test("authorized Slack message spawns the stub Claude binary and posts its parsed reply", async () => {
  await setUser("U_E2E", { name: "E2E User", approved: true });
  const client = fakeSlack();
  const event = {
    type: "message",
    channel: "D_E2E",
    channel_type: "im",
    user: "U_E2E",
    text: "Run the end-to-end smoke",
    ts: "1000.001",
  };

  await processMessageEvent(event, client, { botUserId: "U_BOT", teamId: "T_E2E" });

  const final = client.posted.find((message) => String(message.text || "").includes("Stub engine reply"));
  assert.ok(final, `expected parsed stub reply, got: ${JSON.stringify(client.posted)}`);
  assert.equal(final.channel, "D_E2E");
  assert.equal(final.thread_ts, event.ts);
  assert.match(final.text, /Stub engine reply/);
  // The stub echoes its argv: the FIRST turn must not resume, and this clean DM run carries an
  // MCP config file (the gateway control server rides every run).
  assert.match(final.text, /resume=no/);
  assert.doesNotMatch(final.text, /Something went wrong/);

  // Second message in the SAME thread: the saved session must come back as a real `-r` resume
  // reaching the spawned process — parity with the Codex stub's resume assertion.
  const followUp = { ...event, text: "and a follow-up", ts: "1000.002", thread_ts: event.ts };
  await processMessageEvent(followUp, client, { botUserId: "U_BOT", teamId: "T_E2E" });
  const resumed = client.posted.filter((message) => String(message.text || "").includes("Stub engine reply")).at(-1);
  assert.ok(resumed, "expected a reply to the follow-up turn");
  assert.match(resumed.text, /resume=yes/, "turn 2 must resume the thread's session in the spawned argv");
});

test("Claude generic process failures are semantic while the raw code stays structured", async () => {
  await assert.rejects(
    runClaude({
      cwd: projectRoot,
      prompt: "CLAUDE_STUB_FAIL_GENERIC",
      sessionId: "11111111-2222-3333-4444-555555555555",
      isNewSession: true,
      timeoutMs: 1_000,
    }),
    (error) => {
      assert.equal(error.message, "Claude failed because it reported a general error: stub failure detail");
      assert.equal(error.details?.exitCode, 1);
      assert.doesNotMatch(error.message, /exit code|code 1/i);
      return true;
    },
  );
});

test("semantic Claude process failures retain automatic recovery without retrying provider errors", () => {
  assert.equal(runDeathRecovery({
    message: "Claude failed because it reported a general error.",
    details: { engine: "claude", processEnded: true, providerError: false, exitCode: 1 },
  }), "continue");
  assert.equal(runDeathRecovery({
    message: "Claude usage limit reached: resets tomorrow",
    details: { engine: "claude", processEnded: true, providerError: true, exitCode: 1 },
  }), null);
});

test("authorization refuses an unknown author before canonical Slack reads or engine spawn", async () => {
  await setUser("U_E2E_UNKNOWN", { name: "Unknown", approved: false, isAdmin: false });
  const client = fakeSlack();
  client.conversations.history = async () => { throw new Error("canonical read must not happen"); };
  const event = {
    type: "message",
    channel: "D_E2E_UNKNOWN",
    channel_type: "im",
    user: "U_E2E_UNKNOWN",
    text: "Process this private file",
    files: [{ id: "F_PRIVATE", file_access: "check_file_info" }],
    ts: "1000.002",
  };

  await processMessageEvent(event, client, { botUserId: "U_BOT", teamId: "T_E2E" });

  assert.equal(client.posted.length, 1);
  assert.match(client.posted[0].text, /not approved/i);
  assert.doesNotMatch(client.posted[0].text, /Stub engine reply/);
});

test("a channel message without a bot mention exits before registration or engine work", async () => {
  const client = fakeSlack();
  client.conversations.info = async () => { throw new Error("registration must not happen"); };
  await processMessageEvent({
    type: "message",
    channel: "C_E2E",
    channel_type: "channel",
    user: "U_E2E",
    text: "ordinary channel chatter",
    ts: "1000.003",
  }, client, { botUserId: "U_BOT", teamId: "T_E2E" });
  assert.deepEqual(client.posted, []);
});

// A thread that started on Claude keeps running on Claude when its channel's harness later moves to
// Codex ("continuing on claude"). The relayed login is resolved for the harness that actually runs,
// not for the channel's: it used to be resolved before that decision, so such a turn spawned Claude
// with no token — inside a container that is Claude Code's own "Not logged in · Please run /login"
// (live, 2026-09-03, a Codex-default channel whose thread had started on Claude).
test("a Claude thread inside a Codex-default channel still receives the relayed Claude login", async (t) => {
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { operatorClaudeConfigDir } = await import("../src/gateway/claude-login.js");
  const { listChannels, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");
  // The operator's own login, in the scratch CLAUDE_CONFIG_DIR test/helpers.js pins. Far expiry:
  // no refresh turn is attempted, the token is relayed as-is.
  const operatorFile = path.join(operatorClaudeConfigDir(), ".credentials.json");
  mkdirSync(path.dirname(operatorFile), { recursive: true, mode: 0o700 });
  writeFileSync(operatorFile, JSON.stringify({
    claudeAiOauth: { accessToken: "sk-ant-oat01-e2e-relay", refreshToken: "never-relayed", expiresAt: Date.now() + 4 * 60 * 60 * 1000, refreshTokenExpiresAt: Date.now() + 20 * 24 * 60 * 60 * 1000 },
  }), { mode: 0o600 });
  t.after(() => rmSync(operatorFile, { force: true }));

  await setUser("U_E2E", { name: "E2E User", approved: true });
  const client = fakeSlack();
  const event = { type: "message", channel: "D_E2E_RELAY", channel_type: "im", user: "U_E2E", text: "start on claude", ts: "2000.001" };
  await processMessageEvent(event, client, { botUserId: "U_BOT", teamId: "T_E2E" });
  const first = client.posted.find((message) => String(message.text || "").includes("Stub engine reply"));
  assert.ok(first, `expected a stub reply, got: ${JSON.stringify(client.posted)}`);
  assert.match(first.text, /oauth=yes/, "a Claude-default turn relays the login (sanity)");

  // The channel's harness moves to Codex after the thread exists.
  const entry = (await listChannels()).find((c) => c.channelId === "D_E2E_RELAY");
  assert.ok(entry, "the DM must be registered by the first turn");
  await saveChannelMeta(entry.slug, { ...((await getChannelMeta(entry.slug)) || {}), engine: "codex" });

  const followUp = { ...event, text: "still on claude?", ts: "2000.002", thread_ts: event.ts };
  await processMessageEvent(followUp, client, { botUserId: "U_BOT", teamId: "T_E2E" });
  const resumed = client.posted.filter((message) => String(message.text || "").includes("Stub engine reply")).at(-1);
  assert.ok(resumed && resumed !== first, "expected a reply to the follow-up turn");
  assert.match(resumed.text, /resume=yes/, "the thread resumes its Claude session");
  assert.match(resumed.text, /oauth=yes/, "the resumed Claude turn must carry the relayed login even though the channel is on Codex");
});

test("ambiguous hard kills and explicit Stop never auto-continue", () => {
  for (const details of [
    { exitCode: 137 }, { signal: "SIGKILL" }, { explicitStop: true },
  ]) {
    assert.equal(runDeathRecovery({ message: "Claude session ended", details: { engine: "claude", processEnded: true, ...details } }), null);
    assert.equal(runDeathRecovery({ message: "session is dead", details }), null);
  }
  assert.equal(runDeathRecovery({ name: "AbortError", message: "Claude session ended" }), null);
  assert.equal(runDeathRecovery({ message: "session is dead" }), "retry");
});


test("channel access denials name the channel policy without mislabeling approved users", async () => {
  const { upsertChannelEntry, saveChannelMeta, defaultChannelMeta } = await import("../src/config/store.js");
  for (const [access, expected] of [["admins", /restricted to admins/i], ["none", /restricted to named users/i]]) {
    const user = "U_E2E_POLICY_" + access;
    await setUser(user, { name: "Approved policy test user", approved: true, isAdmin: false });
    const channel = "C_E2E_POLICY_" + access;
    const entry = await upsertChannelEntry(channel, { name: "policy-" + access, type: "mpim", isDM: false });
    await saveChannelMeta(entry.slug, { ...defaultChannelMeta(channel), access });
    const client = fakeSlack();
    client.conversations.history = async () => { throw new Error("denied trigger must not read files"); };
    await processMessageEvent({ type: "message", channel, channel_type: "mpim", user,
      text: "<@U0QABOT> Inspect the prepared file", ts: "deny-" + access,
      files: [{ id: "F_DENIED", file_access: "check_file_info" }],
    }, client, { botUserId: "U0QABOT", teamId: "T_E2E" });
    assert.equal(client.posted.length, 1);
    assert.match(client.posted[0].text, expected);
    assert.doesNotMatch(client.posted[0].text, /not approved|Users settings|Stub engine reply/i);
    assert.equal(client.posted[0].thread_ts, "deny-" + access);
  }
});
