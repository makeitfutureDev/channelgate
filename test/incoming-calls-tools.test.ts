import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { createGatewayMcpServer, ctxFromClaims, createDirectDaemonIpc } = await import("../src/mcp/gateway-server.js");
const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { getDb } = await import("../src/db/index.js");
for (const engine of ["claude", "codex"]) {
  test(`${engine}: call_user binds approval to the current author/thread and cannot ring before approval`, async () => {
    const actor = "U_CALLER", channel = "C_CALLS";
    await setUser(actor, { approved: true, isAdmin: true });
    const entry = await upsertChannelEntry(channel, { name: "calls", type: "channel", isDM: false });
    await saveChannelMeta(entry.slug, { channelId: channel, type: "channel", isDM: false, mode: "admin", autoMode: true });
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
