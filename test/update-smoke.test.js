import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { tempDir } from "./helpers.js";

import {
  prepareUpdateSmokeFolder,
  runUpdateSmoke,
  usageLimitedSmoke,
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

// Live on Atlas (2026-09-28): the update was refused because the Claude plan had hit its weekly
// limit. A usage-limit answer proves the CLI started in the new container, authenticated and reached
// its provider — the probe's whole purpose — so it counts as reachable, never as a broken gateway.
test("a provider usage limit counts as reachable, thrown or returned; real failures still refuse", async () => {
  for (const text of [
    "Claude usage limit reached: You've hit your weekly limit · resets Sep 29, 11pm (Europe/Bucharest)",
    "Codex usage limit reached: You've hit your usage limit. Visit chatgpt.com/codex/settings/usage",
    "You've hit your session limit · resets 4pm",
    "rate_limit_error: too many requests",
  ]) assert.equal(usageLimitedSmoke(text), true, text);
  for (const text of ["authentication failed", "Engine smoke probe returned an unexpected response.", "ENOENT: claude not found", ""]) {
    assert.equal(usageLimitedSmoke(text), false, text);
  }
  const root = tempRoot(); const f = fixture(root);
  try {
    const limited = await runUpdateSmoke({ root, resolveTarget: f.resolveTarget, engines: [
      { id: "claude", updateSmoke: async () => { throw new Error("Claude usage limit reached: You've hit your weekly limit · resets Sep 29, 11pm (Europe/Bucharest)"); } },
      { id: "codex", updateSmoke: async () => ({ content: "You've hit your usage limit. Visit chatgpt.com/codex/settings/usage" }) },
    ] });
    assert.equal(limited.ok, true, limited.error);
    assert.deepEqual(limited.engines.map((e) => [e.engine, e.ok, e.usageLimited]), [["claude", true, true], ["codex", true, true]]);
    assert.match(limited.engines[0].note, /reachable but usage-limited: Claude usage limit reached/);
    // A required engine (it passed before the update) that is usage-limited afterwards still passes;
    // one that genuinely breaks still refuses.
    const after = await runUpdateSmoke({ root, resolveTarget: f.resolveTarget, requiredEngines: ["claude"], engines: [
      { id: "claude", updateSmoke: async () => { throw new Error("Claude usage limit reached: weekly"); } },
    ] });
    assert.equal(after.ok, true);
    const broken = await runUpdateSmoke({ root, resolveTarget: f.resolveTarget, engines: [
      { id: "claude", updateSmoke: async () => { throw new Error("authentication failed"); } },
    ] });
    assert.equal(broken.ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
