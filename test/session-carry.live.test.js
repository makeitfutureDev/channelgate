// Fixture-only live proof: no engine prompt, real login or external message is sent.
// Real disposable containers prove both native history layouts survive a mount rebuild while
// carrySession holds its own lease. Opt in with CG_LIVE_CONTAINER=1.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
const LIVE = process.env.CG_LIVE_CONTAINER === "1";

test("live: Claude and Codex fixture history roundtrips through a container rebuild with the carry lease held", {
  skip: !LIVE && "opt-in: CG_LIVE_CONTAINER=1", timeout: 180_000,
}, async (t) => {
  const { __setContainerRuntime, __resetContainerRuntime, stopContainerRuntime, containerBackend } = await import("../src/runtimes/container/index.js");
  const { resolveRuntime } = await import("../src/runtimes/resolve.js");
  const { carrySession } = await import("../src/gateway/session-carry.js");
  const { engineStateDir, engineSessionFiles } = await import("../src/engines/registry.js");
  const settings = {
    cli: "auto", image: process.env.CG_LIVE_IMAGE || "channelgate/runtime:latest",
    idleMinutes: 10, maxRunning: 8, pidsLimit: 1024, hasClaudeOauthToken: true,
  };
  const runtime = __setContainerRuntime({ log() {} });
  const slug = `cg-carry-fixtures-${randomUUID().slice(0, 8)}`;
  const target = resolveRuntime(slug, { platform: "slack", channelId: "C-CARRY-FIXTURE" }, { settings });
  const host = { ...target, backend: "host", container: null };
  let mayHaveContainer = false;
  try {
    const caps = await runtime.cli.probe(settings, { image: settings.image });
    if (!caps.ok) return t.skip(caps.reason);
    const image = await runtime.image.inspect(caps, settings);
    if (!image.present) return t.skip(image.reason);
    const inspectId = async () => {
      const result = await runtime.cli.runWith(caps, ["inspect", "--type", "container", "--format", "{{.Id}}", target.container.name]);
      assert.equal(result.code, 0, result.stderr);
      return String(result.stdout).trim();
    };
    mayHaveContainer = true;
    for (const engine of ["claude", "codex"]) {
      const sessionId = randomUUID();
      const rel = engine === "claude"
        ? engineSessionFiles(engine, { cwd: target.cwd, sessionId })[0].rel
        : `sessions/2026/10/02/rollout-fixture-${sessionId}.jsonl`;
      const fixture = path.join(engineStateDir(engine, host), rel);
      const body = `${JSON.stringify({ fixture: true, engine, sessionId })}\n`;
      mkdirSync(path.dirname(fixture), { recursive: true });
      writeFileSync(fixture, body);
      assert.deepEqual(await carrySession({
        engine, sessionId, cwd: target.cwd, storedRuntime: { backend: "host" }, target,
        resolveFor: () => host, log() {},
      }), { direction: "host→container", files: 1 });
      const before = await inspectId();
      rmSync(fixture);
      // Change a real bind source while retaining cwd and the persistent HOME volume.
      target.cleanWorkDir = tempDir(`cg-carry-new-clean-${engine}-`);
      assert.deepEqual(await carrySession({
        engine, sessionId, cwd: target.cwd, storedRuntime: { backend: "container" }, target: host,
        resolveFor: () => target, log() {},
      }), { direction: "container→host", files: 1 });
      assert.notEqual(await inspectId(), before, `${engine}: stale mounts must recreate the container`);
      assert.equal(readFileSync(fixture, "utf8"), body);
      assert.equal(runtime.reaper.leaseCount(target.container.name), 0);
      t.diagnostic(`${engine}: fixture roundtrip preserved bytes across a real container rebuild`);
    }
  } finally {
    try {
      if (mayHaveContainer) await containerBackend.destroy(target, { volumes: true, reason: "disposable session fixture cleanup" });
    } finally {
      stopContainerRuntime();
      __resetContainerRuntime();
    }
  }
});
