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
const { apiSourcesForChannel, apiSourceVisible, apiSourceId, backfillApiRunLedger, noteApiRejection, syncApiRun, ORG_KEY_SOURCE, apiRunStatus } = await import("../src/gateway/api-run-history.js");
const { listScheduleRuns, getScheduleRun, scheduleRunSummary } = await import("../src/gateway/schedule-runs.js");
const { recordTaskOutcome } = await import("../src/gateway/automation-run-recorder.js");
const { runProblem, automationHealth, currentProblem } = await import("../src/gateway/automation-health.js");
const { resultPosts, apiPostingRule, suppressScheduleResult } = await import("../src/gateway/schedule-outcome.js");
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

test("API outcome answers strip metadata only when outcome reporting was requested", () => {
  const valid = report({ status: "no-op", summary: "Empty", connections: [] });
  for (const content of [
    "Done.\n\n```automation-result\n{bad json\n```",
    "Done.\n\n```automation-result\n{bad json",
    `${valid}\nLater output.`,
    `${valid}\n${valid}`,
  ]) {
    for (const reportOutcome of [true, false]) {
      const result = apiRunOutcome({ content }, { reportOutcome });
      if (reportOutcome) assert.doesNotMatch(result.content, /```automation-result/);
      else assert.equal(result.content, content);
      assert.match(result.content, /Done\./);
      assert.equal(result.automationOutcome.status, "unreported");
      assert.equal(result.automationOutcome.source, reportOutcome ? "unreported" : "none");
    }
  }
  assert.equal(apiRunOutcome({ content: valid }).content, valid);
  assert.equal(apiRunOutcome({ content: valid, engineError: true }).content, valid);
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

  // Jobs stored before the shared ledger existed are folded into it once, idempotently.
  assert.equal(backfillApiRunLedger(), 3);
  assert.equal(backfillApiRunLedger(), 0);

  const admin = apiSourcesForChannel(channelId, { isAdmin: true, userId: "U_ADMIN" });
  assert.deepEqual(admin.map((s) => s.id).sort(), [ORG_KEY_SOURCE, `api:${token.record.id}`].sort());
  const tok = admin.find((s) => s.id !== ORG_KEY_SOURCE);
  assert.equal(tok.total, 2);
  assert.match(tok.title, /make flow/);
  const summary = scheduleRunSummary(tok.id, channelId);
  assert.equal(summary.lastStatus, "blocked", "the latest run decides the failing badge");
  assert.equal(summary.successRate, 0.5);

  const owner = apiSourcesForChannel(channelId, { userId: "U_OWNER" });
  assert.deepEqual(owner.map((s) => s.id), [`api:${token.record.id}`], "the organization key's runs are admin-only");
  assert.deepEqual(apiSourcesForChannel(channelId, { userId: "U_OTHER" }), [], "another member sees no one else's token runs");
  assert.equal(apiSourceVisible(channelId, ORG_KEY_SOURCE, { userId: "U_OWNER" }), false);
  assert.equal(apiSourceVisible(channelId, tok.id, { userId: "U_OTHER" }), false);

  // The same ledger rows schedules write: status, model, connections, trigger.
  const runs = listScheduleRuns({ scheduleId: tok.id, channelId });
  assert.equal(runs[0].id, "out-t2");
  assert.equal(runs[0].status, "blocked");
  assert.equal(runs[0].trigger, "api");
  assert.equal(runs[0].model, "claude-opus-5-5");
  assert.deepEqual(runs[0].connections, [{ name: "composio-agent/gmail", status: "unavailable" }]);
  assert.equal(listScheduleRuns({ scheduleId: ORG_KEY_SOURCE, channelId })[0].status, "failed");
  // A conversation-wide read of the scheduled half never includes them.
  assert.deepEqual(listScheduleRuns({ channelId, scheduledOnly: true }), []);

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
  assert.equal(api.every((a) => a.trigger === "api"), true);
  assert.equal(automationRuns(access, entry, ORG_KEY_SOURCE, "U_ADMIN")[0].id, "out-k1");
  assert.throws(() => automationRuns({ user: {} }, entry, ORG_KEY_SOURCE, "U_OWNER"), /denied/);
  assert.throws(() => deleteAutomation(access, "U_ADMIN", entry, ORG_KEY_SOURCE), /not deletable/);
});

// ── One ledger, one recorder, one definition of "failing" ───────────────────────────────────
test("a started API run writes a ledger row, grouped by its optional name", async () => {
  const driver = () => {};
  const bad = await startApiRun({ message: "x", name: 42, driver });
  assert.equal(bad.code, 400);
  const started = await startApiRun({ message: "sync the CRM with secret=hunter2", name: "Nightly CRM sync", idempotencyKey: "ledger-1", driver });
  assert.equal(started.ok, true);
  const job = getApiJob(started.jobId);
  assert.equal(job.name, "Nightly CRM sync");
  const run = getScheduleRun(started.jobId);
  assert.equal(run.trigger, "api");
  assert.equal(run.scheduleId, apiSourceId(job));
  assert.match(run.scheduleId, /^api:org-key~nightly-crm-sync$/);
  assert.equal(run.status, "running");
  assert.equal("webhookUrl" in run || "textForRun" in run, false, "the ledger never stores the webhook URL or the full prompt");

  // A repeated call with the same idempotency key starts nothing and is counted on the run.
  const again = await startApiRun({ message: "sync the CRM with secret=hunter2", name: "Nightly CRM sync", idempotencyKey: "ledger-1", driver });
  assert.equal(again.reused, true);
  assert.equal(getScheduleRun(started.jobId).duplicates, 1);

  // A different name is a different source; no name falls back to the credential alone.
  assert.equal(apiSourceId({ principalKind: "api" }), ORG_KEY_SOURCE);
  assert.equal(apiSourceId({ principalKind: "user", apiTokenId: "tok1", name: "A / B" }), "api:tok1~a-b");
});

test("a run that was never asked to report is completed, not a problem; a missing requested report is", async () => {
  const driver = () => {};
  const plain = await startApiRun({ message: "hello", name: "plain", driver });
  const plainResult = apiRunOutcome({ content: "Plain answer", engine: "claude", completed: true });
  const neutral = recordTaskOutcome(plain.jobId, plainResult);
  assert.equal(neutral.status, "completed");
  assert.equal(runProblem(neutral), null);
  assert.equal(currentProblem(null, neutral), null);
  assert.equal(apiRunStatus({ status: "completed", taskStatus: "unreported", outcome: { source: "none" } }), "completed");
  const health = automationHealth(null, [neutral]);
  assert.equal(health.health, "healthy");
  assert.equal(health.stats.successRate, null, "an unjudged run is not counted as a success or a failure");

  const asked = await startApiRun({ message: "hello", name: "asked", reportOutcome: true, driver });
  const missing = recordTaskOutcome(asked.jobId, apiRunOutcome({ content: "I forgot the block", engine: "claude", completed: true }, { reportOutcome: true }));
  assert.equal(missing.status, "unreported");
  assert.equal(runProblem(missing), "unreported");
});

test("webhook delivery maps onto the ledger's delivery states, beside the run's own outcome", async () => {
  const started = await startApiRun({ message: "hello", name: "hooked", webhook: "https://93.184.216.34/hook?token=abc", driver: () => {} });
  assert.equal(started.ok, true, started.error);
  const job = getApiJob(started.jobId);
  assert.equal(getScheduleRun(job.id).deliveryStatus, "pending");
  assert.doesNotMatch(JSON.stringify(getScheduleRun(job.id)), /93\.184\.216\.34|token=abc/);
  recordTaskOutcome(job.id, apiRunOutcome({ content: report({ status: "succeeded", summary: "done" }), completed: true }, { reportOutcome: true }));

  Object.assign(job, { status: "completed", completedMs: Date.now(), webhookPending: true, webhookAttempts: 3, webhookError: "HTTP 500" });
  const failed = syncApiRun(job);
  assert.equal(failed.status, "succeeded", "the run's own outcome is untouched");
  assert.equal(failed.deliveryStatus, "failed");
  assert.equal(failed.deliveryError, "HTTP 500");
  assert.equal(runProblem(failed), "webhook_failed");

  Object.assign(job, { webhookPending: false });
  const delivered = syncApiRun(job);
  assert.equal(delivered.deliveryStatus, "delivered");
  assert.equal(delivered.deliveryError, "");
  assert.equal(runProblem(delivered), null);
});

test("calls refused at the in-flight cap leave one aggregated trace per source", () => {
  const channelId = "CAPIREJ";
  const now = Date.now();
  noteApiRejection({ channelId, principalKind: "api", name: "burst", now });
  noteApiRejection({ channelId, principalKind: "api", name: "burst", now: now + 1000 });
  const rows = listScheduleRuns({ scheduleId: "api:org-key~burst", channelId });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "skipped");
  assert.equal(rows[0].rejectedCount, 2);
  assert.equal(runProblem(rows[0]), "rejected");
});

test("one posting rule serves schedules and API visibility", () => {
  assert.equal(resultPosts(apiPostingRule("hidden"), "failed"), false);
  assert.equal(resultPosts(apiPostingRule("on-failure"), "succeeded"), false);
  assert.equal(resultPosts(apiPostingRule("on-failure"), "blocked"), true);
  assert.equal(resultPosts(apiPostingRule("visible"), "succeeded"), true);
  assert.equal(suppressScheduleResult({ resultPolicy: "on-result" }, { automationOutcome: { status: "no-op" } }), true);
  assert.equal(suppressScheduleResult({ resultPolicy: "always", failureNotify: false }, { automationOutcome: { status: "failed" } }), true);
  assert.equal(suppressScheduleResult({}, { automationOutcome: { status: "succeeded" } }), false);
});

test("the board builds API sources like schedules: acknowledge, limits, the shared failing verdict", async () => {
  const { automationBoard, acknowledgeAutomation, automationChannels } = await import("../src/gateway/automations-view.js");
  const { upsertChannelEntry } = await import("../src/config/store.js");
  const channelId = "CAPIOUT1";
  await upsertChannelEntry(channelId, { slug: "api-out", name: "api-out" });
  const access = { user: { isAdmin: true }, allows: async () => true };
  const board = await automationBoard(access, "U_ADMIN", { days: 7, adminConsole: true });
  const api = board.automations.filter((a) => a.trigger === "api" && a.channelId === channelId);
  assert.equal(api.length, 2);
  const tok = api.find((a) => a.id !== ORG_KEY_SOURCE);
  assert.equal(tok.kind, "API");
  assert.equal(tok.canAcknowledge, true);
  assert.equal(tok.canDelete, false);
  assert.equal(tok.problem.key, "blocked");
  assert.equal(tok.limits.cap, 25);
  const channels = await automationChannels(access, "U_ADMIN");
  assert.equal(channels.find((c) => c.channelId === channelId).failing, 2, "the list counts what the board calls a problem");
  const acked = await acknowledgeAutomation(access, "U_ADMIN", { channelId, slug: "api-out" }, tok.id, {});
  assert.ok(acked);
  const after = await automationBoard(access, "U_ADMIN", { days: 7, adminConsole: true });
  assert.equal(after.automations.find((a) => a.id === tok.id).problem, null);
});

test("three failures in a row alert the owner once, for either trigger; a success resets the streak", async () => {
  const { createAutomationRun, updateScheduleRun } = await import("../src/gateway/schedule-runs.js");
  const { alertFailureStreak, FAILURE_STREAK_ALERT } = await import("../src/gateway/automation-run-recorder.js");
  assert.equal(FAILURE_STREAK_ALERT, 3);
  const channelId = "CSTREAK";
  const sent = [];
  let at = Date.now() - 60_000;
  const settle = (scheduleId, status) => {
    const run = createAutomationRun({ scheduleId, channelId, startedMs: at += 1000, description: "x", trigger: scheduleId.startsWith("api:") ? "api" : "schedule" });
    updateScheduleRun(run.id, { status, taskStatus: status, error: status === "failed" ? "boom" : "", completedAt: new Date(at).toISOString(), deliveryStatus: "delivered" });
    return alertFailureStreak({ scheduleId, channelId, title: "Nightly *sync*", notify: async (text) => sent.push(text) });
  };
  for (const id of ["api:tokx~nightly", "sched-streak-1"]) {
    sent.length = 0;
    assert.equal(await settle(id, "failed"), false);
    assert.equal(await settle(id, "failed"), false);
    assert.equal(await settle(id, "failed"), true, "the third failure in a row alerts");
    assert.equal(await alertFailureStreak({ scheduleId: id, channelId, notify: async (t) => sent.push(t) }), false, "never twice for the same run");
    assert.equal(await settle(id, "failed"), false, "the fourth is silent");
    assert.equal(await settle(id, "succeeded"), false);
    assert.equal(await settle(id, "failed"), false, "a success reset the streak");
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Nightly sync.*failed 3 runs in a row/);
  }
  // The automation's own "no failure notices" choice wins.
  const quiet = "sched-streak-quiet";
  for (let i = 0; i < 3; i += 1) {
    const run = createAutomationRun({ scheduleId: quiet, channelId, startedMs: at += 1000, description: "x" });
    updateScheduleRun(run.id, { status: "failed", taskStatus: "failed", completedAt: new Date(at).toISOString() });
  }
  assert.equal(await alertFailureStreak({ scheduleId: quiet, channelId, enabled: false, notify: async (t) => sent.push(t) }), false);
});

test("get_schedule_runs keeps API rows behind the token-creator rule", async () => {
  const { register } = await import("../src/mcp/tools/schedules.js");
  const channelId = "CAPIOUT1";
  const tool = (ctx) => {
    const handlers = new Map();
    register({ registerTool: (name, _config, fn) => handlers.set(name, fn) }, { channelId, text: (value) => value, ...ctx });
    return async (args) => JSON.parse(await handlers.get("get_schedule_runs")(args));
  };
  const tokenSource = apiSourcesForChannel(channelId, { isAdmin: true }).find((s) => s.id !== ORG_KEY_SOURCE).id;
  const member = tool({ createdBy: "U_OTHER", requireAdmin: async () => false });
  const owner = tool({ createdBy: "U_OWNER", requireAdmin: async () => false });
  const admin = tool({ createdBy: "U_ADMIN", requireAdmin: async () => true });

  // A conversation-wide read is the scheduled half only, for everyone.
  for (const read of [member, owner, admin]) assert.deepEqual((await read({})).runs.filter((r) => r.trigger === "api"), []);
  // Asking for a source or one of its runs by id answers only its creator or an admin.
  assert.deepEqual((await member({ schedule_id: tokenSource })).runs, []);
  assert.match((await member({ run_id: "out-t2" })).error, /No run/);
  assert.equal((await owner({ schedule_id: tokenSource })).runs.length, 2);
  assert.equal((await owner({ run_id: "out-t2" })).id, "out-t2");
  assert.deepEqual((await owner({ schedule_id: ORG_KEY_SOURCE })).runs, [], "the organization key's runs are admin-only");
  assert.equal((await admin({ schedule_id: ORG_KEY_SOURCE })).runs[0].id, "out-k1");
});
