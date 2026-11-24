// Automation health: the one classifier behind the Automations health board (admin console and
// Activity dashboard alike). Pure functions over a schedule row and its recorded runs, so the
// verdict an admin sees and the one a member sees can never disagree.
//
// Two outcomes are kept apart on purpose: the RUN (did the agent do the work?) and the DELIVERY
// (did the answer reach the conversation?). A run can succeed while its answer never arrives.

const LIVE = new Set(["queued", "running"]);
const BAD_RUN = new Set(["failed", "blocked", "interrupted"]);
const UNDELIVERABLE = /\b(channel_not_found|not_in_channel|is_archived|channel_is_archived|channel archived|bot removed)\b/i;

// Human labels for each problem category, and which of the two outcomes it belongs to.
export const PROBLEMS = Object.freeze({
  undeliverable: { label: "Bot removed / channel archived", outcome: "delivery" },
  delivery_failed: { label: "Delivery failed", outcome: "delivery" },
  delivery_retrying: { label: "Delivery retrying", outcome: "delivery" },
  webhook_failed: { label: "Webhook not delivered", outcome: "delivery" },
  transport: { label: "Platform disconnected", outcome: "delivery" },
  interrupted: { label: "Interrupted by restart", outcome: "run" },
  blocked: { label: "Blocked", outcome: "run" },
  login: { label: "Login expired (engine)", outcome: "run" },
  credential: { label: "Credential rejected", outcome: "run" },
  connector: { label: "Connector / tool error", outcome: "run" },
  usage_limit: { label: "Usage limit reached", outcome: "run" },
  spending_limit: { label: "Spending limit reached", outcome: "run" },
  license: { label: "License limit reached", outcome: "run" },
  access: { label: "Access refused", outcome: "run" },
  engine_disabled: { label: "Engine turned off", outcome: "run" },
  timeout: { label: "Silent too long / timed out", outcome: "run" },
  resources: { label: "Container resources exhausted", outcome: "run" },
  attempts: { label: "Out of attempts", outcome: "run" },
  deferred: { label: "Not started (deferred)", outcome: "run" },
  rejected: { label: "Rejected at the run limit", outcome: "run" },
  agent_failed: { label: "Agent reported failure", outcome: "run" },
  failed: { label: "Run failed", outcome: "run" },
  unreported: { label: "Outcome not reported", outcome: "run" },
  flaky: { label: "Fails now and then", outcome: "run" },
});

// Problems that break the automation by themselves, even on the first occurrence.
const HARD = new Set(["undeliverable", "delivery_failed", "transport", "interrupted", "login", "credential", "attempts", "license", "access", "engine_disabled"]);

const text = (run) => `${run?.error || ""} ${run?.summary || ""}`;
const acknowledged = (run) => Boolean(run?.acknowledgedAt);

// The problem one finished run shows, or null for a clean run.
export function runProblem(run) {
  if (!run || LIVE.has(run.status)) return null;
  // A caller's webhook is judged after the run itself (below): a failed run is the bigger fact.
  if (run.deliveryStatus === "failed" && run.delivery !== "webhook") {
    if (UNDELIVERABLE.test(text(run))) return "undeliverable";
    if (/transport is not connected/i.test(text(run))) return "transport";
    return "delivery_failed";
  }
  if (run.status === "interrupted") return "interrupted";
  if (run.status === "blocked") return ["license", "access", "engine_disabled", "spending_limit"].includes(run.errorKind) ? run.errorKind : "blocked";
  if (run.status === "failed") {
    if (run.errorKind === "attempt_budget") return "attempts";
    if (run.errorKind === "authentication") return "login";
    if (run.errorKind === "usage_limit") return "usage_limit";
    const t = text(run);
    if (/\b(EAGAIN|process limit|Resource temporarily unavailable|out of memory|ENOMEM)\b/i.test(t)) return "resources";
    if (/\b(silent|stalled?|timed? ?out|timeout)\b/i.test(t)) return "timeout";
    if (/\b(401|unauthori[sz]ed|invalid (api )?key|credential|forbidden|403)\b/i.test(t)) return "credential";
    if ((run.connections || []).some((c) => c.status === "unavailable")) return "connector";
    if (run.outcomeSource === "agent-report") return "agent_failed";
    return "failed";
  }
  if (run.status === "skipped" && run.errorKind === "deferred") return "deferred";
  if (run.status === "skipped" && run.errorKind === "rejected") return "rejected";
  if (run.status === "skipped" && /transport is not connected/i.test(text(run))) return "transport";
  if (run.status === "unreported") return "unreported";
  if (run.deliveryStatus === "failed") return "webhook_failed";
  if (run.deliveryStatus === "pending" && Number(run.deliveryAttempts) > 1) return "delivery_retrying";
  return null;
}

// The problem a run still asks someone to handle: none once a person acknowledged it.
export function openProblem(run) {
  return acknowledged(run) ? null : runProblem(run);
}

// One square of the two-row strip: top = run, bottom = delivery.
export function stripCell(run) {
  const s = run.status;
  const runTone = s === "succeeded" ? "ok" : s === "no-op" ? "noop" : s === "completed" ? "done" : LIVE.has(s) ? "live" : s === "skipped" ? "skip"
    : s === "blocked" || s === "unreported" ? "warn" : BAD_RUN.has(s) ? "fail" : "skip";
  const d = run.deliveryStatus;
  const deliveryTone = d === "delivered" ? "ok" : d === "failed" ? "fail" : d === "pending" ? (LIVE.has(s) ? "live" : "warn") : d === "suppressed" ? "quiet" : "none";
  return { id: run.id, at: run.startedAt || null, run: runTone, delivery: deliveryTone, status: s || "", deliveryStatus: d || "", ack: acknowledged(run) && Boolean(runProblem(run)) };
}

// Consecutive bad runs from the newest finished one backwards.
export function failureStreak(runs) {
  let n = 0;
  for (const run of runs) {
    if (LIVE.has(run.status)) continue;
    if (run.status === "skipped" && run.errorKind !== "deferred") continue;
    // A run nobody asked to judge says nothing either way: it neither extends nor ends a streak.
    if (run.status === "completed" && run.deliveryStatus !== "failed") continue;
    if (!openProblem(run)) break;
    n += 1;
  }
  return n;
}

// The message a run lives under in its conversation: where its answer went, else the thread it
// announced itself in (a run that failed before delivering still has one), else nothing.
export function runThread(run) {
  return String(run?.deliveryThread || run?.thread || "");
}

export function windowStats(runs) {
  const finished = runs.filter((r) => !LIVE.has(r.status) && r.status !== "skipped");
  // "completed" finished without anyone asking for a task report: it counts as a run, never as
  // a success or a failure, so only JUDGED runs can move the success rate.
  const judged = finished.filter((r) => r.status !== "completed" || r.deliveryStatus === "failed");
  // Success means the work was done AND its answer arrived (or was held back by rule).
  const good = judged.filter((r) => (r.status === "succeeded" || r.status === "no-op") && r.deliveryStatus !== "failed").length;
  const cost = runs.reduce((sum, r) => sum + (typeof r.costUsd === "number" ? r.costUsd : 0), 0);
  return {
    runs: runs.length,
    finished: finished.length,
    judged: judged.length,
    succeeded: good,
    failed: finished.filter((r) => BAD_RUN.has(r.status)).length,
    notDelivered: runs.filter((r) => r.deliveryStatus === "failed").length,
    costUsd: Math.round(cost * 10000) / 10000,
    successRate: judged.length ? good / judged.length : null,
  };
}

// The latest run that can say something about an automation: finished, and not a plain skip.
export const settledRun = (run) => Boolean(run) && !LIVE.has(run.status) && !(run.status === "skipped" && !run.errorKind);

// The ONE definition of "this automation has a problem right now", from its stored row (null for
// an API source) and its latest settled run. The channel list, the board and the failure alerts
// all ask this; the board alone adds "flaky", which needs a whole window of runs.
export function currentProblem(schedule, latest) {
  const state = String(schedule?.executionState || "");
  const lastStatus = String(schedule?.lastStatus || "");
  const enabled = schedule ? schedule.enabled !== false : true;
  // A schedule-level verdict (undeliverable, interrupted) stays acknowledged until the scheduler
  // writes a different status, which only a new run or a new archival does.
  const stateAcknowledged = Boolean(schedule?.acknowledgedStatus) && schedule.acknowledgedStatus === lastStatus;
  if (schedule && !stateAcknowledged && (state === "undeliverable" || /^undeliverable:|^paused: channel archived/.test(lastStatus))) return "undeliverable";
  if (schedule && !stateAcknowledged && !enabled && state === "interrupted") return "interrupted";
  return enabled ? openProblem(latest) : null;
}

// The verdict for one automation. `schedule` is the stored row (null for API sources); `runs`
// are its newest runs (newest first); `windowRuns` the runs inside the board's time window.
export function automationHealth(schedule, runs, windowRuns = runs) {
  const latest = runs.find(settledRun) || null;
  const running = runs.some((r) => LIVE.has(r.status));
  const streak = failureStreak(runs);
  const stats = windowStats(windowRuns);
  const enabled = schedule ? schedule.enabled !== false : true;
  // Acknowledged failures no longer make the automation look flaky; the stats above stay honest.
  const open = windowStats(windowRuns.filter((r) => !(acknowledged(r) && runProblem(r))));
  let key = currentProblem(schedule, latest);
  let since = null;
  if (!key && enabled && open.judged >= 3 && open.successRate !== null && open.successRate < 0.8) key = "flaky";
  if (key) {
    // When this problem started: the oldest run of the current streak, else the latest run.
    const first = runs.filter((r) => !LIVE.has(r.status)).slice(0, Math.max(1, streak)).at(-1);
    since = first?.startedAt || latest?.startedAt || null;
  }
  const paused = Boolean(schedule) && !enabled && key !== "interrupted";
  const health = paused ? "paused" : !key ? "healthy" : HARD.has(key) || streak >= 2 ? "broken" : "degraded";
  const outcome = key ? PROBLEMS[key].outcome : null;
  return {
    health,
    attention: health === "broken" || health === "degraded",
    group: health === "paused" ? "paused" : !key ? "healthy" : outcome === "delivery" ? "not-delivered" : "failing",
    problem: key ? { key, label: PROBLEMS[key].label, outcome, since, message: problemMessage(key, latest, schedule, streak), code: latest?.errorKind || "" } : null,
    streak,
    running,
    lastRun: latest ? { id: latest.id, status: latest.status, deliveryStatus: latest.deliveryStatus || "", startedAt: latest.startedAt || null, error: latest.error || "", summary: latest.summary || "", engine: latest.engine || "", model: latest.model || "",
      thread: runThread(latest), costUsd: typeof latest.costUsd === "number" ? latest.costUsd : null } : null,
    strip: runs.slice(0, 30).map(stripCell).reverse(),
    stats,
    // Recent runs whose error nobody acknowledged yet, and the last acknowledgement shown when
    // the automation went back to healthy because of it.
    openErrors: runs.filter((r) => openProblem(r)).length,
    acknowledgement: !key && latest && acknowledged(latest) && runProblem(latest)
      ? { at: latest.acknowledgedAt, byName: latest.acknowledgedByName || "", label: PROBLEMS[runProblem(latest)].label, runId: latest.id } : null,
  };
}

function problemMessage(key, run, schedule, streak) {
  const detail = String(run?.error || run?.summary || "").trim();
  const times = streak > 1 ? ` (${streak} runs in a row)` : "";
  switch (key) {
    case "undeliverable": return "The gateway can no longer post in this conversation: the bot was removed or the channel was archived. Runs that finish are not posted.";
    case "delivery_failed": return `The run finished but its answer could not be posted${detail ? `: ${detail}` : "."}`;
    case "webhook_failed": return `The run finished, but the caller's webhook did not accept the result${run?.deliveryError ? ` (${run.deliveryError})` : ""}. The result is still available from GET /api/runs/${run?.id || "<job id>"}.`;
    case "rejected": return `The gateway refused ${Number(run?.rejectedCount) > 1 ? `${run.rejectedCount} calls` : "a call"} because too many API runs were already in flight. Nothing ran for ${Number(run?.rejectedCount) > 1 ? "them" : "it"}.`;
    case "delivery_retrying": return `The answer is saved and the gateway is retrying the post every minute (attempt ${Number(run?.deliveryAttempts) || 2}).`;
    case "transport": return "The chat platform for this conversation was not connected when the automation was due.";
    case "interrupted": return "The gateway restarted while this automation was running. It was paused because external actions (emails, updates) may already have happened.";
    case "blocked": return detail || "The run stopped waiting for an approval or an answer.";
    case "flaky": return "Recent runs mix successes and failures. Open the failed runs to find the pattern.";
    case "unreported": return "The run ended without a task report, so nobody knows whether the work was done.";
    default: return (detail || PROBLEMS[key].label) + times;
  }
}

// What to do about it, as numbered steps. Each step may name ONE action the board renders as a
// button; the server never trusts these, every action is re-authorized on its own endpoint.
export function fixSteps(key, { kind = "Task", once = false, botName = "" } = {}) {
  const bot = botName ? `@${botName.replace(/^@/, "")}` : "the bot";
  const steps = {
    undeliverable: [
      { title: `Add ${bot} back to the conversation`, body: botName ? "Anyone in the conversation can do it. If the channel was archived, unarchive it first." : "Type /invite in the conversation and pick the bot. If the channel was archived, unarchive it first.", ...(botName ? { copy: `/invite ${bot}` } : {}) },
      { title: "Run it again", body: "Runs the automation now so today's result is posted. This runs the agent again, so it costs a run.", action: "run-now" },
    ],
    delivery_failed: [
      { title: "Check the conversation still accepts posts", body: "Open the last run to read the exact refusal from the chat platform.", action: "open-runs" },
      { title: "Run it again", body: "Runs the agent again and posts its answer.", action: "run-now" },
    ],
    delivery_retrying: [{ title: "Nothing to do yet", body: "The saved answer is posted as soon as the conversation accepts it. No agent run, no extra cost." }],
    transport: [
      { title: "Reconnect the chat platform", body: "An admin reconnects it in Settings → Platforms. Due runs resume on their own." },
      { title: "Run it now if today's result is needed", action: "run-now" },
    ],
    interrupted: [
      { title: "Check what already happened", body: "Read the last run's log. Emails, posts or record updates may already have gone out before the restart.", action: "open-runs" },
      { title: "Turn it back on, or run it now", body: "Turning it on resumes the schedule. Running now repeats the work, which can repeat external actions.", action: "enable" },
    ],
    blocked: [
      { title: "Open the run's thread", body: "Answer the approval card or question there, then run it again.", action: "open-runs" },
      { title: "Or change the instructions", body: "Say exactly what the automation may do so it doesn't need to stop and ask.", action: "edit" },
    ],
    login: [
      { title: "Sign the engine back in", body: "An admin renews the Claude or Codex login on the gateway. The next run picks it up." },
      { title: "Run it again", action: "run-now" },
    ],
    credential: [
      { title: "Update the rejected secret", body: "Replace it in the conversation's Settings → Secrets (values are write-only)." },
      { title: "Run it again", action: "run-now" },
    ],
    connector: [
      { title: "Reconnect the tool", body: "Open the last run to see which connection was unavailable, then reconnect it in Settings → Connections.", action: "open-runs" },
      { title: "Run it again", action: "run-now" },
    ],
    usage_limit: [{ title: "Wait for the limit to reset, or switch engine", body: "The engine's usage limit was reached. Change the engine or model in the conversation's settings, or pause until the limit resets.", action: "pause" }],
    spending_limit: [{ title: "Raise or wait for the spending limit", body: "An admin can raise the limit in Settings → Usage. Pause the automation until then to avoid repeated refusals.", action: "pause" }],
    license: [{ title: "Check the plan's limits", body: "This conversation reached the plan's monthly limit. An admin can upgrade or wait for the next period.", action: "pause" }],
    access: [{ title: "Check who created it", body: "The creator no longer has access to this conversation. Recreate the automation as someone who does, or delete it." }],
    engine_disabled: [{ title: "Turn the engine back on or change it", body: "The engine this conversation uses was turned off by an admin." }],
    timeout: [
      { title: "Read the last run's log", body: "Find the step that hung: a long tool call, a stuck browser or a large download.", action: "open-runs" },
      { title: "Make the instructions smaller", body: "Split the work, or give the agent a clear stopping point.", action: "edit" },
    ],
    resources: [
      { title: "Free the container", body: "Something left running (browser sessions, servers) used up the conversation's process limit. Ask the agent in the conversation to close them." },
      { title: "Run it again", action: "run-now" },
    ],
    attempts: [{ title: once ? "Schedule it again" : "Run it again", body: "Every allowed attempt failed. Read the last run first.", action: once ? "edit" : "run-now" }],
    webhook_failed: [
      { title: "Check the webhook URL answers with 2xx", body: "The gateway posts the result once when the run ends and tries again after a gateway restart. Open the run to read what the endpoint answered.", action: "open-runs" },
      { title: "Fetch the result yourself", body: "GET /api/runs/<job id> returns the same result for 7 days." },
    ],
    rejected: [
      { title: "Slow the caller down", body: "Send fewer runs at once, or retry a 429 answer after a short wait. The limit counts every API run on this gateway." },
      { title: "Use an idempotency key", body: "A retry with the same idempotencyKey returns the original run instead of starting another." },
    ],
    deferred: [{ title: "No action needed", body: "Too many automations were due at once, so this one waited. It runs in the next free minute." }],
    agent_failed: [
      { title: "Read why the agent says it failed", action: "open-runs" },
      { title: "Fix the cause, or adjust the instructions", action: "edit" },
    ],
    failed: [
      { title: "Read the last run's error", action: "open-runs" },
      { title: "Run it again", action: "run-now" },
    ],
    unreported: [{ title: "Add success criteria", body: "Tell the automation what success looks like so every run reports a clear outcome.", action: "edit" }],
    flaky: [
      { title: "Compare a failed run with a good one", action: "open-runs" },
      { title: "Tighten the instructions", action: "edit" },
    ],
  };
  if (kind === "API" && key === "unreported") return [{ title: "Read the run's answer", body: "The call asked for an outcome report (reportOutcome, successCriteria or visibility \"on-failure\"), and the agent's answer ended without a valid one.", action: "open-runs" }];
  const out = steps[key] || [];
  return kind === "API" ? out.filter((s) => !["run-now", "edit", "enable", "pause"].includes(s.action)).map((s) => ({ ...s })) : out;
}
