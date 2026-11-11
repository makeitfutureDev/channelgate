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
  for (const host of ["*.example.com", "https://ssh.example.com", "ssh.example.com:22", "sql.example.com:1433", "ssh.example.com/path"]) {
    await assert.rejects(prepareEgressHost(ctx, host, { lookup: unexpectedLookup }), /exact hostname/);
  }
  for (const host of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fc00::1", "::ffff:127.0.0.1"]) {
    await assert.rejects(prepareEgressHost(ctx, host, { lookup: unexpectedLookup }), /which channels may not reach/);
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


test("public IPv4 and IPv6 literals are approved without DNS and become raw tunnels", async () => {
  const ctx = await fixture();
  const { rawPassthroughFor } = await import("../src/gateway/egress/service.js");
  const { checkDestination } = await import("../src/gateway/egress/policy.js");
  const { assertValidEgressRawHosts, isValidRuleHost, assertValidSwapRuleFields } = await import("../src/gateway/egress/catalog-rules.js");
  const lookup = async () => assert.fail("IP literals must not require DNS");
  for (const host of ["8.8.8.8", "2001:4860:4860::8888"]) {
    const prepared = await prepareEgressHost(ctx, host, { lookup });
    assert.equal(prepared.host, host);
    assert.equal(prepared.alreadyAllowed, false);
    await addApprovedEgressHost(ctx, host, { lookup });
    const meta = await store.getChannelMeta(ctx.slug);
    const rawPassthrough = rawPassthroughFor(meta);
    assert.ok(rawPassthrough.some(rule => rule.host === host && rule.port === 22));
    const on = await checkDestination({ hostname: host, port: 22, mode: "on", rawPassthrough, lookup });
    assert.equal(on.ok, true);
    assert.equal(on.tunnel, true, "the proxy must bypass TLS for an approved SSH IP");
    const off = await checkDestination({ hostname: host, port: 22, mode: "off", rawPassthrough, lookup });
    assert.equal(off.ok, false);
    assert.equal(isValidRuleHost(host), false, "secret-host declarations remain DNS-only");
    assert.throws(() => assertValidSwapRuleFields({ hosts: [host] }));
  }
  assert.deepEqual(assertValidEgressRawHosts(["[2001:4860:4860::8888]", "8.8.8.8"]), ["2001:4860:4860::8888", "8.8.8.8"]);
  for (const host of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "fc00::1", "::1", "::ffff:127.0.0.1", "999.1.1.1", "8.8.8.8:22", "2001:4860:4860::8888%eth0"]) {
    assert.throws(() => assertValidEgressRawHosts([host]), /not a raw destination/);
    assert.ok(!rawPassthroughFor({ egressRawHosts: [host] }).some(rule => rule.host === host));
  }
});

test("an admin-scoped Azure SQL destination opens only 1433 while network is on", async () => {
  const { rawPassthroughFor } = await import("../src/gateway/egress/service.js");
  const { checkDestination } = await import("../src/gateway/egress/policy.js");
  const { assertValidEgressRawHosts } = await import("../src/gateway/egress/catalog-rules.js");
  const hosts = assertValidEgressRawHosts(["SQL.Example.Com:1433"]);
  assert.deepEqual(hosts, ["sql.example.com:1433"]);
  const rawPassthrough = rawPassthroughFor({ egressRawHosts: hosts });
  assert.deepEqual(rawPassthrough, [
    { host: "github.com", port: 22 },
    { host: "sql.example.com", port: 1433 },
  ]);
  const destination = { hostname: "sql.example.com", port: 1433, rawPassthrough, lookup: publicLookup };
  assert.deepEqual((await checkDestination({ ...destination, mode: "on" })).tunnel, true);
  assert.equal((await checkDestination({ ...destination, mode: "off" })).ok, false);
  assert.equal((await checkDestination({ ...destination, port: 5432, mode: "on" })).tunnel, false);
  for (const invalid of ["*.database.windows.net:1433", "localhost:1433", "10.0.0.1:1433", "sql.example.com:1434", "sql.example.com:22"]) {
    assert.throws(() => assertValidEgressRawHosts([invalid]), /not a raw destination/);
    assert.deepEqual(rawPassthroughFor({ egressRawHosts: [invalid] }), [{ host: "github.com", port: 22 }]);
  }
});


test("scoped SQL grants preserve legacy hosts, IPv6 literals and pinned public-address checks", async () => {
  const { rawPassthroughFor } = await import("../src/gateway/egress/service.js");
  const { checkDestination } = await import("../src/gateway/egress/policy.js");
  const { assertValidEgressRawHosts } = await import("../src/gateway/egress/catalog-rules.js");
  const hosts = assertValidEgressRawHosts([
    "SSH.EXAMPLE.COM.", "[2001:4860:4860::8888]:1433", "SQL.Example.Com.:1433", "sql.example.com:1433",
  ]);
  assert.deepEqual(hosts, ["ssh.example.com", "[2001:4860:4860::8888]:1433", "sql.example.com:1433"]);
  const rawPassthrough = rawPassthroughFor({ egressRawHosts: hosts });
  assert.deepEqual(rawPassthrough.filter(rule => rule.host === "ssh.example.com").map(rule => rule.port), [22, 5432, 6543]);
  assert.deepEqual(rawPassthrough.filter(rule => rule.host === "2001:4860:4860::8888"), [{ host: "2001:4860:4860::8888", port: 1433 }]);
  const ipv6 = await checkDestination({ hostname: "2001:4860:4860::8888", port: 1433, mode: "on", rawPassthrough,
    lookup: async () => assert.fail("literal IP must not use DNS") });
  assert.equal(ipv6.tunnel, true);
  const destination = { hostname: "sql.example.com", port: 1433, mode: "on", rawPassthrough };
  const allowed = await checkDestination({ ...destination, lookup: publicLookup });
  assert.equal(allowed.address, "8.8.8.8", "upstream dials the policy's pinned address");
  for (const addresses of [
    [{ address: "10.0.0.1", family: 4 }],
    [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }],
  ]) {
    assert.equal((await checkDestination({ ...destination, lookup: async () => addresses })).category, "blocked-address");
  }
  assert.equal((await checkDestination({ ...destination, hostname: "other.example.com", lookup: publicLookup })).tunnel, false);
  const ctx = await fixture({ egressRawHosts: hosts });
  await addApprovedEgressHost(ctx, "new-ssh.example.com", { lookup: publicLookup });
  assert.deepEqual((await store.getChannelMeta(ctx.slug)).egressRawHosts, [...hosts, "new-ssh.example.com"]);
});
