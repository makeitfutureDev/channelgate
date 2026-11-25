// A subprocess enables Node's module mock for just the handler's runtime resolver. The native
// handler, transcript validation, session store and next-turn orchestrator all remain real.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv } from "../helpers.js";

ensureTestEnv();
process.env.PATH = `${new URL("./", import.meta.url).pathname}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
const actualResolver = await import("../../src/runtimes/resolve.js");
const { createFakeRuntimeBackend, fakeTarget } = await import("../runtime-fake.js");
const { saveSettings } = await import("../../src/config/settings.js");
const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../../src/config/store.js");
const { getSession, getSessionRuntime } = await import("../../src/gateway/sessions.js");
const { runMessage, setRuntimeResolver } = await import("../../src/gateway/run.js");
let resolver;
mock.module("../../src/runtimes/resolve.js", {
  namedExports: { ...actualResolver, resolveRuntime: (...args) => resolver(...args) },
});
const { processMessageEvent } = await import("../../src/slack/message-pipeline.js");

try {
  for (const engine of ["claude", "codex"]) {
    saveSettings({ engine, engineFallback: false, memoryReviewEvery: 0, composioMode: "personal", codexEnabled: true });
    const backend = createFakeRuntimeBackend();
    resolver = (slug, meta, options) => {
      const target = fakeTarget(backend, slug, meta, options);
      target.container.sharedHistory = true;
      return target;
    };
    setRuntimeResolver(resolver);
    const channel = `D_HANDLER_RESUME_${engine.toUpperCase()}`;
    const user = "U_HANDLER_RESUME_ADMIN";
    await setUser(user, { name: "Resume User", approved: true, isAdmin: true });
    const entry = await upsertChannelEntry(channel, { name: `handler-resume-${engine}`, type: "im", isDM: true });
    const meta = { channelId: channel, name: `handler-resume-${engine}`, type: "im", isDM: true, template: "custom", engine, allowedMcps: [], platform: "slack" };
    await saveChannelMeta(entry.slug, meta);
    const target = resolver(entry.slug, meta, { isAdminAuthor: true });
    mkdirSync(target.cwd, { recursive: true });
    const sessionId = engine === "claude" ? "abcdef12-aaaa-4bbb-8ccc-123456789abc" : "abcdef12-aaaa-4bbb-8ccc-123456789abd";
    backend.inspectState = async (_target, { globs }) => {
      const directory = engine === "claude" ? "/home/agent/.claude/projects/channel" : "/home/agent/.codex/sessions/2026/11/25";
      if (!globs.some((glob) => glob.includes(sessionId) && glob.includes(engine === "claude" ? ".claude" : ".codex"))) return [];
      return [{ path: `${directory}/${engine === "codex" ? "rollout-" : ""}${sessionId}.jsonl`, mtimeMs: Date.now(),
        head: [JSON.stringify(engine === "claude"
          ? { type: "user", sessionId, cwd: target.cwd, message: { role: "user", content: "native context" } }
          : { type: "session_meta", payload: { id: sessionId, cwd: target.cwd } })] }];
    };
    const posted = [];
    const client = {
      chat: { postMessage: async (message) => { posted.push(message); return { ok: true, ts: "2000.001" }; } },
      users: { info: async () => ({ user: { id: user, real_name: "Resume User" } }) },
      conversations: { replies: async () => ({ ok: true, messages: [] }) },
    };
    const threadKey = "1000.001";
    await processMessageEvent({ type: "message", channel, channel_type: "im", user, thread_ts: threadKey, ts: "1000.002", text: `/resume ${sessionId}` }, client, { botUserId: "UBOT" });
    assert.ok(posted.some((message) => message.text.includes(`session \`${sessionId}\``)), `${engine}: adoption acknowledged`);
    assert.equal(await getSession(entry.slug, threadKey), sessionId);
    assert.equal((await getSessionRuntime(entry.slug, threadKey)).history, "channel-v1", `${engine}: native command stamps shared history`);
    const next = await runMessage({ channelId: channel, authorId: user, text: "Continue the native conversation", threadKey, origin: "slack_foreground", preferCold: true });
    assert.equal(next.sessionId, sessionId, `${engine}: native handler adoption survives the next turn`);
    assert.equal(backend.calls.spawn.length, 1);
    const args = backend.calls.spawn[0].args;
    assert.ok(args.includes(sessionId));
    assert.ok(args.includes(engine === "claude" ? "-r" : "resume"));
  }
} finally {
  setRuntimeResolver(null);
  mock.restoreAll();
}
