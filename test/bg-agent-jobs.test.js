// Background AGENT jobs: the daemon-owned durable subagent. These tests cover the job-record
// plumbing (validation, kind-aware persistence, status surface) without spawning an engine —
// the end-to-end run is a manual TEST-PLAN check (it needs a live Slack + `claude`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
const { useFakeRuntime: __useFakeRuntime } = await import("./runtime-fake.js");
await __useFakeRuntime();
// Keep default channel workspaces inside the scratch dir (never the operator's real ~/ChannelGate).
process.env.CG_WORKSPACE_DIR = path.join(scratch, "workspaces");

const [{ BackgroundJobs, backgroundCompletionNotice }, { getDb, fromJson }, { upsertChannelEntry, saveChannelMeta, setUser }] = await Promise.all([
  import("../src/gateway/background.js"),
  import("../src/db/index.js"),
  import("../src/config/store.js"),
]);

test("completion notices explain outcomes instead of exposing process codes", () => {
  const success = backgroundCompletionNotice({
    what: "Background job",
    label: "Verify toolbox and restart recovery",
    outcome: { ok: true, kind: "success", summary: "completed successfully" },
  });
  assert.equal(
    success,
    "✅ Background job *Verify toolbox and restart recovery* completed successfully. Continuing…",
  );
  assert.doesNotMatch(success, /exit code|code 0/i);

  const failure = backgroundCompletionNotice({
    what: "Background job",
    label: "Verify toolbox and restart recovery",
    outcome: { ok: false, kind: "failed", summary: "failed because it reported a general error" },
  });
  assert.match(failure, /failed because it reported a general error/);
  assert.match(failure, /review what happened/);
  assert.doesNotMatch(failure, /exit code|code 1/i);
});

test("agent jobs validate task/context before any spawn", async () => {
  const jobs = new BackgroundJobs({});
  assert.match((await jobs.start({ kind: "agent", channelId: "C1", threadKey: "t" })).error, /No task provided/);
  assert.match((await jobs.start({ kind: "agent", task: "do X" })).error, /Missing channel\/thread context/);
  // Shell jobs keep their own validation wording.
  assert.match((await jobs.start({ channelId: "C1", threadKey: "t" })).error, /No command provided/);
  // Unknown channel is refused before anything runs (agent kind has no auto-mode gate, but the
  // channel must exist).
  assert.match((await jobs.start({ kind: "agent", task: "do X", channelId: "C-nope", threadKey: "t" })).error, /isn't registered/);
});

// the 2026-08 update plan (internal repo) A1: shell jobs run OUTSIDE the engine sandbox (plain bash on the daemon
// account), so Auto mode needs an explicit admin approval of the exact command. Admin mode skips
// that second click only for an admin author, matching its explicit foreground sandbox-off tier.
test("shell jobs require approval in Auto mode but not for an admin author in Admin mode", async () => {
  const entry = await upsertChannelEntry("C-bgshell", { name: "bgshell", type: "channel", isDM: false });
  const asked = [];
  const record = async (req) => (asked.push(req), { allow: false, reason: "Denied by <@U9>" });

  // Mode gate first: without auto/admin mode the job is refused BEFORE any approval is requested.
  await saveChannelMeta(entry.slug, { channelId: "C-bgshell", autoMode: false });
  const gated = new BackgroundJobs({ requestShellApproval: record });
  assert.match((await gated.start({ channelId: "C-bgshell", authorId: "U1", threadKey: "t0", command: "echo hi" })).error, /aren't allowed in this channel/);
  assert.equal(asked.length, 0);

  await saveChannelMeta(entry.slug, { channelId: "C-bgshell", autoMode: true });

  // Fail closed: auto mode alone is NOT enough when no approval channel exists.
  const bare = new BackgroundJobs({});
  assert.match((await bare.start({ channelId: "C-bgshell", authorId: "U1", threadKey: "t0", command: "echo hi" })).error, /no approval channel/);

  // A denial (with its reason) refuses the job; the request carried the exact command and the
  // never-auto-approved "agent" type.
  const denied = await gated.start({ channelId: "C-bgshell", authorId: "U1", threadKey: "t0", command: "echo hi" });
  assert.match(denied.error, /not approved/);
  assert.match(denied.error, /Denied by <@U9>/);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].approvalType, "agent");
  assert.equal(asked[0].authorId, "U1");
  assert.match(asked[0].toolInput.details, /echo hi/);
  // The card names where the job really runs: inside this channel's container, not on the daemon.
  assert.match(asked[0].toolInput.details, /Runs inside this channel's container/);
  assert.match(asked[0].toolInput.details, /not on the daemon/);
  assert.doesNotMatch(asked[0].toolInput.details, /OUTSIDE the engine sandbox/);

  // An approval-layer failure also refuses the job (never spawn on error).
  const broken = new BackgroundJobs({ requestShellApproval: async () => { throw new Error("slack down"); } });
  assert.match((await broken.start({ channelId: "C-bgshell", authorId: "U1", threadKey: "t0", command: "echo hi" })).error, /Couldn't request approval.*slack down/);

  // Durable approval creation returns immediately without spawning. The exact serialized action
  // is later passed back through startApproved() by the Slack click handler, which rechecks mode.
  const durableRequests = [];
  const pendingJobs = new BackgroundJobs({
    requestShellApproval: async (request) => {
      durableRequests.push(request);
      return { allow: false, pending: true, approvalId: "approval-1" };
    },
  });
  const pending = await pendingJobs.start({ channelId: "C-bgshell", authorId: "U1", threadKey: "t-durable", command: "true", label: "durable true" });
  assert.equal(pending.ok, true);
  assert.equal(pending.pendingApproval, true);
  assert.equal(pendingJobs.count(), 0, "pending approval must not spawn early");
  assert.deepEqual(durableRequests[0].durableAction, {
    kind: "background_shell",
    channelId: "C-bgshell",
    slug: entry.slug,
    authorId: "U1",
    threadKey: "t-durable",
    command: "true",
    workDir: path.join(process.env.CG_WORKSPACE_DIR, "slack", entry.slug),
    label: "durable true",
    maxMs: 60 * 60 * 1000,
  });

  // Approved → the job actually spawns and completes. Inside a container the job is watched by
  // the backend's liveness probe (every 5s), not by the daemon-side client's exit, so completion
  // takes up to one probe interval.
  const JOB_WAIT_MS = 15_000;
  mkdirSync(path.join(process.env.CG_WORKSPACE_DIR, "slack", entry.slug), { recursive: true });
  const approving = new BackgroundJobs({ requestShellApproval: async () => ({ allow: true, reason: "Approved by <@U1>" }) });
  const started = await approving.start({ channelId: "C-bgshell", authorId: "U1", threadKey: "t1", command: "true" });
  assert.equal(started.ok, true, started.error);
  const deadline = Date.now() + JOB_WAIT_MS;
  while (approving.count() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  assert.equal(approving.count(), 0, "approved shell job should run to completion");

  const approvedAfterRestart = new BackgroundJobs({});
  const restarted = await approvedAfterRestart.startApproved({
    id: "approval-2",
    decidedBy: "U1",
    action: durableRequests[0].durableAction,
  });
  assert.equal(restarted.ok, true);
  const restartedDeadline = Date.now() + JOB_WAIT_MS;
  while (approvedAfterRestart.count() > 0 && Date.now() < restartedDeadline) await new Promise((r) => setTimeout(r, 25));
  assert.equal(approvedAfterRestart.count(), 0);

  await setUser("U-bg-admin", { name: "Background Admin", approved: true, isAdmin: true });
  await setUser("U-bg-member", { name: "Background Member", approved: true, isAdmin: false });
  await saveChannelMeta(entry.slug, { channelId: "C-bgshell", autoMode: false, adminMode: true });

  const adminJobs = new BackgroundJobs({});
  const adminStarted = await adminJobs.start({ channelId: "C-bgshell", authorId: "U-bg-admin", threadKey: "t-admin", command: "true" });
  assert.equal(adminStarted.ok, true, "Admin mode + admin author starts without an approval channel");
  const adminDeadline = Date.now() + JOB_WAIT_MS;
  while (adminJobs.count() > 0 && Date.now() < adminDeadline) await new Promise((r) => setTimeout(r, 25));
  assert.equal(adminJobs.count(), 0);

  const memberResult = await adminJobs.start({ channelId: "C-bgshell", authorId: "U-bg-member", threadKey: "t-member", command: "true" });
  assert.match(memberResult.error, /aren't allowed in this channel/);
});

test("persistence and status surfaces carry the job kind", () => {
  const jobs = new BackgroundJobs({});
  const rec = {
    id: "agent001",
    kind: "agent",
    channelId: "C1",
    slug: "chan",
    authorId: "U1",
    threadKey: "111.222",
    label: "research supplier",
    command: "",
    task: "Research the supplier and report back.",
    startedAt: Date.now() - 65_000,
    pid: null,
    maxMs: 60 * 60 * 1000,
    logFile: "",
    tail: "[WebSearch supplier]\npartial findings…",
    timedOut: false,
  };
  jobs.jobs.set(rec.id, rec);
  jobs._persist();

  const saved = getDb().prepare("SELECT data FROM bg_jobs WHERE id = ?").get(rec.id);
  const data = fromJson(saved.data, null);
  assert.equal(data.kind, "agent");
  assert.equal(data.task, rec.task);

  const st = jobs.status(rec.id);
  assert.equal(st.kind, "agent");
  assert.ok(st.runtimeMs >= 65_000);
  assert.match(st.tail, /partial findings/);
  assert.equal(jobs.status("missing-id"), null);

  const listed = jobs.listForChannel("chan");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].kind, "agent");
  assert.equal(listed[0].command, rec.task); // agent jobs list their task as the display command
});

test("runtime caps: agents default to a week, shell stays short, everything clamps to the ceiling", async () => {
  const { resolveJobCap } = await import("../src/gateway/background.js");
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  assert.equal(resolveJobCap("agent"), WEEK, "agent default is the one-week ceiling");
  assert.equal(resolveJobCap("shell"), 60 * 60 * 1000, "unsandboxed shell keeps the 60-minute default");
  assert.equal(resolveJobCap("shell", 4 * 60 * 60 * 1000), 4 * 60 * 60 * 1000, "an explicit request is honored");
  assert.equal(resolveJobCap("agent", 100 * WEEK), WEEK, "nothing exceeds the ceiling");
  assert.equal(resolveJobCap("shell", -5), 60 * 60 * 1000, "nonsense falls back to the default");
});
