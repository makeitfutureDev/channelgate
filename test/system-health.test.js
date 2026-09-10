import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { DatabaseSync } = await import("node:sqlite");
const { migrations } = await import("../src/db/migrations.js");
const { createLinuxHealthCollector, parseCpuStat, cpuUsage, parseMeminfo, storageStats } = await import("../src/gateway/system-health-collect.js");
const { createSystemHealthStore, storageForecast, DAY_MS } = await import("../src/gateway/system-health-store.js");
const { createSystemHealth } = await import("../src/gateway/system-health.js");

function database(t) {
  const db = new DatabaseSync(":memory:");
  migrations.find((m) => m.version === 25).up(db);
  t.after(() => db.close());
  return db;
}
function sample(timestamp, overrides = {}) {
  return { timestamp, cpuPercent: 20, memoryPercent: 40, load1: 2, storageUsedBytes: 100,
    storageTotalBytes: 1000, storageAvailableBytes: 850, storagePercent: 100 / 950 * 100, ...overrides };
}
const meminfo = "MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 500 kB\nSwapFree: 200 kB";
function fixtureIo(overrides = {}) {
  const files = { "/proc/stat": "cpu  100 0 20 880 0 0 0 0 100 0\ncpu0 0\ncpu1 0", "/proc/meminfo": meminfo,
    "/proc/loadavg": "1.5 2.5 3.5 1/90 123", "/proc/cpuinfo": "processor: 0\nmodel name: Fixture CPU\nphysical id: 0\ncore id: 0\n\nprocessor: 1\nmodel name: Fixture CPU\nphysical id: 0\ncore id: 1",
    "/etc/os-release": 'PRETTY_NAME="Fixture Linux"', "/proc/self/mountinfo": "1 2 3:4 / / rw - ext4 /dev/test rw", ...overrides };
  const reads = [];
  return { files, reads, async readFile(file) { reads.push(file); if (!(file in files)) throw new Error("missing"); return files[file]; },
    async readdir() { return []; }, async readlink() { throw new Error("missing"); },
    async statfs(dir) { assert.equal(dir, "/runtime"); return { blocks: 1000, bsize: 10, bfree: 400, bavail: 300 }; } };
}

test("CPU excludes guest double counting, waits for baseline, and resets counters safely", () => {
  const before = parseCpuStat("cpu 100 0 0 900 0 0 0 0 100 0");
  const after = parseCpuStat("cpu 150 0 0 950 0 0 0 0 150 0");
  assert.equal(before.total, 1000);
  assert.equal(cpuUsage(null, before), null);
  assert.equal(cpuUsage(before, after), 50);
  assert.equal(cpuUsage(after, before), null);
  assert.equal(parseCpuStat("cpu invalid"), null);
  assert.equal(cpuUsage(parseCpuStat("cpu 100 0 0 900 20 0 0 0"), parseCpuStat("cpu 110 0 0 950 10 0 0 0")), null);
});

test("memory uses MemAvailable and storage distinguishes used/free/reserved capacity", () => {
  assert.deepEqual(parseMeminfo(meminfo), { memoryTotalBytes: 1024000, memoryUsedBytes: 614400, memoryPercent: 60,
    swapTotalBytes: 512000, swapUsedBytes: 307200 });
  assert.equal(parseMeminfo("MemTotal: 1000 kB").memoryPercent, null);
  const disk = storageStats({ blocks: 100, bsize: 1024, bfree: 30, bavail: 20 }, "/runtime");
  assert.equal(disk.storageUsedBytes, 70 * 1024);
  assert.equal(disk.storageAvailableBytes, 20 * 1024);
  assert.equal(disk.storagePercent, 70 / 90 * 100);
});

test("collector reads fixed host sources and reports missing telemetry without fake zeroes", async () => {
  const io = fixtureIo();
  const collector = createLinuxHealthCollector({ io, now: () => 50, storagePath: "/runtime", system: { arch: () => "x64", release: () => "fixture" } });
  const first = await collector.collect();
  assert.equal(first.sample.cpuPercent, null);
  assert.equal(first.sample.memoryPercent, 60);
  assert.equal(first.error, null);
  io.files["/proc/stat"] = "cpu 150 0 20 930 0 0 0 0 150 0\ncpu0 0\ncpu1 0";
  assert.equal((await collector.collect()).sample.cpuPercent, 50);
  delete io.files["/proc/meminfo"];
  io.files["/proc/loadavg"] = "NaN 2.5 3.5";
  const failed = await collector.collect();
  assert.equal(failed.sample.memoryUsedBytes, null);
  assert.equal(failed.sample.load1, null);
  assert.match(failed.error, /memory, load/);
  const hardware = await collector.hardware();
  assert.equal(hardware.cpuModel, "Fixture CPU");
  assert.equal(hardware.logicalCpus, 2);
  assert.equal(hardware.physicalCores, 2);
  assert.equal(hardware.filesystem, "ext4");
  assert.equal(hardware.biosVersion, null);
  assert.ok(io.reads.every((p) => !/serial|temp|uuid|address|\/dev\//.test(p)));
});

test("minute aggregates and downsampled charts preserve true peaks, missing data stays null", (t) => {
  const db = database(t), now = 100 * DAY_MS;
  const store = createSystemHealthStore(db, { now: () => now });
  store.persist([sample(now - 90_000, { cpuPercent: null }), sample(now - 85_000, { cpuPercent: 96 })]);
  store.persist([sample(now - 30_000, { cpuPercent: 10 })]);
  const result = store.history("1h");
  assert.equal(result.points.length, 2);
  assert.equal(result.points[0].cpuPercent, 96);
  assert.equal(result.peaks.cpuPercent, 96);
  assert.equal(store.history("30d").peaks.cpuPercent, 96);
  assert.throws(() => store.history("ALL"), RangeError);
});

test("retention compacts old storage hourly, preserves peak and capacity, removes expired rows", (t) => {
  const db = database(t), now = 300 * DAY_MS;
  const store = createSystemHealthStore(db, { now: () => now });
  for (const delta of [10, 31, 185, 187]) {
    const time = now - delta * DAY_MS;
    store.persist([sample(time, { storagePercent: 97, storageUsedBytes: 970 })]);
    store.persist([sample(time + 60_000, { storagePercent: 20, storageUsedBytes: 200 })]);
  }
  store.maintain();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM system_health_resources").get().n, 2);
  const old = db.prepare("SELECT * FROM system_health_storage WHERE resolution = 3600 ORDER BY timestamp").all();
  assert.equal(old.length, 2);
  assert.ok(old.every((r) => r.used === 200 && r.peak === 97 && r.total === 1000));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM system_health_storage").get().n, 4);
  assert.ok(store.storage().points.length <= 187);
  store.maintain();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM system_health_storage").get().n, 4);
});

test("forecast refuses short history and resized volumes, estimates measured growth only", () => {
  const points = Array.from({ length: 10 }, (_, i) => ({ timestamp: i * DAY_MS, storageUsedBytes: 100 + i * 10, storageTotalBytes: 1000, storageAvailableBytes: 900 - i * 10 }));
  const forecast = storageForecast(points);
  assert.equal(forecast.status, "growing");
  assert.equal(forecast.bytesPerDay, 10);
  assert.equal(forecast.daysToFull, 81);
  assert.equal(storageForecast(points.slice(0, 3)).status, "insufficient_history");
  assert.equal(storageForecast([...points, { ...points.at(-1), timestamp: 10 * DAY_MS, storageTotalBytes: 2000 }]).status, "insufficient_history");
  assert.equal(storageForecast(points.map((p) => ({ ...p, storageUsedBytes: 100 }))).status, "stable");
  assert.equal(storageForecast([{ ...points[0], storageAvailableBytes: 0 }]).status, "full");
});

test("hardware snapshot persists across restarts with bounded field-only changes", (t) => {
  const db = database(t); let timestamp = 0;
  const store = createSystemHealthStore(db, { now: () => ++timestamp });
  store.saveHardware({ cpuModel: "Fixture", memoryTotalBytes: 1 });
  assert.equal(store.hardware().changes.length, 0);
  for (let i = 2; i < 110; i++) store.saveHardware({ cpuModel: "Fixture", memoryTotalBytes: i });
  const restored = createSystemHealthStore(db).hardware();
  assert.equal(restored.snapshot.memoryTotalBytes, 109);
  assert.equal(restored.changes.length, 100);
  assert.deepEqual(restored.changes[0].fields, ["memoryTotalBytes"]);
});

test("service prevents overlapping samples, persists a minute, flushes shutdown, uses unref timer", async (t) => {
  const db = database(t); let time = 60_000, reads = 0, release, unrefs = 0, clears = 0;
  const store = createSystemHealthStore(db, { now: () => time });
  const collector = { collect: async () => { reads++; if (reads === 1) await new Promise((resolve) => { release = resolve; }); return { sample: sample(time), error: null }; }, hardware: async () => ({ cpuModel: "Fixture" }) };
  const service = createSystemHealth({ collector, store, now: () => time,
    schedule: () => ({ unref() { unrefs++; } }), unschedule: () => { clears++; } });
  service.start();
  const next = service.tick();
  assert.equal(reads, 1);
  release(); await next;
  time = 125_000; await service.tick();
  assert.equal(service.current().collection.lastPersistedAt, 60_000);
  assert.equal(service.history("live").points.length, 2);
  assert.equal(unrefs, 1);
  await service.stop();
  assert.equal(clears, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM system_health_resources").get().n, 2);
  await service.tick(); assert.equal(reads, 2);
});

test("collector failure is nonfatal and refreshes coalesce", async (t) => {
  const db = database(t), store = createSystemHealthStore(db); let calls = 0, resolveHardware;
  const service = createSystemHealth({ store, collector: {
    collect: async () => { throw new Error("secret internal detail"); },
    hardware: async () => { calls++; return new Promise((resolve) => { resolveHardware = resolve; }); },
  } });
  await service.tick();
  assert.equal(service.current().sample, null);
  assert.equal(service.current().collection.error, "System telemetry unavailable");
  const first = service.refreshHardware(), second = service.refreshHardware();
  assert.equal(calls, 1);
  resolveHardware({ cpuModel: "Fixture" });
  await Promise.all([first, second]);
  assert.equal(service.hardware().snapshot.cpuModel, "Fixture");
  await service.stop();
});


test("restart in the same minute merges weighted averages and preserves the earlier peaks", (t) => {
  const db = database(t), now = 600_000;
  const before = createSystemHealthStore(db, { now: () => now });
  before.persist([sample(now - 30_000, { cpuPercent: 100, memoryPercent: 80, storagePercent: 99 }),
    sample(now - 25_000, { cpuPercent: 0, memoryPercent: 40, storagePercent: 30 })]);
  const after = createSystemHealthStore(db, { now: () => now });
  after.persist([sample(now - 10_000, { cpuPercent: 20, memoryPercent: 30, storagePercent: 10 })]);
  const history = after.history("1h");
  assert.equal(history.points.length, 1);
  assert.equal(history.points[0].cpuPercent, 40);
  assert.equal(history.points[0].memoryPercent, 50);
  assert.equal(history.peaks.cpuPercent, 100);
  assert.equal(history.peaks.storagePercent, 99);
  assert.equal(db.prepare("SELECT peak FROM system_health_storage").get().peak, 99);
});

test("the complete retained numeric history stays below the 100 MiB metrics budget", (t) => {
  const db = database(t);
  const resource = db.prepare("INSERT INTO system_health_resources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const storage = db.prepare("INSERT INTO system_health_storage VALUES (?, ?, ?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  // Include an extra maintenance hour. Deliberately use non-integer doubles for maximum row size.
  const minuteRows = 30 * 24 * 60 + 60;
  for (let i = 0; i < minuteRows; i++) {
    resource.run(i * 60_000, 47.321, 99.321, 65.321, 97.321, 3.321, 70.321, 42.321, 92.321, 12, 12, 12, 12);
    storage.run(i * 60_000, 60, 532123451234.321, 932123451234.321, 400000000000.321, 42.321, 92.321);
  }
  for (let i = 1; i <= 156 * 24; i++) storage.run(-i * 3_600_000, 3600, 532123451234.321, 932123451234.321, 400000000000.321, 42.321, 92.321);
  db.exec("COMMIT");
  const bytes = db.prepare("PRAGMA page_count").get().page_count * db.prepare("PRAGMA page_size").get().page_size;
  t.diagnostic(`Full retention fixture: ${minuteRows} resource rows, ${minuteRows + 156 * 24} storage rows, ${bytes} SQLite bytes`);
  // Reserve 4 MiB for the default WAL autocheckpoint. This is metrics footprint, not a global cap
  // on the shared DB/WAL, whose other consumers and long-running readers remain independent.
  assert.ok(bytes + 4 * 1024 * 1024 < 100 * 1024 * 1024);
});

test("hardware source loss preserves the previous inventory and reports a sanitized error", async (t) => {
  const db = database(t), store = createSystemHealthStore(db);
  store.saveHardware({ cpuModel: "Last known" });
  const service = createSystemHealth({ store, collector: { collect: async () => ({ sample: sample(Date.now()), error: null }),
    hardware: async () => { throw new Error("sensitive path detail"); } } });
  await assert.rejects(service.refreshHardware(), /Hardware inventory unavailable/);
  assert.equal(service.hardware().snapshot.cpuModel, "Last known");
  assert.equal(service.current().collection.error, "Hardware inventory unavailable");
  await service.stop();
});
