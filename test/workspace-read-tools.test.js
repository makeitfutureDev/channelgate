import path from "node:path";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const scratch = ensureTestEnv();
const workspaceRoot = path.join(scratch, "workspace-read-root");
const workdir = path.join(workspaceRoot, "project");
const outside = path.join(scratch, "outside-secret.txt");
const slug = "workspace-read";
const channelId = "C_WORKSPACE_READ";
const secret = "workspace-read-secret";
const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { mintGatewayCapability } = await import("../src/gateway/mcp-capability.js");

const resultText = (result) => result.content?.map((item) => item.text || "").join("\n") || "";

async function withGateway(engine, fn, { toolset = "full" } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/mcp/gateway-server.js"],
    cwd: projectRoot,
    stderr: "pipe",
    env: {
      PATH: process.env.PATH || "",
      NODE_ENV: "test",
      CG_TEST_SCRATCH: scratch,
      CHANNELGATE_DIR: scratch,
      CHANNELGATE_DB: path.join(scratch, "gateway.db"),
      CG_GATEWAY_CAPABILITY: mintGatewayCapability({ secret, channelId, slug, authorId: "U_WORKSPACE_READ", threadKey: `${engine}.1`, origin: "slack_foreground", engine }),
      CG_APPROVAL_SECRET: secret,
      CG_FS_ROOT: scratch,
      CG_WORKSPACE_DIR: workspaceRoot,
      CG_TOOLSET: toolset,
      HOME: path.join(scratch, "isolated-home"),
    },
  });
  const client = new Client({ name: `workspace-read-${engine}`, version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

test.before(async () => {
  await mkdir(path.join(workdir, "docs"), { recursive: true });
  await mkdir(path.join(scratch, "isolated-home"), { recursive: true });
  await writeFile(path.join(workdir, "README.md"), "alpha\nneedle here\n");
  await writeFile(path.join(workdir, "docs", "guide.txt"), "another needle\n");
  await writeFile(path.join(workdir, "binary.dat"), Buffer.from([0, 1, 2]));
  await writeFile(path.join(workdir, "oversize.txt"), "x".repeat(64 * 1024 + 1));
  await writeFile(outside, "must not leak\n");
  await symlink(outside, path.join(workdir, "escape.txt"));
  await setUser("U_WORKSPACE_READ", { name: "Workspace Reader", approved: true, isAdmin: false });
  await upsertChannelEntry(channelId, { name: slug, type: "channel", isDM: false });
  await saveChannelMeta(slug, { channelId, platform: "slack", workDir: workdir, allowBash: false, autoMode: false, adminMode: false });
});

for (const engine of ["claude", "codex"]) {
  test(`${engine} receives identical bounded workspace read tools`, async () => {
    await withGateway(engine, async (client) => {
      const listedTools = await client.listTools();
      for (const name of ["workspace_list", "workspace_read", "workspace_search"]) {
        assert.ok(listedTools.tools.some((tool) => tool.name === name), `${name} must be available to ${engine}`);
      }

      const listed = resultText(await client.callTool({ name: "workspace_list", arguments: {} }));
      assert.match(listed, /file\tREADME\.md/);
      assert.match(listed, /dir\tdocs/);
      assert.match(listed, /unavailable\tescape\.txt/);

      const read = resultText(await client.callTool({ name: "workspace_read", arguments: { path: "README.md" } }));
      assert.equal(read, "alpha\nneedle here\n");

      const binary = resultText(await client.callTool({ name: "workspace_read", arguments: { path: "binary.dat" } }));
      assert.match(binary, /refused.*binary/i);

      const oversize = resultText(await client.callTool({ name: "workspace_read", arguments: { path: "oversize.txt" } }));
      assert.match(oversize, /refused.*exceeds/i);

      const search = resultText(await client.callTool({ name: "workspace_search", arguments: { query: "needle" } }));
      assert.match(search, /README\.md:2:needle here/);
      assert.match(search, /docs\/guide\.txt:1:another needle/);

      const traversal = resultText(await client.callTool({ name: "workspace_read", arguments: { path: "../outside-secret.txt" } }));
      assert.match(traversal, /refused.*(?:invalid file path|leaves this channel)/i);
      assert.doesNotMatch(traversal, /must not leak/);

      const escaped = resultText(await client.callTool({ name: "workspace_read", arguments: { path: "escape.txt" } }));
      assert.match(escaped, /refused.*points outside/i);
      assert.doesNotMatch(escaped, /must not leak/);
    });
  });
}

test("reduced memory-review toolset cannot read the workspace", async () => {
  await withGateway("claude", async (client) => {
    const listed = await client.listTools();
    assert.ok(!listed.tools.some((tool) => tool.name.startsWith("workspace_")));
  }, { toolset: "memory-review" });
});
