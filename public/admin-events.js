// How the `events` table reads in the Activity view. Pure presentation — no DOM, no fetch — so the
// wording of an audit row is unit-testable (test/admin-events-view.test.js) instead of only being
// visible by eye in a browser.
//
// The run table on Activity is the usage ledger; this is the trail of WHO CHANGED WHAT: channel
// policy changes, secret reveals (granted and refused), skill grants, platform connections.

// An unknown kind still renders: eventLabel falls back to the raw kind with its underscores opened
// up, so a newly added event is readable here the day it ships rather than invisible until someone
// remembers to extend this map.
export const EVENT_LABELS = Object.freeze({
  channel_meta_changed: "Channel settings changed",
  channel_env_set: "Channel secret set",
  channel_env_removed: "Channel secret removed",
  channels_access_reset: "All channel access reset",
  channels_nudges_reset: "All channel reminders reset",
  channels_runtime_reset: "All channel runtimes reset",
  secret_revealed: "Secret revealed",
  secret_reveal_denied: "Secret reveal refused (wrong password)",
  secret_reveal_rejected: "Secret reveal refused (not revealable)",
  skill_granted: "Skills granted",
  skill_revoked: "Skills revoked",
  skill_template_assigned: "Skill template assigned",
  gateway_update_started: "Gateway update started",
  platform_connect: "Platform connected",
  platform_disconnect: "Platform disconnected",
  unauthorized_message: "Unauthorized message",
  license_run_refused: "Run refused (license limit)",
});

// Own-property lookup, not truthiness: `EVENT_LABELS["constructor"]` inherits a FUNCTION from
// Object.prototype and would render as one. Same discipline as every other name→handler map here.
export const eventLabel = (kind) =>
  (Object.hasOwn(EVENT_LABELS, String(kind)) ? EVENT_LABELS[String(kind)] : "") || String(kind || "").replace(/_/g, " ");

// The kinds worth an operator's attention — what the feed opens on. Everything else (the
// run/schedule/background firehose) stays one click away behind "Show all events".
export const isAdminEvent = (e) => Object.hasOwn(EVENT_LABELS, String(e?.event || ""));

// Already shown in their own columns, or structural.
const SKIP_FIELDS = new Set(["ts", "event", "channel", "author", "slug", "actor", "keys", "changes"]);

export function eventValue(v) {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "(none)";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// The one-line "what happened" for a row. A channel policy change gets the real detail —
// `key: before → after` — because that IS the event; everything else falls back to its own fields.
export function describeEvent(e = {}) {
  if (e.event === "channel_meta_changed" && e.changes && typeof e.changes === "object") {
    return Object.entries(e.changes)
      .map(([k, c]) => (c && "truncated" in c ? `${k}: ${c.fromCount} → ${c.toCount} entries` : `${k}: ${eventValue(c?.from)} → ${eventValue(c?.to)}`))
      .join(" · ");
  }
  const bits = [];
  for (const [k, v] of Object.entries(e)) {
    if (SKIP_FIELDS.has(k)) continue;
    bits.push(`${k}: ${eventValue(v)}`);
  }
  return bits.join(" · ");
}
