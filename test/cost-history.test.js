import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, testLicenseEnv, clearTestLicense } from "./helpers.js";
ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { readUsage, usageSummary, usageDashboard, costHistoryStart } = await import("../src/gateway/usage.js");

test("Free cost reports expose 30 days for both engines without deleting older accounting", async () => {
  const db = getDb();
  const now = new Date();
  const recent = new Date(now.getTime() - 86400000).toISOString();
  const old = new Date(now.getTime() - 31 * 86400000).toISOString();
  for (const engine of ["claude", "codex"]) {
    for (const ts of [recent, old]) {
      db.prepare("INSERT INTO external_usage(scope, engine, session_id, bucket, turns, cost_usd, updated_ms) VALUES('operator', ?, ?, ?, 1, 1, 0)").run(engine, engine + ts, ts.slice(0, 13));
      db.prepare("INSERT INTO usage(ts, channel_id, slug, author_id, engine, model, task_kind, tokens_in, tokens_out, cost_usd) VALUES(?, 'history', 'history', 'user', ?, 'model', 'interactive', 10, 5, 1)").run(ts, engine);
    }
  }
  for (const tier of ["free", "none"]) {
    if (tier === "none") clearTestLicense(); else testLicenseEnv({ tier });
    assert.equal(costHistoryStart(now).getTime(), now.getTime() - 30 * 86400000);
    assert.equal((await readUsage()).length, 2);
    assert.equal((await usageSummary()).totalRuns, 2);
    const report = usageDashboard({ range: "year", source: "gateway" });
    assert.equal(report.historyDays, 30);
    assert.equal(report.totals.runs, 2);
    assert.equal(usageDashboard({ range: "year", source: "external" }).totals.runs, 2);
  }
  testLicenseEnv({ tier: "enterprise" });
  assert.equal(costHistoryStart(now), null);
  assert.equal(usageDashboard({ range: "year", source: "external" }).totals.runs, 4);
  assert.equal((await readUsage()).length, 4);
  assert.equal((await usageSummary()).totalRuns, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage").get().n, 4);
});
