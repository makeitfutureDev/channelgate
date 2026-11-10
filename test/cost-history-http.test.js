import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv, testLicenseEnv } from "./helpers.js";
ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { createRunsRouter } = await import("../src/web/routes/runs.js");
const { createObservabilityRouter } = await import("../src/web/routes/observability.js");
const { visibleEventCosts } = await import("../src/ee/cost-history.js");

test("HTTP event and job views hide expired Free costs without changing records or results", async t => {
  const now = Date.now();
  const cutoff = now - 30 * 86400000;
  const db = getDb();
  const rows = [["old", cutoff - 1000], ["recent", now - 1000], ["unknown", null]];
  for (const [id, timestamp] of rows) {
    const job = { id, status: "completed", createdMs: timestamp, completedMs: timestamp, costUSD: 12.34, costEstimated: true, result: { content: "Result costs $12.34" } };
    db.prepare("INSERT INTO api_jobs(id, status, created_ms, data) VALUES(?, 'completed', ?, ?)").run(id, timestamp || 0, JSON.stringify(job));
    db.prepare("INSERT INTO events(ts, event, data) VALUES(?, 'run_done', ?)").run(timestamp ? new Date(timestamp).toISOString() : "", JSON.stringify({ fixture: id, costUSD: 12.34, costEstimated: true, detail: "Keep $12.34 in text" }));
  }
  const app = express();
  app.use("/runs", createRunsRouter());
  app.use(createObservabilityRouter());
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const tier of ["free", "enterprise", "free"]) {
    testLicenseEnv({ tier });
    const listing = await (await fetch(`${base}/runs`)).json();
    const events = await (await fetch(`${base}/audit/events`)).json();
    for (const [id] of rows) {
      const visible = tier === "enterprise" || id === "recent";
      const detail = await (await fetch(`${base}/runs/${id}`)).json();
      const listed = listing.jobs.find(r => r.jobId === id);
      for (const job of [detail, listed]) {
        assert.equal(job.costUSD, visible ? 12.34 : null);
        assert.equal(job.costEstimated, visible);
        assert.equal(job.result, "Result costs $12.34");
        assert.equal(job.status, "completed");
      }
      const event = events.events.find(r => r.fixture === id);
      assert.equal(event.costUSD, visible ? 12.34 : null);
      assert.equal(event.detail, "Keep $12.34 in text");
    }
  }
  assert.equal(JSON.parse(db.prepare("SELECT data FROM api_jobs WHERE id='old'").get().data).costUSD, 12.34);
  assert.equal(JSON.parse(db.prepare("SELECT data FROM events WHERE json_extract(data, '$.fixture')='old'").get().data).costUSD, 12.34);
  const clock = new Date(now);
  assert.equal(visibleEventCosts({ ts: new Date(cutoff).toISOString(), costUSD: 1 }, clock).costUSD, 1);
  assert.equal(visibleEventCosts({ ts: new Date(cutoff - 1).toISOString(), costUSD: 1 }, clock).costUSD, null);
  assert.equal(visibleEventCosts({ ts: "invalid", costUSD: 1 }, clock).costUSD, null);
});
