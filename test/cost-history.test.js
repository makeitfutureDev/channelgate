import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv, testLicenseEnv, clearTestLicense } from "./helpers.js";
ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { readUsage, usageSummary, usageDashboard, costHistoryStart } = await import("../src/gateway/usage.js");

test("Free cost reports expose 30 days for both engines without deleting older accounting", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 6, 15, 12) });
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

test("Free dashboard chart includes partial calendar buckets at the history cutoff", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 3, 12) });
  testLicenseEnv({ tier: "free" });
  const db = getDb();
  db.exec("DELETE FROM usage; DELETE FROM external_usage");
  const insert = db.prepare("INSERT INTO usage(ts, channel_id, slug, author_id, engine, model, task_kind, tokens_in, tokens_out, cost_usd) VALUES(?, 'history', 'history', 'user', 'claude', 'model', 'interactive', 10, 5, 1)");
  insert.run("2026-10-04T13:00:00.000Z");
  insert.run("2026-11-03T11:00:00.000Z");
  const yearly = usageDashboard({ range: "year", source: "gateway" });
  assert.deepEqual(yearly.series.map(({ key, runs }) => ({ key, runs })), [
    { key: "2026-10", runs: 1 }, { key: "2026-11", runs: 1 },
  ]);
  assert.deepEqual(usageDashboard({ range: "lastyear", source: "gateway" }).series, []);

  t.mock.timers.setTime(Date.UTC(2026, 9, 31, 12));
  insert.run("2026-10-31T11:00:00.000Z");
  const monthly = usageDashboard({ range: "month", source: "gateway" });
  assert.equal(monthly.series.length, 31);
  assert.equal(monthly.series.at(-1).key, "2026-10-31");
  assert.equal(monthly.series.at(-1).runs, 1);
  assert.equal(monthly.series.reduce((sum, row) => sum + row.runs, 0), monthly.totals.runs);
});

test("exact cutoff and non-hour external buckets stay bounded across every breakdown and tier change", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 2, 31, 12, 30) });
  const db = getDb();
  db.exec("DELETE FROM usage_components; DELETE FROM usage; DELETE FROM external_usage");
  const cutoff = Date.UTC(2026, 2, 1, 12, 30);
  for (const [name, delta] of [["old", -1], ["equal", 0], ["new", 1]]) {
    db.prepare("INSERT INTO usage(ts, channel_id, slug, author_id, engine, model, task_kind, tokens_in, tokens_out, cost_usd) VALUES(?, ?, ?, ?, 'codex', ?, 'interactive', 10, 5, 1)")
      .run(new Date(cutoff + delta).toISOString(), name, name, name, name);
  }
  for (const hour of [12, 13]) {
    db.prepare("INSERT INTO external_usage(scope, engine, session_id, bucket, channel_id, slug, origin, model, turns, cost_usd, updated_ms) VALUES('operator', 'codex', ?, ?, ?, ?, 'terminal', ?, 1, 1, 0)")
      .run(`external-${hour}`, `2026-03-01T${hour}`, `external-${hour}`, `external-${hour}`, `external-${hour}`);
  }
  for (const tier of ["free", "enterprise", "free"]) {
    testLicenseEnv({ tier });
    const free = tier === "free";
    const report = usageDashboard({ range: "month" });
    assert.equal((await readUsage()).length, free ? 2 : 3);
    assert.equal((await usageSummary()).totalRuns, free ? 2 : 3);
    assert.equal(report.totals.runs, free ? 3 : 5);
    assert.equal(report.series.reduce((sum, r) => sum + r.runs, 0), report.totals.runs);
    assert.equal(report.models.some(r => r.model === "old"), !free);
    assert.equal(report.byUser.some(r => r.userId === "old"), !free);
    assert.equal(report.byChannel.some(r => r.channelId === "external-12"), !free);
    assert.equal(report.origins.find(r => r.origin === "terminal").cost, free ? 1 : 2);
    assert.equal(report.byChannel.reduce((sum, r) => sum + r.cost, 0), report.totals.cost);
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM usage").get().n, 3);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM external_usage").get().n, 2);
});

test("costHistoryStart resolves Enterprise expiry using the supplied clock", () => {
  const expiry = Date.UTC(2026, 5, 15);
  testLicenseEnv({ tier: "enterprise", expiresAt: new Date(expiry).toISOString() });
  assert.equal(costHistoryStart(new Date(expiry - 1)), null);
  assert.equal(costHistoryStart(new Date(expiry + 1)).getTime(), expiry + 1 - 30 * 86400000);
});
