import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { commandHealth, createAdapterRegistry, validateRunContext } from "../src/engines/contract.js";
import { engineUiManifest, fallbackTargets, requireAdapter } from "../src/engines/registry.js";

function fakeAdapter(id = "third") {
  return {
    id, label: "Third", cli: "third", defaultModelKey: "defaultThirdModel", mcpMetaKey: "allowedThirdMcps",
    instructionFile: "THIRD.md", skillsDir: ".third/skills", mcpTransport: "argv", contextWindow: 1000,
    efforts: ["low"], models: [{ label: "Third One", value: "third-1" }], mintsOwnSessionId: true,
    supports: { warmPool: false, networkModes: ["off"] }, modelBelongs: (m) => m.startsWith("third-"),
    resumeCommand: (session) => `third resume ${session}`,
    compileConfinement: () => ({ supported: true, network: { mode: "off", supported: true }, writable: false }),
    run: async () => ({ content: "ok" }), interrupt: () => false, discoverMcps: async () => [],
    discoverModels: async () => [{ label: "Third Two", value: "third-2" }],
    health: async () => ({ ready: true }),
  };
}

test("a fake third adapter satisfies the kernel without orchestrator, route, or wizard edits", async () => {
  const registry = createAdapterRegistry([fakeAdapter()]);
  assert.deepEqual(registry.ids, ["third"]);
  assert.equal(registry.require("third").modelBelongs("third-1"), true);
  assert.deepEqual(registry.manifests()[0].models, [{ label: "Third One", value: "third-1" }]);
  assert.equal(registry.manifests()[0].discoverModels, undefined);
  await assert.doesNotReject(() => registry.require("third").run({}));
});

test("adapter registration and RunContext validation fail closed", () => {
  assert.throws(() => createAdapterRegistry([{ ...fakeAdapter(), compileConfinement: undefined }]), /compileConfinement/);
  assert.throws(() => createAdapterRegistry([{ ...fakeAdapter(), discoverModels: true }]), /discoverModels/);
  assert.throws(() => createAdapterRegistry([{ ...fakeAdapter(), compileConfinement: () => ({ supported: true, network: { mode: "approved" } }) }]), /fail closed/);
  assert.throws(() => validateRunContext({}), /principal/);
  assert.throws(() => validateRunContext({ principal: { kind: "user", id: "U1" }, origin: "unknown", cwd: "/tmp", session: {}, policy: {} }), /origin/);
});

test("built-in registry publishes safe UI manifests and a generic fallback graph", () => {
  const manifests = engineUiManifest();
  assert.deepEqual(manifests.map((m) => m.id), ["claude", "codex", "opencode"]);
  assert.ok(manifests.every((m) => !Object.values(m).some((v) => typeof v === "function")));
  assert.deepEqual(fallbackTargets("claude"), ["codex"]);
  assert.deepEqual(fallbackTargets("codex"), ["claude"], "failover is bidirectional — either harness covers the other");
  assert.deepEqual(fallbackTargets("opencode"), []);
  assert.throws(() => requireAdapter("missing"), /Unknown or unavailable/);
});

test("CLI health failures explain the outcome without exposing a numeric process code", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  const checked = commandHealth("third-cli", { spawnImpl: () => child, timeoutMs: 1_000 });
  queueMicrotask(() => {
    child.stderr.write("unknown option --bad\n");
    child.emit("close", 2, null);
  });
  const health = await checked;
  assert.equal(health.ready, false);
  assert.equal(health.error, "third-cli failed because it rejected its input or options: unknown option --bad");
  assert.doesNotMatch(health.error, /exit code|code 2/i);
});
