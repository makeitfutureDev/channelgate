import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const {
  requestApproval,
  handleApprovalClick,
  setApprovalClient,
  setDurableApprovalExecutor,
} = await import("../src/slack/approvals.js");
const {
  approvalActionKey,
  createApprovalRequest,
  getApprovalRequest,
  recoverInterruptedApprovalExecutions,
  transitionApprovalRequest,
} = await import("../src/gateway/approval-requests.js");
const { getDb, toJson } = await import("../src/db/index.js");

const CHANNEL = "C_DURABLE_APPROVAL";
const SLUG = "durable-approval";
const ADMIN = "U_DURABLE_ADMIN";

await setUser(ADMIN, { name: "Durable Admin", approved: true, isAdmin: true });
await upsertChannelEntry(CHANNEL, { name: SLUG, type: "channel", isDM: false });
await saveChannelMeta(SLUG, { channelId: CHANNEL, access: "approved", autoMode: true });

function fakeClient() {
  const posted = [];
  const updates = [];
  return {
    posted,
    updates,
    chat: {
      postMessage: async (payload) => {
        posted.push(payload);
        return { ts: `1800.${posted.length}` };
      },
      postEphemeral: async () => {},
      update: async (payload) => updates.push(payload),
    },
  };
}

const durableAction = (command) => ({
  kind: "background_shell",
  channelId: CHANNEL,
  slug: SLUG,
  authorId: ADMIN,
  threadKey: "1700.100",
  command,
  label: "durable shell test",
  maxMs: 60_000,
});

function cardId(client) {
  return client.posted.at(-1).blocks.find((block) => block.type === "actions").elements[0].value;
}

test("background-shell approval returns immediately and an after-restart click executes it once", async () => {
  const client = fakeClient();
  setApprovalClient(client);
  const decision = await requestApproval(null, {
    channelId: CHANNEL,
    slug: SLUG,
    authorId: ADMIN,
    threadKey: "1700.100",
    toolName: "Background shell job (unsandboxed)",
    toolInput: { details: "$ echo durable" },
    approvalType: "agent",
    requiredTier: "admin",
    approveText: "Run it",
    denyText: "Deny",
    durableAction: durableAction("echo durable"),
  });

  assert.equal(decision.pending, true);
  assert.equal(decision.allow, false);
  assert.equal(client.posted.length, 1);
  const id = cardId(client);
  assert.equal((await getApprovalRequest(id)).status, "pending");

  // The executor is process-local and is registered again at boot. Installing it only after the
  // request simulates the original daemon disappearing before the Slack click.
  const executed = [];
  setDurableApprovalExecutor(async (record) => {
    executed.push(record);
    return { ok: true, id: "job-durable-1", label: "durable shell test" };
  });
  await handleApprovalClick({
    ack: async () => {},
    body: { user: { id: ADMIN }, channel: { id: CHANNEL }, message: { ts: client.posted[0].ts } },
    action: { action_id: "cg_approve", value: id },
    client,
  });

  assert.equal(executed.length, 1);
  assert.equal(executed[0].action.command, "echo durable");
  assert.equal((await getApprovalRequest(id)).status, "consumed");

  // Single-use: replaying the same Slack action never executes the command twice.
  await handleApprovalClick({
    ack: async () => {},
    body: { user: { id: ADMIN }, channel: { id: CHANNEL }, message: { ts: client.posted[0].ts } },
    action: { action_id: "cg_approve", value: id },
    client,
  });
  assert.equal(executed.length, 1);
});

test("the same exact pending shell action reuses its durable card; a different command does not", async () => {
  const client = fakeClient();
  setApprovalClient(client);
  const ask = (command) => requestApproval(null, {
    channelId: CHANNEL,
    slug: SLUG,
    authorId: ADMIN,
    threadKey: "1700.200",
    toolName: "Background shell job (unsandboxed)",
    toolInput: { details: `$ ${command}` },
    approvalType: "agent",
    requiredTier: "admin",
    approveText: "Run it",
    denyText: "Deny",
    durableAction: { ...durableAction(command), threadKey: "1700.200" },
  });

  const first = await ask("echo same");
  const repeated = await ask("echo same");
  const different = await ask("echo different");
  assert.equal(first.approvalId, repeated.approvalId);
  assert.notEqual(first.approvalId, different.approvalId);
  assert.equal(client.posted.length, 2, "only the distinct exact command gets another card");
});

test("boot recovery consumes a claimed approval with a recorded job and fails closed without proof", () => {
  const makeExecuting = (id, command) => {
    const action = durableAction(command);
    createApprovalRequest({
      id,
      actionKey: approvalActionKey(action),
      status: "pending",
      channelId: CHANNEL,
      slug: SLUG,
      authorId: ADMIN,
      threadKey: action.threadKey,
      toolName: "Background shell job (unsandboxed)",
      action,
    });
    transitionApprovalRequest(id, "pending", "executing", { decidedBy: ADMIN });
  };

  makeExecuting("approval-with-job", "echo recorded");
  makeExecuting("approval-without-job", "echo retry");
  getDb().prepare("INSERT INTO bg_jobs(id, data) VALUES(?, ?)").run(
    "recorded-job",
    toJson({ id: "recorded-job", approvalId: "approval-with-job", label: "recorded shell" }),
  );

  assert.deepEqual(recoverInterruptedApprovalExecutions(), { consumed: 1, failed: 1 });
  assert.equal(getApprovalRequest("approval-with-job").status, "consumed");
  assert.equal(getApprovalRequest("approval-with-job").jobId, "recorded-job");
  assert.equal(getApprovalRequest("approval-without-job").status, "failed");
});
