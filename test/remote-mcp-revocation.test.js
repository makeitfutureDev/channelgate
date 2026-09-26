// When a relayed remote MCP grant (src/mcp/remote-mcp-registry.js) is dropped BEFORE its
// capability expires: a cold turn's grant goes when the turn settles, and a person clearing their
// own Composio/Toolbox token in the admin UI drops every grant minted for their runs at once.
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.env.PATH = `${path.join(projectRoot, "test", "fixtures", "prompt-echo")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
const scratch = ensureTestEnv();
const { useFakeRuntime } = await import("./runtime-fake.js");
await useFakeRuntime();
process.env.CG_WORKSPACE_DIR = path.join(scratch, "relay-revocation-workspaces");

const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage } = await import("../src/gateway/run.js");
const { effectiveWorkDir } = await import("../src/gateway/folders.js");
const { hasRemoteMcps, registerRemoteMcps, remoteMcpRegistryStats, clearRemoteMcpsWhere } = await import("../src/mcp/remote-mcp-registry.js");
const { createUsersRouter } = await import("../src/web/routes/users.js");

const SERVER = { "composio-user": { url: "https://connect.composio.dev/mcp", headers: { "x-consumer-api-key": "ck_revocation" } } };

test("a cold container turn's relay grant exists while it runs and is gone once it settles", async () => {
  saveSettings({ engine: "claude", agentMemory: false, memoryReviewEvery: 0, composioMode: "personal", defaultComposioToken: "ak_org_relay" });
  await setUser("U_RELAY_COLD", { name: "Relay Cold", approved: true, isAdmin: false, composioToken: "ak_user_relay" });
  const entry = await upsertChannelEntry("C_RELAY_COLD", { name: "relay-cold", type: "channel" });
  const meta = { channelId: "C_RELAY_COLD", name: "relay-cold", type: "channel", template: "custom", engine: "claude", cleanMode: false, allowNetwork: false, memory: false };
  await saveChannelMeta(entry.slug, meta);
  await mkdir(effectiveWorkDir(entry.slug, meta), { recursive: true });
  clearRemoteMcpsWhere(() => true);

  // Sample the registry while the (fixture) engine process runs: the turn mints after admission
  // and the engine is a real child process, so the grant is observable for its whole life.
  let peak = 0;
  const sampler = setInterval(() => { peak = Math.max(peak, remoteMcpRegistryStats().servers); }, 1);
  let result;
  try {
    result = await runMessage({ channelId: "C_RELAY_COLD", authorId: "U_RELAY_COLD", text: "hello", threadKey: "9300.001", origin: "slack_foreground", preferCold: true });
  } finally {
    clearInterval(sampler);
  }
  assert.match(result.content, /hello$/);
  assert.equal(peak, 2, "both Composio identities were relayed during the turn");
  assert.deepEqual(remoteMcpRegistryStats(), { registrations: 0, servers: 0, sweeping: false }, "and released when the cold turn settled");
});

test("clearing a person's token in the admin UI drops every relay grant minted for their runs", async (t) => {
  clearRemoteMcpsWhere(() => true);
  const exp = Date.now() + 60_000;
  registerRemoteMcps({ jti: "revoke-mine-1", exp, servers: SERVER, meta: { authorId: "U_REVOKE", slug: "a", channelId: "C_A", origin: "slack_foreground" } });
  registerRemoteMcps({ jti: "revoke-mine-2", exp, servers: SERVER, meta: { authorId: "U_REVOKE", slug: "b", channelId: "C_B", origin: "ssh_session" } });
  registerRemoteMcps({ jti: "revoke-other", exp, servers: SERVER, meta: { authorId: "U_SOMEONE_ELSE", slug: "a", channelId: "C_A", origin: "slack_foreground" } });
  await setUser("U_REVOKE", { name: "Revoke", composioToken: "ak_before", toolboxToken: "tb_before" });

  const app = express();
  app.use(express.json());
  app.use("/api", createUsersRouter());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const put = (body) => fetch(`http://127.0.0.1:${server.address().port}/api/users/U_REVOKE`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  assert.equal((await put({ name: "Revoke renamed" })).status, 200);
  assert.ok(hasRemoteMcps("revoke-mine-1"), "an unrelated edit revokes nothing");
  assert.equal((await put({ clearToolboxToken: true })).status, 200);
  assert.ok(!hasRemoteMcps("revoke-mine-1") && !hasRemoteMcps("revoke-mine-2"), "every grant for that author, in every channel and origin");
  assert.ok(hasRemoteMcps("revoke-other"), "nobody else's grant");
  clearRemoteMcpsWhere(() => true);
});
