// API runs as automations: success criteria ("goal") in the outcome-report instruction, the task
// outcome an API run records, and the Automations page's API sources with their visibility rule.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
process.env.CG_WORKSPACE_DIR = path.join(scratch, "api-outcome-workspaces");

const { automationPrompt, normalizeSuccessCriteria } = await import("../src/gateway/schedule-outcome.js");
const { startApiRun, getApiJob, apiRunOutcome } = await import("../src/gateway/api-runs.js");
const { apiSourcesForChannel, apiSourceRuns, ORG_KEY_SOURCE, apiRunStatus } = await import("../src/gateway/api-run-history.js");
const { createApiToken } = await import("../src/gateway/api-tokens.js");
const { getDb, toJson } = await import("../src/db/index.js");

const report = (json) => "Done.\n\n```automation-result\n" + JSON.stringify(json) + "\n```";

test("success criteria are injected into the outcome instruction only when set", () => {
  const plain = automationPrompt("Draft replies");
  assert.doesNotMatch(plain, /Success criteria/);
  const goal = automationPrompt("Draft replies", { successCriteria: "A draft exists for every unread client email" });
  assert.match(goal, /Success criteria[^\n]*\nA draft exists for every unread client email\n/);
  assert.match(goal, /Report succeeded only when every criterion is met/);
  assert.equal(normalizeSuccessCriteria(undefined), "");
  assert.equal(normalizeSuccessCriteria("  x  "), "x");
  assert.throws(() => normalizeSuccessCriteria(42), /must be a string/);
  assert.throws(() => normalizeSuccessCriteria("x".repeat(2001)), /limited to 2000/);
});

test("an API run's outcome: gateway facts always, the agent's report only when asked", () => {
  const ok = { content: report({ status: "succeeded", summary: "3 drafts created", connections: [{ name: "composio-agent/gmail", status: "available" }] }) };
  const asked = apiRunOutcome(ok, { reportOutcome: true });
  assert.equal(asked.automationOutcome.status, "succeeded");
  assert.equal(asked.content, "Done.", "the report block never reaches the caller's answer");

  const notAsked = apiRunOutcome({ content: "Plain answer" });
  assert.equal(notAsked.automationOutcome.status, "unreported");
  assert.equal(notAsked.automationOutcome.source, "none");
  assert.equal(notAsked.content, "Plain answer");

  // Admission refusals (license / usage cap) and engine failures are reported without asking.
  assert.equal(apiRunOutcome({ content: "Monthly limit reached.", licenseRefused: true }).automationOutcome.status, "blocked");
  assert.equal(apiRunOutcome({ content: "", engineError: true }).automationOutcome.status, "failed");

  // A connection the agent found unavailable cannot be reported as success.
  const broken = apiRunOutcome({ content: report({ status: "succeeded", summary: "x", connections: [{ name: "composio-agent/gmail", status: "unavailable" }] }) }, { reportOutcome: true });
  assert.equal(broken.automationOutcome.status, "blocked");
});

test("startApiRun validates and stores successCriteria, and wraps the prompt with it", async () => {
  const driver = () => {};
  const tooLong = await startApiRun({ message: "x", successCriteria: "y".repeat(2001), driver });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.code, 400);
  const badFlag = await startApiRun({ message: "x", reportOutcome: "yes", driver });
  assert.equal(badFlag.code, 400);

  const started = await startApiRun({ message: "sync invoices", successCriteria: "Every paid invoice is marked paid in Airtable", driver });
  assert.equal(started.ok, true);
  const job = getApiJob(started.jobId);
  assert.equal(job.reportOutcome, true, "a goal implies outcome reporting");
  assert.equal(job.successCriteria, "Every paid invoice is marked paid in Airtable");
  assert.match(job.textForRun, /\[Automation outcome reporting\]\nSuccess criteria/);

  const plain = await startApiRun({ message: "hello", driver });
  const plainJob = getApiJob(plain.jobId);
  assert.equal(plainJob.reportOutcome, false);
  assert.doesNotMatch(plainJob.textForRun, /Automation outcome reporting/);
});

function insertJob(job) {
  getDb().prepare("INSERT INTO api_jobs(id, status, created_ms, data) VALUES(?, ?, ?, ?)").run(job.id, job.status, job.createdMs, toJson(job));
}

test("API sources group by credential and follow the API-token visibility rule", () => {
  const channelId = "CAPIOUT1";
  const token = createApiToken({ name: "make flow", channelId, slug: "api-out", createdBy: "U_OWNER" });
  const now = Date.now();
  const base = { channelId, slug: "api-out", engine: "claude", startedMs: now, completedMs: now, durationMs: 1200 };
  insertJob({ ...base, id: "out-t1", status: "completed", createdMs: now - 3000, principalKind: "user", apiTokenId: token.record.id, taskStatus: "succeeded", outcome: { status: "succeeded", summary: "ok", connections: [] }, costUSD: 0.02 });
  insertJob({ ...base, id: "out-t2", status: "completed", createdMs: now - 1000, principalKind: "user", apiTokenId: token.record.id, taskStatus: "blocked", outcome: { status: "blocked", summary: "Gmail expired", connections: [{ name: "composio-agent/gmail", status: "unavailable" }] }, model: "claude-opus-5-5" });
  insertJob({ ...base, id: "out-k1", status: "failed", createdMs: now - 2000, principalKind: "api", error: "boom" });

  const admin = apiSourcesForChannel(channelId, { isAdmin: true, userId: "U_ADMIN" });
  assert.deepEqual(admin.map((s) => s.id).sort(), [ORG_KEY_SOURCE, `api:${token.record.id}`].sort());
  const tok = admin.find((s) => s.id !== ORG_KEY_SOURCE);
  assert.equal(tok.runs.total, 2);
  assert.equal(tok.runs.lastStatus, "blocked", "the latest finished run decides the failing badge");
  assert.equal(tok.runs.successRate, 0.5);
  assert.match(tok.title, /make flow/);

  const owner = apiSourcesForChannel(channelId, { userId: "U_OWNER" });
  assert.deepEqual(owner.map((s) => s.id), [`api:${token.record.id}`], "the organization key's runs are admin-only");
  assert.deepEqual(apiSourcesForChannel(channelId, { userId: "U_OTHER" }), [], "another member sees no one else's token runs");
  assert.throws(() => apiSourceRuns(channelId, ORG_KEY_SOURCE, { userId: "U_OWNER" }), /denied/);

  const runs = apiSourceRuns(channelId, `api:${token.record.id}`, { userId: "U_OWNER" });
  assert.equal(runs[0].id, "out-t2");
  assert.equal(runs[0].status, "blocked");
  assert.equal(runs[0].model, "claude-opus-5-5");
  assert.deepEqual(runs[0].connections, [{ name: "composio-agent/gmail", status: "unavailable" }]);
  assert.equal(apiSourceRuns(channelId, ORG_KEY_SOURCE, { isAdmin: true })[0].status, "failed");

  assert.equal(apiRunStatus({ status: "completed" }), "unreported");
  assert.equal(apiRunStatus({ status: "running" }), "running");
  assert.equal(apiRunStatus({ status: "stopped" }), "skipped");
});

test("the Automations view lists API sources beside schedules, never deletable", async () => {
  const { channelAutomations, automationRuns, deleteAutomation } = await import("../src/gateway/automations-view.js");
  const access = { user: { isAdmin: true } };
  const entry = { channelId: "CAPIOUT1", slug: "api-out" };
  const list = channelAutomations(access, "U_ADMIN", entry);
  const api = list.filter((a) => a.kind === "API");
  assert.equal(api.length, 2);
  assert.equal(api.every((a) => a.canDelete === false), true);
  assert.equal(automationRuns(access, entry, ORG_KEY_SOURCE, "U_ADMIN")[0].id, "out-k1");
  assert.throws(() => deleteAutomation(access, "U_ADMIN", entry, ORG_KEY_SOURCE), /not deletable/);
});
