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
    assert.equal("sandbox" in settings, false, "container runtime owns confinement");
    assert.ok(["Bash", "Write", "Edit", "WebFetch"].every((tool) => settings.permissions.deny.includes(tool)));
    assert.deepEqual(settings.allowedMcpServers, []);
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

function fixture(root, overrides = {}) {
  const calls = [];
  const target = { backend: "container", cwd: path.join(root, "probe"), artifactDir: path.join(root, "artifacts"),
    runtime: { capabilities: { isolated: true },
      acquireLease: () => { calls.push("lease"); return () => calls.push("release"); },
      ensureUp: async () => calls.push("ensure"),
      credentialError: async () => null,
      destroy: async (_target, opts) => { assert.equal(opts.volumes, true); calls.push("destroy"); },
      ...overrides,
    },
  };
  return { target, calls, resolveTarget: () => target };
}

test("both engines run inside the resolved container with strict arguments and cleanup", async () => {
  const root = tempRoot(); const f = fixture(root);
  try {
    const engines = ["claude", "codex"].map((id) => ({ id, updateSmoke: async (args) => {
      assert.equal(args.target, f.target);
      assert.equal(args.dangerouslySkip, false);
      assert.equal(args.strictMcp, true);
      assert.equal(existsSync(args.settingsFile), true);
      f.calls.push(id);
      return { content: "CG_UPDATE_SMOKE_OK" };
    } }));
    const result = await runUpdateSmoke({ root, resolveTarget: f.resolveTarget, engines });
    assert.equal(result.ok, true);
    assert.equal(result.engines.length, 2);
    assert.deepEqual(f.calls, ["lease", "ensure", "claude", "codex", "destroy", "release"]);
    assert.equal(existsSync(f.target.cwd), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("host target is refused without invoking an engine", async () => {
  const result = await runUpdateSmoke({ resolveTarget: () => ({ backend: "local" }), engines: [{ updateSmoke: () => assert.fail() }] });
  assert.equal(result.ok, false);
  assert.match(result.error, /isolated container/);
});

test("engine failure is reported, second engine runs, and cleanup always releases lease", async () => {
  const root = tempRoot(); const f = fixture(root);
  try {
    const result = await runUpdateSmoke({ root, resolveTarget: f.resolveTarget, engines: [
      { id: "claude", updateSmoke: async () => { throw new Error("authentication failed\nsecret stderr"); } },
      { id: "codex", updateSmoke: async () => ({ content: "unexpected" }) },
    ] });
    assert.equal(result.ok, false);
    assert.equal(result.engines.length, 2);
    assert.equal(result.error, "claude: authentication failed");
    assert.equal(JSON.stringify(result).includes("secret stderr"), false);
    assert.deepEqual(f.calls.slice(-2), ["destroy", "release"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("absent credentials are explicit skips and zero probes never passes", async () => {
  const root = tempRoot(); const f = fixture(root, { credentialError: async () => new Error("missing") });
  f.target.container = { credentialMode: { codex: "missing" } };
  try {
    const result = await runUpdateSmoke({ root, resolveTarget: f.resolveTarget, engines: [{ id: "codex", updateSmoke: () => assert.fail() }] });
    assert.equal(result.ok, false);
    assert.equal(result.engines[0].skipped, true);
    assert.match(result.error, /No configured engine/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed container startup still destroys resources and releases lease", async () => {
  const root = tempRoot(); const f = fixture(root, { ensureUp: async () => { throw new Error("image missing"); } });
  try {
    const result = await runUpdateSmoke({ root, resolveTarget: f.resolveTarget, engines: [] });
    assert.equal(result.ok, false);
    assert.match(result.error, /image missing/);
    assert.deepEqual(f.calls, ["lease", "destroy", "release"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an engine that passed baseline cannot become a skip", async () => {
  const root = tempRoot(); const f = fixture(root, { credentialError: async () => new Error("missing") });
  f.target.container = { credentialMode: { codex: "missing" } };
  try {
    const result = await runUpdateSmoke({ root, resolveTarget: f.resolveTarget, requiredEngines: ["codex"], engines: [{ id: "codex", updateSmoke: () => assert.fail() }] });
    assert.equal(result.ok, false);
    assert.equal(result.engines.some((entry) => entry.skipped), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a rejected target is never destroyed and cleanup failures fail verification", async () => {
  const root = tempRoot(); const f = fixture(root);
  f.target.runtime.capabilities.isolated = false;
  const rejected = await runUpdateSmoke({ root, resolveTarget: f.resolveTarget, engines: [] });
  assert.equal(rejected.ok, false);
  assert.deepEqual(f.calls, []);
  f.target.runtime.capabilities.isolated = true;
  f.target.runtime.destroy = async () => { throw new Error("volume cleanup refused"); };
  const result = await runUpdateSmoke({ root, resolveTarget: f.resolveTarget, engines: [{ id: "codex", updateSmoke: async () => ({ content: "CG_UPDATE_SMOKE_OK" }) }] });
  assert.equal(result.ok, false);
  assert.match(result.error, /cleanup/);
  assert.equal(existsSync(f.target.cwd), false);
  assert.equal(f.calls.at(-1), "release");
  rmSync(root, { recursive: true, force: true });
});
