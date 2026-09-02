import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { tempDir } from "./helpers.js";

import {
  prepareUpdateSmokeFolder,
  runUpdateSmoke,
  validSmokeResponse,
} from "../src/gateway/update-smoke.js";

function tempRoot() {
  return tempDir("cg-update-smoke-");
}

test("smoke settings confine Claude to a temporary folder with no MCPs or bypass", async () => {
  const root = tempRoot();
  try {
    const probe = await prepareUpdateSmokeFolder({ root, id: "probe-1" });
    const settings = JSON.parse(readFileSync(probe.settingsFile, "utf8"));
    assert.deepEqual(JSON.parse(readFileSync(probe.mcpFile, "utf8")), { mcpServers: {} });
    assert.equal(settings.permissions.disableBypassPermissionsMode, "disable");
    assert.equal(settings.permissions.disableAutoMode, "disable");
    assert.deepEqual(settings.permissions.allow, []);
    assert.equal(settings.autoMemoryEnabled, false);
    assert.equal(settings.autoDreamEnabled, false);
    assert.equal(settings.sandbox.enabled, true);
    assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
    assert.deepEqual(settings.allowedMcpServers, []);
    assert.deepEqual(settings.sandbox.filesystem.allowRead, [`/${probe.folder.replace(/^\/+/, "")}`]);
    assert.deepEqual(settings.sandbox.filesystem.allowWrite, [`/${probe.folder.replace(/^\/+/, "")}`]);
    assert.equal(statSync(probe.settingsFile).mode & 0o777, 0o600);
    assert.equal(statSync(probe.mcpFile).mode & 0o777, 0o600);
    await probe.cleanup();
    assert.equal(existsSync(probe.folder), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only the exact fixed response passes", () => {
  assert.equal(validSmokeResponse("CG_UPDATE_SMOKE_OK"), true);
  assert.equal(validSmokeResponse("  CG_UPDATE_SMOKE_OK\n"), true);
  assert.equal(validSmokeResponse("almost CG_UPDATE_SMOKE_OK"), false);
  assert.equal(validSmokeResponse("CG_UPDATE_SMOKE_OK."), false);
  assert.equal(validSmokeResponse(""), false);
});

test("real smoke runner receives strict gated arguments and always removes the folder", async () => {
  const root = tempRoot();
  let observed;
  try {
    const result = await runUpdateSmoke({
      root,
      runner: async (args) => {
        observed = args;
        assert.equal(existsSync(args.cwd), true);
        assert.equal(existsSync(args.settingsFile), true);
        assert.equal(existsSync(args.mcpConfig), true);
        return { content: "CG_UPDATE_SMOKE_OK", durationMs: 12 };
      },
    });
    assert.deepEqual(result, { ok: true, durationMs: 12 });
    assert.equal(observed.isNewSession, true);
    assert.equal(observed.strictMcp, true);
    assert.equal(observed.dangerouslySkip, false);
    assert.equal(observed.permissionPromptTool, "");
    assert.equal(observed.model, "");
    assert.equal(observed.effort, "");
    assert.match(observed.prompt, /Reply with exactly CG_UPDATE_SMOKE_OK/);
    const smokeRoot = path.join(root, "update-smoke");
    assert.deepEqual(existsSync(smokeRoot) ? readdirSync(smokeRoot) : [], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("smoke mismatch and runner errors fail safely and clean up", async () => {
  const root = tempRoot();
  try {
    const mismatch = await runUpdateSmoke({ root, runner: async () => ({ content: "not healthy", durationMs: 8 }) });
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.error, /unexpected response/i);

    const failure = await runUpdateSmoke({
      root,
      runner: async () => {
        const error = new Error("authentication failed\nsecret stderr must not follow");
        error.details = { stderr: "token=secret" };
        throw error;
      },
    });
    assert.equal(failure.ok, false);
    assert.equal(failure.error, "authentication failed");
    assert.equal(JSON.stringify(failure).includes("token=secret"), false);
    const smokeRoot = path.join(root, "update-smoke");
    assert.deepEqual(existsSync(smokeRoot) ? readdirSync(smokeRoot) : [], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
