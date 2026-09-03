// Admission concurrency for the HTTP run API. Every check that decides "may this run start?" reads
// state that only becomes true several awaits later (the job record is published at the very end of
// startApiRun, after a webhook DNS check, channel resolution, an attachment save and a Slack post).
// Two same-key POSTs therefore each saw "no prior job" and each started a PAID run, and a burst of
// simultaneous POSTs each read inflight = 0. These tests drive the real function concurrently with
// an injected no-op driver, so admission is exercised without spawning an engine.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
// startApiRun provisions the synthetic `api` folder for real; keep it inside the scratch root so the
// suite never writes to the operator's actual working-folder home.
process.env.CG_WORKSPACE_DIR = path.join(scratch, "api-admission-workspaces");

const { startApiRun, getApiJob } = await import("../src/gateway/api-runs.js");

const MAX_INFLIGHT = 25; // mirrors api-runs.js — the cap this file proves is actually enforced

test("two concurrent POSTs with the same idempotency key produce exactly one job", async () => {
  const started = [];
  const driver = (job) => started.push(job.id);
  const key = `idem-concurrent-${Date.now()}`;

  const [a, b] = await Promise.all([
    startApiRun({ message: "reconcile invoices", idempotencyKey: key, driver }),
    startApiRun({ message: "reconcile invoices", idempotencyKey: key, driver }),
  ]);

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.jobId, b.jobId, "both callers must be handed the SAME job, not two paid runs");
  assert.equal(started.length, 1, "only one run may actually be driven");
  assert.deepEqual([a.reused, b.reused].sort(), [false, true], "exactly one caller started it");
  assert.equal(getApiJob(a.jobId).idempotencyKey, key);

  // A later retry still dedupes through the ordinary published-record lookup.
  const later = await startApiRun({ message: "reconcile invoices", idempotencyKey: key, driver });
  assert.equal(later.jobId, a.jobId);
  assert.equal(later.reused, true);
  assert.equal(started.length, 1);
});

test("a rejected start releases its key and its slot instead of burning them", async () => {
  const key = `idem-released-${Date.now()}`;
  const driver = () => {};
  // A loopback webhook is refused by the SSRF guard — a failure that happens INSIDE the claimed
  // section, after the key was taken.
  const refused = await startApiRun({ message: "x", idempotencyKey: key, webhook: "http://127.0.0.1:9/hook", driver });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 400);

  const retried = await startApiRun({ message: "x", idempotencyKey: key, driver });
  assert.equal(retried.ok, true, "a failed attempt must not poison the key for an honest retry");
  assert.equal(retried.reused, false);
});

test("a burst of simultaneous starts cannot all read inflight = 0", async () => {
  const driver = () => {};
  const burst = MAX_INFLIGHT + 12;
  const results = await Promise.all(
    Array.from({ length: burst }, (_, i) => startApiRun({ message: `burst ${i}`, driver })),
  );
  const accepted = results.filter((r) => r.ok);
  const rejected = results.filter((r) => !r.ok);

  assert.ok(accepted.length <= MAX_INFLIGHT, `admitted ${accepted.length} concurrent runs past the ${MAX_INFLIGHT} cap`);
  assert.ok(rejected.length > 0, "the cap must bite on a simultaneous burst, not only on serial POSTs");
  for (const r of rejected) {
    assert.equal(r.code, 429);
    assert.match(r.error, /Too many API runs in flight/);
  }
  assert.equal(new Set(accepted.map((r) => r.jobId)).size, accepted.length, "job ids stay unique");
});
