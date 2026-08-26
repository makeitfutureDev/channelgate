// API run restart recovery. Hermetic: writes synthetic api_jobs rows into the scratch SQLite DB and
// injects a fake recovery driver so no real Claude/Codex subprocess is spawned.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { getDb, toJson } = await import("../src/db/index.js");
const { getApiJob, listApiJobs, recoverApiRuns } = await import("../src/gateway/api-runs.js");

function insertJob(job) {
  getDb()
    .prepare("INSERT INTO api_jobs(id, status, created_ms, data) VALUES(?, ?, ?, ?)")
    .run(job.id, job.status, job.createdMs, toJson(job));
}

function baseJob(overrides = {}) {
  const id = overrides.id || `job_${Math.random().toString(36).slice(2)}`;
  return {
    id,
    status: "running",
    message: "Check invoice line items",
    slug: "api",
    channelId: "cg-api",
    threadKey: `api:${id}`,
    author: "api",
    engine: "codex",
    sessionId: "session-1",
    resumeCommand: "cd \"/tmp\" && codex exec resume session-1",
    cwd: "/tmp",
    slackThread: false,
    hasAttachment: false,
    attachmentPath: null,
    attachments: [],
    textForRun: "[Provenance: test]\n\nCheck invoice line items",
    webhook: "",
    idempotencyKey: "",
    overrides: null,
    stopRequested: false,
    recoveryAttempts: 0,
    createdMs: Date.now(),
    startedMs: Date.now(),
    completedMs: null,
    costUSD: null,
    durationMs: null,
    result: null,
    error: null,
    ...overrides,
  };
}

test("persisted running API jobs remain running when read after restart", () => {
  const job = baseJob({ id: "api_recover_read" });
  insertJob(job);

  const read = getApiJob(job.id);
  assert.equal(read.status, "running");
  assert.equal(read.error, null);

  const listed = listApiJobs({ status: "running", limit: 20 }).find((j) => j.id === job.id);
  assert.ok(listed);
  assert.equal(listed.status, "running");
  getDb().prepare("DELETE FROM api_jobs WHERE id = ?").run(job.id);
});

test("recoverApiRuns rehydrates running rows and starts the driver", async () => {
  const job = baseJob({ id: "api_recover_driver" });
  insertJob(job);

  const started = [];
  await recoverApiRuns({
    slack: { snapshot: () => ({ connected: false }), getClient: () => null },
    driver: (recovered, args) => {
      started.push({ recovered, args });
    },
  });

  assert.equal(started.length, 1);
  assert.equal(started[0].recovered.id, job.id);
  assert.equal(started[0].recovered.recoveryAttempts, 1);
  assert.equal(started[0].args.textForRun, job.textForRun);
  assert.equal(started[0].args.client, null);
  assert.equal(started[0].args.recovering, true);
  assert.ok(started[0].args.signal);

  const read = getApiJob(job.id);
  assert.equal(read.status, "running");
  assert.equal(read.recoveryAttempts, 1);
});
