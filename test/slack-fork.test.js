import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.env.PATH = `${path.join(projectRoot, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
process.env.PROGRESS_VIEW = "shimmer";
const { useFakeRuntime } = await import("./runtime-fake.js");
await useFakeRuntime();
const { saveSettings } = await import("../src/config/settings.js");
const { setUser, getChannelEntry } = await import("../src/config/store.js");
const { getSession, getSessionEngine } = await import("../src/gateway/sessions.js");
const { buildClaudeArgs } = await import("../src/engines/claude.js");
const { buildCodexArgs } = await import("../src/engines/codex.js");
const { createFakeRuntime } = await import("./fixtures/fake-runtime-backend.js");
const { parseSlashCommand } = await import("../src/slack/message-normalize.js");
const { processMessageEvent } = await import("../src/slack/message-pipeline.js");

function slack() {
  const posted = [];
  let nextTs = 2000;
  const ok = async () => ({ ok: true });
  return {
    posted,
    chat: {
      postMessage: async (message) => {
        posted.push(message);
        return { ok: true, ts: `${++nextTs}.001` };
      },
      getPermalink: async ({ channel, message_ts }) => ({ permalink: `https://slack.test/archives/${channel}/p${String(message_ts).replace(".", "")}` }),
      update: ok,
      postEphemeral: ok,
    },
    users: { info: async ({ user }) => ({ user: { id: user, real_name: "Fork User" } }), list: async () => ({ members: [], response_metadata: {} }) },
    conversations: { history: async () => ({ messages: [] }), replies: async () => ({ messages: [], response_metadata: {} }) },
    apiCall: ok,
  };
}

test("fork command preserves its message and both CLIs receive their native fork flags", () => {
  assert.deepEqual(parseSlashCommand("/fork investigate the other approach"), { cmd: "fork", arg: "investigate the other approach" });
  const claude = buildClaudeArgs({ prompt: "new request", sessionId: "child", isNewSession: true, forkSourceSessionId: "parent" });
  assert.deepEqual(claude.slice(claude.indexOf("-r"), claude.indexOf("-r") + 3), ["-r", "parent", "--fork-session"]);
  assert.ok(!claude.includes("--session-id"));
  const target = createFakeRuntime().target();
  const codex = buildCodexArgs({ prompt: "new request", sessionId: "child", isNewSession: true, forkSourceSessionId: "parent", cwd: target.cwd, target, outFile: `${target.artifactDir}/fork-answer` });
  assert.deepEqual(codex.slice(0, 3), ["exec", "fork", "parent"]);
  assert.ok(!codex.includes("-C"), "fork uses the process cwd like resume");
  assert.ok(codex.includes("--ignore-user-config"));
});

for (const engine of ["claude", "codex"]) {
  test(`${engine} /fork creates a linked Slack root and distinct resumable engine session`, async () => {
    saveSettings({ engine, composioMode: "personal" });
    const user = `U_FORK_${engine.toUpperCase()}`;
    const channel = `D_FORK_${engine.toUpperCase()}`;
    await setUser(user, { name: "Fork User", approved: true });
    const client = slack();
    const sourceTs = engine === "claude" ? "1000.001" : "1001.001";
    const event = { type: "message", channel, channel_type: "im", user, ts: sourceTs, text: "Source task" };
    await processMessageEvent(event, client, { botUserId: "U_BOT", teamId: "T_FORK" });
    const entry = await getChannelEntry(channel);
    const sourceId = await getSession(entry.slug, sourceTs);
    assert.ok(sourceId);
    await processMessageEvent({ ...event, ts: `${sourceTs.slice(0, 4)}.002`, thread_ts: sourceTs, text: "/fork Explore another solution" }, client, { botUserId: "U_BOT", teamId: "T_FORK" });
    const root = client.posted.find((m) => !m.thread_ts && /Fork of/.test(m.text || ""));
    assert.ok(root, "fork gets a new top-level Slack message");
    const forkTs = client.posted.find((m) => m.thread_ts === sourceTs && /Fork started/.test(m.text || ""))?.text.match(/p(\d+)/)?.[1];
    assert.ok(forkTs, "source thread links to child");
    const childTs = `${forkTs.slice(0, -3)}.${forkTs.slice(-3)}`;
    assert.ok(client.posted.some((m) => m.thread_ts === childTs && /New request from/.test(m.text || "") && /Explore another solution/.test(m.text || "")));
    const childId = await getSession(entry.slug, childTs);
    assert.ok(childId);
    assert.notEqual(childId, sourceId, "fork must not resume or overwrite the original session");
    assert.equal(await getSession(entry.slug, sourceTs), sourceId);
    assert.equal(await getSessionEngine(entry.slug, childTs), engine);
    assert.ok(client.posted.some((m) => m.thread_ts === childTs && /stub .*reply/i.test(m.text || "")), "new request is answered in child thread");
    await processMessageEvent({ ...event, ts: "9000.002", thread_ts: childTs, text: "Continue the alternative" }, client, { botUserId: "U_BOT", teamId: "T_FORK" });
    assert.equal(await getSession(entry.slug, childTs), childId, "follow-up resumes the forked session");
    assert.equal(await getSession(entry.slug, sourceTs), sourceId, "follow-up leaves source untouched");
  });
}

test("/fork without a completed source session refuses before posting a new Slack root", async () => {
  const user = "U_FORK_EMPTY";
  const channel = "D_FORK_EMPTY";
  await setUser(user, { name: "Fork User", approved: true });
  const client = slack();
  await processMessageEvent({ type: "message", channel, channel_type: "im", user, ts: "5000.001", text: "/fork Something new" }, client, { botUserId: "U_BOT" });
  assert.ok(client.posted.some((m) => m.thread_ts === "5000.001" && /needs a completed/.test(m.text || "")));
  assert.equal(client.posted.some((m) => !m.thread_ts), false);
});
