import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const store = await import("../src/config/store.js");
const { prepareEgressHost, addApprovedEgressHost } = await import("../src/gateway/egress-hosts.js");
const { canResolveApproval } = await import("../src/slack/approvals.js");
const cp = await import("../src/gateway/control-plane-approvals.js");
const MEMBER = "U_EGRESS_MEMBER";
const TEAMMATE = "U_EGRESS_TEAMMATE";
const STRANGER = "U_EGRESS_STRANGER";
await store.setUser(MEMBER, { approved: true, isAdmin: false });
await store.setUser(TEAMMATE, { approved: true, isAdmin: false });
let sequence = 0;
const publicLookup = async () => [{ address: "8.8.8.8", family: 4 }];

async function fixture(patch = {}) {
  const channelId = `C_EGRESS_HOST_${++sequence}`;
  const entry = await store.upsertChannelEntry(channelId, { name: `egress-host-${sequence}`, type: "channel", isDM: false });
  await store.saveChannelMeta(entry.slug, {
    channelId, access: "approved", allowBash: true, allowNetwork: true,
    managers: "admins", egressRawHosts: ["existing.example.com"], model: "preserved-model", ...patch,
  });
  return { channelId, slug: entry.slug, createdBy: MEMBER, principalTrusted: true, threadKey: "1700000000.000100" };
}

test("a non-admin worker can request and append an exact host while preserving channel settings", async () => {
  const ctx = await fixture();
  const prepared = await prepareEgressHost(ctx, "SSH.EXAMPLE.COM", { lookup: publicLookup });
  assert.deepEqual(prepared, { host: "ssh.example.com", alreadyAllowed: false });
  assert.deepEqual((await store.getChannelMeta(ctx.slug)).egressRawHosts, ["existing.example.com"], "preparation never grants access");
  assert.equal(await addApprovedEgressHost(ctx, prepared.host, { lookup: publicLookup }), prepared.host);
  await addApprovedEgressHost(ctx, prepared.host, { lookup: publicLookup });
  const meta = await store.getChannelMeta(ctx.slug);
  assert.deepEqual(meta.egressRawHosts, ["existing.example.com", "ssh.example.com"]);
  assert.equal(meta.model, "preserved-model");
  assert.equal(meta.managers, "admins");
});

test("untrusted principals, unauthorized users, read mode and network-off cannot request or add hosts", async () => {
  for (const [patch, context] of [
    [{}, { createdBy: STRANGER }], [{}, { principalTrusted: false }],
    [{ allowBash: false }, {}], [{ allowNetwork: false }, {}],
  ]) {
    const ctx = { ...await fixture(patch), ...context };
    await assert.rejects(prepareEgressHost(ctx, "ssh.example.com", { lookup: publicLookup }), /write access|Network access is off/);
    await assert.rejects(addApprovedEgressHost(ctx, "ssh.example.com", { lookup: publicLookup }), /write access|Network access is off/);
    assert.deepEqual((await store.getChannelMeta(ctx.slug)).egressRawHosts, ["existing.example.com"]);
  }
});

test("wildcards, URLs and ports are refused before DNS; private and mixed DNS answers never grant raw egress", async () => {
  const ctx = await fixture();
  const unexpectedLookup = async () => { assert.fail("invalid host must not reach DNS"); };
  for (const host of ["*.example.com", "https://ssh.example.com", "ssh.example.com:22", "ssh.example.com/path", "8.8.8.8", "127.0.0.1", "::1"]) {
    await assert.rejects(prepareEgressHost(ctx, host, { lookup: unexpectedLookup }), /exact hostname/);
  }
  for (const addresses of [
    [{ address: "192.168.1.5", family: 4 }],
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "169.254.169.254", family: 4 }],
    [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }],
  ]) {
    await assert.rejects(addApprovedEgressHost(ctx, "mixed.example.com", { lookup: async () => addresses }), /which channels may not reach/);
  }
  assert.deepEqual((await store.getChannelMeta(ctx.slug)).egressRawHosts, ["existing.example.com"]);
});

test("concurrent approved hosts append atomically and retain both grants", async () => {
  const ctx = await fixture();
  await Promise.all([
    addApprovedEgressHost(ctx, "first.example.com", { lookup: publicLookup }),
    addApprovedEgressHost(ctx, "second.example.com", { lookup: publicLookup }),
  ]);
  const meta = await store.getChannelMeta(ctx.slug);
  assert.deepEqual(new Set(meta.egressRawHosts), new Set(["existing.example.com", "first.example.com", "second.example.com"]));
  assert.equal(meta.model, "preserved-model");
});

test("mode, network and requester-access changes during DNS resolution abort the approved append", async () => {
  for (const patch of [{ allowBash: false }, { allowNetwork: false }, { excludedUsers: [MEMBER] }]) {
    const ctx = await fixture();
    const lookup = async () => {
      await store.patchChannelMeta(ctx.slug, patch);
      return publicLookup();
    };
    await assert.rejects(addApprovedEgressHost(ctx, "stale.example.com", { lookup }), /no longer permits SSH egress|no longer has write access/);
    assert.deepEqual((await store.getChannelMeta(ctx.slug)).egressRawHosts, ["existing.example.com"]);
  }
});

test("worker approval tier admits another authorized member without channel-management rights and rechecks write access", async () => {
  const ctx = await fixture();
  const entry = { channelId: ctx.channelId, slug: ctx.slug, authorId: MEMBER, requiredTier: "worker" };
  const teammate = await canResolveApproval(entry, TEAMMATE);
  assert.equal(teammate.allowed, true);
  assert.equal(teammate.clickerCanManage, false);
  assert.equal(teammate.meetsTier, true);
  assert.equal((await canResolveApproval(entry, STRANGER)).meetsTier, false);
  await store.patchChannelMeta(ctx.slug, { allowBash: false });
  assert.equal((await canResolveApproval(entry, TEAMMATE)).meetsTier, false);
});

test("durable worker executor revalidates the requester and approver before invoking the saved action", async () => {
  const ctx = await fixture();
  const action = cp.buildControlPlaneAction(ctx, { tool: "allow_channel_ssh_host", args: { host: "ssh.example.com" }, tier: "worker" });
  const record = { id: "egress-worker-approval", status: "executing", channelId: ctx.channelId, slug: ctx.slug, authorId: MEMBER, decidedBy: TEAMMATE, action };
  const calls = [];
  cp.setControlPlaneInvoker(async (call) => { calls.push(call); return { ok: true, text: "Allowed" }; });
  try {
    assert.equal((await cp.executeControlPlaneApproval(record)).ok, true);
    assert.equal(calls.length, 1);
    assert.equal((await cp.executeControlPlaneApproval({ ...record, decidedBy: STRANGER })).ok, false);
    await store.patchChannelMeta(ctx.slug, { excludedUsers: [MEMBER] });
    assert.equal((await cp.executeControlPlaneApproval(record)).ok, false);
    assert.equal(calls.length, 1, "revoked principals never reach the invoker");
    await store.patchChannelMeta(ctx.slug, { excludedUsers: [], allowBash: false });
    assert.equal((await cp.executeControlPlaneApproval({ ...record, decidedBy: "admin UI" })).ok, false, "admin UI cannot revive a read-only request");
    assert.equal(calls.length, 1);
  } finally {
    cp.__resetControlPlaneApprovals();
  }
});
