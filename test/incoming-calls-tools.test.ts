import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { createGatewayMcpServer, ctxFromClaims, createDirectDaemonIpc } = await import("../src/mcp/gateway-server.js");
const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { getDb } = await import("../src/db/index.js");
const { createIncomingCalls, __setIncomingCallsForTests } = await import("../src/gateway/voice/incoming.ts");
const { executeControlPlaneApproval, setControlPlaneInvoker, __resetControlPlaneApprovals } = await import("../src/gateway/control-plane-approvals.js");
const pushConfig = { enabled: true, teamId: "ABCDE12345", keyId: "FGHIJ67890", bundleId: "com.example.calls", privateKey: "test-key" };
const phone = { platform: "ios", kind: "voip", token: "ab".repeat(32), bundleId: pushConfig.bundleId, environment: "sandbox", name: "Test phone" };
// A service whose configuration, access and Apple response the test controls; the gate and the tool use it.
function service({ configured = true, status = 200 } = {}) {
  const pushes: unknown[] = [];
  const calls = createIncomingCalls({ config: () => ({ ...pushConfig, enabled: configured }), voiceEnabled: () => true, authorize: async () => true,
    send: async (_config, _device, payload) => { pushes.push(payload); return { status, reason: "" }; }, notify: async () => {} });
  __setIncomingCallsForTests(calls);
  return { calls, pushes };
}
beforeEach(() => { getDb().exec("DELETE FROM user_devices; DELETE FROM incoming_calls;"); });
afterEach(() => { __setIncomingCallsForTests(); __resetControlPlaneApprovals(); });
async function connect(claims: Record<string, unknown>, approval: (value: never) => Promise<unknown>) {
  const ctx = ctxFromClaims({ threadKey: "1700000000.000001", engine: "claude", principalTrusted: true, toolset: "full", ...claims }, { daemon: createDirectDaemonIpc({ approval }) });
  const server = createGatewayMcpServer(ctx), client = new Client({ name: "incoming-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  return { ctx, server, client, close: async () => { await client.close(); await server.close(); } };
}
async function member(actor: string, channel: string) {
  await setUser(actor, { approved: true, isAdmin: true });
  const entry = await upsertChannelEntry(channel, { name: channel.toLowerCase(), type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, { channelId: channel, type: "channel", isDM: false, mode: "admin", autoMode: true });
  return entry.slug;
}
for (const engine of ["claude", "codex"]) {
  test(`${engine}: call_user binds approval to the current author/thread and cannot ring before approval`, async () => {
    const actor = "U_CALLER", channel = "C_CALLS";
    await setUser(actor, { approved: true, isAdmin: true });
    const entry = await upsertChannelEntry(channel, { name: "calls", type: "channel", isDM: false });
    await saveChannelMeta(entry.slug, { channelId: channel, type: "channel", isDM: false, mode: "admin", autoMode: true });
    service().calls.registerDevice(actor, phone);
    const approvals: {toolName: string; requiredTier: string; durableAction: { authorId: string; channelId: string; threadKey: string; args: { reason: string; in_minutes: number }}}[] = [];
    const ctx = ctxFromClaims({ channelId: channel, slug: entry.slug, authorId: actor, threadKey: "1700000000.000001", engine,
      principalTrusted: true, toolset: "full" }, { daemon: createDirectDaemonIpc({ approval: async (value: typeof approvals[number]) => {
        approvals.push(value); return { pending: true, approvalId: "call-card" };
      } }) });
    const server = createGatewayMcpServer(ctx), client = new Client({ name: "incoming-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
    try {
      assert.ok((await client.listTools()).tools.some(tool => tool.name === "call_user"));
      const result = await client.callTool({ name: "call_user", arguments: { reason: "Review", in_minutes: 1, ownerId: "FORGED", channelId: "C_OTHER" } });
      assert.match(JSON.stringify(result), /awaiting approval/);
      assert.equal(approvals.length, 1); assert.equal(approvals[0].requiredTier, "owner");
      assert.equal(approvals[0].durableAction.authorId, actor);
      assert.equal(approvals[0].durableAction.channelId, channel);
      assert.equal(approvals[0].durableAction.threadKey, "1700000000.000001");
      assert.deepEqual(approvals[0].durableAction.args, { reason: "Review", in_minutes: 1 });
      assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM incoming_calls").get()?.n, 0);
    } finally { await client.close(); await server.close(); }
  });
}
test("API principals cannot request incoming calls or create an approval card", async () => {
  let approvals = 0;
  const ctx = ctxFromClaims({ channelId: "C_CALLS", slug: "calls", authorId: "api", threadKey: "1700000000.000001", engine: "claude", principalTrusted: false, toolset: "full" },
    { daemon: createDirectDaemonIpc({ approval: async () => { approvals++; return { allow: true }; } }) });
  const server = createGatewayMcpServer(ctx), client = new Client({ name: "incoming-api", version: "1" });
  const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  try { await client.callTool({ name: "call_user", arguments: { reason: "No" } }); assert.equal(approvals, 0); }
  finally { await client.close(); await server.close(); }
});
for (const [name, setup, expected] of [
  ["incoming calls are not configured", () => { service({ configured: false }).calls.registerDevice("U_PRE", phone); }, /not configured/],
  ["no iPhone is registered", () => { service(); }, /No iPhone registered/],
  ["a call is already pending", async () => { const s = service(); s.calls.registerDevice("U_PRE", phone); await s.calls.request({ ownerId: "U_PRE", channelId: "C_PRE", threadTs: "1700000000.000001" }, "Earlier", 30); }, /pending or the call limit/],
] as const) {
  test(`call_user posts no approval card when ${name}`, async () => {
    const slug = await member("U_PRE", "C_PRE"); await setup();
    let approvals = 0;
    const session = await connect({ channelId: "C_PRE", slug, authorId: "U_PRE" }, async () => { approvals++; return { pending: true, approvalId: "never" }; });
    try {
      const result = await session.client.callTool({ name: "call_user", arguments: { reason: "Review" } });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), expected);
      assert.match(JSON.stringify(result), /No approval card was posted/);
      assert.doesNotMatch(JSON.stringify(result), /awaiting approval/);
      assert.equal(approvals, 0);
    } finally { await session.close(); }
  });
}
test("an approved call that cannot be placed is reported on the card as failed, a placed one as applied", async () => {
  const slug = await member("U_APPLY", "C_APPLY");
  const saved: { durableAction: Record<string, unknown> }[] = [];
  let live = service(); live.calls.registerDevice("U_APPLY", phone);
  const session = await connect({ channelId: "C_APPLY", slug, authorId: "U_APPLY" }, async (value: never) => { saved.push(value); return { pending: true, approvalId: "card" }; });
  try {
    assert.match(JSON.stringify(await session.client.callTool({ name: "call_user", arguments: { reason: "Review" } })), /awaiting approval/);
  } finally { await session.close(); }
  assert.equal(saved.length, 1);
  // The daemon applies the saved call on the click, exactly as src/server.js wires it.
  type Approved = { invokeApproved: (tool: string, args: unknown) => Promise<unknown> };
  setControlPlaneInvoker(async ({ tool, args, channelId, slug: channelSlug, authorId, threadKey }: Record<string, never>) =>
    (createGatewayMcpServer(ctxFromClaims({ channelId, slug: channelSlug, authorId, threadKey, origin: "approval", principalTrusted: true, toolset: "full" })) as unknown as Approved).invokeApproved(tool, args));
  const approval = { id: "card", status: "executing", action: saved[0].durableAction, channelId: "C_APPLY", slug, authorId: "U_APPLY", decidedBy: "U_APPLY" };
  // Apple refuses between the request and the click: the card must not say "applied".
  live = service({ status: 500 }); live.calls.registerDevice("U_APPLY", phone);
  const refused = await executeControlPlaneApproval(approval);
  assert.equal(refused.ok, false);
  assert.match(String(refused.error), /Couldn't place the call: Apple did not accept/);
  getDb().exec("DELETE FROM incoming_calls");
  live = service(); live.calls.registerDevice("U_APPLY", phone);
  const placed = await executeControlPlaneApproval(approval);
  assert.equal(placed.ok, true, JSON.stringify(placed));
  assert.match(String(placed.message), /invitation sent to 1 registered iPhone/);
  assert.equal(live.pushes.length, 1);
});
