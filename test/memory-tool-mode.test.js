import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { setUser, upsertChannelEntry, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");
const { effectiveWorkDir } = await import("../src/gateway/folders.js");
const { createGatewayMcpServer, ctxFromClaims } = await import("../src/mcp/gateway-server.js");
const { mintGatewayCapability, verifyGatewayCapability } = await import("../src/gateway/mcp-capability.js");
const text = (result) => result.content.map((entry) => entry.text || "").join("\n");
let sequence = 0;

async function fixture(t, engine, { adminMode = true, memory = true, admin = true, principal = "human", toolset = "full" } = {}) {
  const channelId = `C_MEMORY_MODE_${++sequence}`;
  const authorId = principal === "agent" ? "agent:memory-source" : principal === "api" ? "api" : `U_MEMORY_MODE_${sequence}`;
  if (principal === "human") await setUser(authorId, { approved: true, isAdmin: admin });
  const { slug } = await upsertChannelEntry(channelId, { name: `memory-mode-${sequence}`, type: "channel", isDM: false });
  const meta = { channelId, isDM: false, type: "channel", adminMode, cleanMode: true, memory };
  await saveChannelMeta(slug, meta);
  const cwd = effectiveWorkDir(slug, { ...meta, cleanMode: false });
  await mkdir(cwd, { recursive: true });
  await writeFile(path.join(cwd, "MEMORY.md"), "# Channel memory\n\n## Environment\n- Release meetings happen Friday.\n");
  const secret = "memory-mode-test-secret";
  const token = mintGatewayCapability({ secret, channelId, slug, authorId, threadKey: "1.000", engine,
    origin: toolset === "memory-review" ? "memory_review" : "slack_foreground", principalTrusted: principal !== "api", toolset });
  const verified = verifyGatewayCapability(token, { secret });
  assert.equal(verified.ok, true);
  const server = createGatewayMcpServer(ctxFromClaims(verified.claims));
  const client = new Client({ name: "memory-mode", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, cwd, slug, authorId };
}

async function memoryCalls(client) {
  return Promise.all([
    client.callTool({ name: "search_channel_memory", arguments: { query: "Friday", isAdminAuthor: true, cleanMode: false } }).then(text),
    client.callTool({ name: "read_channel_memory", arguments: { source: "MEMORY.md", isAdminAuthor: true } }).then(text),
    client.callTool({ name: "update_channel_memory", arguments: { action: "add", text: "The project uses release checklists.", section: "Environment", isAdminAuthor: true } }).then(text),
  ]);
}

for (const engine of ["claude", "codex"]) {
  test(`${engine}: trusted admin in Admin + saved Lean can search, read and save memory`, async (t) => {
    const { client, cwd, slug } = await fixture(t, engine);
    const [search, read, save] = await memoryCalls(client);
    assert.match(search, /MEMORY.md.*Friday/is);
    assert.match(read, /meetings happen Friday/);
    assert.match(save, /✅ Memory updated/);
    assert.match(await readFile(path.join(cwd, "MEMORY.md"), "utf8"), /release checklists/);
    assert.equal((await getChannelMeta(slug)).cleanMode, true, "effective context never changes saved Lean");
  });

  for (const options of [
    { admin: false },
    { adminMode: false },
    { memory: false },
    { principal: "agent", toolset: "agent-message" },
  ]) {
    test(`${engine}: Lean memory stays disabled for ${JSON.stringify(options)}`, async (t) => {
      const { client, cwd } = await fixture(t, engine, options);
      const before = await readFile(path.join(cwd, "MEMORY.md"), "utf8");
      for (const result of await memoryCalls(client)) assert.match(result, /memory is disabled/i);
      assert.equal(await readFile(path.join(cwd, "MEMORY.md"), "utf8"), before);
    });
  }

  test(`${engine}: current role is rechecked after the capability was issued`, async (t) => {
    const { client, authorId } = await fixture(t, engine);
    await setUser(authorId, { approved: true, isAdmin: false });
    for (const result of await memoryCalls(client)) assert.match(result, /memory is disabled/i);
  });

  test(`${engine}: API admin context uses the same Admin + Lean exception`, async (t) => {
    const { client } = await fixture(t, engine, { principal: "api" });
    const [search, read, save] = await memoryCalls(client);
    assert.match(search, /MEMORY.md.*Friday/is);
    assert.match(read, /meetings happen Friday/);
    assert.match(save, /✅ Memory updated/);
  });

  test(`${engine}: reduced memory reviewer still honors saved Lean`, async (t) => {
    const { client } = await fixture(t, engine, { admin: false, toolset: "memory-review" });
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(tools, ["update_channel_memory"]);
    const result = text(await client.callTool({ name: "update_channel_memory", arguments: { action: "add", text: "The project uses release checklists." } }));
    assert.match(result, /memory is disabled/i);
  });
}
