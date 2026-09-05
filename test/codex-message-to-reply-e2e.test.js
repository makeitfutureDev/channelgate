import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.env.PATH = `${path.join(projectRoot, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
process.env.PROGRESS_VIEW = "shimmer";
ensureTestEnv();
// Every Codex turn runs in a container-shaped target: the orchestrated turns resolve one through
// run.js's test seam, and the direct runner calls below are handed the same fake backend, which
// delegates the spawn to this host so the stub `codex` on PATH really runs.
const { useFakeRuntime, fakeTarget } = await import("./runtime-fake.js");
const fakeBackend = await useFakeRuntime();
const directTarget = () => fakeTarget(fakeBackend, "codex-e2e-direct", { platform: "slack", channelId: "D_CODEX_DIRECT" });

const { saveSettings } = await import("../src/config/settings.js");
saveSettings({ engine: "codex", composioMode: "personal" });
const { setUser } = await import("../src/config/store.js");
const { processMessageEvent } = await import("../src/slack/message-pipeline.js");
const { runCodex } = await import("../src/engines/codex.js");

function fakeSlack() {
  const posted = [];
  let seq = 0;
  const ok = async () => ({ ok: true });
  const client = {
    posted,
    chat: { postMessage: async (m) => { posted.push(m); return { ok: true, ts: `bot.${++seq}` }; }, update: ok, postEphemeral: ok },
    users: { info: async ({ user }) => ({ user: { id: user, real_name: "Codex E2E" } }), list: async () => ({ members: [], response_metadata: {} }) },
    conversations: { history: async () => ({ messages: [] }), replies: async () => ({ messages: [], response_metadata: {} }) },
    apiCall: ok,
  };
  client.chatStream = ({ channel, thread_ts }) => {
    let streamed = "";
    return { ts: `stream.${++seq}`, append: async ({ markdown_text = "" }) => { streamed += markdown_text; }, stop: async ({ markdown_text = "" } = {}) => { posted.push({ channel, thread_ts, text: streamed + markdown_text }); return { ok: true }; } };
  };
  return client;
}

test("Codex stub covers Slack message→reply, persisted resume, and gateway MCP injection", async () => {
  await setUser("U_CODEX_E2E", { name: "Codex E2E", approved: true });
  const client = fakeSlack();
  const root = { type: "message", channel: "D_CODEX_E2E", channel_type: "im", user: "U_CODEX_E2E", text: "first Codex turn", ts: "2000.001" };
  await processMessageEvent(root, client, { botUserId: "U_BOT", teamId: "T_E2E" });
  await processMessageEvent({ ...root, text: "second Codex turn", ts: "2000.002", thread_ts: root.ts }, client, { botUserId: "U_BOT", teamId: "T_E2E" });
  const replies = client.posted.filter((m) => /Codex stub reply/.test(String(m.text || "")));
  assert.equal(replies.length, 2);
  assert.match(replies[0].text, /resume=no; gateway_mcp=yes/);
  assert.match(replies[1].text, /resume=yes; gateway_mcp=yes/);
  assert.equal(replies[0].thread_ts, root.ts);
  assert.equal(replies[1].thread_ts, root.ts);
});

test("Codex stub process is terminated when the run is cancelled", async () => {
  const controller = new AbortController();
  const target = directTarget();
  const pending = runCodex({ cwd: projectRoot, prompt: "CODEX_STUB_WAIT_FOR_CANCEL", sessionId: "", isNewSession: true, clean: true, timeoutMs: 10_000, signal: controller.signal, target, artifactDir: target.artifactDir });
  setTimeout(() => controller.abort(), 100).unref();
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, "AbortError");
    assert.match(error.message, /stopped before it finished/i);
    assert.doesNotMatch(error.message, /exit code|code \d+/i);
    return true;
  });
});

test("Codex generic process failures are semantic while the raw code stays structured", async () => {
  const target = directTarget();
  await assert.rejects(
    runCodex({ cwd: projectRoot, prompt: "CODEX_STUB_FAIL_GENERIC", sessionId: "", isNewSession: true, clean: true, timeoutMs: 1_000, target, artifactDir: target.artifactDir }),
    (error) => {
      assert.equal(error.message, "Codex failed because it reported a general error: stub failure detail");
      assert.equal(error.details?.exitCode, 1);
      assert.doesNotMatch(error.message, /exit code|code 1/i);
      return true;
    },
  );
});

test("the Codex runner takes the network switch as on/off and hands the process no proxy or domain list — the container is the boundary", async () => {
  const target = directTarget();
  const turn = (networkMode) => runCodex({
    cwd: projectRoot,
    prompt: `${networkMode} network turn`,
    sessionId: "",
    isNewSession: true,
    clean: true,
    writable: true,
    networkMode,
    timeoutMs: 10_000,
    target,
    artifactDir: target.artifactDir,
  });
  for (const networkMode of ["on", "off"]) {
    const result = await turn(networkMode);
    assert.match(result.content, /network_proxy=no; approved_domain=no/, `${networkMode}: nothing about egress reaches Codex's own config`);
  }
  // The host-sandbox tiers no longer exist: a caller that still names one is refused before spawn.
  await assert.rejects(turn("approved"), /Unknown Codex network mode/);
});

test("consecutive Codex message segments reach Slack as separate paragraphs", async () => {
  // Codex reports each assistant message as its own completed item, and the native Slack stream
  // shows exactly what the runner streamed — so without a boundary the reader gets
  // "…isolates conversations.ChannelGate isolates each…" in one run-on paragraph.
  const target = directTarget();
  let streamed = "";
  const result = await runCodex({
    cwd: projectRoot,
    prompt: "CODEX_STUB_TWO_SEGMENTS",
    sessionId: "",
    isNewSession: true,
    clean: true,
    timeoutMs: 10_000,
    target,
    artifactDir: target.artifactDir,
    onDelta: (text) => { streamed += text; },
  });

  assert.match(streamed, /isolates conversations\.\n\nChannelGate isolates each Slack channel/);
  // The authoritative final message (the -o file) is untouched by the boundary.
  assert.equal(result.content, "ChannelGate isolates each Slack channel in its own folder.");
});
