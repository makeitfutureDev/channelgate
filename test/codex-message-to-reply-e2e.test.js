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
  const pending = runCodex({ cwd: projectRoot, prompt: "CODEX_STUB_WAIT_FOR_CANCEL", sessionId: "", isNewSession: true, clean: true, timeoutMs: 10_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 100).unref();
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, "AbortError");
    assert.match(error.message, /stopped before it finished/i);
    assert.doesNotMatch(error.message, /exit code|code \d+/i);
    return true;
  });
});

test("Codex generic process failures are semantic while the raw code stays structured", async () => {
  await assert.rejects(
    runCodex({ cwd: projectRoot, prompt: "CODEX_STUB_FAIL_GENERIC", sessionId: "", isNewSession: true, clean: true, timeoutMs: 1_000 }),
    (error) => {
      assert.equal(error.message, "Codex failed because it reported a general error: stub failure detail");
      assert.equal(error.details?.exitCode, 1);
      assert.doesNotMatch(error.message, /exit code|code 1/i);
      return true;
    },
  );
});

test("Codex runner checks compatibility and carries approved-domain confinement to the process", async () => {
  const result = await runCodex({
    cwd: projectRoot,
    prompt: "approved network turn",
    sessionId: "",
    isNewSession: true,
    clean: true,
    writable: true,
    networkMode: "approved",
    networkDomains: ["api.github.com"],
    timeoutMs: 10_000,
  });
  assert.match(result.content, /network_proxy=yes; approved_domain=yes/);
});
