// Stop hook: mechanical subagent-completion enforcement for gateway channels.
//
// A model-owned background subagent (Agent/Task with run_in_background) lives inside the engine
// process — a cold `claude -p` exits the moment the final answer is posted (killing the subagent
// mid-flight), and a warm process idles out shortly after. If the parent ends its turn while one
// is still running, the work is silently lost. Instructions alone can't prevent that, so this hook
// makes the HARNESS refuse: Claude Code invokes it on every attempted turn end with the live
// `background_tasks` list on stdin, and a {"decision":"block"} response forces the model to keep
// going, wait for its subagents, and incorporate their results.
//
// Scope: `type:"subagent"` and `type:"workflow"` entries. A background Agent reports as the former
// and a background Workflow as the latter, and both are model-owned in-engine work that dies with
// the turn, so matching only "subagent" let a running Workflow be orphaned silently. Background
// SHELL tasks (`type:"shell"`) are excluded on purpose — a deliberately long-lived process (dev
// server, watcher) would otherwise block the turn forever; durable shell work belongs to the
// daemon's run_in_background tool per the gateway-usage guide.
//
// Loop bound: a hung subagent must not block the thread indefinitely, so after MAX_BLOCKS blocks
// in one session the hook lets the stop through. The counter is a tmpdir file keyed by session id
// (hooks are stateless processes); it is removed on every clean allow so a long warm session
// doesn't inherit stale counts. That release is never silent: it carries a `systemMessage` (and the
// same line on stderr) naming the tasks whose work is being abandoned, because an invisible drop
// looks exactly like a clean finish to everyone reading the thread.
//
// No dependencies, no gateway imports — this runs inside the sandboxed engine context, spawned by
// the Claude CLI itself. Exit 0 always; stdout carries the decision (no `decision` field = allow).
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const MAX_BLOCKS = 30;
// Model-owned in-engine work that dies with the turn. A background `Agent` reports as "subagent",
// a background `Workflow` as "workflow"; a background `Bash` reports as "shell" and is excluded.
const BLOCKING_TYPES = new Set(["subagent", "workflow"]);
const RUNNING_STATUSES = new Set(["running", "pending", "in_progress"]);

export function decide(input, { counterDir = tmpdir() } = {}) {
  const tasks = Array.isArray(input?.background_tasks) ? input.background_tasks : [];
  const running = tasks.filter(
    (t) => t && BLOCKING_TYPES.has(String(t.type || "").toLowerCase()) && RUNNING_STATUSES.has(String(t.status || "").toLowerCase())
  );
  const session = String(input?.session_id || "").replace(/[^a-zA-Z0-9-]/g, "");
  const counterFile = session ? path.join(counterDir, `cg-stop-subagents-${session}`) : "";

  if (running.length === 0) {
    if (counterFile) rmSync(counterFile, { force: true });
    return null; // allow
  }

  let blocks = 0;
  if (counterFile) {
    try {
      blocks = Number.parseInt(readFileSync(counterFile, "utf8"), 10) || 0;
    } catch {
      /* first block this session */
    }
  }
  const names = running.map((t) => `"${t.description || t.id}"`).join(", ");
  if (blocks >= MAX_BLOCKS) {
    // Safety valve: a hung subagent must not wedge the thread. Allow the stop, but SAY SO — the
    // abandoned tasks are about to be killed with the engine process and their work is lost.
    return {
      systemMessage:
        `Stop hook safety valve: releasing this turn after ${MAX_BLOCKS} blocked stops while ${running.length} background ` +
        `task(s) are still running (${names}). Their results are being abandoned — say so in your answer and re-launch ` +
        `anything that still matters as a durable background job.`,
    };
  }
  if (counterFile) {
    try {
      writeFileSync(counterFile, String(blocks + 1));
    } catch {
      /* counter is best-effort; blocking still works, just unbounded-guard-less */
    }
  }

  return {
    decision: "block",
    reason:
      `${running.length} background subagent/workflow task(s) still running (${names}). This Slack turn cannot end ` +
      `while work you launched is unfinished — it would be lost. Wait for each one (e.g. TaskOutput with wait, or ` +
      `the task tools), collect the results, and incorporate them before giving your final answer.`,
  };
}

// Entry point when invoked as a hook (stdin JSON in, optional decision JSON out).
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    /* unparseable input — allow the stop rather than wedge the turn */
  }
  const out = decide(input);
  // stderr as well as `systemMessage`: the transcript surfaces one and the hook log the other, and a
  // released valve must not be able to slip past both.
  if (out?.systemMessage) process.stderr.write(`${out.systemMessage}\n`);
  if (out) process.stdout.write(JSON.stringify(out));
}
