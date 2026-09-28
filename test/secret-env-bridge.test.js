import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.js";

const bridge = fileURLToPath(new URL("../src/mcp/secret-env-bridge.js", import.meta.url));

test("Codex secret bridge preserves daemon-canonical gateway path context", () => {
  const scratch = tempDir("cg-secret-bridge-");
  const bundle = path.join(scratch, "bundle.json");
  const probe = path.join(scratch, "probe.js");
  writeFileSync(bundle, JSON.stringify({ gatewayCapability: "signed-capability" }), { mode: 0o600 });
  writeFileSync(
    probe,
    "process.stdout.write(JSON.stringify({ fsRoot: process.env.CG_FS_ROOT, workspace: process.env.CG_WORKSPACE_DIR }));\n",
  );

  const fsRoot = path.join(scratch, "daemon-home");
  const workspace = path.join(fsRoot, "Slack Agent");
  const result = spawnSync(
    process.execPath,
    [bridge, bundle, "gatewayCapability", "CG_GATEWAY_CAPABILITY", probe],
    {
      encoding: "utf8",
      env: { ...process.env, CG_FS_ROOT: fsRoot, CG_WORKSPACE_DIR: workspace },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { fsRoot, workspace });
});

test("the broker forwards the socket service selection and path to the bridge it launches", () => {
  const scratch = tempDir("cg-secret-bridge-svc-");
  const bundle = path.join(scratch, "bundle.json");
  const probe = path.join(scratch, "probe.js");
  writeFileSync(bundle, JSON.stringify({ gatewayCapability: "signed-capability" }), { mode: 0o600 });
  writeFileSync(probe, "process.stdout.write(JSON.stringify({ service: process.env.CG_MCP_SERVICE, socket: process.env.CG_MCP_SOCKET, cap: process.env.CG_GATEWAY_CAPABILITY, argv: process.argv.slice(2), other: process.env.SOME_DAEMON_SECRET || '' }));\n");
  const result = spawnSync(process.execPath, [bridge, bundle, "gatewayCapability", "CG_GATEWAY_CAPABILITY", probe, "composio-user"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, CG_MCP_SERVICE: "remote-mcp", CG_MCP_SOCKET: "/run/channelgate/mcp.sock", SOME_DAEMON_SECRET: "never" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { service: "remote-mcp", socket: "/run/channelgate/mcp.sock", cap: "signed-capability", argv: ["composio-user"], other: "" });
});
