import { getDb } from "../db/index.js";
import { gatewayRoot } from "../config/paths.js";
import { createLinuxHealthCollector } from "./system-health-collect.js";
import { createSystemHealthStore, HEALTH_POLICY } from "./system-health-store.js";

export function createSystemHealth({ collector, store, now = Date.now, schedule = setInterval, unschedule = clearInterval } = {}) {
  let sample = null, recent = [], pending = [], active = null, refreshing = null;
  let timer = null, started = false, stopped = false, lastHardwareAt = null, lastMaintenanceAt = null;
  let lastPersistedAt = store.lastPersistedAt(), collectionError = null, persistenceError = null, hardwareError = null;
  async function refreshHardware() {
    if (refreshing) return refreshing;
    // Coalesce repeated clicks/pollers without rescanning sysfs on every admin request.
    if (lastHardwareAt != null && now() - lastHardwareAt < 5000) return store.hardware();
    refreshing = (async () => {
      try {
        const snapshot = await collector.hardware();
        const result = store.saveHardware(snapshot);
        lastHardwareAt = now(); hardwareError = snapshot.unavailableSources?.length ? `Hardware sources unavailable: ${snapshot.unavailableSources.join(", ")}` : null;
        return result;
      } catch {
        hardwareError = "Hardware inventory unavailable";
        throw new Error(hardwareError);
      } finally { refreshing = null; }
    })();
    return refreshing;
  }
  function flush() {
    if (!pending.length) return;
    lastPersistedAt = store.persist(pending);
    pending = [];
    persistenceError = null;
  }
  async function tick() {
    if (stopped || active) return active;
    active = (async () => {
      try {
        const result = await collector.collect();
        sample = result.sample;
        collectionError = result.error;
        recent.push(sample);
        recent = recent.filter((s) => s.timestamp >= now() - 15 * 60_000).slice(-180);
        if (pending.length && Math.floor(sample.timestamp / 60_000) !== Math.floor(pending[0].timestamp / 60_000)) {
          try { flush(); } catch { persistenceError = "Metrics persistence unavailable"; pending = []; }
        }
        pending.push(sample);
        pending = pending.slice(-12);
        if (lastMaintenanceAt == null || now() - lastMaintenanceAt >= 3_600_000) {
          try { store.maintain(); lastMaintenanceAt = now(); } catch { persistenceError = "Metrics retention unavailable"; }
        }
        if (lastHardwareAt == null || now() - lastHardwareAt >= HEALTH_POLICY.hardwareIntervalMs) {
          // Inventory work never holds up the five-second metrics loop.
          void refreshHardware().catch(() => {});
        }
      } catch { collectionError = "System telemetry unavailable"; }
      finally { active = null; }
    })();
    return active;
  }
  function current() {
    return { sample, recent, collection: { ...HEALTH_POLICY, lastSampleAt: sample?.timestamp ?? null,
      lastPersistedAt, error: [collectionError, persistenceError, hardwareError].filter(Boolean).join("; ") || null } };
  }
  function history(range = "live") {
    if (range !== "live") return store.history(range);
    const end = now(), start = end - 15 * 60_000;
    const points = recent.filter((s) => s.timestamp >= start && s.timestamp <= end);
    const peaks = Object.fromEntries(["cpuPercent", "memoryPercent", "load1", "storagePercent"].map((key) => {
      const values = points.map((s) => s[key]).filter(Number.isFinite);
      return [key, values.length ? Math.max(...values) : null];
    }));
    return { points, peaks, start, end };
  }
  function start() {
    if (started) return;
    started = true; stopped = false;
    timer = schedule(() => void tick(), HEALTH_POLICY.sampleIntervalMs);
    timer.unref?.();
    void tick();
  }
  async function stop() {
    stopped = true;
    if (timer) unschedule(timer);
    timer = null; started = false;
    await active;
    await refreshing?.catch(() => {});
    try { flush(); } catch { persistenceError = "Metrics persistence unavailable"; }
  }
  return { start, stop, tick, current, history, storage: store.storage, hardware: store.hardware, refreshHardware };
}
let service;
export function getSystemHealth() {
  service ||= createSystemHealth({ collector: createLinuxHealthCollector({ storagePath: gatewayRoot() }), store: createSystemHealthStore(getDb()) });
  return service;
}
export function startSystemHealth() {
  try { getSystemHealth().start(); } catch { console.error("[system-health] collector unavailable; gateway continues"); }
}
export async function stopSystemHealth() { await service?.stop(); }
