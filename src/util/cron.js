// Minimal 5-field cron matcher: "min hour day-of-month month day-of-week".
// Supports *, lists (a,b), ranges (a-b), and steps (*/n or a-b/n) per field. Day-of-month and
// day-of-week use the standard OR rule when both are restricted. Enough for everyday schedules
// like "0 9 * * *" (every day 9am) or "*/15 * * * *" (every 15 min).

const RANGES = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (0/7 = Sunday)
];

function parseField(field, min, max) {
  const values = new Set();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? parseInt(stepPart, 10) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    let lo = min;
    let hi = max;
    if (rangePart !== "*") {
      const m = rangePart.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) return null;
      lo = parseInt(m[1], 10);
      hi = m[2] !== undefined ? parseInt(m[2], 10) : lo;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

export function parseCron(expr) {
  const fields = String(expr || "").trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets = [];
  for (let i = 0; i < 5; i++) {
    const s = parseField(fields[i], RANGES[i][0], RANGES[i][1]);
    if (!s) return null;
    sets.push(s);
  }
  return sets;
}

export function cronValid(expr) {
  return parseCron(expr) !== null;
}

// Smallest gap (in minutes) between two consecutive fires of a cron expression — used to enforce a
// minimum-interval floor (reject runaway crons like "* * * * *"). Scans minute-by-minute over an
// 8-day window that covers daily/weekly/day-of-month patterns; a schedule that fires fewer than
// twice in that window has an interval >= the window (returns Infinity → always above any floor).
export function minIntervalMinutes(expr) {
  if (!cronValid(expr)) return null;
  const start = new Date(2025, 0, 6, 0, 0, 0, 0); // Mon Jan 6 2025
  let prev = null;
  let min = Infinity;
  for (let i = 0; i <= 8 * 1440; i++) {
    const d = new Date(start.getTime() + i * 60_000);
    if (cronMatches(expr, d)) {
      if (prev !== null) min = Math.min(min, i - prev);
      prev = i;
    }
  }
  return min;
}

// Minute-boundary catch-up for the scheduler tick. setInterval drifts under load, so consecutive
// ticks can land at 08:59:58 and 09:01:02 — evaluating only "now" would skip the 09:00 minute
// entirely (and a "0 9 * * *" cron with it, for the whole day). Returns the start-of-minute
// timestamps (ms) that have elapsed since `prevMs`, oldest first, up to and including `nowMs`'s
// minute — never re-including `prevMs`'s own minute (already evaluated). Capped to the most
// recent `maxMinutes` so a long pause (laptop sleep, suspended VM) doesn't replay hours of stale
// crons. With no previous tick (prevMs falsy) only the current minute is returned.
export function elapsedMinutes(prevMs, nowMs, maxMinutes = 5) {
  const MIN = 60_000;
  const nowMin = Math.floor(nowMs / MIN) * MIN;
  if (!Number.isFinite(prevMs) || prevMs <= 0) return [nowMin];
  const prevMin = Math.floor(prevMs / MIN) * MIN;
  if (nowMin <= prevMin) return [];
  const from = Math.max(prevMin + MIN, nowMin - (Math.max(1, maxMinutes) - 1) * MIN);
  const out = [];
  for (let t = from; t <= nowMin; t += MIN) out.push(t);
  return out;
}

// Does `date` (local time) fall on the given cron expression's schedule (to the minute)?
export function cronMatches(expr, date) {
  const sets = parseCron(expr);
  if (!sets) return false;
  const [min, hour, dom, mon, dow] = sets;
  const d = date;
  const wday = d.getDay(); // 0=Sun
  if (!min.has(d.getMinutes())) return false;
  if (!hour.has(d.getHours())) return false;
  if (!mon.has(d.getMonth() + 1)) return false;

  // DOM/DOW OR-rule: if both are restricted (not "*"), match if EITHER matches.
  const domStar = expr.trim().split(/\s+/)[2] === "*";
  const dowStar = expr.trim().split(/\s+/)[4] === "*";
  const domOk = dom.has(d.getDate());
  const dowOk = dow.has(wday) || (wday === 0 && dow.has(7)); // allow 7 = Sunday
  if (domStar && dowStar) return true;
  if (domStar) return dowOk;
  if (dowStar) return domOk;
  return domOk || dowOk;
}

// The next instant `expr` fires at or after `from`, as a Date in the DAEMON's local time (the same
// clock `cronMatches` is evaluated against by the scheduler tick), or null when the expression is
// invalid or matches nothing inside the search window (e.g. "0 0 30 2 *" — February 30th).
//
// It exists so a reply can say WHEN a cron actually fires instead of leaving the reader to decode
// five fields: an agent that has to compute the next run itself computes it in the container's
// zone and gets it wrong (QA ART-002). Fields are parsed once and the scan skips whole days and
// hours that cannot match, so a yearly cron costs a few thousand steps rather than half a million.
export function nextCronRun(expr, from = new Date(), { maxDays = 400 } = {}) {
  const sets = parseCron(expr);
  if (!sets) return null;
  const fields = String(expr).trim().split(/\s+/);
  const domStar = fields[2] === "*";
  const dowStar = fields[4] === "*";
  const [minutes, hours, dom, mon, dow] = sets;
  const dayOk = (d) => {
    if (!mon.has(d.getMonth() + 1)) return false;
    const wday = d.getDay();
    const domOk = dom.has(d.getDate());
    const dowOk = dow.has(wday) || (wday === 0 && dow.has(7)); // allow 7 = Sunday
    if (domStar && dowStar) return true;
    if (domStar) return dowOk;
    if (dowStar) return domOk;
    return domOk || dowOk;
  };

  const start = new Date(from instanceof Date ? from.getTime() : Number(from));
  if (!Number.isFinite(start.getTime())) return null;
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1); // strictly after `from`'s minute
  const deadline = start.getTime() + maxDays * 24 * 60 * 60_000;
  let cursor = start;
  // A wall-clock jump (DST) can land on a time that is not later than the cursor; the guard caps
  // the walk so an unexpected zone can never spin here.
  for (let steps = 0; steps < maxDays * 24 * 60 && cursor.getTime() <= deadline; steps++) {
    if (!dayOk(cursor)) {
      const next = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1, 0, 0, 0, 0);
      cursor = next.getTime() > cursor.getTime() ? next : new Date(cursor.getTime() + 60_000);
      continue;
    }
    if (!hours.has(cursor.getHours())) {
      const next = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), cursor.getHours() + 1, 0, 0, 0);
      cursor = next.getTime() > cursor.getTime() ? next : new Date(cursor.getTime() + 60_000);
      continue;
    }
    if (!minutes.has(cursor.getMinutes())) {
      cursor = new Date(cursor.getTime() + 60_000);
      continue;
    }
    return cursor;
  }
  return null;
}
