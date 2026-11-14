import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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
const { getThreadEngine, getThreadModel, getThreadEffort, getThreadClean, setThreadModel, setThreadEffort, setThreadClean } = await import("../src/gateway/thread-engine.js");
const { getSession, getSessionEngine, saveSession } = await import("../src/gateway/sessions.js");
const { codexEuLoginHome } = await import("../src/engines/codex-eu.js");
const { buildClaudeArgs } = await import("../src/engines/claude.js");
const { buildCodexArgs } = await import("../src/engines/codex.js");
const { createFakeRuntime } = await import("./fixtures/fake-runtime-backend.js");
const { parseSlashCommand } = await import("../src/slack/message-normalize.js");
const { getSlackThread } = await import("../src/gateway/slack-threads.js");
const { processMessageEvent, runQueue, abortRunsInChannel } = await import("../src/slack/message-pipeline.js");
const { runMessage } = await import("../src/gateway/run.js");

// Dedicated scratch login so individual EU test cases also work with --test-name-pattern.
const euClaims = { exp: Math.floor(Date.now() / 1000) + 864000, "https://api.openai.com/auth": { chatgpt_account_id: "fork-eu-fixture" } };
const euAccessToken = `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(euClaims)).toString("base64url")}.fixture`;
mkdirSync(codexEuLoginHome(), { recursive: true });
writeFileSync(path.join(codexEuLoginHome(), "auth.json"), JSON.stringify({ tokens: { access_token: euAccessToken, refresh_token: "fixture-refresh", account_id: "fork-eu-fixture" } }), { mode: 0o600 });

function slack() {
  const posted = [], apiCalls = [];
  let nextTs = 2000;
  const ok = async () => ({ ok: true });
  return {
    posted, apiCalls,
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
    apiCall: async (method, payload) => { apiCalls.push([method, payload]); return { ok: true }; },
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

for (const engine of ["claude", "codex", "codex-eu"]) {
  test(`${engine} /fork creates a linked Slack root and distinct resumable engine session`, async () => {
    saveSettings({ engine, composioMode: "personal", engineEnabled: { claude: true, codex: true, "codex-eu": true } });
    const user = `U_FORK_${engine.toUpperCase()}`;
    const channel = `D_FORK_${engine.toUpperCase()}`;
    await setUser(user, { name: "Fork User", approved: true });
    const client = slack();
    const sourceTs = { claude: "1000.001", codex: "1001.001", "codex-eu": "1002.001" }[engine];
    const event = { type: "message", channel, channel_type: "im", user, ts: sourceTs, text: "Source task" };
    await processMessageEvent(event, client, { botUserId: "UBOT", teamId: "T_FORK" });
    const entry = await getChannelEntry(channel);
    const sourceId = await getSession(entry.slug, sourceTs);
    assert.ok(sourceId);
    assert.equal(await getSessionEngine(entry.slug, sourceTs), engine);
    const beforeFork = runtime.calls.spawn.length;
    await processMessageEvent({ ...event, ts: `${sourceTs.slice(0, 4)}.002`, thread_ts: sourceTs, text: "/fork Explore another solution" }, client, { botUserId: "UBOT", teamId: "T_FORK" });
    const root = client.posted.find((m) => !m.thread_ts && /Fork:/.test(m.text || ""));
    assert.ok(root, "fork gets a new top-level Slack message");
    assert.equal(root.text, `↪️ <@${user}> Fork: Explore another solution`);
    assert.equal(root.unfurl_links, false);
    assert.equal(root.unfurl_media, false);
    assert.ok(!root.text.includes("https://"), "channel root has no source link preview");
    const forkTs = client.posted.find((m) => m.thread_ts === sourceTs && /Fork started/.test(m.text || ""))?.text.match(/p(\d+)/)?.[1];
    assert.ok(forkTs, "source thread links to child");
    const childTs = `${forkTs.slice(0, -3)}.${forkTs.slice(-3)}`;
    const activity = getSlackThread(channel, childTs);
    assert.equal(activity.starter_id, user, "fork Activity row belongs to its requester");
    assert.equal(activity.title, "↪️ Fork User Fork: Explore another solution", "Activity uses the new root label with its creator's name");
    assert.ok(client.apiCalls.some(([method, payload]) => method === "agents.sessions.rename"
      && payload.thread_ts === childTs && payload.title === activity.title), "the new Slack session gets the same child title");
    assert.equal(activity.fork_source_ts, sourceTs);
    assert.equal(activity.fork_bot_user_id, "UBOT");
    assert.equal(activity.agent_engaged, 1);
    const firstReply = client.posted.find((m) => m.thread_ts === childTs);
    assert.equal(firstReply.text, `↪️ Fork of <https://slack.test/archives/${channel}/p${sourceTs.replace(".", "")}|this thread>`);
    assert.equal(firstReply.unfurl_links, false);
    assert.equal(firstReply.unfurl_media, false);
    assert.ok(!client.posted.some((m) => /New request from/.test(m.text || "")), "request is not duplicated in replies");
    const childId = await getSession(entry.slug, childTs);
    assert.ok(childId);
    assert.notEqual(childId, sourceId, "fork must not resume or overwrite the original session");
    assert.equal(await getSession(entry.slug, sourceTs), sourceId);
    assert.equal(await getSessionEngine(entry.slug, childTs), engine);
    if (engine === "codex-eu") {
      const forkSpawn = runtime.calls.spawn.slice(beforeFork).find(call => call.args.includes("fork"));
      assert.ok(forkSpawn?.args.includes(sourceId), "EU forks the actual source session");
      assert.equal(forkSpawn.env.CODEX_HOME, "/home/agent/.codex-eu", "EU fork stays in its isolated login/state home");
    }
    assert.ok(client.posted.some((m) => m.thread_ts === childTs && /stub .*reply/i.test(m.text || "")), "new request is answered in child thread");
    const beforeFollowup = runtime.calls.spawn.length;
    await processMessageEvent({ ...event, ts: "9000.002", thread_ts: childTs, text: "Continue the alternative" }, client, { botUserId: "UBOT", teamId: "T_FORK" });
    assert.equal(await getSession(entry.slug, childTs), childId, "follow-up resumes the forked session");
    assert.equal(await getSession(entry.slug, sourceTs), sourceId, "follow-up leaves source untouched");
    if (engine === "codex-eu") {
      const resumeSpawn = runtime.calls.spawn.slice(beforeFollowup).find(call => call.args.includes(childId));
      assert.ok(resumeSpawn?.args.includes("resume"), "EU follow-up resumes the child");
      assert.equal(resumeSpawn.env.CODEX_HOME, "/home/agent/.codex-eu");
    }
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

for (const engine of ["qwen", "qwen-eu", "opencode", "unknown-engine"]) {
  test(`/fork explains unsupported ${engine} sessions without creating a child`, async () => {
    const user = `U_FORK_UNSUPPORTED_${engine}`;
    const channel = `D_FORK_UNSUPPORTED_${engine}`;
    await setUser(user, { name: "Fork User", approved: true });
    const entry = await upsertChannelEntry(channel, { name: `unsupported-${engine}`, isDM: true, type: "im" });
    await saveSession(entry.slug, "5100.001", "unsupported-source", engine, null, JSON.stringify({ backend: "container", scope: "project" }));
    const client = slack();
    const before = runtime.calls.spawn.length;
    await processMessageEvent({ type: "message", channel, channel_type: "im", user, thread_ts: "5100.001", ts: "5100.002", text: "/fork Another approach" }, client, { botUserId: "UBOT" });
    assert.ok(client.posted.some(message => /does not support session forks/.test(message.text || "")));
    assert.equal(client.posted.some(message => !message.thread_ts), false);
    assert.equal(runtime.calls.spawn.length, before);
    assert.equal(await getSession(entry.slug, "5100.001"), "unsupported-source");
  });
}

for (const [name, runtimeStamp, refusal] of [
  ["host", { backend: "host", scope: "project" }, /history is outside the channel container/],
  ["admin scope", { backend: "container", scope: "admin" }, /under your own access level/],
]) {
  test(`Codex EU /fork still rejects a source from ${name}`, async () => {
    const user = `U_FORK_EU_GUARD_${runtimeStamp.backend}`;
    const channel = `D_FORK_EU_GUARD_${runtimeStamp.backend}`;
    await setUser(user, { name: "Fork User", approved: true });
    const entry = await upsertChannelEntry(channel, { name: `eu-guard-${runtimeStamp.backend}`, isDM: true, type: "im" });
    await saveSession(entry.slug, "5200.001", "eu-guard-source", "codex-eu", null, JSON.stringify(runtimeStamp));
    const client = slack();
    const before = runtime.calls.spawn.length;
    await processMessageEvent({ type: "message", channel, channel_type: "im", user, thread_ts: "5200.001", ts: "5200.002", text: "/fork Another approach" }, client, { botUserId: "UBOT" });
    assert.ok(client.posted.some(message => refusal.test(message.text || "")));
    assert.equal(client.posted.some(message => !message.thread_ts), false);
    assert.equal(runtime.calls.spawn.length, before);
    assert.equal(await getSession(entry.slug, "5200.001"), "eu-guard-source");
  });
}

test("disabled EU source refuses before child creation and cannot substitute another login at run admission", async () => {
  saveSettings({ engine: "claude", engineEnabled: { claude: true, codex: true, "codex-eu": false } });
  const user = "U_FORK_DISABLED_EU", channel = "D_FORK_DISABLED_EU";
  await setUser(user, { name: "Fork User", approved: true });
  const entry = await upsertChannelEntry(channel, { name: "disabled-eu", isDM: true, type: "im" });
  await saveSession(entry.slug, "5300.001", "disabled-eu-source", "codex-eu", null, JSON.stringify({ backend: "container", scope: "project" }));
  const client = slack();
  const before = runtime.calls.spawn.length;
  await processMessageEvent({ type: "message", channel, channel_type: "im", user, thread_ts: "5300.001", ts: "5300.002", text: "/fork Another approach" }, client, { botUserId: "UBOT" });
  assert.ok(client.posted.some(message => /Codex EU is disabled/.test(message.text || "")));
  assert.equal(client.posted.some(message => !message.thread_ts), false);
  // Simulate a recovered child, or a disable between preparation and run admission.
  const result = await runMessage({ channelId: channel, authorId: user, threadKey: "5300.003", text: "Recovered fork", origin: "recovery", overrides: { engine: "codex-eu" }, forkSourceSessionId: "disabled-eu-source" });
  assert.equal(result.engineRefused, true);
  assert.equal(result.engine, "codex-eu");
  assert.match(result.content, /disabled/);
  assert.equal(runtime.calls.spawn.length, before, "no source ID is sent to a substitute engine");
  assert.equal(await getSession(entry.slug, "5300.001"), "disabled-eu-source");
});

for (const engine of ["claude", "codex"]) for (const effort of ["", "low"]) {
  test(`${engine} /fork :shortcut ${effort || "without effort"} selects the child's model and preserves the source pins`, async () => {
    const model = engine === "claude" ? "claude-opus-5-5" : "gpt-6-astra";
    const sourceModel = engine === "claude" ? "claude-sonnet-4-6" : "gpt-6.1-sol";
    saveSettings({ engine, modelShortcuts: { branch: { engine, model } }, engineEnabled: { claude: true, codex: true } });
    const user = `U_FORK_MODEL_${engine}_${effort}`;
    const channel = `D_FORK_MODEL_${engine}_${effort}`;
    await setUser(user, { name: "Fork User", approved: true });
    const client = slack();
    const event = { type: "message", channel, channel_type: "im", user, ts: "6000.001", text: "Source task" };
    await processMessageEvent(event, client, { botUserId: "UBOT" });
    const entry = await getChannelEntry(channel);
    const sourceId = await getSession(entry.slug, event.ts);
    await setThreadModel(entry.slug, event.ts, sourceModel);
    await setThreadEffort(entry.slug, event.ts, "high");
    const before = runtime.calls.spawn.length;
    await processMessageEvent({ ...event, ts: "6000.002", thread_ts: event.ts, text: `<@UBOT> /fork :BRANCH ${effort ? ":LOW " : ""}Explore another solution` }, client, { botUserId: "UBOT" });
    const childTs = client.posted.find((m) => /↪️ Fork of/.test(m.text || ""))?.thread_ts;
    assert.ok(childTs);
    assert.equal(await getThreadEngine(entry.slug, childTs), engine);
    assert.equal(await getThreadModel(entry.slug, childTs), model);
    assert.equal(await getThreadEffort(entry.slug, childTs), effort);
    assert.equal(await getThreadModel(entry.slug, event.ts), sourceModel);
    assert.equal(await getThreadEffort(entry.slug, event.ts), "high");
    assert.equal(await getSession(entry.slug, event.ts), sourceId);
    assert.notEqual(await getSession(entry.slug, childTs), sourceId);
    const spawn = runtime.calls.spawn.slice(before).find((call) => call.args.includes(engine === "claude" ? "--fork-session" : "fork"));
    assert.ok(spawn, "selected model still uses native fork");
    assert.ok(spawn.args.includes(model), "fork CLI receives the shortcut model");
    if (effort && engine === "codex") assert.ok(spawn.args.includes('model_reasoning_effort="low"'));
    if (effort && engine === "claude") assert.equal(spawn.args[spawn.args.indexOf("--effort") + 1], "low");
    assert.ok(spawn.args.every(arg => !arg.includes(":LOW")), "effort selector is removed from the engine request");
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
    { settings: { modelShortcuts: { branch: { engine: "codex", model: "gpt-6-astra" } } }, text: ":branch :bogus New task", expected: /Invalid effort/ },
    { settings: { modelShortcuts: {} }, text: ":unknown New task", expected: /Unknown model shortcut/ },
    { settings: { modelShortcuts: { branch: { engine: "codex", model: "invalid" } } }, text: ":branch New task", expected: /enabled engine and valid model/ },
    { settings: { modelShortcuts: { branch: { engine: "codex", model: "gpt-6-astra" } }, engineEnabled: { claude: true, codex: false } }, text: ":branch New task", expected: /enabled engine and valid model/ },
    { settings: { modelShortcuts: { branch: { engine: "claude", model: "claude-opus-5-5" } }, engineEnabled: { claude: true, codex: true } }, text: ":branch New task", expected: /could not read the source thread/ },
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

for (const [sourceEngine, childEngine] of [["claude", "codex"], ["codex", "claude"], ["codex-eu", "codex"], ["codex", "codex-eu"]]) {
  test(`${sourceEngine} /fork to ${childEngine} starts fresh with source Slack history`, async () => {
    const model = childEngine === "claude" ? "claude-opus-5-5" : "gpt-6-astra";
    saveSettings({ engine: sourceEngine, engineEnabled: { claude: true, codex: true, "codex-eu": true }, modelShortcuts: { other: { engine: childEngine, model } } });
    const user = `U_FORK_HANDOFF_${sourceEngine}_${childEngine}`;
    const channel = `D_FORK_HANDOFF_${sourceEngine}_${childEngine}`;
    await setUser(user, { name: "Fork User", approved: true });
    const client = slack();
    const event = { type: "message", channel, channel_type: "im", user, ts: "8000.001", text: "Remember FORK-HISTORY-42" };
    await processMessageEvent(event, client, { botUserId: "UBOT" });
    const entry = await getChannelEntry(channel);
    const sourceId = await getSession(entry.slug, event.ts);
    const sourceModel = sourceEngine === "claude" ? "claude-sonnet-4-6" : "gpt-6.1-sol";
    await setThreadModel(entry.slug, event.ts, sourceModel);
    await setThreadEffort(entry.slug, event.ts, "high");
    const historyCalls = [];
    client.conversations.replies = async (args) => {
      historyCalls.push(args);
      return { messages: [
        { user, ts: event.ts, text: "Remember FORK-HISTORY-42" },
        { user: "UBOT", ts: "8000.002", text: "Our decision was to use SQLite." },
        { user, ts: "8000.003", text: "/fork :other Continue the decision" },
        { user, ts: "8000.004", text: "FUTURE-MESSAGE-MUST-NOT-TRANSFER" },
      ], response_metadata: {} };
    };
    const before = runtime.calls.spawn.length;
    await processMessageEvent({ ...event, ts: "8000.003", thread_ts: event.ts, text: "<@UBOT> /fork :other Continue the decision" }, client, { botUserId: "UBOT" });
    const childTs = client.posted.find((m) => /↪️ Fork of/.test(m.text || ""))?.thread_ts;
    assert.ok(childTs);
    assert.ok(client.posted.some((m) => !m.thread_ts && m.text === `↪️ <@${user}> Fork: Continue the decision`));
    assert.ok(client.posted.some((m) => m.thread_ts && /^↪️ Fork of <.*from Slack history/.test(m.text || "")));
    assert.equal(await getSessionEngine(entry.slug, childTs), childEngine);
    assert.equal(await getThreadModel(entry.slug, childTs), model);
    assert.equal(await getThreadEffort(entry.slug, childTs), "");
    const childId = await getSession(entry.slug, childTs);
    assert.ok(childId);
    assert.notEqual(childId, sourceId);
    const spawn = runtime.calls.spawn.slice(before).find((call) => call.args.includes(model));
    assert.ok(spawn);
    assert.ok(!spawn.args.includes("fork") && !spawn.args.includes("--fork-session") && !spawn.args.includes("resume") && !spawn.args.includes("-r"), "other engine starts fresh");
    assert.ok(!spawn.args.includes(sourceId), "source session ID never reaches the other CLI");
    if (sourceEngine === "codex-eu" || childEngine === "codex-eu") {
      assert.equal(spawn.env.CODEX_HOME, childEngine === "codex-eu" ? "/home/agent/.codex-eu" : "/home/agent/.codex", "handoff uses the destination's own state home");
    }
    const prompt = spawn.args.find((arg) => arg.includes("Continue the decision"));
    assert.match(prompt, /FORK-HISTORY-42/);
    assert.match(prompt, /Our decision was to use SQLite/);
    assert.match(prompt, /https:\/\/slack.test\/archives\//);
    assert.doesNotMatch(prompt, /:other|FUTURE-MESSAGE-MUST-NOT-TRANSFER/);
    assert.deepEqual(historyCalls.filter((call) => call.limit === 200).map((call) => call.ts), [event.ts], "only the source thread is replayed");
    const followupStart = runtime.calls.spawn.length;
    await processMessageEvent({ ...event, ts: "8001.001", thread_ts: childTs, text: "Keep going" }, client, { botUserId: "UBOT" });
    assert.equal(await getSession(entry.slug, childTs), childId);
    assert.equal(await getSession(entry.slug, event.ts), sourceId);
    assert.equal(await getSessionEngine(entry.slug, event.ts), sourceEngine);
    assert.equal(await getThreadModel(entry.slug, event.ts), sourceModel);
    assert.equal(await getThreadEffort(entry.slug, event.ts), "high");
    assert.equal(historyCalls.filter((call) => call.limit === 200).length, 1, "child follow-up resumes without replaying the source again");
    assert.ok(runtime.calls.spawn.slice(followupStart).some((call) => call.args.includes(childId)));
  });
}

test("another-engine fork respects clean mode and a dedicated channel Codex login", async () => {
  saveSettings({ engine: "codex", modelChangeAccess: "users", engineEnabled: { claude: true, codex: true }, modelShortcuts: { other: { engine: "claude", model: "claude-opus-5-5" } } });
  const user = "U_FORK_CLEAN_HANDOFF";
  const channel = "D_FORK_CLEAN_HANDOFF";
  await setUser(user, { name: "Fork User", approved: true });
  const client = slack();
  const event = { type: "message", channel, channel_type: "im", user, ts: "8100.001", text: "Source task" };
  await processMessageEvent(event, client, { botUserId: "UBOT" });
  const entry = await getChannelEntry(channel);
  await setThreadClean(entry.slug, event.ts, true);
  let historyReads = 0;
  client.conversations.replies = async (args) => {
    if (args.limit === 200) { historyReads++; throw new Error("clean fork must not replay history"); }
    return { messages: [], response_metadata: {} };
  };
  const before = runtime.calls.spawn.length;
  await processMessageEvent({ ...event, ts: "8100.002", thread_ts: event.ts, text: "/fork :other Clean alternative" }, client, { botUserId: "UBOT" });
  const childTs = client.posted.find((m) => /↪️ Fork of/.test(m.text || ""))?.thread_ts;
  assert.ok(childTs);
  assert.equal(await getThreadClean(entry.slug, childTs), true);
  assert.ok(client.posted.some((m) => /clean session; no history replay/.test(m.text || "")));
  const prompt = runtime.calls.spawn.slice(before).flatMap((call) => call.args).find((arg) => arg.includes("Clean alternative"));
  assert.ok(prompt);
  assert.doesNotMatch(prompt, /Thread context|Source task|Source thread:/);
  assert.equal(historyReads, 0);
  await saveChannelMeta(entry.slug, { channelId: channel, name: entry.name, type: "im", isDM: true, codexAuthSource: "channel", engine: "codex" });
  const count = client.posted.length;
  const spawns = runtime.calls.spawn.length;
  await processMessageEvent({ ...event, ts: "8100.003", thread_ts: event.ts, text: "/fork :other Another harness" }, client, { botUserId: "UBOT" });
  assert.ok(client.posted.slice(count).some((m) => /Fork of/.test(m.text || "")));
  assert.ok(runtime.calls.spawn.length > spawns);
});

async function until(check) {
  for (let n = 0; n < 200; n++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for queued fork");
}

for (const engine of ["claude", "codex", "codex-eu"]) {
  test(`${engine} busy /fork queues, waits, forks once and releases source ownership`, async () => {
    saveSettings({ engine, engineEnabled: { claude: true, codex: true, "codex-eu": true } });
    const user = `U_QUEUE_FORK_${engine}`;
    const channel = `D_QUEUE_FORK_${engine}`;
    await setUser(user, { name: "Queued Fork", approved: true });
    const client = slack();
    const event = { type: "message", channel, channel_type: "im", user, ts: "9200.001", text: "Source task" };
    await processMessageEvent(event, client, { botUserId: "UBOT" });
    const entry = await getChannelEntry(channel);
    const sourceId = await getSession(entry.slug, event.ts);
    const key = `${entry.slug}::${event.ts}`;
    const source = { aborted: false, controller: new AbortController(), authorId: user };
    await runQueue.acquire(key, source);
    const before = runtime.calls.spawn.length;
    const fork = processMessageEvent({ ...event, ts: "9200.002", thread_ts: event.ts, text: "/fork Queued alternative" }, client, { botUserId: "UBOT" });
    try {
      await until(() => client.posted.some((m) => /Fork queued/.test(m.text || "")));
      assert.equal(runQueue.count(key), 2);
      assert.equal(runtime.calls.spawn.length, before);
      assert.equal(client.posted.some((m) => !m.thread_ts && /Fork:/.test(m.text || "")), false);
    } finally {
      runQueue.release(key, source);
    }
    await fork;
    const childTs = client.posted.find((m) => /↪️ Fork of/.test(m.text || ""))?.thread_ts;
    assert.ok(childTs);
    assert.notEqual(await getSession(entry.slug, childTs), sourceId);
    assert.equal(await getSession(entry.slug, event.ts), sourceId);
    assert.equal(client.posted.filter((m) => !m.thread_ts && /Fork:/.test(m.text || "")).length, 1);
    assert.equal(runQueue.count(key), 0);
  });
}

test("Stop cancels queued forks before they can create a child", async () => {
  saveSettings({ engine: "codex" });
  const user = "U_QUEUE_FORK_STOP", channel = "D_QUEUE_FORK_STOP";
  await setUser(user, { name: "Queued Fork Stop", approved: true });
  const client = slack();
  const event = { type: "message", channel, channel_type: "im", user, ts: "9300.001", text: "Source task" };
  await processMessageEvent(event, client, { botUserId: "UBOT" });
  const entry = await getChannelEntry(channel);
  const key = `${entry.slug}::${event.ts}`;
  const source = { aborted: false, controller: new AbortController(), authorId: user };
  await runQueue.acquire(key, source);
  const fork = processMessageEvent({ ...event, ts: "9300.002", thread_ts: event.ts, text: "/fork Cancel this alternative" }, client, { botUserId: "UBOT" });
  try {
    await until(() => client.posted.some((m) => /Fork queued/.test(m.text || "")));
    abortRunsInChannel(channel, entry.slug, user, event.ts);
    await fork;
    assert.equal(client.posted.some((m) => !m.thread_ts && /Fork:/.test(m.text || "")), false);
  } finally { runQueue.release(key, source); }
});


test("queued fork rechecks current admission after waiting", async () => {
  saveSettings({ engine: "codex" });
  const user = "U_QUEUE_FORK_REVOKE", channel = "D_QUEUE_FORK_REVOKE";
  await setUser(user, { name: "Queued Fork Revoke", approved: true });
  const client = slack();
  const event = { type: "message", channel, channel_type: "im", user, ts: "9400.001", text: "Source task" };
  await processMessageEvent(event, client, { botUserId: "UBOT" });
  const entry = await getChannelEntry(channel);
  const key = `${entry.slug}::${event.ts}`;
  const source = { aborted: false, controller: new AbortController(), authorId: user };
  await runQueue.acquire(key, source);
  const fork = processMessageEvent({ ...event, ts: "9400.002", thread_ts: event.ts, text: "/fork Revoked alternative" }, client, { botUserId: "UBOT" });
  await until(() => client.posted.some((m) => /Fork queued/.test(m.text || "")));
  await setUser(user, { approved: false, isAdmin: false });
  runQueue.release(key, source);
  await fork;
  assert.equal(client.posted.some((m) => !m.thread_ts && /Fork:/.test(m.text || "")), false);
  assert.ok(client.posted.some((m) => /Sorry/.test(m.text || "")));
  assert.equal(runQueue.count(key), 0);
});

test("a Codex native fork the engine refuses falls back to a fresh session on the Slack history copy", async () => {
  // Codex 0.162.1 answered `exec fork <id>` with "invalid paginated history lineage … missing
  // source rollout" for a long compacted thread (Atlas, int-hubexo-nordics, 2026-11-12). The
  // child's prompt already carries the thread's Slack history, so the turn must continue in a
  // fresh Codex session with a visible note — not fail, not switch harness, not strand the source.
  saveSettings({ engine: "codex", engineEnabled: { claude: true, codex: true } });
  const user = "U_FORK_FALLBACK";
  const channel = "D_FORK_FALLBACK";
  await setUser(user, { name: "Fork User", approved: true });
  const client = slack();
  const event = { type: "message", channel, channel_type: "im", user, ts: "7000.001", text: "Source task" };
  await processMessageEvent(event, client, { botUserId: "UBOT" });
  const entry = await getChannelEntry(channel);
  const sourceId = await getSession(entry.slug, event.ts);
  assert.ok(sourceId);
  // The source thread as Slack would replay it: the request, the bot's answer, then the fork command.
  let historyReads = 0;
  const defaultReplies = client.conversations.replies;
  client.conversations.replies = async () => {
    historyReads++;
    return { messages: [
      { user, ts: event.ts, text: "Source task" },
      { user: "UBOT", ts: "7000.0015", text: "The source answer mentions TOKEN-EARLY-42" },
      { user, ts: "7000.002", text: "<@UBOT> /fork CODEX_STUB_FORK_UNAVAILABLE Explore another solution" },
    ], response_metadata: {} };
  };
  const before = runtime.calls.spawn.length;
  await processMessageEvent({ ...event, ts: "7000.002", thread_ts: event.ts, text: "<@UBOT> /fork CODEX_STUB_FORK_UNAVAILABLE Explore another solution" }, client, { botUserId: "UBOT" });
  const childTs = client.posted.find((m) => /↪️ Fork of/.test(m.text || ""))?.thread_ts;
  assert.ok(childTs, "the child thread is still created");
  const attempts = runtime.calls.spawn.slice(before);
  const forkAttempt = attempts.find((call) => call.args.includes("fork"));
  assert.ok(forkAttempt, "the native fork is attempted first");
  const freshAttempt = attempts.find((call) => !call.args.includes("fork") && call.args.some((arg) => arg.includes("Explore another solution")));
  assert.ok(freshAttempt, "the same turn is retried as a fresh session on the same harness");
  assert.ok(!freshAttempt.args.includes("resume"), "the retry never resumes the provisional fork id");
  assert.ok(!forkAttempt.args.some((arg) => /TOKEN-EARLY-42/.test(arg)), "the native attempt carries no history copy");
  assert.ok(freshAttempt.args.some((arg) => /Source thread:/.test(arg) && /TOKEN-EARLY-42/.test(arg)), "the fresh session receives the Slack history copy, read lazily");
  assert.ok(historyReads >= 1);
  client.conversations.replies = defaultReplies;
  assert.ok(!attempts.some((call) => call.args.includes("--fork-session")), "no cross-engine failover to Claude");
  assert.equal(await getSession(entry.slug, childTs), "codex-stub-session", "the child keeps the fresh session the engine minted");
  assert.equal(await getSession(entry.slug, event.ts), sourceId, "the source session is untouched");
  assert.ok(client.posted.some((m) => m.thread_ts === childTs && /could not fork the source thread/.test(m.text || "")), "the fallback is announced in the child thread");
  assert.ok(client.posted.some((m) => m.thread_ts === childTs && /stub .*reply/i.test(m.text || "")), "the child thread gets the answer");
  assert.ok(!client.posted.some((m) => /run failed|general error/i.test(m.text || "")), "no failure is reported");
  // The source thread was released: a follow-up there runs immediately.
  const sourceBefore = runtime.calls.spawn.length;
  await processMessageEvent({ ...event, ts: "7000.003", thread_ts: event.ts, text: "Continue the source" }, client, { botUserId: "UBOT" });
  assert.ok(runtime.calls.spawn.length > sourceBefore, "the source thread accepts new turns after the fallback");
  // And the child resumes its own fresh session on the next turn.
  const childBefore = runtime.calls.spawn.length;
  await processMessageEvent({ ...event, ts: "7000.004", thread_ts: childTs, text: "Continue the alternative" }, client, { botUserId: "UBOT" });
  const resumed = runtime.calls.spawn.slice(childBefore).find((call) => call.args.includes("resume"));
  assert.ok(resumed && resumed.args[resumed.args.indexOf("resume") + 1] === "codex-stub-session");
});
