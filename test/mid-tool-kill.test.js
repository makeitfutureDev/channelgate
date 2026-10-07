import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, tempDir } from "./helpers.js";
import { createFakeRuntime } from "./fixtures/fake-runtime-backend.js";
ensureTestEnv();
const { runClaude } = await import("../src/engines/claude.js");
const { runCodex } = await import("../src/engines/codex.js");
const { PersistentClaudeSession } = await import("../src/engines/persistent-session.js");
const { isDiagnosableRunError } = await import("../src/gateway/diagnosis.js");
const { runDeathRecovery } = await import("../src/slack/message-pipeline.js");
const { runFailureDiagnostics } = await import("../src/util/process-outcome.js");

for (const engine of ["claude", "warm", "codex"]) {
  for (const finished of [false, true]) {
    for (const exit of [{ code: 137, signal: null }, { code: null, signal: "SIGKILL" }]) {
    test(`${engine} hard kill ${exit.signal || exit.code} ${finished ? "after" : "during"} a tool reports only observed lifecycle`, async () => {
      const runtime = createFakeRuntime();
      const cwd = tempDir("cg-kill-context-");
      const target = runtime.target({ cwd, artifactDir: cwd });
      let session;
      const pending = (engine === "warm"
        ? (session = new PersistentClaudeSession({ cwd, args: [], target }), session.start(), session.send("kill fixture"))
        : engine === "codex"
          ? runCodex({ cwd, prompt: "kill fixture", sessionId: "", isNewSession: true, clean: true, target, artifactDir: cwd })
          : runClaude({ cwd, prompt: "kill fixture", sessionId: "fixture", target }))
        .then(result => ({ result }), error => ({ error }));
      for (let i = 0; !runtime.children.length && i < 200; i++) await new Promise(r => setTimeout(r, 5));
      assert.equal(runtime.children.length, 1);
      const child = runtime.children[0];
      const send = event => child.stdout.write(JSON.stringify(event) + "\n");
      if (engine === "codex") {
        send({ type: "item.started", item: { id: "tool", type: "command_execution", command: "private command argument" } });
        if (finished) send({ type: "item.completed", item: { id: "tool", type: "command_execution" } });
      } else {
        send({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool", name: "Bash", input: { command: "private command argument" } }] } });
        if (finished) send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "private result" }] } });
      }
      child.emit("close", exit.code, exit.signal);
      const { error, result } = await pending;
      assert.equal(result, undefined);
      assert.ok(error);
      assert.equal(Boolean(error.details.killedDuringTool), !finished);
      if (!finished) {
        assert.match(error.message, /no recorded result.*cause unknown/);
        assert.deepEqual(error.details.pendingToolNames, [engine === "codex" ? "command_execution" : "Bash"]);
        assert.equal(runFailureDiagnostics(error).killedDuringTool, true);
        assert.deepEqual(runFailureDiagnostics(error).pendingToolNames, error.details.pendingToolNames);
      }
      assert.doesNotMatch(error.message, /out of memory|command caused|own command killed/i);
      assert.doesNotMatch(JSON.stringify(runFailureDiagnostics(error)), /private command|private result/);
      assert.equal(runDeathRecovery(error), null);
      assert.equal(isDiagnosableRunError(error), true, "an unexplained kill remains diagnosable");
      assert.notEqual(error.details.replaySafe, true);
      session?.terminate();
    });
    }
  }
}
