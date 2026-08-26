// Dropped-write counters for the best-effort stores (usage ledger, event log, bg-job persistence).
// Those writes swallow errors by design — a logging failure must never break a run — but under WAL
// contention that meant the spend ledger could silently diverge with zero trace. Count every drop
// per source and emit a rate-limited console line so the degradation is at least observable.
// In-memory and per-process (the daemon and the spawned MCP server each keep their own tally);
// dropCounts() is the read side for a future health/metrics surface.
const counts = new Map(); // source -> dropped-write count
const lastLogMs = new Map(); // source -> last console line (rate limit)
const LOG_EVERY_MS = 60_000;

export function countDrop(source, err) {
  counts.set(source, (counts.get(source) || 0) + 1);
  const now = Date.now();
  if (now - (lastLogMs.get(source) || 0) >= LOG_EVERY_MS) {
    lastLogMs.set(source, now);
    console.warn(`[drops] ${source}: write dropped (${counts.get(source)} total this process): ${err?.message || err}`);
  }
}

// Snapshot of per-source drop counts ({} when nothing was dropped).
export function dropCounts() {
  return Object.fromEntries(counts);
}
