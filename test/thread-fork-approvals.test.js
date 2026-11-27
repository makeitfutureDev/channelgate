import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
process.env.CG_FS_ROOT = process.env.TMPDIR;
const { setUser, upsertChannelEntry, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");
const { saveSession, clearSession } = await import("../src/gateway/sessions.js");
const { setThreadSudo } = await import("../src/gateway/thread-engine.js");
const { THREAD_FORK_ACTION, normalizeThreadForks, describeThreadForks, prepareThreadForkApproval, executeThreadForkApproval } = await import("../src/gateway/thread-fork-approvals.js");
const { requestApproval, lookupApproval, applyApprovalDecision, setDurableApprovalExecutor } = await import("../src/slack/approvals.js");
const { approvalActionKey, getApprovalRequest } = await import("../src/gateway/approval-requests.js");
let serial = 0;
const forks = [{ title: "Permissions", prompt: "Discuss the permission model." }, { title: "Queue", prompt: "Discuss queue ordering." }];

async function fixture() {
  const n = ++serial;
  const slug = `thread-fork-approval-${n}`;
  const channelId = `C_FORK_APPROVAL_${n}`;
  const authorId = `U_FORK_APPROVAL_${n}`;
  const adminId = `U_FORK_ADMIN_${n}`;
  const threadKey = `1800000000.${String(n).padStart(6, "0")}`;
  const workDir = tempDir("cg-thread-fork-approval-");
  await setUser(authorId, { approved: true, isAdmin: false });
  await setUser(adminId, { approved: true, isAdmin: true });
  await upsertChannelEntry(channelId, { name: slug, type: "channel", isDM: false });
  await saveChannelMeta(slug, { channelId, workDir, access: "approved" });
  await saveSession(slug, threadKey, `source-${n}`, "claude", null, JSON.stringify({ backend: "container", scope: "project" }));
  const posted = [], updates = [];
  const client = { chat: {
    postMessage: async payload => { posted.push(payload); return { ts: `1900000000.${String(posted.length).padStart(6, "0")}` }; },
    update: async payload => updates.push(payload),
    postEphemeral: async () => {},
  } };
  return { slug, channelId, authorId, adminId, threadKey, workDir, posted, updates, client,
    ctx: { slug, channelId, createdBy: authorId, threadKey, toolset: "full", principalTrusted: true, origin: "slack_foreground" } };
}

async function ask(f, items = forks) {
  const action = await prepareThreadForkApproval(f.ctx, { forks: items });
  const response = await requestApproval({ getClient: () => f.client }, {
    channelId: f.channelId, slug: f.slug, authorId: f.authorId, threadKey: f.threadKey,
    toolName: "fork_threads", approvalType: "agent", requiredTier: "owner",
    toolInput: { details: describeThreadForks(action.forks) }, durableAction: action,
    approveText: `Create ${items.length} forks`, denyText: "Cancel",
  });
  assert.equal(response.pending, true);
  assert.equal(response.allow, false);
  return response.approvalId;
}

async function decide(f, id, runBatch, options = {}) {
  setDurableApprovalExecutor(record => executeThreadForkApproval(record, { runBatch }));
  const found = lookupApproval(id);
  return applyApprovalDecision({ id, entry: found.entry, durable: found.durable, decision: "approve", actorId: f.authorId, client: f.client, ...options });
}

test("a fork proposal preserves every prompt, deduplicates pending cards and hashes the exact payload", async () => {
  const f = await fixture();
  const id = await ask(f);
  assert.equal(await ask(f), id);
  assert.equal(f.posted.length, 1);
  const action = getApprovalRequest(id).action;
  assert.equal(action.kind, THREAD_FORK_ACTION);
  assert.deepEqual(action.forks, forks);
  for (const item of forks) assert.ok(JSON.stringify(f.posted).includes(item.prompt));
  for (const field of ["channelId", "slug", "authorId", "threadKey", "sourceSessionId", "sourceEngine", "sourceScope", "workDir"]) {
    assert.notEqual(approvalActionKey({ ...action, [field]: `${action[field]}-changed` }), approvalActionKey(action), field);
  }
  for (const field of ["title", "prompt"]) {
    const changed = forks.map((item, index) => index ? item : { ...item, [field]: `${item[field]} changed` });
    assert.notEqual(approvalActionKey({ ...action, forks: changed }), approvalActionKey(action));
  }
  assert.notEqual(await ask(f, [...forks].reverse()), id);
});

test("Auto and remembered tool grants still require one explicit fork approval", async () => {
  const f = await fixture();
  await saveChannelMeta(f.slug, { ...await getChannelMeta(f.slug), autoMode: true, approvedTools: ["fork_threads"] });
  await ask(f);
  assert.equal(f.posted.length, 1);
  const admin = await fixture();
  await setUser(admin.authorId, { approved: true, isAdmin: true });
  await saveSession(admin.slug, admin.threadKey, "admin-source", "claude", null, JSON.stringify({ backend: "container", scope: "admin" }));
  await saveChannelMeta(admin.slug, { ...await getChannelMeta(admin.slug), adminMode: true, autoMode: true });
  await ask(admin);
  assert.equal(admin.posted.length, 1);
});

test("concurrent approval clicks execute the exact saved batch once", async () => {
  const f = await fixture();
  const id = await ask(f);
  const calls = [];
  const runBatch = async record => { calls.push(record); return { ok: true, completed: true, message: "Created two forks." }; };
  const results = await Promise.all([decide(f, id, runBatch), decide(f, id, runBatch)]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].action.forks, forks);
  assert.equal(getApprovalRequest(id).status, "consumed");
});

test("denial and requested changes create no forks", async () => {
  for (const options of [{ decision: "deny" }, { comment: "Please remove the queue topic." }]) {
    const f = await fixture();
    const id = await ask(f);
    let calls = 0;
    assert.equal((await decide(f, id, async () => { calls++; }, options)).ok, true);
    assert.equal(calls, 0);
    assert.equal(getApprovalRequest(id).status, "denied");
  }
});

test("revoked requester or unauthorized clicker cannot start a saved batch", async () => {
  for (const revoke of ["requester", "clicker"]) {
    const f = await fixture();
    const id = await ask(f);
    if (revoke === "requester") await setUser(f.authorId, { approved: false, isAdmin: false });
    else await setUser(f.adminId, { approved: true, isAdmin: false });
    let calls = 0;
    const result = await decide(f, id, async () => { calls++; }, { actorId: f.adminId });
    assert.equal(result.ok, false, revoke);
    assert.equal(calls, 0);
  }
});

test("batch execution errors consume the approval without retrying", async () => {
  const f = await fixture();
  const id = await ask(f);
  let calls = 0;
  const result = await decide(f, id, async () => { calls++; throw new Error("Slack unavailable"); });
  assert.equal(result.ok, false);
  assert.match(result.error, /Slack unavailable/);
  assert.equal(getApprovalRequest(id).status, "failed");
  assert.equal((await decide(f, id, async () => { calls++; })).ok, false);
  assert.equal(calls, 1);
});

test("fork limits prevent empty, oversized or truncated approval previews", () => {
  for (const items of [[], Array.from({ length: 11 }, () => forks[0]), [{ title: "", prompt: "Task" }], [{ title: "Topic", prompt: "" }], [{ title: "Topic", prompt: "x".repeat(2500) }]]) {
    assert.throws(() => normalizeThreadForks(items));
  }
});

test("only trusted foreground Slack threads may propose forks", async () => {
  const f = await fixture();
  for (const patch of [{ principalTrusted: false }, { toolset: "agent-message" }, { origin: "schedule" }, { threadKey: "sched-123" }, { channelId: "msteams:123" }]) {
    await assert.rejects(prepareThreadForkApproval({ ...f.ctx, ...patch }, { forks }));
  }
});

test("source boundary and access are rechecked before proposing a batch", async () => {
  for (const invalid of ["missing", "host", "scope", "engine", "sudo", "revoked"]) {
    const f = await fixture();
    if (invalid === "missing") await clearSession(f.slug, f.threadKey);
    if (invalid === "host") await saveSession(f.slug, f.threadKey, "s", "claude", null, JSON.stringify({ backend: "host", scope: "project" }));
    if (invalid === "scope") await saveSession(f.slug, f.threadKey, "s", "claude", null, JSON.stringify({ backend: "container", scope: "admin" }));
    if (invalid === "engine") await saveSession(f.slug, f.threadKey, "s", "qwen", null, JSON.stringify({ backend: "container", scope: "project" }));
    if (invalid === "sudo") await setThreadSudo(f.slug, f.threadKey, true);
    if (invalid === "revoked") await setUser(f.authorId, { approved: false, isAdmin: false });
    await assert.rejects(prepareThreadForkApproval(f.ctx, { forks }), undefined, invalid);
  }
});


test("a pending proposal cannot follow a changed source session or boundary", async () => {
  for (const change of ["session", "workDir", "sudo", "scope", "codeChannel"]) {
    const f = await fixture();
    const id = await ask(f);
    if (change === "session") await saveSession(f.slug, f.threadKey, "replacement", "claude", null, JSON.stringify({ backend: "container", scope: "project" }));
    if (change === "workDir") await saveChannelMeta(f.slug, { ...await getChannelMeta(f.slug), workDir: tempDir("cg-fork-moved-") });
    if (change === "sudo") await setThreadSudo(f.slug, f.threadKey, true);
    if (change === "scope") await setUser(f.authorId, { approved: true, isAdmin: true });
    if (change === "codeChannel") await saveChannelMeta(f.slug, { ...await getChannelMeta(f.slug), codeChannel: { originSlug: "source" } });
    let calls = 0;
    assert.equal((await decide(f, id, async () => { calls++; })).ok, false, change);
    assert.equal(calls, 0, change);
  }
});


test("fork tool is in the shared gateway catalog for confinement and discovery", async () => {
  const { GATEWAY_TOOL_NAMES } = await import("../src/gateway/mcp-catalog.js");
  assert.ok(GATEWAY_TOOL_NAMES.includes("propose_thread_forks"));
});
