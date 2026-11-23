import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const store = await import("../src/config/store.js");
const { checkDestination } = await import("../src/gateway/egress/policy.js");
const ph = await import("../src/gateway/egress/private-hosts.js");
const { preparePrivateHost, addApprovedPrivateHost, removePrivateHost } = await import("../src/gateway/egress-hosts.js");
const { egressPolicyFor } = await import("../src/gateway/egress/service.js");

const MEMBER = "U_PRIV_MEMBER";
await store.setUser(MEMBER, { approved: true, isAdmin: false });
let sequence = 0;
async function fixture(patch = {}) {
  const channelId = `C_PRIV_HOST_${++sequence}`;
  const entry = await store.upsertChannelEntry(channelId, { name: `priv-host-${sequence}`, type: "channel", isDM: false });
  await store.saveChannelMeta(entry.slug, { channelId, access: "approved", allowBash: true, allowNetwork: true, ...patch });
  return { channelId, slug: entry.slug, createdBy: MEMBER, principalTrusted: true, threadKey: "1700000000.000100" };
}
const lookupTo = (...addresses) => async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

test("parse/format: only exact private or loopback pins; metadata, link-local and the admin port never", () => {
  assert.deepEqual(ph.parsePrivateHost("nas.lan:22@192.168.1.10"), { host: "nas.lan", port: 22, address: "192.168.1.10", value: "nas.lan:22@192.168.1.10" });
  assert.equal(ph.parsePrivateHost("[fd00::5]:21@fd00::5").value, "[fd00::5]:21@fd00::5");
  assert.equal(ph.parsePrivateHost(`${ph.LOOPBACK_ALIAS}:8931@127.0.0.1`).host, ph.LOOPBACK_ALIAS);
  assert.ok(ph.parsePrivateHost("tail.example:22@100.88.1.2"), "Tailscale CGNAT is approvable");
  for (const bad of [
    "meta:80@169.254.169.254", "ali:80@100.100.100.200", "ll:22@fe80::1", "nas.lan:22", "*.lan:22@10.0.0.1",
    "10.0.0.1:22@10.0.0.2", "localhost:80@127.0.0.1", "other.name:80@127.0.0.1", `${ph.LOOPBACK_ALIAS}:80@10.0.0.1`,
    `${ph.LOOPBACK_ALIAS}:4747@127.0.0.1`, "nas.lan:0@10.0.0.1", "nas.lan:70000@10.0.0.1",
  ]) assert.equal(ph.parsePrivateHost(bad, { ownPorts: [4747] }), null, bad);
  assert.throws(() => ph.assertValidEgressPrivateHosts(["nas.lan:22@169.254.169.254"]), /not an approvable/);
  assert.deepEqual(ph.assertValidEgressPrivateHosts(["nas.lan:22@10.0.0.1", "nas.lan:22@10.0.0.2"]), ["nas.lan:22@10.0.0.2"], "one pin per host:port, latest wins");
  assert.deepEqual(ph.privateDestinationsFor({ egressPrivateHosts: ["junk", "nas.lan:22@10.0.0.1"] }), [{ host: "nas.lan", port: 22, address: "10.0.0.1" }]);
});

test("policy: a pinned private destination tunnels to its address on its port only, and refuses rebinding", async () => {
  const rules = [{ host: "nas.lan", port: 22, address: "192.168.1.10" }, { host: ph.LOOPBACK_ALIAS, port: 8931, address: "127.0.0.1" }];
  const ok = await checkDestination({ hostname: "nas.lan", port: 22, mode: "on", privateDestinations: rules, lookup: lookupTo("192.168.1.10") });
  assert.deepEqual([ok.ok, ok.address, ok.tunnel], [true, "192.168.1.10", true]);
  const otherPort = await checkDestination({ hostname: "nas.lan", port: 23, mode: "on", privateDestinations: rules, lookup: lookupTo("192.168.1.10") });
  assert.equal(otherPort.category, "blocked-address");
  const moved = await checkDestination({ hostname: "nas.lan", port: 22, mode: "on", privateDestinations: rules, lookup: lookupTo("192.168.1.11") });
  assert.equal(moved.category, "pin-mismatch");
  const mixed = await checkDestination({ hostname: "nas.lan", port: 22, mode: "on", privateDestinations: rules, lookup: lookupTo("192.168.1.10", "10.0.0.9") });
  assert.equal(mixed.category, "pin-mismatch");
  const off = await checkDestination({ hostname: "nas.lan", port: 22, mode: "off", privateDestinations: rules, lookup: lookupTo("192.168.1.10") });
  assert.equal(off.ok, false, "network off still refuses");
  const loop = await checkDestination({ hostname: ph.LOOPBACK_ALIAS, port: 8931, mode: "on", privateDestinations: rules, lookup: async () => assert.fail("alias never reaches DNS") });
  assert.deepEqual([loop.ok, loop.address], [true, "127.0.0.1"]);
  const loopOther = await checkDestination({ hostname: ph.LOOPBACK_ALIAS, port: 4747, mode: "on", privateDestinations: rules });
  assert.equal(loopOther.category, "not-approved");
  const forged = await checkDestination({ hostname: "x.lan", port: 80, mode: "on", privateDestinations: [{ host: "x.lan", port: 80, address: "169.254.169.254" }], lookup: lookupTo("169.254.169.254") });
  assert.equal(forged.category, "blocked-address", "a forged metadata rule is still refused");
});

test("prepare pins one address, add appends it, the policy carries it, revoke removes it", async () => {
  const ctx = await fixture();
  const prepared = await preparePrivateHost(ctx, "NAS.LAN", { port: 22, lookup: lookupTo("192.168.1.10") });
  assert.deepEqual([prepared.host, prepared.port, prepared.address, prepared.alreadyAllowed], ["nas.lan", 22, "192.168.1.10", false]);
  assert.equal((await store.getChannelMeta(ctx.slug)).egressPrivateHosts, undefined, "preparation never grants access");
  await assert.rejects(addApprovedPrivateHost(ctx, "nas.lan", { port: 22, address: "192.168.1.10", lookup: lookupTo("192.168.1.99") }), /not the approved 192\.168\.1\.10/);
  await addApprovedPrivateHost(ctx, "nas.lan", { port: 22, address: "192.168.1.10", lookup: lookupTo("192.168.1.10") });
  const loop = await addApprovedPrivateHost(ctx, "localhost", { port: 8931 });
  assert.equal(loop.host, ph.LOOPBACK_ALIAS);
  assert.deepEqual((await store.getChannelMeta(ctx.slug)).egressPrivateHosts, ["nas.lan:22@192.168.1.10", `${ph.LOOPBACK_ALIAS}:8931@127.0.0.1`]);
  const policy = await egressPolicyFor({ slug: ctx.slug });
  assert.deepEqual(policy.privateDestinations.map((r) => r.host), ["nas.lan", ph.LOOPBACK_ALIAS]);
  assert.deepEqual(await removePrivateHost(ctx, "127.0.0.1"), [`${ph.LOOPBACK_ALIAS}:8931@127.0.0.1`]);
  assert.deepEqual((await store.getChannelMeta(ctx.slug)).egressPrivateHosts, ["nas.lan:22@192.168.1.10"]);
});

test("prepare refuses public, multi-address, metadata, network-off and non-member requests", async () => {
  const ctx = await fixture();
  await assert.rejects(preparePrivateHost(ctx, "pub.example", { port: 22, lookup: lookupTo("8.8.8.8") }), /public address; use allow_channel_ssh_host/);
  await assert.rejects(preparePrivateHost(ctx, "rr.lan", { port: 22, lookup: lookupTo("10.0.0.1", "10.0.0.2") }), /2 addresses/);
  await assert.rejects(preparePrivateHost(ctx, "169.254.169.254", { port: 80 }), /may never reach/);
  await assert.rejects(preparePrivateHost(ctx, "127.0.0.1", { port: Number(process.env.PORT ?? 4747) }), /admin port/);
  await assert.rejects(preparePrivateHost(ctx, "10.0.0.1", {}), /TCP port/);
  await assert.rejects(preparePrivateHost({ ...ctx, createdBy: "U_PRIV_STRANGER" }, "10.0.0.1", { port: 22 }), /write access/);
  await assert.rejects(preparePrivateHost(await fixture({ allowNetwork: false }), "10.0.0.1", { port: 22 }), /Network access is off/);
});
