// Slice 3 of the 09.08 review: "delete the durable record only at a terminal DELIVERY boundary".
// Every case below used to destroy state before anyone was told about it — an interrupted turn
// wiped at boot while Slack was still down, a background job's row deleted before its continuation
// posted, a one-time schedule deleted before it ran, a cron minute retired while its schedules were
// still queued behind the concurrency cap — plus the identity and accounting guarantees those
// retries depend on.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
// Keep default channel workspaces inside the scratch dir (never ~/Slack Agent).
process.env.CG_WORKSPACE_DIR = path.join(scratch, "workspaces");

const [
  { clearActiveRun, listActiveRuns, recordActiveRun, recoverRuns, takeStaleRuns },
  { BackgroundJobs, pidIdentityAlive, recoveredWatchAction },
  { processStartTime },
  { handleApprovalClick, isSlackTs, requestApproval, slackThreadFor },
  scheduler,
  { addSchedule, getSchedules },
  { getDb, fromJson },
  { saveChannelMeta, setUser, upsertChannelEntry },
] = await Promise.all([
  import("../src/gateway/active-runs.js"),
  import("../src/gateway/background.js"),
  import("../src/util/proc.js"),
  import("../src/slack/approvals.js"),
  import("../src/gateway/scheduler.js"),
  import("../src/config/schedules.js"),
  import("../src/db/index.js"),
  import("../src/config/store.js"),
]);

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
async function waitFor(predicate, label) {
  for (let i = 0; i < 200 && !predicate(); i++) await settle();
  assert.ok(predicate(), `timed out waiting for ${label}`);
}

function fakeSlack(posted = [], updates = []) {
  let n = 0;
  const client = {
    posted,
    updates,
    chat: {
      postMessage: async (payload) => {
        const ts = `17000000${String(++n).padStart(2, "0")}.000100`;
        posted.push({ ...payload, ts });
        return { ok: true, ts };
      },
      update: async (payload) => updates.push(payload),
      postEphemeral: async () => {},
    },
  };
  return { client, slack: { snapshot: () => ({ connected: true }), getClient: () => client } };
}

const usageRows = (taskKind) =>
  getDb().prepare("SELECT COUNT(*) AS n FROM usage WHERE task_kind = ?").get(taskKind).n;

// The DURABLE row, straight from the table. listActiveRuns() is the dashboard's "running right
// now" projection and deliberately hides boot snapshots, so survival must be asserted here.
const durableRun = (id) => {
  const row = getDb().prepare("SELECT data FROM active_runs WHERE id = ?").get(id);
  return row ? fromJson(row.data, null) : null;
};

// ── H2: interrupted interactive turns ────────────────────────────────────────────

test("a boot with Slack down keeps every interrupted turn for the next boot", async () => {
  const id = "durable-recovery::message";
  recordActiveRun(id, {
    channelId: "C_DUR",
    slug: "durable-recovery",
    authorId: "U_DUR",
    threadKey: "1700000000.000100",
    text: "answer me",
  });

  assert.ok(listActiveRuns().some((row) => row.id === id), "while it runs it IS a live active run");

  const stale = takeStaleRuns();
  assert.ok(stale.some((rec) => rec.id === id), "the interrupted turn is snapshotted for replay");
  assert.ok(durableRun(id), "…and is NOT deleted before Slack is known good");
  // …but it is no longer a LIVE run: the snapshot is stamped recoveryPending, because these rows
  // survive across boots whenever Slack is down and unstamped ones showed up in the admin
  // dashboard as sessions "running now" forever — ghosts of a daemon that died days ago.
  assert.equal(durableRun(id).recoveryPending, true, "the boot snapshot is stamped, not live");
  assert.equal(listActiveRuns().some((row) => row.id === id), false, "and is filtered out of the live feed");

  await recoverRuns(stale, { slack: { snapshot: () => ({ connected: false }) } });
  assert.ok(
    durableRun(id),
    "a Slack outage leaves the row for the next boot instead of consuming the turn",
  );

  // The one thing that is dropped up front: a row that can never be replayed at all. That IS its
  // terminal state — keeping it would only leak rows forever.
  recordActiveRun("durable-recovery::unreplayable", { slug: "durable-recovery", text: "no channel, no thread" });
  takeStaleRuns();
  assert.equal(durableRun("durable-recovery::unreplayable"), null);

  clearActiveRun(id);
});

test("a recovered turn banks its spend even when delivery throws", async () => {
  const posts = [];
  const usage = [];
  const rec = {
    id: "durable-usage::message",
    channelId: "C_USG",
    slug: "durable-usage",
    authorId: "U_USG",
    threadKey: "1700000000.000200",
    text: "spend, then fail to deliver",
    attachments: [],
  };

  await recoverRuns([rec], {
    slack: { snapshot: () => ({ connected: true }), getClient: () => ({ chat: { postMessage: async (p) => posts.push(p) } }) },
    runner: async () => ({ content: "an expensive answer", engine: "claude", usage: { output_tokens: 4242 } }),
    deliver: async () => { throw new Error("slack rejected the message"); },
    usageRecorder: async (payload) => usage.push(payload),
  });

  // M8: the engine spent these tokens before Slack was ever asked to accept the answer.
  assert.equal(usage.length, 1, "spend is recorded exactly once, before delivery");
  assert.equal(usage[0].result.usage.output_tokens, 4242);
  assert.match(posts.at(-1).text, /slack rejected the message/, "and the failure is reported in-thread");
});

test("a replay whose answer AND whose failure notice both fail keeps its durable row", async () => {
  const id = "durable-mute::message";
  const rec = {
    id,
    channelId: "C_MUTE",
    slug: "durable-mute",
    authorId: "U_MUTE",
    threadKey: "1700000000.000250",
    text: "nobody will ever hear about this",
    attachments: [],
  };
  recordActiveRun(id, rec);

  // Slack accepts nothing: not the "picking it back up" heads-up, not the answer, not the error.
  await recoverRuns([{ ...rec }], {
    slack: {
      snapshot: () => ({ connected: true }),
      getClient: () => ({ chat: { postMessage: async () => { throw new Error("slack is down"); } } }),
    },
    runner: async () => { throw new Error("the resumed run failed"); },
    deliver: async () => { throw new Error("unreachable"); },
    usageRecorder: async () => {},
  });

  // "Terminal" means the user SAW something. Nothing reached the thread, so deleting the row would
  // silently swallow the turn; the attempt cap (2) is what eventually retires it instead.
  assert.ok(durableRun(id), "the row survives a completely invisible failure");
  assert.equal(durableRun(id).attempts, 1, "…with its attempt counter banked for the next boot");
  clearActiveRun(id);
});

test("a replay that DID report its failure is terminal and drops its row", async () => {
  const id = "durable-told::message";
  const rec = {
    id,
    channelId: "C_TOLD",
    slug: "durable-told",
    authorId: "U_TOLD",
    threadKey: "1700000000.000260",
    text: "this failure is announced",
    attachments: [],
  };
  recordActiveRun(id, rec);

  await recoverRuns([{ ...rec }], {
    slack: { snapshot: () => ({ connected: true }), getClient: () => ({ chat: { postMessage: async () => ({ ok: true }) } }) },
    runner: async () => { throw new Error("the resumed run failed"); },
    deliver: async () => {},
    usageRecorder: async () => {},
  });

  assert.equal(durableRun(id), null, "the thread was told, so the row is retired");
});

// ── H3: background jobs ──────────────────────────────────────────────────────────

function jobRecord(id, threadKey = "1700000000.000300") {
  return {
    id,
    kind: "shell",
    channelId: "C_BGD",
    slug: "durable-bg",
    authorId: "U_BGD",
    threadKey,
    label: "nightly backup",
    command: "true",
    task: "",
    startedAt: Date.now() - 1_000,
    pid: null,
    maxMs: 60_000,
    logFile: "",
    tail: "backup complete",
    timedOut: false,
  };
}

test("a background job whose continuation fails keeps its row for redelivery — and banks its spend", async () => {
  getDb().exec("DELETE FROM bg_jobs");
  const before = usageRows("background");
  const { slack } = fakeSlack();
  const jobs = new BackgroundJobs({
    slack,
    runner: async () => ({ content: "carrying on", engine: "claude", usage: { output_tokens: 7 } }),
    deliver: async () => { throw new Error("slack rejected the reply"); },
  });
  const rec = jobRecord("bgdurable1");
  jobs.jobs.set(rec.id, rec);

  await jobs._finish(rec, { code: 0 });

  assert.equal(jobs.jobs.has(rec.id), true, "an undelivered job is not thrown away");
  const saved = fromJson(getDb().prepare("SELECT data FROM bg_jobs WHERE id = ?").get(rec.id).data, null);
  assert.ok(saved.pendingDelivery, "the finished outcome is persisted, so a restart can redeliver it");
  assert.equal(saved.deliveryAttempts, 1, "the attempt is claimed durably BEFORE delivering");
  assert.equal(usageRows("background"), before + 1, "the continuation's spend is banked before delivery");
  assert.equal(jobs.count(), 0, "…but a job awaiting delivery is no longer running work");

  // What boot recovery does with that row: deliver it, and only then let it go.
  const { client, slack: slack2 } = fakeSlack();
  const delivered = [];
  const revived = new BackgroundJobs({
    slack: slack2,
    runner: async () => { throw new Error("saved continuation must never execute again"); },
    deliver: async (_client, payload) => delivered.push(payload),
  });
  await revived.recover();

  assert.equal(delivered.length, 1, "the interrupted continuation is redelivered");
  assert.equal(revived.jobs.size, 0, "delivery is the terminal boundary");
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM bg_jobs").get().n, 0, "and only then is the row gone");
  assert.match(client.posted[0].text, /nightly backup/, "the thread got its completion notice");
});

test("a background job is kept when Slack is unreachable, without burning a delivery attempt", async () => {
  getDb().exec("DELETE FROM bg_jobs");
  const jobs = new BackgroundJobs({}); // no Slack manager at all
  const rec = jobRecord("bgdurable2");
  jobs.jobs.set(rec.id, rec);

  await jobs._finish(rec, { code: 0 });

  const saved = fromJson(getDb().prepare("SELECT data FROM bg_jobs WHERE id = ?").get(rec.id).data, null);
  assert.ok(saved.pendingDelivery, "the job survives the outage");
  assert.equal(saved.deliveryAttempts, 0, "an unreachable Slack is not a failed attempt");
  getDb().exec("DELETE FROM bg_jobs");
});

test("a completed background agent delivers its report without a second model turn", async () => {
  getDb().exec("DELETE FROM bg_jobs");
  const { slack } = fakeSlack();
  const delivered = [];
  const jobs = new BackgroundJobs({
    slack,
    runner: async () => { throw new Error("the launching model must not be needed"); },
    deliver: async (_client, payload) => delivered.push(payload),
  });
  const rec = {
    ...jobRecord("bg-agent-direct"),
    kind: "agent",
    label: "research supplier",
    command: "",
    task: "Research the supplier.",
    result: { content: "The supplier passed every check.", engine: "claude" },
  };
  jobs.jobs.set(rec.id, rec);

  await jobs._finish(rec, { outcome: { ok: true, kind: "success", summary: "completed successfully" } });

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].result.content, "The supplier passed every check.");
  assert.equal(delivered[0].result.engine, "claude");
  assert.equal(jobs.jobs.has(rec.id), false, "direct delivery is the terminal boundary");
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM bg_jobs").get().n, 0);
});

for (const engine of ["claude", "codex"]) {
  test(`a large ${engine} background report survives recovery complete and redacted`, async () => {
    getDb().exec("DELETE FROM bg_jobs");
    const secret = "qa-private-report-fixture";
    const content = `Report header ${secret}\n${"A checked item with its evidence.\n".repeat(700)}END-OF-COMPLETE-REPORT`;
    const expected = content.replace(secret, "[REDACTED]");
    const jobs = new BackgroundJobs({}); // delivery must wait for a reachable transport
    const rec = {
      ...jobRecord(`bg-large-${engine}`), kind: "agent", command: "",
      task: "Return the complete report.", secretValues: [secret],
      result: { content, engine },
    };
    jobs.jobs.set(rec.id, rec);
    await jobs._finish(rec, { outcome: { ok: true, kind: "success", summary: "completed successfully" } });
    const saved = fromJson(getDb().prepare("SELECT data FROM bg_jobs WHERE id = ?").get(rec.id).data, null);
    assert.equal(saved.pendingDelivery.report, expected, "durable payload keeps the final item, not just a preview");
    assert.doesNotMatch(JSON.stringify(saved), new RegExp(secret));
    const delivered = [];
    const { slack } = fakeSlack();
    const revived = new BackgroundJobs({
      slack,
      runner: async () => { throw new Error("a completed report must not require another model turn"); },
      deliver: async (_client, payload) => delivered.push(payload),
    });
    await revived.recover();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].result.content, expected);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM bg_jobs").get().n, 0);
  });
}

// ── H4: pid identity ─────────────────────────────────────────────────────────────

test("a recycled pid is not our child, and an unverifiable probe never invents a death", () => {
  const spawnTime = "Thu Jan  1 00:00:00 2001";
  assert.equal(pidIdentityAlive(process.pid, spawnTime, { probe: () => spawnTime }), true);
  assert.equal(
    pidIdentityAlive(process.pid, spawnTime, { probe: () => "Sat Aug 15 09:12:44 2026" }),
    false,
    "same pid, different start time → the OS recycled it and our child is gone",
  );
  assert.equal(pidIdentityAlive(process.pid, "", { probe: () => "whatever" }), true,
    "a legacy record captured no identity — fall back to plain aliveness");
  assert.equal(pidIdentityAlive(process.pid, spawnTime, { probe: () => "" }), true,
    "an unavailable `ps` must not be read as a dead process");
  assert.equal(pidIdentityAlive(0, spawnTime), false);
  assert.equal(pidIdentityAlive(0x7fffffff, spawnTime), false, "a pid nobody owns is dead");

  // The probe itself is best-effort (procps `ps -p <pid> -o lstart=`); where it can't run it
  // degrades to "" instead of throwing.
  assert.equal(typeof processStartTime(process.pid), "string");
  assert.equal(processStartTime(0), "");
});

// ── H6: approvals from a synthetic session key ───────────────────────────────────

test("an approval from a synthetic session key posts a real thread and validates its ts", async () => {
  assert.equal(isSlackTs("1700000000.000100"), true);
  assert.equal(isSlackTs("sched-9f2c1a7b-1700000000.000100"), false);
  assert.equal(slackThreadFor("1700000000.000100"), "1700000000.000100");
  assert.equal(
    slackThreadFor("1700000000.000100::agent-ab12cd34"),
    "1700000000.000100",
    "a background agent's approval still lands in the thread that launched it",
  );
  assert.equal(slackThreadFor("sched-9f2c1a7b-1700000000.000100"), null, "a scheduler key is no thread at all");

  const CHANNEL = "C_SCHED_APPROVAL";
  const APPROVER = "U_SCHED_APPROVER";
  await setUser(APPROVER, { name: "Sched Approver", approved: true, isAdmin: true });
  const entry = await upsertChannelEntry(CHANNEL, { name: "sched-approvals", type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, { channelId: CHANNEL, access: "approved" });

  const { client } = fakeSlack();
  const ask = {
    channelId: CHANNEL,
    slug: entry.slug,
    authorId: APPROVER,
    threadKey: "sched-9f2c1a7b-1700000000.000100", // a scheduler session key, NOT a Slack thread
    approvalType: "agent",
    toolName: "Background shell job (unsandboxed)",
    toolInput: { details: "$ deploy.sh" },
  };
  const pending = requestApproval({ getClient: () => client }, ask);
  pending.catch(() => {});
  await waitFor(() => client.posted.length === 1, "the approval card");

  const card = client.posted[0];
  assert.equal(card.thread_ts, undefined, "a synthetic key can't be a thread_ts, so the card posts top-level");
  assert.ok(isSlackTs(card.ts), "…which creates a REAL thread the decision can be anchored to");

  const id = card.blocks.find((block) => block.type === "actions").elements[0].value;
  await handleApprovalClick({
    ack: async () => {},
    body: { user: { id: APPROVER }, channel: { id: CHANNEL }, message: { ts: card.ts } },
    action: { action_id: "cg_approve", value: id },
    client,
  });
  const decision = await pending;
  assert.equal(decision.allow, true, "a scheduled run's approval is now clickable at all");
  assert.ok(isSlackTs(client.updates.at(-1).ts), "and the resolution updates that same real message");

  // Fail loudly rather than leaving a card nobody can ever resolve.
  const refused = await requestApproval({ getClient: () => ({ chat: { postMessage: async () => ({ ok: true }) } }) }, ask);
  assert.equal(refused.allow, false);
  assert.match(refused.reason, /no usable message ts/i);
});

// ── H5: schedules ────────────────────────────────────────────────────────────────

test("a one-time schedule survives a Slack outage and is deleted only after it posts", async () => {
  const sched = addSchedule({
    channelId: "C_SCHED_ONCE",
    slug: "sched-once",
    prompt: "Stand-up in 5 minutes",
    createdBy: "U_SCHED",
    kind: "reminder",
    once: true,
    runAt: new Date(Date.now() - 90_000).toISOString(),
    notify: "none",
  });
  scheduler.resetSchedulerState();

  // Slack down: the row used to be deleted up front, so the reminder was lost for good.
  scheduler.startScheduler({ immediate: false, slack: { snapshot: () => ({ connected: false }) } });
  await scheduler.tick(Date.now());
  const survived = getSchedules().find((s) => s.id === sched.id);
  assert.ok(survived, "an outage must not consume a one-time schedule");
  assert.equal(survived.runAttempts || 0, 0, "…nor burn one of its execution attempts");

  // Slack back: it fires, posts, and only then disappears.
  const { slack, client } = fakeSlack();
  scheduler.startScheduler({ immediate: false, slack });
  await scheduler.tick(Date.now() + 60_000);
  assert.equal(client.posted.length, 1);
  assert.match(client.posted[0].text, /Stand-up in 5 minutes/);
  assert.equal(getSchedules().some((s) => s.id === sched.id), false, "delivered — now the row may go");
});

test("the concurrency cap defers a due minute instead of retiring it unevaluated", async () => {
  scheduler.resetSchedulerState();
  const base = Math.floor(Date.now() / 60_000) * 60_000 + 5_000; // 5s into a minute
  const at = new Date(base);

  // Five slow schedules saturate the fan-out ceiling…
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const posted = [];
  const slowClient = {
    chat: {
      postMessage: async (payload) => {
        posted.push(payload);
        if (/filler/.test(payload.text)) await gate;
        return { ok: true, ts: "1700000000.000100" };
      },
    },
  };
  for (let i = 0; i < 5; i++) {
    addSchedule({
      channelId: "C_SCHED_CAP", slug: "sched-cap", prompt: `filler ${i}`, createdBy: "U_SCHED",
      kind: "reminder", once: true, runAt: new Date(base - 90_000).toISOString(), notify: "none",
    });
  }
  // …ahead of a cron that matches ONLY this minute. Retiring the minute would lose it for a day.
  const daily = addSchedule({
    channelId: "C_SCHED_CAP", slug: "sched-cap", prompt: "the daily report", createdBy: "U_SCHED",
    kind: "reminder", cron: `${at.getMinutes()} ${at.getHours()} * * *`, notify: "none",
  });

  scheduler.startScheduler({ immediate: false, slack: { snapshot: () => ({ connected: true }), getClient: () => slowClient } });
  const firstTick = scheduler.tick(base);
  release();
  await firstTick;
  assert.equal(posted.filter((p) => /filler/.test(p.text)).length, 5, "the cap let exactly five through");
  assert.equal(posted.some((p) => /daily report/.test(p.text)), false, "the sixth was deferred, not run");

  // A second tick INSIDE THE SAME MINUTE still finds it: the watermark never advanced past the
  // minute the cap cut short.
  await scheduler.tick(base + 25_000);
  assert.equal(posted.some((p) => /daily report/.test(p.text)), true, "the deferred minute is re-evaluated, not lost");
  assert.ok(getSchedules().some((s) => s.id === daily.id), "a recurring schedule is never retired by firing");
});

test("daily-thread schedule delivery persists one anchor per local day", async () => {
  const sched = addSchedule({
    channelId: "C_DAILY_THREAD", slug: "daily-thread", prompt: "check SLA", description: "Monitor SLA",
    createdBy: "U_SCHED", cron: "0 * * * *", notify: "none", delivery: "daily-thread",
  });
  const { client } = fakeSlack();
  const morning = new Date(2026, 8, 1, 9, 0);

  const first = await scheduler.taskDeliveryThread(client, sched, "Monitor SLA", morning);
  assert.equal(client.posted.length, 1, "the day's first run creates its top-level anchor");
  assert.equal(client.posted[0].thread_ts, undefined);

  // Reload the row to prove the reuse decision survives a process-local object being discarded.
  const stored = getSchedules().find((row) => row.id === sched.id);
  assert.equal(stored.dailyThreadDate, "2026-09-01");
  assert.equal(stored.dailyThreadTs, first);
  const later = await scheduler.taskDeliveryThread(client, stored, "Monitor SLA", new Date(2026, 8, 1, 17, 0));
  assert.equal(later, first);
  assert.equal(client.posted.length, 1, "later runs reuse the anchor without another banner");

  const tomorrow = await scheduler.taskDeliveryThread(client, stored, "Monitor SLA", new Date(2026, 8, 2, 9, 0));
  assert.notEqual(tomorrow, first);
  assert.equal(client.posted.length, 2, "the next local day opens a fresh anchor");

  // The reused anchor is a DELIVERY decision and nothing else. It used to seed the run's session
  // key too (`sched-<id>-<threadTs>`), so the day's second fire resumed the first fire's engine
  // session instead of starting the fresh, context-less one the schedule contract promises
  // (QA AUT-DAILY-THREAD-01). The end-to-end proof is test/schedule-daily-thread.test.js.
  const keys = [scheduler.scheduleSessionKey(stored), scheduler.scheduleSessionKey(stored)];
  assert.notEqual(keys[0], keys[1], "each fire of the day runs under its own session key");
  for (const key of keys) {
    assert.ok(key.startsWith(`sched-${sched.id}-`), "…still the schedule's own synthetic key");
    assert.equal(key.includes(first), false, "…and never derived from the reused anchor");
    assert.equal(slackThreadFor(key), null, "…which Slack must never see as a thread_ts");
  }
});

// ── H4: a recovered job's cap-kill must verify identity BEFORE it signals ────────────────────
// Recovered jobs were spawned detached, so killGroup targets a whole process GROUP. Across a long
// outage the OS can recycle the pid onto an unrelated process — and the poll used to fire
// SIGTERM (and schedule SIGKILL) on the over-cap branch before checking whether the pid was still
// ours, which could kill a stranger's process group.

test("an over-cap recovered job is only signalled while its pid identity still checks out", () => {
  assert.deepEqual(recoveredWatchAction({ alive: true, overCap: true }), { signal: true, finish: true });
  assert.deepEqual(
    recoveredWatchAction({ alive: false, overCap: true }),
    { signal: false, finish: true },
    "a recycled/dead pid is declared finished, never signalled",
  );
  assert.deepEqual(recoveredWatchAction({ alive: true, overCap: false }), { signal: false, finish: false });
  assert.deepEqual(recoveredWatchAction({ alive: false, overCap: false }), { signal: false, finish: true });
});

// ── One-time schedules must release their durable `running` claim ────────────────────────────

test("a one-time schedule that fails clears its running flag instead of staying stuck", async () => {
  await upsertChannelEntry("C_STUCK", { name: "sched-stuck", type: "channel", isDM: false });
  await saveChannelMeta("sched-stuck", { channelId: "C_STUCK", allowedUsers: ["U_STUCK"], access: "approved" });
  await setUser("U_STUCK", { name: "stuck", approved: true });
  const sched = addSchedule({
    channelId: "C_STUCK",
    slug: "sched-stuck",
    createdBy: "U_STUCK",
    prompt: "do the thing",
    runAt: new Date(Date.now() - 60_000).toISOString(),
    once: true,
    enabled: true,
  });

  // No Slack client → runSchedule postpones. The row survives (that is the point) but used to
  // survive with running:true forever, because only runDueForMinute ever set the flag.
  scheduler.resetSchedulerState();
  scheduler.startScheduler({ immediate: false, slack: { snapshot: () => ({ connected: false }) } });
  await scheduler.tick(Date.now());

  const stored = getSchedules().find((s) => s.id === sched.id);
  assert.ok(stored, "a postponed one-time schedule keeps its row");
  assert.equal(stored.running, false, "and its durable running claim was released");
  assert.equal(stored.runningSince, "", "…along with the timestamp that went with it");
});

test("a background continuation interrupted before its result checkpoint is reported without replay", async () => {
  getDb().exec("DELETE FROM bg_jobs");
  const { slack, client } = fakeSlack();
  let executions = 0;
  const jobs = new BackgroundJobs({ slack, runner: async () => { executions++; return { content: "must not run" }; } });
  const rec = { ...jobRecord("bg-unknown-continuation"), pendingDelivery: { continuationStarted: new Date().toISOString(), outcome: { ok: true, summary: "completed" } } };
  jobs.jobs.set(rec.id, rec);
  await jobs._deliver(rec);
  assert.equal(executions, 0);
  assert.match(client.posted.at(-1).text, /external actions are unknown/);
  assert.equal(jobs.jobs.has(rec.id), false);
});
