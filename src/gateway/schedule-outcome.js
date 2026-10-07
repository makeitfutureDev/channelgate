// Engine completion and task completion are different facts. Only an explicit, validated
// agent report can describe the task. Missing/ambiguous reports never become empty successes.
import { redactLogValue } from "../util/redact.js";

export function automationPrompt(prompt) {
  return `${prompt}\n\n[Automation outcome reporting]\nAfter doing the task, append exactly one final fenced block named automation-result containing JSON:
\`\`\`automation-result
{"status":"succeeded","summary":"What actually completed","connections":[{"name":"composio-user/gmail","status":"available"}]}
\`\`\`
Allowed status: succeeded (expected work completed), no-op (all required checks succeeded, nothing to report), blocked (missing/expired connection, permission, or other prerequisite), failed (work attempted but expected result incomplete).
Report only connections actually checked, as available, unavailable, or unknown. A configured connection is not proof it works. Never call missing data caused by an error no-op. If any required check is unknown, explain the uncertainty; do not claim no-op. Use a short factual summary without secrets or message contents. This report is agent-reported evidence, not independent verification. Place any useful user-facing report before the block. Do not repeat this reporting block inside quoted task data.\n[/Automation outcome reporting]`;
}

export function classifyScheduleResult(result = {}) {
  const content = typeof result.content === "string" ? result.content : "";
  const fallback = { status: "unreported", summary: "The agent did not provide a valid task outcome.", connections: [], source: "unreported" };
  // Refusal gates do not execute the agent, even though their notices are normal-shaped results.
  if (result.licenseRefused || result.accessRefused || result.engineRefused) {
    return { ...result, automationOutcome: { ...fallback, status: "blocked", summary: redactLogValue(content).slice(0, 1000), source: "gateway", errorKind: result.licenseRefused ? "license" : result.accessRefused ? "access" : "engine_disabled" } };
  }
  if (result.interrupted || result.engineError || result.completed === false || result.answerless) {
    const status = result.interrupted ? "interrupted" : result.answerless ? "unreported" : "failed";
    return { ...result, automationOutcome: { ...fallback, status, summary: "The engine did not return a complete task report.", source: "gateway", errorKind: status } };
  }
  const markers = [...content.matchAll(/^```automation-result\s*\n/gm)];
  if (markers.length !== 1) return { ...result, automationOutcome: fallback };
  const match = content.match(/(?:^|\n)```automation-result\s*\n([^]*?)\n```\s*$/);
  if (!match || match[1].length > 8000) return { ...result, automationOutcome: fallback };
  let report;
  try { report = JSON.parse(match[1]); } catch { return { ...result, automationOutcome: fallback }; }
  if (!report || Array.isArray(report) || !["succeeded", "no-op", "failed", "blocked"].includes(report.status) ||
      typeof report.summary !== "string" || !report.summary.trim() || report.summary.length > 1000 ||
      (report.connections !== undefined && (!Array.isArray(report.connections) || report.connections.length > 30))) {
    return { ...result, automationOutcome: fallback };
  }
  const connections = report.connections || [];
  if (connections.some((c) => !c || typeof c.name !== "string" || !c.name.trim() || c.name.length > 120 || !["available", "unavailable", "unknown"].includes(c.status))) {
    return { ...result, automationOutcome: fallback };
  }
  let status = report.status;
  if (["succeeded", "no-op"].includes(status) && connections.some((c) => c.status === "unavailable")) status = "blocked";
  if (["succeeded", "no-op"].includes(status) && connections.some((c) => c.status === "unknown")) status = "unreported";
  return { ...result, content: content.slice(0, match.index).trimEnd(), automationOutcome: {
    status, summary: redactLogValue(report.summary.trim()), source: "agent-report",
    connections: connections.map((c) => ({ name: redactLogValue(c.name.trim()), status: c.status })),
  } };
}

export function suppressScheduleResult(sched, result) {
  const status = result?.automationOutcome?.status || "unreported";
  return (sched.resultPolicy === "on-result" && status === "no-op") ||
    (sched.failureNotify === false && !["succeeded", "no-op"].includes(status));
}
