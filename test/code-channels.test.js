// Slack code channels (src/gateway/code-channels.js, src/slack/code-channels.js,
// src/mcp/tools/code-channels.js, the pipeline/session seams): a code channel is a CHILD of the
// channel it was opened from — the origin's folder, policy, secrets and skills, re-projected on
// every read — with one channel-wide session, top-level replies, a task branch in a worktree when
// the folder is a repository, and Slack's agents.conversations.* lifecycle behind a human click.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const core = await import("../src/gateway/code-channels.js");
const slackCc = await import("../src/slack/code-channels.js");
const { setUser, upsertChannelEntry, saveChannelMeta, getChannelMeta, patchChannelMeta, getChannelEntry } = await import("../src/config/store.js");
const { workspaceFolder } = await import("../src/config/paths.js");
const { effectiveWorkDir } = await import("../src/gateway/folders.js");
const { createGatewayMcpServer, ctxFromClaims, createDirectDaemonIpc, DAEMON_IPC_KINDS } = await import("../src/mcp/gateway-server.js");
const { setAgentSessionStatus, renameAgentSession, resetAgentSessionsMode, stoppedSessionTarget } = await import("../src/slack/agent-sessions.js");
const { registerAgentInterfaceHandlers } = await import("../src/slack/agent-interface.js");
const { setAssistantStatus } = await import("../src/slack/progress.js");
const { capabilitiesFor, platformSupports } = await import("../src/platforms/registry.js");
const { resolvedGuideFiles } = await import("../src/gateway/guide.js");
const { GATEWAY_TOOL_NAMES } = await import("../src/gateway/mcp-catalog.js");

const REQUESTER = "U_CC_REQ";
const ADMIN = "U_CC_ADMIN";
const ORIGIN = "C_CC_ORIGIN";
const CODE = "C_CC_CODE";
let originSlug;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
}

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), "# origin\n");
  writeFileSync(path.join(dir, "AGENTS.md"), "# rules\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

// A fake Slack Web API: records every call, answers like Slack, and can be told to refuse.
function fakeSlack({ refuse = {} } = {}) {
  const calls = [];
  const api = async (method, payload) => {
    calls.push([method, payload]);
    if (refuse[method]) throw Object.assign(new Error(slackCc.describeCodeChannelError(refuse[method], method)), { code: refuse[method] });
    if (method === "agents.conversations.create") return { ok: true, channel_id: CODE };
    if (method === "conversations.info") return { ok: true, channel: { id: CODE, name: "code-task", is_private: false, properties: { record_channel: { record_type: "agent_channel" } } } };
    if (method === "agents.conversations.setView") return { ok: true, channel_id: CODE, view_id: "Ct1", content_version: calls.filter(([m]) => m === "agents.conversations.setView").length };
    if (method === "chat.postMessage") return { ok: true, ts: "1700000100.000001" };
    return { ok: true };
  };
  return { api, calls, of: (method) => calls.filter(([m]) => m === method).map(([, p]) => p) };
}

test.before(async () => {
  await setUser(REQUESTER, { name: "Requester", approved: true, isAdmin: false });
  await setUser(ADMIN, { name: "Admin", approved: true, isAdmin: true });
  const entry = await upsertChannelEntry(ORIGIN, { name: "#cc-origin", type: "channel", isDM: false, platform: "slack" });
  originSlug = entry.slug;
  await saveChannelMeta(originSlug, {
    channelId: ORIGIN, name: "#cc-origin", type: "channel", isDM: false, platform: "slack",
    access: "approved", allowedUsers: [REQUESTER], skills: ["origin-skill"], allowBash: true, allowNetwork: true,
    env: { ORIGIN_TOKEN: { value: "sekrit-origin", provider: "github", setBy: ADMIN, setAt: "2026-01-01T00:00:00Z" } },
  });
  initRepo(workspaceFolder(originSlug, "slack"));
});

// ── the platform-neutral core ───────────────────────────────────────────────────────────────

test("a code channel is one session with top-level replies, or the thread the person used", () => {
  assert.deepEqual(core.codeChannelReplyTarget({ ts: "1.1" }), { threadKey: core.CODE_CHANNEL_SESSION_KEY, replyTs: "" });
  assert.deepEqual(core.codeChannelReplyTarget({ ts: "1.2", thread_ts: "1.1" }), { threadKey: core.CODE_CHANNEL_SESSION_KEY, replyTs: "1.1" });
  assert.deepEqual(core.codeChannelReplyTarget({ ts: "1.2", thread_ts: "garbage" }), { threadKey: core.CODE_CHANNEL_SESSION_KEY, replyTs: "" });
  assert.equal(core.CODE_CHANNEL_SESSION_KEY.includes("."), false, "the key must never look like a Slack ts");
});

test("the mode follows the folder: a repository gets a worktree, anything else works in place, the requester may force either", (t) => {
  const repo = workspaceFolder(originSlug, "slack");
  const plain = path.join(path.dirname(repo), "cc-plain");
  mkdirSync(plain, { recursive: true });
  assert.equal(core.decideCodeChannelMode(repo, "auto").mode, "worktree");
  assert.equal(core.decideCodeChannelMode(repo, "in_place").mode, "in_place");
  assert.equal(core.decideCodeChannelMode(repo, "branch").mode, "worktree");
  assert.equal(core.decideCodeChannelMode(plain, "auto").mode, "in_place");
  const forced = core.decideCodeChannelMode(plain, "worktree");
  assert.equal(forced.mode, "in_place");
  assert.match(forced.note, /not a git repository/);
  assert.equal(core.normalizeCodeChannelMode("in-place"), "in_place");
  assert.equal(core.normalizeCodeChannelMode("nonsense"), "auto");
});

test("inherited meta is the origin's policy with the code channel's own identity and the origin's folder", async () => {
  const originMeta = await getChannelMeta(originSlug);
  const own = { channelId: CODE, name: "#code-task", type: "channel", platform: "slack", codeChannel: { originSlug, originChannelId: ORIGIN } };
  const meta = core.inheritedCodeChannelMeta({ ...originMeta, dmUserId: "U_PEER", isDM: true, template: "user" }, own);
  assert.equal(meta.channelId, CODE);
  assert.equal(meta.name, "#code-task");
  assert.equal(meta.isDM, false);
  assert.equal(meta.template, "");
  assert.equal("dmUserId" in meta, false);
  assert.deepEqual(meta.skills, ["origin-skill"]);
  assert.deepEqual(meta.allowedUsers, [REQUESTER]);
  assert.equal(meta.env.ORIGIN_TOKEN.value, "sekrit-origin", "secrets are the origin's");
  assert.equal(meta.workDir, effectiveWorkDir(originSlug, originMeta), "the same host folder is mounted");
  assert.equal(core.isCodeChannelMeta(meta), true);
  assert.equal(core.isCodeChannelMeta(originMeta), false);
  assert.equal(core.codeChannelPreamble(originMeta), "");
});

test("the worktree is created on a task branch from the checkout's base, with a suffix when the branch name is taken", async () => {
  const repo = workspaceFolder(originSlug, "slack");
  git(repo, "branch", "code/taken");
  const taken = await core.prepareCodeChannelWorktree({ root: repo, slug: "taken" });
  assert.equal(taken.ok, true, taken.error);
  assert.equal(taken.branch, "code/taken-2");
  assert.equal(taken.worktree, path.join(repo, ".worktrees", "taken"));
  assert.ok(existsSync(path.join(taken.worktree, "README.md")));
  assert.match(readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8"), /^\.worktrees\/$/m);
  const again = await core.prepareCodeChannelWorktree({ root: repo, slug: "taken" });
  assert.equal(again.ok, false, "an existing worktree path is final, never clobbered");
  const notRepo = await core.prepareCodeChannelWorktree({ root: path.join(path.dirname(repo), "cc-plain"), slug: "x" });
  assert.equal(notRepo.ok, false);
  assert.match(notRepo.error, /not a git repository/);
});

test("the diff covers committed and uncommitted tracked work and leaves out the gateway's managed instruction block", async () => {
  const repo = workspaceFolder(originSlug, "slack");
  const made = await core.prepareCodeChannelWorktree({ root: repo, slug: "diffy" });
  assert.equal(made.ok, true, made.error);
  const wt = made.worktree;
  let empty = await core.computeCodeChannelDiff({ worktree: wt, baseRef: made.baseRef, branch: made.branch });
  assert.equal(empty.ok, true);
  assert.equal(empty.diff.trim(), "");
  writeFileSync(path.join(wt, "feature.js"), "export const x = 1;\n");
  git(wt, "add", "feature.js");
  git(wt, "commit", "-q", "-m", "feat");
  writeFileSync(path.join(wt, "README.md"), "# origin\nmore\n");
  writeFileSync(path.join(wt, "AGENTS.md"), "# rules\n<!-- GATEWAY-INSTRUCTIONS:START -->\nmanaged\n<!-- GATEWAY-INSTRUCTIONS:END -->\n");
  const result = await core.computeCodeChannelDiff({ worktree: wt, baseRef: made.baseRef, branch: made.branch });
  assert.equal(result.ok, true, result.error);
  assert.match(result.diff, /\+export const x = 1;/);
  assert.match(result.diff, /\+more/);
  assert.doesNotMatch(result.diff, /GATEWAY-INSTRUCTIONS/);
  assert.equal(result.files, 2);
  assert.equal(result.head, made.branch);
  const missing = await core.computeCodeChannelDiff({ worktree: path.join(repo, ".worktrees", "nope") });
  assert.equal(missing.ok, false);
});

// ── the Slack half ─────────────────────────────────────────────────────────────────────────

test("opening registers a child channel: Slack create linked to the origin, inherited meta, a task worktree, status and context bar", async () => {
  const slack = fakeSlack();
  const originMeta = await getChannelMeta(originSlug);
  const originDir = effectiveWorkDir(originSlug, originMeta);
  const result = await slackCc.openCodeChannel({
    originChannelId: ORIGIN, originSlug, originMeta, originDir, originThreadTs: "1700000000.000100", originMessageTs: "1700000000.000100",
    requesterId: REQUESTER, name: "code task", task: "Add the export button\nto the report page", mode: "auto",
  }, { api: slack.api });
  assert.equal(result.channelId, CODE);
  assert.equal(result.mode, "worktree");
  assert.match(result.branch, /^code\//);
  const create = slack.of("agents.conversations.create")[0];
  assert.equal(create.origin_channel_id, ORIGIN);
  assert.equal(create.origin_message_ts, "1700000000.000100");
  assert.equal(create.name, "code task");
  assert.match(create.session_id, /^cgcc:C_CC_ORIGIN:1700000000\.000100$/);
  assert.equal("is_private" in create, false, "privacy follows the origin unless forced");
  const status = slack.of("agents.sessions.setStatus")[0];
  assert.deepEqual(status, { channel_id: CODE, status: "active", title: "code task" });
  const bar = slack.of("agents.conversations.setProperties")[0].code_channel.context_bar_items;
  assert.deepEqual(bar.map((i) => i.key), ["folder", "branch"]);
  assert.equal(bar[1].label, result.branch);

  const entry = await getChannelEntry(CODE);
  assert.ok(entry);
  const meta = await getChannelMeta(entry.slug);
  assert.equal(core.isCodeChannelMeta(meta), true);
  assert.equal(meta.codeChannel.task, "Add the export button to the report page");
  assert.equal(meta.codeChannel.createdBy, REQUESTER);
  assert.equal(meta.codeChannel.originThreadTs, "1700000000.000100");
  assert.equal(meta.workDir, originDir);
  assert.equal(effectiveWorkDir(entry.slug, meta), originDir, "the code channel runs in the origin's folder");
  assert.equal(meta.env.ORIGIN_TOKEN.value, "sekrit-origin");
  assert.deepEqual(meta.allowedUsers, [REQUESTER]);
  assert.ok(existsSync(path.join(meta.codeChannel.worktree, "README.md")));
  assert.match(core.codeChannelPreamble(meta), /\[Slack code channel\].*task worktree `.*\.worktrees/s);
  assert.match(core.codeChannelKickoffPrompt(meta.codeChannel), /Add the export button/);
});

test("a change in the origin reaches the code channel on the next sync, and an unchanged origin writes nothing", async () => {
  const entry = await getChannelEntry(CODE);
  const before = await getChannelMeta(entry.slug);
  const same = await core.syncCodeChannelMeta(entry.slug, before);
  assert.equal(same, before, "identical projection returns the same record (no write)");
  await patchChannelMeta(originSlug, { allowedUsers: [REQUESTER, ADMIN], skills: ["origin-skill", "new-skill"], env: { ...before.env, ROTATED: { value: "v2", provider: "", setBy: ADMIN, setAt: "2026-01-02T00:00:00Z" } } });
  const after = await core.syncCodeChannelMeta(entry.slug, before);
  assert.deepEqual(after.allowedUsers, [REQUESTER, ADMIN]);
  assert.deepEqual(after.skills, ["origin-skill", "new-skill"]);
  assert.equal(after.env.ROTATED.value, "v2");
  assert.equal(after.channelId, CODE, "identity stays the code channel's");
  assert.deepEqual(after.codeChannel, before.codeChannel);
  assert.deepEqual((await getChannelMeta(entry.slug)).skills, ["origin-skill", "new-skill"], "persisted");
});

test("the Code tab is published once per distinct diff and archiving posts the wrap-up, closes and records", async () => {
  const entry = await getChannelEntry(CODE);
  const meta = await getChannelMeta(entry.slug);
  slackCc.__resetCodeChannelState();
  const slack = fakeSlack();
  assert.deepEqual(await slackCc.refreshCodeChannelDiff(meta, { api: slack.api }), { ok: true, skipped: true, empty: true });
  writeFileSync(path.join(meta.codeChannel.worktree, "new.txt"), "hello\n");
  git(meta.codeChannel.worktree, "add", "new.txt");
  const first = await slackCc.refreshCodeChannelDiff(meta, { api: slack.api });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.files, 1);
  const view = slack.of("agents.conversations.setView")[0];
  assert.equal(view.type, "diff");
  assert.match(view.content, /\+hello/);
  assert.equal(view.head_branch, meta.codeChannel.branch);
  assert.equal("view_key" in view, false, "diff views are the channel's singleton");
  const second = await slackCc.refreshCodeChannelDiff(meta, { api: slack.api });
  assert.equal(second.unchanged, true);
  assert.equal(slack.of("agents.conversations.setView").length, 1);

  const archived = await slackCc.archiveCodeChannel({ slug: entry.slug, meta, summary: "Done: export button shipped on code/x." }, { api: slack.api });
  assert.equal(archived.summaryTs, "1700000100.000001");
  assert.deepEqual(slack.of("agents.sessions.setStatus").at(-1), { channel_id: CODE, status: "closed" });
  assert.deepEqual(slack.of("agents.conversations.archive")[0], { channel_id: CODE, summary_message_ts: "1700000100.000001" });
  assert.match((await getChannelMeta(entry.slug)).codeChannel.archivedAt, /^\d{4}-/);
  assert.ok(existsSync(meta.codeChannel.worktree), "archiving never deletes the task branch");
  // Put it back for the later tests.
  await patchChannelMeta(entry.slug, (current) => ({ codeChannel: { ...current.codeChannel, archivedAt: "" } }));
});

test("eligibility refusals are named, and views are validated before Slack sees them", async () => {
  const slack = fakeSlack({ refuse: { "agents.conversations.create": "feature_disabled" } });
  const originMeta = await getChannelMeta(originSlug);
  await assert.rejects(
    () => slackCc.openCodeChannel({ originChannelId: ORIGIN, originSlug, originMeta, originDir: effectiveWorkDir(originSlug, originMeta), originThreadTs: "1.1", requesterId: REQUESTER, task: "x" }, { api: slack.api }),
    (error) => error.code === "feature_disabled" && /Slack Code is not enabled/.test(error.message),
  );
  assert.equal(slackCc.isCodeChannelEligibilityError("user_not_enabled"), true);
  assert.equal(slackCc.isCodeChannelEligibilityError("invalid_blocks"), false);
  const api = fakeSlack().api;
  await assert.rejects(() => slackCc.setCodeChannelView(CODE, { type: "html", content: "<html></html>" }, { api }), /needs a stable `key`/);
  await assert.rejects(() => slackCc.setCodeChannelView(CODE, { type: "pull_request", pr_url: "http://evil/pull/1" }, { api }), /valid https pull-request URL/);
  await assert.rejects(() => slackCc.setCodeChannelView(CODE, { type: "html", key: "p.html", content: "x".repeat(core.CODE_CHANNEL_VIEW_MAX_BYTES + 1) }, { api }), /larger than Slack accepts/);
  await assert.rejects(() => slackCc.setCodeChannelView(CODE, { type: "hologram" }, { api }), /Unknown view type/);
  const ok = fakeSlack();
  await slackCc.setCodeChannelView(CODE, { type: "pull_request", pr_url: "https://github.com/o/r/pull/7" }, { api: ok.api });
  assert.deepEqual(ok.of("agents.conversations.setView")[0], { channel_id: CODE, type: "pull_request", pr_url: "https://github.com/o/r/pull/7" });
  assert.deepEqual(slackCc.normalizeContextItems([{ key: "a", label: "A", icon: "nope", url: "ftp://x" }, { key: "a", label: "dup" }, { key: "b", label: "B", icon: "branch", url: "https://x.example/b" }]),
    [{ key: "a", label: "A" }, { key: "b", label: "B", icon: "branch", url: "https://x.example/b" }]);
});

// ── sessions, status and Stop at channel level ─────────────────────────────────────────────

test("a channel-wide session is addressed by channel id alone, skips the legacy thread bridge, and Stop sweeps the channel", async () => {
  resetAgentSessionsMode();
  const calls = [];
  const client = { apiCall: async (method, payload) => { calls.push([method, payload]); return { ok: true }; } };
  assert.equal(await setAgentSessionStatus(client, { channel: CODE, phrase: "thinking", channelSession: true, username: "Opus" }), true);
  assert.equal(await setAgentSessionStatus(client, { channel: CODE, channelSession: true }), true);
  assert.deepEqual(calls.map(([m, p]) => [m, p.channel_id, "thread_ts" in p, p.status]), [
    ["agents.sessions.setStatus", CODE, false, "processing"],
    ["agents.sessions.setStatus", CODE, false, "active"],
  ]);
  assert.equal(await setAgentSessionStatus(client, { channel: CODE, phrase: "x" }), false, "no thread and not a channel session → nothing to drive");
  calls.length = 0;
  assert.equal(await renameAgentSession(client, { channel: CODE, title: "Export button", channelSession: true }), true);
  assert.deepEqual(calls, [["agents.sessions.rename", { channel_id: CODE, title: "Export button" }]]);
  calls.length = 0;
  assert.equal(await setAssistantStatus(client, CODE, "", "thinking", [], { channelSession: true }), true);
  assert.equal(calls[0][0], "agents.sessions.setStatus");
  assert.equal(await setAssistantStatus(client, "C_OTHER", "", "thinking"), false);

  // The Stop button without a thread: the channel's one session.
  assert.deepEqual(stoppedSessionTarget({ channel: CODE, user: REQUESTER }), { channel: CODE, threadTs: "", user: REQUESTER, streamingMessageTs: [] });
  const events = new Map();
  const stops = [];
  const statuses = [];
  registerAgentInterfaceHandlers({ event: (n, h) => events.set(n, h), action: () => {} }, {
    botUserId: "UBOT",
    seenEvents: { add: () => true },
    authorizedControlEntry: async () => ({ slug: "code-slug" }),
    stopRunsInChannel: async (_c, channel, slug, user, threadKey) => { stops.push({ channel, slug, user, threadKey }); return 0; },
    setAssistantStatus: async (_c, channel, threadTs, status, _lm, opts) => { statuses.push([channel, threadTs, status, opts?.channelSession]); return true; },
    isCodeChannel: async (channel) => channel === CODE,
  });
  const handler = events.get("agent_session_stopped");
  await handler({ event: { channel: CODE, user: REQUESTER, event_ts: "9.1", streaming_message_ts: [] }, client: {}, body: {} });
  assert.deepEqual(stops, [{ channel: CODE, slug: "code-slug", user: REQUESTER, threadKey: null }], "null sweeps every run in the channel");
  assert.deepEqual(statuses, [[CODE, "", "", true]]);
  await handler({ event: { channel: "C_PLAIN", user: REQUESTER, event_ts: "9.2" }, client: {}, body: {} });
  assert.equal(stops.length, 1, "a thread-less stop outside a code channel names no session and is ignored");
});

// ── the gateway tools ─────────────────────────────────────────────────────────────────────

const bodyText = (result) => result.content.map((c) => c.text || "").join("\n");

async function withTools({ channelId, slug, authorId = REQUESTER, threadKey = "1700000000.000100", handlers = {}, overrides = {} }, run) {
  const ctx = ctxFromClaims({ channelId, slug, authorId, engine: "claude", origin: "slack_foreground", principalTrusted: true, toolset: "full", threadKey }, { daemon: createDirectDaemonIpc(handlers) });
  Object.assign(ctx, overrides);
  const server = createGatewayMcpServer(ctx);
  const client = new Client({ name: "cc-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  try { return await run(client, server); } finally { await client.close(); await server.close(); }
}

test("open_code_channel is a card the requester confirms; the saved call opens the channel and kicks off the first turn", async () => {
  const approvals = [];
  const kickoffs = [];
  const opened = [];
  const handlers = {
    approval: async (body) => { approvals.push(body); return { allow: false, pending: true, approvalId: "appr-cc" }; },
    "code-channel": async (body) => { kickoffs.push(body); return { ok: true }; },
  };
  const fakeOpen = async (args) => { opened.push(args); return { channelId: CODE, slug: "code-slug", name: "#code-task", mode: "worktree", branch: "code/code-slug", worktree: "/w", meta: { codeChannel: { task: args.task } } }; };
  await withTools({ channelId: ORIGIN, slug: originSlug, handlers, overrides: { openCodeChannel: fakeOpen } }, async (client, server) => {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ["open_code_channel", "update_code_channel", "archive_code_channel"]) assert.ok(tools.includes(name), name);
    const pending = bodyText(await client.callTool({ name: "open_code_channel", arguments: { task: "Add the export button", mode: "auto" } }));
    assert.match(pending, /awaiting approval/);
    assert.equal(opened.length, 0, "nothing is created before the click");
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].requiredTier, "owner");
    assert.match(approvals[0].toolInput.details, /Open a Slack code channel for: Add the export button/);
    assert.match(approvals[0].toolInput.details, /a task branch in a git worktree when the folder is a repository/);
    assert.equal(approvals[0].durableAction.tool, "open_code_channel");
    // The click: the daemon applies the exact saved call as the requester.
    const applied = await server.invokeApproved("open_code_channel", approvals[0].durableAction.args);
    assert.equal(applied.ok, true);
    assert.match(applied.text, /Opened code channel <#C_CC_CODE>/);
    assert.match(applied.text, /branch `code\/code-slug`/);
    assert.match(applied.text, /started working there/);
    assert.equal(opened[0].requesterId, REQUESTER);
    assert.equal(opened[0].originThreadTs, "1700000000.000100");
    assert.equal(opened[0].originSlug, originSlug);
    assert.deepEqual(kickoffs, [{ action: "kickoff", channelId: CODE, requesterId: REQUESTER, task: "Add the export button" }]);
  });
  assert.ok(DAEMON_IPC_KINDS.includes("code-channel"));
  // Refusals: a synthetic session key (no origin message), a DM, and inside a code channel.
  await withTools({ channelId: ORIGIN, slug: originSlug, handlers, threadKey: "sched-1-2", overrides: { openCodeChannel: fakeOpen } }, async (client, server) => {
    assert.match((await server.invokeApproved("open_code_channel", { task: "x" })).text, /no originating message/);
  });
  const codeEntry = await getChannelEntry(CODE);
  await withTools({ channelId: CODE, slug: codeEntry.slug, handlers, overrides: { openCodeChannel: fakeOpen } }, async (client, server) => {
    assert.match((await server.invokeApproved("open_code_channel", { task: "x" })).text, /already a code channel/);
  });
});

test("update_code_channel works only inside a code channel and publishes tabs, context items and the title; archive is a card anyone there approves", async () => {
  const codeEntry = await getChannelEntry(CODE);
  const slack = fakeSlack();
  await withTools({ channelId: ORIGIN, slug: originSlug, overrides: { codeChannelApi: slack.api } }, async (client, server) => {
    assert.match(bodyText(await client.callTool({ name: "update_code_channel", arguments: { title: "x" } })), /only works inside a Slack code channel/);
    // The archive card is posted before the handler runs; the applied call still refuses outside a code channel.
    assert.match((await server.invokeApproved("archive_code_channel", {})).text, /only works inside a Slack code channel/);
  });
  const approvals = [];
  const handlers = { approval: async (body) => { approvals.push(body); return { allow: false, pending: true, approvalId: "appr-arch" }; } };
  await withTools({ channelId: CODE, slug: codeEntry.slug, threadKey: core.CODE_CHANNEL_SESSION_KEY, handlers, overrides: { codeChannelApi: slack.api } }, async (client, server) => {
    const out = bodyText(await client.callTool({ name: "update_code_channel", arguments: {
      title: "Export button",
      context_items: [{ key: "ci", label: "Tests passing", icon: "terminal" }],
      view: { type: "html", key: "preview.html", name: "Preview", content: "<!doctype html><html><body>hi</body></html>" },
    } }));
    assert.match(out, /✔️ Title: Export button/);
    assert.match(out, /✔️ Context bar: Tests passing · /);
    assert.match(out, /✔️ html tab Preview published/);
    assert.deepEqual(slack.of("agents.sessions.rename")[0], { channel_id: CODE, title: "Export button" });
    const bar = slack.of("agents.conversations.setProperties")[0].code_channel.context_bar_items;
    assert.equal(bar[0].key, "ci");
    assert.ok(bar.some((i) => i.key === "branch"), "the defaults stay");
    assert.deepEqual(slack.of("agents.conversations.setView")[0], { channel_id: CODE, type: "html", name: "Preview", view_key: "preview.html", content: "<!doctype html><html><body>hi</body></html>" });
    const pr = bodyText(await client.callTool({ name: "update_code_channel", arguments: { view: { type: "pull_request", pr_url: "https://github.com/o/r/pull/9" } } }));
    assert.match(pr, /pull_request tab .*published/);
    assert.ok(slack.of("agents.conversations.setProperties").at(-1).code_channel.context_bar_items.some((i) => i.key === "pr" && i.url === "https://github.com/o/r/pull/9"));
    assert.match(bodyText(await client.callTool({ name: "update_code_channel", arguments: {} })), /Nothing to update/);

    const pending = bodyText(await client.callTool({ name: "archive_code_channel", arguments: { summary: "All done." } }));
    assert.match(pending, /awaiting approval/);
    assert.equal(approvals[0].requiredTier, "");
    assert.match(approvals[0].toolInput.details, /Archive this code channel after posting the wrap-up/);
    assert.equal(slack.of("agents.conversations.archive").length, 0);
    const applied = await server.invokeApproved("archive_code_channel", approvals[0].durableAction.args);
    assert.equal(applied.ok, true, applied.text);
    assert.match(applied.text, /Archived <#C_CC_CODE>.*shared back/);
    assert.equal(slack.of("agents.conversations.archive").length, 1);
    assert.match((await server.invokeApproved("archive_code_channel", {})).text, /already archived/);
  });
});

// ── declarations: capability, guide, manifest, tool inventory ─────────────────────────────

test("code channels are a declared Slack-only capability with a Slack-only guide, manifest feature and scope", async () => {
  assert.equal(platformSupports("slack", "codeChannels"), true);
  for (const id of ["msteams", "googlechat"]) assert.equal(capabilitiesFor(id).codeChannels, false, id);
  const slackGuide = await resolvedGuideFiles("slack");
  assert.ok(slackGuide.has("references/code-channels.md"));
  assert.match(slackGuide.get("references/code-channels.md").src, /platforms\/slack\//);
  assert.equal((await resolvedGuideFiles("msteams")).has("references/code-channels.md"), false);
  const skill = readFileSync(new URL("../src/gateway/gateway-usage/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /code channel.*references\/code-channels\.md.*open_code_channel/s);
  const reference = readFileSync(new URL("../src/gateway/gateway-usage/platforms/slack/code-channels.md", import.meta.url), "utf8");
  assert.match(reference, /ONLY when the requester explicitly asks/);
  assert.match(reference, /update_code_channel/);
  assert.match(reference, /archive_code_channel/);
  const manifest = JSON.parse(readFileSync(new URL("../slack-app-manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.features.code_channels.enabled, true);
  assert.ok(manifest.oauth_config.scopes.bot.includes("code_channels:manage"));
  for (const name of ["open_code_channel", "update_code_channel", "archive_code_channel"]) assert.ok(GATEWAY_TOOL_NAMES.includes(name), name);
});
