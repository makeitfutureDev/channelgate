import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bridge = fileURLToPath(new URL("../src/mcp/secret-env-bridge.js", import.meta.url));

test("Codex secret bridge preserves daemon-canonical gateway path context", () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "cg-secret-bridge-"));
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
