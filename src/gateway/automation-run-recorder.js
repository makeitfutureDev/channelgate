// The one recorder behind the run ledger (schedule-runs.js). The scheduler and the HTTP run API
// execute differently and stay apart; what a finished run MEANS is written here, once, so a
// scheduled run and an API run can never be classified, counted or alerted on by two rules.
import { runAdmissionRefusalKind } from "./run-admission-result.js";
import { getScheduleRun, updateScheduleRun, appendScheduleRunEvent, listScheduleRuns } from "./schedule-runs.js";
import { normalizeUsage } from "./usage.js";
import { failureStreak, runProblem, PROBLEMS } from "./automation-health.js";
import { logEvent } from "../util/logger.js";

const UNREPORTED = { status: "unreported", summary: "Task outcome not reported.", connections: [], source: "unreported" };
const STARTED_KINDS = new Set(["tool_use", "tool_result", "thinking", "quiet", "agent_activity"]);
const LEDGER_KINDS = new Set([...STARTED_KINDS, "notice", "engine_note", "run_queued"]);

// How many failures in a row make the gateway tell the owner, once per streak.
export const FAILURE_STREAK_ALERT = 3;

// An engine event worth keeping on the run's timeline (names only; schedule-runs.js bounds it).
export function recordRunEvent(id, event) {
  if (!id || !event) return;
  if (STARTED_KINDS.has(event.kind)) {
    const current = getScheduleRun(id);
    if (current && !current.agentStartedAt) updateScheduleRun(id, { agentStartedAt: new Date().toISOString() });
  }
  if (LEDGER_KINDS.has(event.kind)) appendScheduleRunEvent(id, event);
}

// The task outcome of a finished engine turn. An outcome whose source is "none" belongs to a run
// that was never asked to report (a plain API call): it is recorded as "completed" — finished,
// not judged — instead of as a missing report.
export function recordTaskOutcome(id, result = {}) {
  const previous = getScheduleRun(id);
  if (!previous) return null;
  const o = result.automationOutcome || UNREPORTED;
  const neutral = o.source === "none";
  const status = neutral ? "completed" : o.status;
  const usage = normalizeUsage(result);
  const refused = runAdmissionRefusalKind(result);
  const run = updateScheduleRun(id, { status, taskStatus: status,
    engineStatus: refused ? (result.engineStarted ? "failed" : "not-started") : result.interrupted ? "interrupted" : result.engineError || result.completed === false ? "failed" : "completed",
    summary: neutral ? "Completed. No outcome report was requested for this run." : o.summary, connections: o.connections || [], outcomeSource: o.source,
    engine: result.engine || "", model: result.runtimeModel || result.model || "",
    durationMs: result.durationMs || 0, tokensIn: usage.inTok, tokensOut: usage.outTok, costUsd: usage.costUSD, costEstimated: usage.estimated,
    toolUseCount: Number(result.toolUseCount) || 0, completedAt: previous.completedAt || new Date().toISOString(), ...(o.errorKind ? { errorKind: o.errorKind } : {}) });
  appendScheduleRunEvent(id, { kind: "task_outcome" });
  return run;
}

// After a run settles: when it made the automation's failures-in-a-row reach the threshold, tell
// the owner once. `notify(text)` is the caller's own way to reach them (a DM); `enabled: false`
// is the automation's "no failure notices" choice. Never throws, and never repeats inside one
// streak: the fourth failure in a row is silent, a success resets it.
export async function alertFailureStreak({ scheduleId, channelId, title = "", enabled = true, notify }) {
  try {
    if (!enabled || typeof notify !== "function") return false;
    const runs = listScheduleRuns({ scheduleId, channelId, limit: 30 });
    if (failureStreak(runs) !== FAILURE_STREAK_ALERT) return false;
    const latest = runs.find((r) => !["queued", "running"].includes(r.status));
    if (!latest || latest.streakAlertedAt) return false;
    updateScheduleRun(latest.id, { streakAlertedAt: new Date().toISOString() });
    const problem = PROBLEMS[runProblem(latest)]?.label || "Run failed";
    await notify(`⚠️ Automation *${String(title || "Automation").replace(/[*_`<>]/g, "").slice(0, 120)}* failed ${FAILURE_STREAK_ALERT} runs in a row. Latest problem: ${problem}. Open the Automations page to read the runs, fix the cause, and acknowledge the errors.`);
    appendScheduleRunEvent(latest.id, { kind: "failure_streak_alert" });
    await logEvent("automation_failure_streak", { id: scheduleId, channel: channelId, streak: FAILURE_STREAK_ALERT }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
