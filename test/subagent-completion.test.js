// Regression for the Slack incident where a parent turn posted "waiting on an agent" and ended,
// orphaning its background subagents (the engine process exits/idles out with the turn). The
// contract is now MECHANICAL, not instructional: a Stop hook in every generated channel settings
// file blocks a Claude turn from ending while background subagents are running, and durable
// delegation goes through the daemon's run_agent_in_background job (which re-invokes the thread).
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const [{ decide }, { buildSettings, STOP_SUBAGENTS_HOOK }] = await Promise.all([
  import("../src/gateway/hooks/stop-subagents.mjs"),
  import("../src/gateway/folders.js"),
]);

const runningTask = { id: "t1", type: "subagent", status: "running", description: "research X" };

test("stop hook blocks while a background subagent is running", () => {
  const counterDir = mkdtempSync(path.join(os.tmpdir(), "cg-hook-"));
  const out = decide({ session_id: "s1", background_tasks: [runningTask] }, { counterDir });
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /background subagent/i);
  assert.match(out.reason, /research X/);
});

test("stop hook blocks while a background workflow is running", () => {
  // A Workflow is model-owned in-engine work exactly like a subagent — the harness just reports it
  // as type "workflow" — so letting the turn end orphans it the same way.
  const counterDir = mkdtempSync(path.join(os.tmpdir(), "cg-hook-"));
  const workflow = { id: "w1", type: "workflow", status: "in_progress", description: "migrate the docs" };
  const out = decide({ session_id: "w", background_tasks: [workflow] }, { counterDir });
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /migrate the docs/);
  // Mixed lists count both kinds.
  const both = decide({ session_id: "w2", background_tasks: [runningTask, workflow] }, { counterDir });
  assert.match(both.reason, /^2 background/);
});

test("stop hook allows when no subagent is running (and on completed/foreign task types)", () => {
  const counterDir = mkdtempSync(path.join(os.tmpdir(), "cg-hook-"));
  assert.equal(decide({ session_id: "s2", background_tasks: [] }, { counterDir }), null);
  assert.equal(decide({ session_id: "s2" }, { counterDir }), null);
  assert.equal(decide({ session_id: "s2", background_tasks: [{ ...runningTask, status: "completed" }] }, { counterDir }), null);
  assert.equal(decide({ session_id: "s2", background_tasks: [{ id: "w", type: "workflow", status: "completed" }] }, { counterDir }), null);
  // Background SHELL tasks must not block — a deliberately long-lived process (dev server) would
  // wedge the turn forever; durable shell work is the daemon run_in_background tool's job.
  assert.equal(decide({ session_id: "s2", background_tasks: [{ ...runningTask, type: "shell" }] }, { counterDir }), null);
});

test("stop hook block count is bounded and resets on a clean allow", () => {
  const counterDir = mkdtempSync(path.join(os.tmpdir(), "cg-hook-"));
  const input = { session_id: "s3", background_tasks: [runningTask] };
  let blocks = 0;
  for (let i = 0; i < 40; i++) if (decide(input, { counterDir })?.decision === "block") blocks++;
  assert.equal(blocks, 30); // MAX_BLOCKS — a hung subagent must not wedge the thread forever
  // A clean allow (no running tasks) clears the counter, so the next stall blocks again.
  decide({ session_id: "s3", background_tasks: [] }, { counterDir });
  assert.equal(decide(input, { counterDir })?.decision, "block");
});

test("the safety valve never releases silently — it names the abandoned tasks", () => {
  const counterDir = mkdtempSync(path.join(os.tmpdir(), "cg-hook-"));
  const input = { session_id: "s4", background_tasks: [runningTask, { id: "w1", type: "workflow", status: "running", description: "long workflow" }] };
  for (let i = 0; i < 30; i++) assert.equal(decide(input, { counterDir }).decision, "block");
  const released = decide(input, { counterDir });
  assert.equal(released?.decision, undefined); // the stop goes through…
  assert.match(released.systemMessage, /2 background/); // …but says how much work it just dropped
  assert.match(released.systemMessage, /research X/);
  assert.match(released.systemMessage, /long workflow/);
  // Still visible on every later attempt, not just the first release.
  assert.match(decide(input, { counterDir }).systemMessage, /safety valve/i);
  // A clean allow stays silent — nothing was abandoned.
  assert.equal(decide({ session_id: "s4", background_tasks: [] }, { counterDir }), null);
});

test("the hook entry point emits the decision on stdout and the valve release on stderr too", (t) => {
  const hook = fileURLToPath(new URL("../src/gateway/hooks/stop-subagents.mjs", import.meta.url));
  const session = `cli-${randomUUID()}`; // the CLI uses the real tmpdir, so keep the counter unique
  t.after(() => rmSync(path.join(os.tmpdir(), `cg-stop-subagents-${session}`), { force: true }));
  const input = JSON.stringify({ session_id: session, background_tasks: [runningTask] });
  const run = () => spawnSync(process.execPath, [hook], { input, encoding: "utf8" });

  const blocked = run();
  assert.equal(blocked.status, 0); // a hook that exits non-zero would wedge the turn
  assert.equal(JSON.parse(blocked.stdout).decision, "block");
  assert.equal(blocked.stderr, ""); // an ordinary block is not a user-facing warning

  for (let i = 0; i < 40; i++) decide(JSON.parse(input)); // drive the same tmpdir counter to MAX_BLOCKS
  const released = run();
  assert.equal(released.status, 0);
  assert.equal(JSON.parse(released.stdout).decision, undefined); // the stop is allowed…
  assert.match(released.stdout, /safety valve/); // …loudly, on both channels
  assert.match(released.stderr, /safety valve/);
  assert.match(released.stderr, /1 background/);
});

test("stop hook is malformed-input safe", () => {
  const counterDir = mkdtempSync(path.join(os.tmpdir(), "cg-hook-"));
  assert.equal(decide(null, { counterDir }), null);
  assert.equal(decide({ background_tasks: "not-an-array" }, { counterDir }), null);
  assert.equal(decide({ session_id: "../../etc", background_tasks: [] }, { counterDir }), null);
});

test("every generated channel settings variant installs the Stop hook", async () => {
  for (const meta of [
    { _slug: "hook-default", allowedMcps: [] },
    { _slug: "hook-clean", cleanMode: true, allowedMcps: [] },
    { _slug: "hook-auto", autoMode: true, allowBash: true, allowedMcps: [] },
  ]) {
    const settings = await buildSettings(meta);
    const stop = settings.hooks?.Stop?.[0]?.hooks?.[0];
    assert.equal(stop?.type, "command", `${meta._slug} missing Stop hook`);
    assert.ok(stop.command.includes(STOP_SUBAGENTS_HOOK), `${meta._slug} hook path wrong`);
  }
});

test("the injected instruction rule is gone — enforcement is the hook + daemon jobs", () => {
  const source = readFileSync(new URL("../src/gateway/run.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /SUBAGENT_COMPLETION_RULE|withSubagentCompletionRule/);
  assert.match(source, /const turnText = String\(text \?\? ""\)/);
});

test("gateway-usage guide routes outliving work to the daemon tools", () => {
  const skill = readFileSync(new URL("../src/gateway/gateway-usage/SKILL.md", import.meta.url), "utf8");
  const jobs = readFileSync(new URL("../src/gateway/gateway-usage/references/background-jobs.md", import.meta.url), "utf8");

  assert.match(skill, /run_agent_in_background/);
  assert.match(skill, /Stop hook/);
  assert.match(jobs, /run_agent_in_background/);
  assert.match(jobs, /complete, self-contained brief/);
  assert.match(jobs, /STOP and end your turn/);
  assert.match(jobs, /Never restart the gateway with a background/);
  assert.match(jobs, /restart_gateway/);
});
