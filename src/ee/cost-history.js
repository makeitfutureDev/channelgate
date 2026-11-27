// ─────────────────────────────────────────────────────────────────────────────────────────────
// PROPRIETARY — MAKEITFUTURE S.R.L. All rights reserved.
// This file is part of src/ee/ and is NOT covered by the Sustainable Use License in LICENSE.md.
// It is source-visible so operators can audit the license check; use requires a valid license
// key issued by the Licensor. See src/ee/LICENSE-EE.md and LICENSE.md §3.2 / §4.5.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// Keep underlying accounting intact across upgrades and downgrades. This read window is
// independent of license admission counters, never a destructive retention job.
import { getLicenseStatus } from "./license.js";

export function costHistoryStart(now = new Date()) {
  const days = getLicenseStatus(now.getTime()).features.costHistoryDays;
  return days === null ? null : new Date(now.getTime() - days * 86400000);
}

// HTTP listings pass one precomputed cutoff so license resolution runs once per request.
export function costVisibleAt(timestamp, now = new Date(), start = costHistoryStart(now)) {
  if (!start) return true;
  const ms = typeof timestamp === "number" ? timestamp
    : typeof timestamp === "string" && timestamp.trim() ? Date.parse(timestamp) : NaN;
  return Number.isFinite(ms) && ms >= start.getTime();
}

export function visibleEventCosts(event, now = new Date(), start = costHistoryStart(now)) {
  if (costVisibleAt(event.ts, now, start)) return event;
  // Only structured cost fields are restricted; keep the event and its operational data.
  const result = { ...event };
  if (Object.hasOwn(result, "costUSD")) result.costUSD = null;
  if (Object.hasOwn(result, "costEstimated")) result.costEstimated = false;
  return result;
}
