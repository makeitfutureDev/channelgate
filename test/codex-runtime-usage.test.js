import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tempDir } from "./helpers.js";
import { createCodexUsageReader } from "../src/engines/codex-usage.js";
import { createContainerState } from "../src/runtimes/container/state.js";

const jsonl = (events) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const tokens = (input, output, lastInput, lastOutput) => ({ type: "event_msg", payload: { type: "token_count", info: {
  total_token_usage: { input_tokens: input, output_tokens: output }, last_token_usage: { input_tokens: lastInput, output_tokens: lastOutput },
} } });

test("runtime reducer returns only usage metadata and preserves a resumed turn baseline", async () => {
  const stateDir = tempDir("cg-runtime-usage-");
  mkdirSync(path.join(stateDir, "sessions"));
  const file = path.join(stateDir, "sessions", "rollout-root.jsonl");
  writeFileSync(file, jsonl([
    { type: "session_meta", payload: { id: "root" } },
    { type: "response_item", payload: { text: "PRIVATE-TRANSCRIPT-SENTINEL" } },
    tokens(250, 12, 250, 12),
  ]));
  const calls = [];
  const state = createContainerState({ exec: { async runExec(target, args, opts) {
    calls.push({ args, opts });
    const stdout = execFileSync(process.execPath, args.slice(2), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.ok(!stdout.includes("PRIVATE-TRANSCRIPT-SENTINEL"));
    return { code: 0, stdout };
  } } });
  const target = { container: { name: "fixture-container", codexHome: stateDir, homeVolumeHostPath: "/proc/1/unreadable" }, runtime: state };
  const reader = createCodexUsageReader(target, "/proc/1/unreadable/.codex");
  const snapshot = await reader.snapshot("root");
  appendFileSync(file, jsonl([tokens(400, 20, 150, 8)]));
  const accounting = await reader.root({ sessionId: "root", snapshot, terminalUsage: { input_tokens: 400, output_tokens: 20 } });
  assert.equal(accounting.usage.input_tokens, 150);
  assert.equal(accounting.usage.output_tokens, 8);
  assert.equal(accounting.exactRequests, true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ args, opts }) => args[0] === "fixture-container" && opts.retry === false && opts.timeoutMs > 0));
  assert.ok(calls.every(({ args }) => !args.join(" ").includes("/proc/1/unreadable")));
});

test("runtime reducer fails on exec/JSON failure without exposing stderr or consulting host state", async () => {
  for (const result of [{ code: 125, stderr: "PRIVATE-SECRET" }, { code: 0, stdout: "invalid JSON PRIVATE-SECRET" }]) {
    const state = createContainerState({ exec: { async runExec() { return result; } } });
    await assert.rejects(state.inspectUsage({ container: { name: "fixture" } }, { source: "// reducer", args: {} }), (error) => {
      assert.match(error.message, /runtime usage inspection/);
      assert.ok(!error.message.includes("PRIVATE-SECRET"));
      return true;
    });
  }
  await assert.rejects(createCodexUsageReader({ runtime: {}, container: {} }).snapshot("root"), /runtime cannot inspect/);
});

test("runtime reducer names a safe failure category and exit facts without exposing stderr", async () => {
  const { classifyUsageInspectionFailure, USAGE_INSPECTION_CATEGORIES } = await import("../src/runtimes/container/state.js");
  const cases = [
    [{ code: 1, stderr: "Error: ENOENT: no such file or directory, open '/home/agent/.codex/sessions/PRIVATE-SECRET.jsonl'" }, "missing-file"],
    [{ code: 1, stderr: "Error: EACCES: permission denied, open 'PRIVATE-SECRET'" }, "permission-denied"],
    [{ code: 1, stderr: "SqliteError: SQLITE_BUSY: database is locked PRIVATE-SECRET" }, "state-database"],
    [{ code: 137, signal: "SIGKILL", stderr: "\n[timed out after 30000ms]" }, "timed-out"],
    [{ code: 125, stderr: "Error: no such container PRIVATE-SECRET" }, "container-unavailable"],
    [{ code: 2, stderr: "PRIVATE-SECRET" }, "unknown"],
  ];
  for (const [result, category] of cases) {
    assert.ok(USAGE_INSPECTION_CATEGORIES.includes(category));
    assert.equal(classifyUsageInspectionFailure(result), category);
    const logged = [];
    const state = createContainerState({ exec: { async runExec() { return result; } }, log: (entry) => logged.push(entry) });
    await assert.rejects(state.inspectUsage({ container: { name: "fixture" } }, { source: "// reducer", args: {} }), (error) => {
      assert.equal(error.message, `runtime usage inspection failed (exit ${result.code}${result.signal ? `, ${result.signal}` : ""}, ${category})`);
      assert.deepEqual(error.details, { exitCode: result.code, signal: result.signal || null, category });
      assert.ok(!error.message.includes("PRIVATE-SECRET"), "stderr never reaches the user-facing message");
      return true;
    });
    assert.equal(logged.length, 1, "the daemon log keeps the first stderr line for the operator");
    assert.ok(logged[0].includes(`fixture failed (exit ${result.code}`) && logged[0].includes(category));
  }
});
