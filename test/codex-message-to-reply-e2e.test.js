import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, tempDir } from "./helpers.js";

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

// SLK-203. Two subagents left ONE anonymous `wait_agent` row on the card while Claude's equivalent
// turn showed a named row per child. The cause is upstream and not a parsing slip: `codex exec
// --json` (CLI 0.153.4, multi-agent v2) never puts child identity on stdout — no spawn call, no
// SubAgentActivity item, empty `receiver_thread_ids`/`agents_states` on the only `wait` item it
// sends. The children's own rollout files are where their identity lives, so the runner reads them.
test("Codex subagents each get a named card row, read from their own rollouts", async () => {
  const { mkdirSync: mkdirs, writeFileSync: writeText } = await import("node:fs");
  const stateDir = path.join(tempDir("cg-codex-subagents-"), ".codex");
  const day = path.join(stateDir, "sessions", "2026", "09", "07");
  mkdirs(day, { recursive: true });
  const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
  const seconds = (offsetMs) => Math.floor((Date.now() + offsetMs) / 1000);
  // A child rollout, verbatim in shape: `session_meta` names the child (`agent_path`,
  // `agent_nickname`) and its parent, then its own task boundary and token counts.
  const childRollout = (id, agentPath, nickname, tokens) => [
    JSON.stringify({ timestamp: iso(5), type: "session_meta", payload: {
      session_id: "codex-stub-subagents", id, parent_thread_id: "codex-stub-subagents", forked_from_id: "codex-stub-subagents",
      timestamp: iso(5), originator: "codex_exec", thread_source: "subagent", agent_path: agentPath, agent_nickname: nickname,
      source: { subagent: { thread_spawn: { parent_thread_id: "codex-stub-subagents", depth: 1, agent_path: agentPath, agent_nickname: nickname, agent_role: null } } },
    } }),
    JSON.stringify({ timestamp: iso(6), type: "turn_context", payload: { model: "gpt-5.6-codex" } }),
    JSON.stringify({ timestamp: iso(6), type: "event_msg", payload: { type: "task_started", started_at: seconds(6) } }),
    JSON.stringify({ timestamp: iso(20), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: tokens, output_tokens: 10 }, last_token_usage: { input_tokens: tokens, output_tokens: 10 } } } }),
    JSON.stringify({ timestamp: iso(30), type: "event_msg", payload: { type: "task_complete" } }),
  ].join("\n") + "\n";
  writeText(path.join(day, "rollout-2026-09-07T02-41-56-codex-stub-subagents.jsonl"), `${JSON.stringify({ timestamp: iso(0), type: "session_meta", payload: { id: "codex-stub-subagents", timestamp: iso(0) } })}\n`);
  writeText(path.join(day, "rollout-2026-09-07T02-42-18-child-sandbox.jsonl"), childRollout("child-sandbox", "/root/sandbox_reviewer", "Ohm", 4_000));
  writeText(path.join(day, "rollout-2026-09-07T02-42-23-child-connector.jsonl"), childRollout("child-connector", "/root/connector_reviewer", "Dewey", 6_000));

  const target = directTarget();
  const events = [];
  const result = await runCodex({
    cwd: projectRoot,
    prompt: "CODEX_STUB_SUBAGENTS",
    sessionId: "",
    isNewSession: true,
    clean: true,
    timeoutMs: 10_000,
    target,
    artifactDir: target.artifactDir,
    codexStateDir: stateDir,
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.content, "Both reviews are in.");

  const agents = events.filter((event) => event.kind === "agent_activity");
  // Live first: the coordination item is the cue to go and find out who is working.
  const running = agents.filter((event) => event.status === "running");
  assert.deepEqual(running.map((event) => event.name).sort(), ["connector_reviewer", "sandbox_reviewer"]);
  // Then the terminal rows, with the metrics only the rollouts carry.
  const done = agents.filter((event) => event.status === "completed");
  assert.deepEqual(done.map((event) => event.name).sort(), ["connector_reviewer", "sandbox_reviewer"]);
  assert.ok(done.every((event) => event.elapsedMs > 0 && event.tokens > 0), "each child reports how long it ran and what it spent");
  // A child's row is keyed on its own thread id, so the live row and the terminal one are one row.
  assert.deepEqual([...new Set(agents.map((event) => event.id))].sort(), ["child-connector", "child-sandbox"]);
  // Every "running" announcement lands before the "completed" one that closes the same row.
  assert.ok(agents.findIndex((event) => event.status === "completed") > agents.findLastIndex((event) => event.status === "running"));
  // The coordination step stays visible as its own tool row — it is what the model actually called.
  assert.ok(events.some((event) => event.kind === "tool_use" && event.name === "wait_agent"));
  // The subagents are still billed: identity rides along with the accounting, it does not replace it.
  assert.deepEqual(result.usageAccounting.children.map((child) => child.name).sort(), ["connector_reviewer", "sandbox_reviewer"]);
});
