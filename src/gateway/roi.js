// ROI of automations, API sources and skills: what a person says one successful run or use is
// worth (minutes of work saved, and what an hour of that work costs), set against what the runs
// cost in AI spend. The inputs are people's own estimates; nothing here measures time.
//   hours saved = counted runs × minutes ÷ 60        value = hours saved × hourly rate
//   net = value − AI cost                            ROI = net ÷ AI cost (a multiple)
// A schedule keeps its inputs on its own record (roiMinutes, roiHourlyRate — schedule-patch.js);
// an API source, a skill and the gateway's default hourly rate live in `roi_assignments`.
import { getDb } from "../db/index.js";

export const ROI_WINDOWS = [7, 30, 90];
export const ROI_MAX_MINUTES = 100_000;
export const ROI_MAX_RATE = 100_000;

const round = (n, digits) => { const f = 10 ** digits; return Math.round((Number(n) || 0) * f) / f; };
const fail = (message) => Object.assign(new Error(message), { status: 400, userFacing: true });

// One number field: empty/null clears it (0), anything else must be a plain non-negative number.
export function roiNumber(value, { label, max }) {
  if (value === undefined || value === null || value === "") return 0;
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n) || n < 0) throw fail(`${label} must be a number, 0 or more.`);
  if (n > max) throw fail(`${label} can be ${max.toLocaleString("en-US")} at most.`);
  return round(n, 2);
}
export const roiMinutes = (value) => roiNumber(value, { label: "Time saved", max: ROI_MAX_MINUTES });
export const roiRate = (value) => roiNumber(value, { label: "The hourly rate", max: ROI_MAX_RATE });

// A run that did its job: finished without a failure, and its answer was not lost on the way.
// "completed" (nobody asked for an outcome report) counts — it ran and delivered.
const DONE = new Set(["succeeded", "no-op", "completed"]);
export const roiCounts = (run) => DONE.has(run?.status) && run.deliveryStatus !== "failed";

/**
 * The ROI of one item. `rate` 0 falls back to the gateway default; without minutes AND a rate the
 * item is not configured and contributes nothing to a total. `costUsd` null means the AI cost of
 * these uses is not attributed (skills), so there is no net and no multiple to claim.
 */
export function roiOf({ minutes = 0, rate = 0, defaultRate = 0, counted = 0, costUsd = 0 } = {}) {
  const m = Number(minutes) > 0 ? Number(minutes) : 0;
  const own = Number(rate) > 0 ? Number(rate) : 0;
  const effectiveRate = own || (Number(defaultRate) > 0 ? Number(defaultRate) : 0);
  const configured = m > 0 && effectiveRate > 0;
  const n = Math.max(0, Number(counted) || 0);
  const hoursSaved = m > 0 ? (n * m) / 60 : 0;
  const valueUsd = configured ? hoursSaved * effectiveRate : 0;
  const cost = costUsd === null ? null : Math.max(0, Number(costUsd) || 0);
  const netUsd = configured && cost !== null ? valueUsd - cost : null;
  return {
    minutes: m, rate: own, effectiveRate, usesDefaultRate: configured && !own, configured, counted: n,
    hoursSaved: round(hoursSaved, 2), valueUsd: round(valueUsd, 2), costUsd: cost === null ? null : round(cost, 2),
    netUsd: netUsd === null ? null : round(netUsd, 2),
    multiple: netUsd !== null && cost > 0 ? round(netUsd / cost, 1) : null,
  };
}

// Totals over the CONFIGURED items only: an item without inputs has no value to add, so its cost
// is reported beside the total (unconfiguredCostUsd), never subtracted from someone else's value.
export function roiTotals(items) {
  const t = { items: items.length, configured: 0, counted: 0, hoursSaved: 0, valueUsd: 0, costUsd: 0, unconfiguredCostUsd: 0 };
  let costKnown = true;
  for (const r of items) {
    if (!r.configured) { t.unconfiguredCostUsd += r.costUsd || 0; continue; }
    t.configured += 1; t.counted += r.counted; t.hoursSaved += r.hoursSaved; t.valueUsd += r.valueUsd;
    if (r.costUsd === null) costKnown = false; else t.costUsd += r.costUsd;
  }
  const net = t.valueUsd - t.costUsd;
  return {
    ...t, hoursSaved: round(t.hoursSaved, 2), valueUsd: round(t.valueUsd, 2), costUsd: round(t.costUsd, 2), unconfiguredCostUsd: round(t.unconfiguredCostUsd, 2),
    costKnown, netUsd: round(net, 2), multiple: costKnown && t.costUsd > 0 ? round(net / t.costUsd, 1) : null,
  };
}

// ── stored inputs ───────────────────────────────────────────────────────────────────────────
const shape = (row) => row ? { minutes: Number(row.minutes_saved) || 0, rate: Number(row.hourly_rate) || 0, updatedAt: row.updated_at, updatedBy: row.updated_by } : null;

export function getRoiAssignment(kind, channelId, ref) {
  return shape(getDb().prepare("SELECT * FROM roi_assignments WHERE kind = ? AND channel_id = ? AND ref = ?").get(kind, channelId || "", String(ref)));
}
export function roiAssignments(kind) {
  const out = new Map();
  for (const row of getDb().prepare("SELECT * FROM roi_assignments WHERE kind = ?").all(kind)) out.set(`${row.channel_id}\n${row.ref}`, shape(row));
  return out;
}
// Both zero removes the row: nothing configured is the absence of a record.
export function setRoiAssignment(kind, channelId, ref, { minutes, rate }, by = "", now = Date.now()) {
  const db = getDb();
  if (!(minutes > 0) && !(rate > 0)) {
    db.prepare("DELETE FROM roi_assignments WHERE kind = ? AND channel_id = ? AND ref = ?").run(kind, channelId || "", String(ref));
    return { minutes: 0, rate: 0 };
  }
  db.prepare(`INSERT INTO roi_assignments(kind, channel_id, ref, minutes_saved, hourly_rate, updated_at, updated_by) VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, channel_id, ref) DO UPDATE SET minutes_saved = excluded.minutes_saved, hourly_rate = excluded.hourly_rate, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(kind, channelId || "", String(ref), minutes || 0, rate || 0, now, String(by || "").slice(0, 64));
  return { minutes: minutes || 0, rate: rate || 0 };
}
export const getDefaultRoiRate = () => getRoiAssignment("default", "", "rate")?.rate || 0;
export const setDefaultRoiRate = (rate, by = "") => setRoiAssignment("default", "", "rate", { minutes: 0, rate }, by).rate;

// Skill uses since `sinceIso`, one per run (a skill loaded twice in one run saved the time once).
// `channelSlugs` null = every conversation; otherwise only uses in those conversations.
export function skillUsesSince(sinceIso, channelSlugs = null) {
  const scoped = Array.isArray(channelSlugs);
  if (scoped && !channelSlugs.length) return [];
  const rows = getDb().prepare(`SELECT slug, COUNT(DISTINCT CASE WHEN run_id <> '' THEN run_id ELSE 'row:' || id END) AS uses,
      COUNT(DISTINCT CASE WHEN user_id <> '' THEN user_id END) AS people, COUNT(DISTINCT CASE WHEN channel_slug <> '' THEN channel_slug END) AS channels, MAX(ts) AS last_ts
    FROM skill_usage WHERE ts >= ?${scoped ? " AND channel_slug IN (SELECT value FROM json_each(?))" : ""} GROUP BY slug ORDER BY uses DESC, slug LIMIT 1000`)
    .all(...(scoped ? [sinceIso, JSON.stringify(channelSlugs)] : [sinceIso]));
  return rows.map((r) => ({ slug: r.slug, uses: Number(r.uses) || 0, people: Number(r.people) || 0, channels: Number(r.channels) || 0, lastUsedAt: r.last_ts || null }));
}
export function skillUsageSlugsSince(sinceIso) {
  return getDb().prepare("SELECT DISTINCT channel_slug AS slug FROM skill_usage WHERE ts >= ? AND channel_slug <> ''").all(sinceIso).map((r) => r.slug);
}
