import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, tempDir } from "./helpers.js";
import { createFakeRuntime } from "./fixtures/fake-runtime-backend.js";

ensureTestEnv();
const { runClaude } = await import("../src/engines/claude.js");
const { PersistentClaudeSession } = await import("../src/engines/persistent-session.js");
const { runDeathRecovery } = await import("../src/slack/message-pipeline.js");

for (const warm of [false, true]) {
  for (const reason of ["silence-budget", "process-gone"]) {
    test(`${warm ? "warm" : "cold"} Claude watchdog ${reason} carries a stable recovery verdict`, async () => {
      const runtime = createFakeRuntime();
      const cwd = tempDir("cg-watchdog-recovery-");
      const target = runtime.target({ cwd });
      runtime.setProbe(reason !== "process-gone");
      runtime.backend.signal = async (child, signal) => {
        runtime.signals.push({ signal });
        child.emit("close", null, signal);
      };
      let session;
      const pending = warm
        ? (session = new PersistentClaudeSession({ cwd, args: [], target }), session.start(), session.send("watchdog fixture", { timeoutMs: 5, maxSilenceMs: 15 }))
        : runClaude({ cwd, prompt: "watchdog fixture", sessionId: "fixture", target, timeoutMs: 5, maxSilenceMs: 15 });
      const deadline = setTimeout(() => {}, 1000);
      try {
        await assert.rejects(pending, (error) => {
          assert.equal(error.details?.errorCode, reason === "process-gone" ? "ENGINE_PROCESS_GONE" : "ENGINE_SILENCE_BUDGET");
          assert.equal(error.details.engine, "claude");
          assert.equal(error.details.watchdogReason, reason);
          assert.equal(runDeathRecovery(error), "continue");
          assert.equal(runDeathRecovery({ message: "renamed diagnostic", details: error.details }), "continue");
          for (const guard of [{ explicitStop: true }, { signal: "SIGKILL" }, { exitCode: 137 }, { incompleteTurn: true }, { providerError: true }]) {
            assert.equal(runDeathRecovery({ message: "renamed diagnostic", details: { ...error.details, ...guard } }), null);
          }
          return true;
        });
        assert.equal(runtime.spawns.length, 1);
        if (session) assert.equal(session.alive, false);
      } finally { clearTimeout(deadline); session?.terminate(); }
    });
  }
}

test("legacy silence wording remains recoverable without authorizing arbitrary engines", () => {
  for (const message of ["Claude produced no output for 30m — giving up", "Warm Claude turn produced no output for 30m — giving up", "Claude stalled — no output"]) {
    assert.equal(runDeathRecovery({ message }), "continue");
  }
  assert.equal(runDeathRecovery({ message: "Codex produced no output for 30m — giving up", details: { incompleteTurn: true } }), null);
});
