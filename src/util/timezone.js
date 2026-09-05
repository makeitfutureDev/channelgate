// The gateway's own wall clock, named — the one place that answers "which zone does the daemon
// mean when it says 09:15?".
//
// Cron schedules are matched against the DAEMON's local time (`src/util/cron.js` reads
// `Date#getHours`), but a channel container runs on whatever zone its image was built with, which
// is `Etc/UTC`. Nothing used to carry the daemon's zone across that boundary, so an agent asked
// what `15 9 * * 1-5` means read its own clock and answered "09:15 UTC" for a schedule that fires
// 09:15 in Bucharest — a wrong answer, confidently stated. Both halves of the fix read this file:
// the container runtime exports `TZ` into every container and every exec (so `date` and both
// engines see the daemon's clock), and the schedule tools NAME the zone in their reply so the
// answer cannot be mislabelled even if a run's environment is ever missing it.
//
// `process.env.TZ` wins when set (it is what every Date in this process already obeys); otherwise
// the platform's resolved zone — the same value `Intl` hands the engines.

const UTC_ZONES = new Set(["UTC", "Etc/UTC", "Etc/GMT", "GMT", "Universal", "Zulu"]);

// The daemon's IANA zone, or "" when the platform has no zone data at all. A leading ":" is the
// POSIX spelling (`TZ=:Europe/Bucharest`) and is not part of the name.
export function daemonTimeZone(env = process.env) {
  const explicit = String(env?.TZ || "").trim().replace(/^:/, "");
  if (explicit) return explicit;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

export function isUtcZone(tz) {
  return UTC_ZONES.has(String(tz || "").trim());
}

// "2026-09-08 09:15" for an instant in `tz`, or "" when the zone is unusable (a hand-typed TZ that
// ICU rejects must degrade to a plain stamp, never throw inside a tool reply).
export function formatInZone(date, tz) {
  const ms = date instanceof Date ? date.getTime() : Number(date);
  if (!Number.isFinite(ms)) return "";
  const zone = String(tz || "").trim();
  if (!zone) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(ms));
    const g = (type) => parts.find((p) => p.type === type)?.value || "";
    const hour = g("hour") === "24" ? "00" : g("hour"); // some ICU builds render midnight as 24
    if (!g("year") || !hour) return "";
    return `${g("year")}-${g("month")}-${g("day")} ${hour}:${g("minute")}`;
  } catch {
    return "";
  }
}

// The stamp a user-facing reply should carry: local time, the zone NAME, and the UTC equivalent
// when they differ — "2026-09-08 09:15 Europe/Bucharest (06:15 UTC)". The UTC half is what makes
// the line checkable from a container (or another country); the date rides along with it whenever
// the two calendars disagree. On a UTC daemon the parenthetical would just repeat itself, so the
// stamp is simply "2026-09-08 09:15 UTC".
export function zonedStamp(date, { tz = daemonTimeZone() } = {}) {
  const ms = date instanceof Date ? date.getTime() : Number(date);
  if (!Number.isFinite(ms)) return "";
  const utc = formatInZone(ms, "UTC");
  const zone = String(tz || "").trim();
  if (!zone || isUtcZone(zone)) return utc ? `${utc} UTC` : "";
  const local = formatInZone(ms, zone);
  if (!local) return utc ? `${utc} UTC` : "";
  if (local === utc) return `${local} ${zone} (same as UTC)`;
  const sameDay = local.slice(0, 10) === utc.slice(0, 10);
  return `${local} ${zone} (${sameDay ? utc.slice(11) : utc} UTC)`;
}
