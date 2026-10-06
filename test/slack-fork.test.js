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
const runtime = await useFakeRuntime();
const { saveSettings } = await import("../src/config/settings.js");
const { setUser, getChannelEntry, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { getThreadEngine, getThreadModel, getThreadEffort, setThreadModel, setThreadEffort } = await import("../src/gateway/thread-engine.js");
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
    await processMessageEvent(event, client, { botUserId: "UBOT", teamId: "T_FORK" });
    const entry = await getChannelEntry(channel);
    const sourceId = await getSession(entry.slug, sourceTs);
    assert.ok(sourceId);
    await processMessageEvent({ ...event, ts: `${sourceTs.slice(0, 4)}.002`, thread_ts: sourceTs, text: "/fork Explore another solution" }, client, { botUserId: "UBOT", teamId: "T_FORK" });
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
    await processMessageEvent({ ...event, ts: "9000.002", thread_ts: childTs, text: "Continue the alternative" }, client, { botUserId: "UBOT", teamId: "T_FORK" });
    assert.equal(await getSession(entry.slug, childTs), childId, "follow-up resumes the forked session");
    assert.equal(await getSession(entry.slug, sourceTs), sourceId, "follow-up leaves source untouched");
  });
}

test("/fork without a completed source session refuses before posting a new Slack root", async () => {
  const user = "U_FORK_EMPTY";
  const channel = "D_FORK_EMPTY";
  await setUser(user, { name: "Fork User", approved: true });
  const client = slack();
  await processMessageEvent({ type: "message", channel, channel_type: "im", user, ts: "5000.001", text: "/fork Something new" }, client, { botUserId: "UBOT" });
  assert.ok(client.posted.some((m) => m.thread_ts === "5000.001" && /needs a completed/.test(m.text || "")));
  assert.equal(client.posted.some((m) => !m.thread_ts), false);
});

for (const engine of ["claude", "codex"]) {
  test(`${engine} /fork :shortcut selects the child's model and preserves the source pins`, async () => {
    const model = engine === "claude" ? "claude-opus-5-5" : "gpt-6-astra";
    const sourceModel = engine === "claude" ? "claude-sonnet-4-6" : "gpt-6.1-sol";
    saveSettings({ engine, modelShortcuts: { branch: { engine, model } }, engineEnabled: { claude: true, codex: true } });
    const user = `U_FORK_MODEL_${engine}`;
    const channel = `D_FORK_MODEL_${engine}`;
    await setUser(user, { name: "Fork User", approved: true });
    const client = slack();
    const event = { type: "message", channel, channel_type: "im", user, ts: "6000.001", text: "Source task" };
    await processMessageEvent(event, client, { botUserId: "UBOT" });
    const entry = await getChannelEntry(channel);
    const sourceId = await getSession(entry.slug, event.ts);
    await setThreadModel(entry.slug, event.ts, sourceModel);
    await setThreadEffort(entry.slug, event.ts, "high");
    const before = runtime.calls.spawn.length;
    await processMessageEvent({ ...event, ts: "6000.002", thread_ts: event.ts, text: "<@UBOT> /fork :BRANCH Explore another solution" }, client, { botUserId: "UBOT" });
    const childTs = client.posted.find((m) => /New request from/.test(m.text || ""))?.thread_ts;
    assert.ok(childTs);
    assert.equal(await getThreadEngine(entry.slug, childTs), engine);
    assert.equal(await getThreadModel(entry.slug, childTs), model);
    assert.equal(await getThreadEffort(entry.slug, childTs), "");
    assert.equal(await getThreadModel(entry.slug, event.ts), sourceModel);
    assert.equal(await getThreadEffort(entry.slug, event.ts), "high");
    assert.equal(await getSession(entry.slug, event.ts), sourceId);
    assert.notEqual(await getSession(entry.slug, childTs), sourceId);
    const spawn = runtime.calls.spawn.slice(before).find((call) => call.args.includes(engine === "claude" ? "--fork-session" : "fork"));
    assert.ok(spawn, "selected model still uses native fork");
    assert.ok(spawn.args.includes(model), "fork CLI receives the shortcut model");
    assert.ok(spawn.args.some((arg) => arg.includes("Explore another solution")));
    assert.ok(spawn.args.every((arg) => !arg.includes(":BRANCH")), "shortcut is removed from the engine request");
    assert.ok(client.posted.some((m) => m.thread_ts === childTs && /stub .*reply/i.test(m.text || "")));
    saveSettings({ modelShortcuts: { branch: { engine, model: sourceModel } } });
    await processMessageEvent({ ...event, ts: "6000.003", thread_ts: childTs, text: "Continue the alternative" }, client, { botUserId: "UBOT" });
    assert.equal(await getThreadModel(entry.slug, childTs), model, "repointing a shortcut does not change the resolved child pin");
  });
}

test("fork shortcut failures create no child thread or engine turn", async () => {
  saveSettings({ engine: "codex", modelChangeAccess: "users", engineEnabled: { claude: true, codex: true } });
  const user = "U_FORK_MODEL_GUARDS";
  const channel = "C_FORK_MODEL_GUARDS";
  await setUser(user, { name: "Fork User", approved: true, isAdmin: false });
  const client = slack();
  const registered = await upsertChannelEntry(channel, { name: "fork-model-guards", type: "channel", isDM: false });
  await saveChannelMeta(registered.slug, { channelId: channel, name: registered.name, type: "channel", isDM: false, template: "custom", allowedUsers: [user], engine: "codex" });
  const event = { type: "message", channel, channel_type: "channel", user, ts: "7000.001", text: "<@UBOT> Source task" };
  await processMessageEvent(event, client, { botUserId: "UBOT" });
  const entry = await getChannelEntry(channel);
  const sourceId = await getSession(entry.slug, event.ts);
  assert.ok(sourceId);
  await setThreadModel(entry.slug, event.ts, "gpt-6.1-sol");
  const cases = [
    { settings: { modelShortcuts: {} }, text: ":unknown New task", expected: /Unknown model shortcut/ },
    { settings: { modelShortcuts: { branch: { engine: "codex", model: "invalid" } } }, text: ":branch New task", expected: /enabled engine and valid model/ },
    { settings: { modelShortcuts: { branch: { engine: "codex", model: "gpt-6-astra" } }, engineEnabled: { claude: true, codex: false } }, text: ":branch New task", expected: /enabled engine and valid model/ },
    { settings: { modelShortcuts: { branch: { engine: "claude", model: "claude-opus-5-5" } }, engineEnabled: { claude: true, codex: true } }, text: ":branch New task", expected: /native fork must keep \*Codex\*/ },
    { settings: { modelShortcuts: { branch: { engine: "codex", model: "gpt-6-astra" } }, modelChangeAccess: "admins" }, text: ":branch New task", expected: /Only admins/ },
    { settings: { modelChangeAccess: "users" }, text: ":branch", expected: /Use `\/fork/ },
  ];
  let ts = 2;
  for (const scenario of cases) {
    saveSettings(scenario.settings);
    const before = runtime.calls.spawn.length;
    const count = client.posted.length;
    await processMessageEvent({ ...event, ts: `7000.00${ts++}`, thread_ts: event.ts, text: `<@UBOT> /fork ${scenario.text}` }, client, { botUserId: "UBOT" });
    assert.match(client.posted.at(-1).text, scenario.expected);
    assert.ok(client.posted.slice(count).every((m) => m.thread_ts === event.ts));
    assert.equal(runtime.calls.spawn.length, before);
    assert.equal(await getSession(entry.slug, event.ts), sourceId);
    assert.equal(await getThreadModel(entry.slug, event.ts), "gpt-6.1-sol");
  }
});
