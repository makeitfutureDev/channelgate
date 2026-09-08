import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
process.env.CG_FS_ROOT = process.env.TMPDIR;
const { setUser, upsertChannelEntry, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");
const { prepareInstructionApproval, executeInstructionApproval } = await import("../src/gateway/instruction-approvals.js");
const { requestApproval, lookupApproval, applyApprovalDecision, handleApprovalClick, listPendingApprovals, setDurableApprovalExecutor } = await import("../src/slack/approvals.js");
const { approvalActionKey, getApprovalRequest, transitionApprovalRequest, recoverInterruptedApprovalExecutions } = await import("../src/gateway/approval-requests.js");
const repo = fileURLToPath(new URL("..", import.meta.url));
let serial = 0;

async function fixture() {
  const n = ++serial;
  const slug = `instruction-approval-${n}`;
  const channelId = `C_INSTRUCTION_${n}`;
  const authorId = `U_INSTRUCTION_${n}`;
  const adminId = `U_INSTRUCTION_ADMIN_${n}`;
  const workDir = tempDir("cg-instruction-approval-");
  const file = path.join(workDir, "CLAUDE.md");
  await writeFile(file, "Existing instructions.\n");
  await setUser(authorId, { approved: true, isAdmin: false });
  await setUser(adminId, { approved: true, isAdmin: true });
  await upsertChannelEntry(channelId, { name: slug, type: "channel", isDM: false });
  await saveChannelMeta(slug, { channelId, workDir, access: "approved" });
  const posted = [];
  const updates = [];
  const ephemeral = [];
  const client = { chat: {
    postMessage: async (payload) => { posted.push(payload); return { ts: `1900.${posted.length}` }; },
    update: async (payload) => updates.push(payload),
    postEphemeral: async (payload) => ephemeral.push(payload),
  } };
  return { slug, channelId, authorId, adminId, workDir, file, client, posted, updates, ephemeral,
    ctx: { slug, channelId, createdBy: authorId, threadKey: `1800.${n}` } };
}

async function ask(f, args = { text: "- Preserve this exact approved rule." }, ctx = f.ctx) {
  const action = await prepareInstructionApproval(ctx, args);
  const response = await requestApproval({ getClient: () => f.client }, {
    channelId: ctx.channelId, slug: ctx.slug, authorId: ctx.createdBy, threadKey: ctx.threadKey,
    toolName: "update_channel_instructions", approvalType: "agent",
    requiredTier: action.mode === "replace" ? "admin" : "",
    toolInput: { details: `${action.mode}:\n${action.text}` }, durableAction: action,
  });
  assert.equal(response.pending, true);
  assert.equal(response.allow, false);
  return response.approvalId;
}

async function decide(f, id, { decision = "approve", actorId = f.authorId, comment = "" } = {}) {
  setDurableApprovalExecutor(executeInstructionApproval);
  const { entry, durable } = lookupApproval(id);
  return applyApprovalDecision({ id, entry, durable, decision, actorId, comment, client: f.client });
}

test("an instruction approval outlives four minutes and writes once after concurrent decisions", async (t) => {
  const f = await fixture();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const id = await ask(f);
  assert.equal(await readFile(f.file, "utf8"), "Existing instructions.\n");
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.equal(getApprovalRequest(id).status, "pending");
  const listing = listPendingApprovals().find((row) => row.id === id);
  assert.equal(listing.expiresAt, null);
  assert.equal(listing.kind, "channel_instructions");
  assert.equal(Object.hasOwn(listing, "action"), false);
  setDurableApprovalExecutor(executeInstructionApproval);
  const captured = lookupApproval(id);
  const apply = () => applyApprovalDecision({ id, entry: captured.entry, durable: captured.durable, decision: "approve", actorId: f.authorId, client: f.client });
  const results = await Promise.all([apply(), apply()]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.find((result) => !result.ok).code, 409);
  assert.equal(await readFile(f.file, "utf8"), "Existing instructions.\n\n- Preserve this exact approved rule.\n");
  assert.equal(getApprovalRequest(id).status, "consumed");
  assert.equal(lookupApproval(id).entry, null);
  assert.match(JSON.stringify(f.updates), /standing instructions/);
  assert.doesNotMatch(JSON.stringify(f.updates), /started.*background job|Check status/);
});

test("an approval created in a terminated process is actionable in a fresh process", async () => {
  const f = await fixture();
  const script = `
    const { prepareInstructionApproval, executeInstructionApproval } = await import('./src/gateway/instruction-approvals.js');
    const { requestApproval, lookupApproval, applyApprovalDecision, setDurableApprovalExecutor } = await import('./src/slack/approvals.js');
    const input = JSON.parse(process.argv[1]);
    if (input.id) {
      setDurableApprovalExecutor(executeInstructionApproval);
      const found = lookupApproval(input.id);
      const result = await applyApprovalDecision({ id: input.id, entry: found.entry, durable: found.durable, decision: 'approve', actorId: input.ctx.createdBy });
      process.stdout.write(JSON.stringify(result));
    } else {
      const action = await prepareInstructionApproval(input.ctx, { text: '- Restart-persistent rule.' });
      const client = { chat: { postMessage: async () => ({ ts: '1901.001' }), postEphemeral: async () => {} } };
      const result = await requestApproval({ getClient: () => client }, { channelId: input.ctx.channelId, slug: input.ctx.slug, authorId: input.ctx.createdBy, threadKey: input.ctx.threadKey, toolName: 'update_channel_instructions', approvalType: 'agent', toolInput: { details: action.text }, durableAction: action });
      process.stdout.write(JSON.stringify(result));
    }
  `;
  const child = (input) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(input)], {
    cwd: repo, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }));
  const pending = child({ ctx: f.ctx });
  assert.equal(pending.pending, true);
  assert.equal(await readFile(f.file, "utf8"), "Existing instructions.\n");
  assert.equal(child({ ctx: f.ctx, id: pending.approvalId }).ok, true);
  assert.equal(await readFile(f.file, "utf8"), "Existing instructions.\n\n- Restart-persistent rule.\n");
  assert.equal(child({ ctx: f.ctx, id: pending.approvalId }).ok, false);
});

test("pending duplicates reuse one card and every exact authority field affects the key", async () => {
  const f = await fixture();
  const id = await ask(f);
  assert.equal(await ask(f), id);
  assert.equal(f.posted.length, 1);
  const action = getApprovalRequest(id).action;
  for (const field of ["channelId", "slug", "authorId", "threadKey", "text", "mode", "fingerprint", "workDir"]) {
    assert.notEqual(approvalActionKey({ ...action, [field]: `${action[field]}-different` }), approvalActionKey(action), field);
  }
  assert.equal(approvalActionKey({ ...action, label: "Different display label" }), approvalActionKey(action));
  assert.notEqual(await ask(f, { text: "- Another rule." }), id);
});

test("denial and change-request comments never change instructions", async () => {
  for (const options of [{ decision: "deny" }, { decision: "approve", comment: "Please revise the rule." }]) {
    const f = await fixture();
    const id = await ask(f);
    assert.equal((await decide(f, id, options)).ok, true);
    assert.equal(getApprovalRequest(id).status, "denied");
    assert.equal(await readFile(f.file, "utf8"), "Existing instructions.\n");
  }
});

test("changing the file or destination while pending fails closed", async () => {
  for (const drift of ["contents", "workDir", "channelId"]) {
    const f = await fixture();
    const id = await ask(f);
    if (drift === "contents") await writeFile(f.file, "A newer instruction.\n");
    else await saveChannelMeta(f.slug, { ...(await getChannelMeta(f.slug)), [drift]: drift === "workDir" ? tempDir("cg-instruction-moved-") : "C_DIFFERENT" });
    const result = await decide(f, id);
    assert.equal(result.ok, false, drift);
    assert.equal(getApprovalRequest(id).status, "failed");
    assert.doesNotMatch(await readFile(f.file, "utf8"), /Preserve this exact/);
  }
});

test("two distinct approvals for one version cannot overwrite each other concurrently", async () => {
  const f = await fixture();
  const first = await ask(f, { text: "- First candidate." });
  const second = await ask(f, { text: "- Second candidate." });
  const results = await Promise.all([decide(f, first), decide(f, second)]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.match(results.find((result) => !result.ok).error, /instructions changed/);
  const contents = await readFile(f.file, "utf8");
  assert.match(contents, /^Existing instructions\./);
  assert.equal((contents.match(/candidate\./g) || []).length, 1);
});

test("a revoked requester cannot execute, including through authenticated admin UI", async () => {
  for (const actor of ["requester", "admin UI"]) {
    const f = await fixture();
    const id = await ask(f);
    await setUser(f.authorId, { approved: false, isAdmin: false });
    const result = await decide(f, id, { actorId: actor === "requester" ? f.authorId : actor });
    assert.equal(result.ok, false);
    assert.match(result.error, /no longer authorized/);
    assert.equal(await readFile(f.file, "utf8"), "Existing instructions.\n");
  }
});

test("replace requires an admin requester and an admin click, rechecked at execution", async () => {
  const f = await fixture();
  await assert.rejects(prepareInstructionApproval(f.ctx, { mode: "replace", text: "Replace everything." }), /Only admins/);
  const id = await ask(f, { mode: "replace", text: "Approved replacement." }, { ...f.ctx, createdBy: f.adminId });
  setDurableApprovalExecutor(executeInstructionApproval);
  await handleApprovalClick({ ack: async () => {}, body: { user: { id: f.authorId }, channel: { id: f.channelId }, message: { ts: "1900.1" } },
    action: { action_id: "cg_approve", value: id }, client: f.client });
  assert.equal(getApprovalRequest(id).status, "pending");
  assert.match(JSON.stringify(f.ephemeral), /admin/);
  await setUser(f.adminId, { approved: true, isAdmin: false });
  assert.equal((await decide(f, id, { actorId: "admin UI" })).ok, false);
  assert.equal(await readFile(f.file, "utf8"), "Existing instructions.\n");

  const allowed = await fixture();
  const replace = await ask(allowed, { mode: "replace", text: "Approved replacement." }, { ...allowed.ctx, createdBy: allowed.adminId });
  assert.equal((await decide(allowed, replace, { actorId: allowed.adminId })).ok, true);
  assert.equal(await readFile(allowed.file, "utf8"), "Approved replacement.\n");
});

test("reserved admin UI and requester-bound link decisions execute the exact saved mutation", async () => {
  for (const actorId of ["admin UI", "link"]) {
    const f = await fixture();
    const id = await ask(f);
    assert.equal((await decide(f, id, { actorId })).ok, true);
    assert.match(await readFile(f.file, "utf8"), /Preserve this exact approved rule/);
  }
  const f = await fixture();
  const id = await ask(f);
  assert.equal((await decide(f, id, { actorId: "U_UNKNOWN_APPROVER" })).ok, false);
});

test("restart during claimed execution records uncertainty and never replays the append", async () => {
  const f = await fixture();
  const id = await ask(f);
  transitionApprovalRequest(id, "pending", "executing", { decidedBy: f.authorId });
  const recovered = recoverInterruptedApprovalExecutions();
  assert.ok(recovered.failed >= 1);
  assert.equal(getApprovalRequest(id).status, "failed");
  assert.match(getApprovalRequest(id).error, /uncertain/);
  assert.equal(lookupApproval(id).entry, null);
  assert.equal(await readFile(f.file, "utf8"), "Existing instructions.\n");
});

test("unreviewable rule text and malformed saved actions are refused", async () => {
  const f = await fixture();
  for (const text of ["", "x".repeat(2401), "```hidden fence``` "]) {
    await assert.rejects(prepareInstructionApproval(f.ctx, { text }));
  }
  await assert.rejects(prepareInstructionApproval(f.ctx, { text: "A rule.", mode: "invalid" }));
  const action = await prepareInstructionApproval(f.ctx, { text: "x".repeat(2400) });
  const invalid = await executeInstructionApproval({ status: "pending", action });
  assert.equal(invalid.ok, false);
  assert.equal(f.posted.length, 0);
});

test("the approved canonical AGENTS sibling is preserved and a changed link target invalidates approval", async () => {
  const f = await fixture();
  const agents = path.join(f.workDir, "AGENTS.md");
  const { unlink } = await import("node:fs/promises");
  await unlink(f.file);
  await writeFile(agents, "Canonical instructions.\n");
  await symlink("AGENTS.md", f.file);
  const id = await ask(f);
  assert.equal((await decide(f, id)).ok, true);
  assert.match(await readFile(agents, "utf8"), /Preserve this exact/);
  const pending = await ask(f, { text: "- Another instruction." });
  await unlink(f.file);
  await writeFile(f.file, "Different target.\n");
  assert.equal((await decide(f, pending)).ok, false);
  assert.equal(await readFile(f.file, "utf8"), "Different target.\n");
});
