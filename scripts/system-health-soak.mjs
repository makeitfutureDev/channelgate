#!/usr/bin/env node
// Foreground canary: a fresh scratch DB, actual Linux reads and measured process overhead.
// It never opens the serving gateway DB, changes hardware or launches an engine.
import { mkdtemp, mkdir, stat, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../src/db/index.js";
import { createLinuxHealthCollector } from "../src/gateway/system-health-collect.js";
import { createSystemHealthStore } from "../src/gateway/system-health-store.js";
import { createSystemHealth } from "../src/gateway/system-health.js";

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--duration-seconds", "--output", "--storage-path"].includes(args[i]) || !args[i + 1]) {
    throw new Error("Usage: node scripts/system-health-soak.mjs --output /absolute/report.json [--duration-seconds 86400] [--storage-path /path/on/target/filesystem]");
  }
  options[args[i]] = args[i + 1];
}
const seconds = Number(options["--duration-seconds"] ?? 86400);
if (!Number.isFinite(seconds) || seconds < 5 || seconds > 604800) throw new Error("Duration must be 5–604800 seconds");
if (!options["--output"] || !path.isAbsolute(options["--output"])) throw new Error("An absolute --output report path is required");
const output = options["--output"];
await mkdir(path.dirname(output), { recursive: true });
// Refuse to overwrite another canary's evidence.
await writeFile(output, "{}\n", { flag: "wx", mode: 0o600 });
const scratch = await mkdtemp(path.join(tmpdir(), "cg-health-soak-"));
const file = path.join(scratch, "metrics.db");
const storagePath = path.resolve(options["--storage-path"] || scratch);
const db = new DatabaseSync(file);
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
runMigrations(db);
const startedAt = Date.now(), startedMono = performance.now(), startedCpu = process.cpuUsage();
let samples = 0, lastSampleAt = null, maxGapMs = 0, peakRssBytes = 0, peakDatabaseWalBytes = 0;
let interrupted = false, finishing = false, reportTimer;
const errors = new Set();
let containerDetected = false;
for (const name of ["/run/.containerenv", "/.dockerenv"]) {
  if (await stat(name).then(() => true, () => false)) containerDetected = true;
}
const linux = createLinuxHealthCollector({ storagePath });
const collector = {
  hardware: linux.hardware,
  collect: async () => {
    const result = await linux.collect();
    samples++;
    if (lastSampleAt != null) maxGapMs = Math.max(maxGapMs, result.sample.timestamp - lastSampleAt);
    lastSampleAt = result.sample.timestamp;
    if (result.error) errors.add(result.error);
    return result;
  },
};
const store = createSystemHealthStore(db);
const service = createSystemHealth({ collector, store });
const bytes = async (name) => (await stat(name).catch(() => null))?.size || 0;
async function report(complete = false) {
  const elapsedSeconds = (performance.now() - startedMono) / 1000;
  const usage = process.cpuUsage(startedCpu);
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024);
  peakDatabaseWalBytes = Math.max(peakDatabaseWalBytes, await bytes(file) + await bytes(`${file}-wal`));
  if (service.current().collection.error) errors.add(service.current().collection.error);
  const minuteRows = db.prepare("SELECT COUNT(*) AS n FROM system_health_resources").get().n;
  const hardware = service.hardware();
  const completed24Hours = elapsedSeconds >= 86400;
  const checksPassed = samples >= Math.floor(elapsedSeconds / 5) * 0.95 && maxGapMs <= 30000 &&
    errors.size === 0 && peakDatabaseWalBytes < 100 * 1024 ** 2 && !interrupted;
  const result = { startedAt, completedAt: complete ? Date.now() : null, elapsedSeconds,
    mode: seconds >= 86400 ? "soak" : "smoke", containerDetected,
    scope: "Local process namespace; host execution must be independently verified", storagePath,
    samples, minuteRows, maxGapMs, averageCpuPercentOfOneCore: (usage.user + usage.system) / (elapsedSeconds * 10000),
    peakRssBytes, peakDatabaseWalBytes, errors: [...errors].slice(0, 10), interrupted,
    completed24Hours, checksPassed, soakPassed: complete && completed24Hours && checksPassed,
    hardware: hardware.snapshot, hardwareCollectedAt: hardware.collectedAt };
  await writeFile(`${output}.tmp`, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  await rename(`${output}.tmp`, output);
  return result;
}
let reportActive = null;
function checkpoint() {
  if (finishing || reportActive) return;
  reportActive = report().catch(() => { errors.add("Canary report write failed"); }).finally(() => { reportActive = null; });
}
try {
  service.start();
  reportTimer = setInterval(checkpoint, 30000);
  console.log(`System health ${seconds >= 86400 ? "soak" : "smoke"} started; foreground duration ${seconds}s; report ${output}`);
  await new Promise((resolve) => {
    const finishTimer = setTimeout(resolve, seconds * 1000);
    const stop = () => { interrupted = true; clearTimeout(finishTimer); resolve(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  finishing = true;
  clearInterval(reportTimer);
  await reportActive;
  await service.stop();
  const result = await report(true);
  db.close();
  const reopened = new DatabaseSync(file);
  result.restartPersistenceVerified = reopened.prepare("SELECT COUNT(*) AS n FROM system_health_resources").get().n === result.minuteRows;
  reopened.close();
  if (!result.restartPersistenceVerified) { result.checksPassed = false; result.soakPassed = false; }
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ complete: true, mode: result.mode, elapsedSeconds: result.elapsedSeconds,
    samples: result.samples, minuteRows: result.minuteRows, checksPassed: result.checksPassed,
    soakPassed: result.soakPassed, containerDetected, report: output }));
  process.exitCode = result.checksPassed ? 0 : 1;
} finally {
  clearInterval(reportTimer);
  await service.stop();
  try { db.close(); } catch { /* already closed */ }
  await rm(scratch, { recursive: true, force: true });
}
