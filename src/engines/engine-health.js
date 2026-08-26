// Adapter-owned CLI compatibility probes, shared by boot and /api/health. Every registered engine
// is checked; adding a third adapter needs no health-route or server edit.
import { engineHealth } from "./registry.js";

export async function getEngineHealth(options) {
  const checks = await engineHealth(options);
  return Object.fromEntries(checks.map(({ id, ready, version, error, ...rest }) => [id, {
    available: Boolean(ready),
    ...(ready ? { version } : { reason: error || "CLI unavailable" }),
    ...rest,
  }]));
}
