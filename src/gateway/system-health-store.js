// Bounded minute history in the gateway's existing SQLite database.
export const DAY_MS = 86_400_000;
export const HEALTH_POLICY = Object.freeze({ sampleIntervalMs: 5000, aggregateIntervalMs: 60_000,
  hardwareIntervalMs: 300_000, resourceRetentionDays: 30, storageRetentionDays: 186 });
const finite = (values) => values.filter(Number.isFinite);
const mean = (values) => { const v = finite(values); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const peak = (values) => { const v = finite(values); return v.length ? Math.max(...v) : null; };

export function storageForecast(points) {
  const valid = points.filter((p) => Number.isFinite(p.storageUsedBytes) && p.storageTotalBytes > 0);
  const latest = valid.at(-1);
  const empty = { status: "insufficient_history", daysToFull: null, bytesPerDay: null, observedDays: 0 };
  if (!latest) return empty;
  // Use only the segment since the most recent capacity change. A replacement disk is not growth.
  let start = valid.length - 1;
  while (start > 0 && valid[start - 1].storageTotalBytes === latest.storageTotalBytes) start--;
  const segment = valid.slice(start);
  const observedDays = (latest.timestamp - segment[0].timestamp) / DAY_MS;
  const available = latest.storageAvailableBytes ?? Math.max(0, latest.storageTotalBytes - latest.storageUsedBytes);
  if (available <= 0) return { ...empty, status: "full", daysToFull: 0, observedDays };
  if (observedDays < 7 || segment.length < 8) return { ...empty, observedDays };
  const xs = segment.map((p) => (p.timestamp - segment[0].timestamp) / DAY_MS);
  const ys = segment.map((p) => p.storageUsedBytes);
  const mx = mean(xs), my = mean(ys);
  const divisor = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  const slope = xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0) / divisor;
  if (!Number.isFinite(slope)) return { ...empty, observedDays };
  if (slope <= 0) return { status: "stable", daysToFull: null, bytesPerDay: slope, observedDays };
  return { status: "growing", daysToFull: available / slope, bytesPerDay: slope, observedDays };
}

export function createSystemHealthStore(db, { now = Date.now } = {}) {
  function persist(samples) {
    if (!samples.length) return;
    const timestamp = Math.floor(samples[0].timestamp / 60_000) * 60_000;
    const values = (field) => samples.map((s) => s[field]);
    const fields = ["cpuPercent", "memoryPercent", "load1", "storagePercent"];
    db.exec("BEGIN IMMEDIATE");
    try {
      const columns = ["cpu", "memory", "load", "storage"];
      const updates = columns.map((key) => `
        ${key} = CASE WHEN ${key}_count + excluded.${key}_count > 0 THEN
          (COALESCE(${key}, 0) * ${key}_count + COALESCE(excluded.${key}, 0) * excluded.${key}_count)
          / (${key}_count + excluded.${key}_count) ELSE NULL END,
        ${key}_peak = NULLIF(MAX(COALESCE(${key}_peak, -1), COALESCE(excluded.${key}_peak, -1)), -1),
        ${key}_count = ${key}_count + excluded.${key}_count`).join(",");
      db.prepare(`INSERT INTO system_health_resources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(timestamp) DO UPDATE SET ${updates}`)
        .run(timestamp, ...fields.flatMap((key) => [mean(values(key)), peak(values(key))]),
          ...fields.map((key) => finite(values(key)).length));
      const latest = samples.filter((s) => s.storageTotalBytes > 0 && Number.isFinite(s.storageUsedBytes)).at(-1);
      if (latest) db.prepare(`INSERT INTO system_health_storage VALUES (?, 60, ?, ?, ?, ?, ?)
        ON CONFLICT(timestamp, resolution) DO UPDATE SET used = excluded.used, total = excluded.total,
          available = excluded.available, percent = excluded.percent,
          peak = NULLIF(MAX(COALESCE(peak, -1), COALESCE(excluded.peak, -1)), -1)`)
        .run(timestamp, latest.storageUsedBytes, latest.storageTotalBytes, latest.storageAvailableBytes, latest.storagePercent, peak(values("storagePercent")));
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return timestamp;
  }
  function maintain() {
    const current = now();
    // Compact only complete hours before the minute-retention boundary. Keeping the newest actual
    // observation (rather than averaging capacity) preserves disk-resize boundaries for forecasting.
    const cutoff = Math.floor((current - HEALTH_POLICY.resourceRetentionDays * DAY_MS) / 3_600_000) * 3_600_000;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`INSERT OR REPLACE INTO system_health_storage (timestamp, resolution, used, total, available, percent, peak)
        SELECT s.timestamp, 3600, s.used, s.total, s.available, s.percent, g.peak
        FROM system_health_storage s JOIN (
          SELECT MAX(timestamp) AS latest, MAX(peak) AS peak FROM system_health_storage
          WHERE resolution = 60 AND timestamp < ? GROUP BY CAST(timestamp / 3600000 AS INTEGER)
        ) g ON s.timestamp = g.latest AND s.resolution = 60`).run(cutoff);
      db.prepare("DELETE FROM system_health_storage WHERE resolution = 60 AND timestamp < ?").run(cutoff);
      db.prepare("DELETE FROM system_health_resources WHERE timestamp < ?").run(current - HEALTH_POLICY.resourceRetentionDays * DAY_MS);
      db.prepare("DELETE FROM system_health_storage WHERE timestamp < ?").run(current - HEALTH_POLICY.storageRetentionDays * DAY_MS);
      db.prepare("DELETE FROM system_health_changes WHERE timestamp < ?").run(current - HEALTH_POLICY.storageRetentionDays * DAY_MS);
      db.exec("DELETE FROM system_health_changes WHERE id NOT IN (SELECT id FROM system_health_changes ORDER BY id DESC LIMIT 100)");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function history(range = "1h") {
    const spans = { "1h": 3_600_000, "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS };
    if (!Object.hasOwn(spans, range)) throw new RangeError("Invalid system health range");
    const end = now(), start = end - spans[range], bucket = Math.max(60_000, Math.ceil(spans[range] / 240 / 60_000) * 60_000);
    const points = db.prepare(`SELECT MAX(timestamp) AS timestamp, AVG(cpu) AS cpuPercent, AVG(memory) AS memoryPercent,
      AVG(load) AS load1, AVG(storage) AS storagePercent FROM system_health_resources WHERE timestamp >= ? AND timestamp <= ?
      GROUP BY CAST(timestamp / ? AS INTEGER) ORDER BY timestamp`).all(start, end, bucket);
    const peaks = db.prepare(`SELECT MAX(cpu_peak) AS cpuPercent, MAX(memory_peak) AS memoryPercent,
      MAX(load_peak) AS load1, MAX(storage_peak) AS storagePercent FROM system_health_resources WHERE timestamp >= ? AND timestamp <= ?`).get(start, end);
    return { points, peaks, start, end };
  }
  function storage() {
    const end = now(), start = end - HEALTH_POLICY.storageRetentionDays * DAY_MS;
    const points = db.prepare(`SELECT s.timestamp, s.used AS storageUsedBytes, s.total AS storageTotalBytes,
      s.available AS storageAvailableBytes, s.percent AS storagePercent FROM system_health_storage s JOIN (
        SELECT MAX(timestamp) AS latest FROM system_health_storage WHERE timestamp >= ? AND timestamp <= ?
        GROUP BY CAST(timestamp / 86400000 AS INTEGER)
      ) g ON s.timestamp = g.latest ORDER BY s.timestamp`).all(start, end);
    return { points, forecast: storageForecast(points), start, end };
  }
  function hardware() {
    const row = db.prepare("SELECT collected_at, snapshot FROM system_health_hardware WHERE id = 1").get();
    const changes = db.prepare("SELECT timestamp, fields FROM system_health_changes ORDER BY id DESC LIMIT 100").all()
      .map((r) => ({ timestamp: r.timestamp, fields: JSON.parse(r.fields) }));
    return { snapshot: row ? JSON.parse(row.snapshot) : null, collectedAt: row?.collected_at ?? null, changes };
  }
  function saveHardware(snapshot) {
    const previous = hardware().snapshot;
    const fields = previous ? Object.keys(snapshot).filter((key) => JSON.stringify(snapshot[key]) !== JSON.stringify(previous[key])) : [];
    const timestamp = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT OR REPLACE INTO system_health_hardware VALUES (1, ?, ?)").run(timestamp, JSON.stringify(snapshot));
      if (fields.length) db.prepare("INSERT INTO system_health_changes(timestamp, fields) VALUES (?, ?)").run(timestamp, JSON.stringify(fields));
      db.exec("DELETE FROM system_health_changes WHERE id NOT IN (SELECT id FROM system_health_changes ORDER BY id DESC LIMIT 100)");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return hardware();
  }
  const lastPersistedAt = () => db.prepare("SELECT MAX(timestamp) AS timestamp FROM system_health_resources").get().timestamp;
  return { persist, maintain, history, storage, hardware, saveHardware, lastPersistedAt };
}
