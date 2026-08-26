// Minimal structured logger: writes one row per event to the `events` table (see ../db) and
// mirrors a short line to the console. channel/author/slug are pulled into their own columns so
// the audit/dashboard views can filter and roll up; everything else lives in a JSON blob. Never
// logs secrets (callers pass only ids, counts, costs — never tokens). Best-effort: a logging
// failure must never break a run.
import { getDb } from "../db/index.js";
import { countDrop } from "./drops.js";

export async function logEvent(event, fields = {}) {
  const ts = new Date().toISOString();
  try {
    const { channel = "", author = "", slug = "", ...rest } = fields;
    getDb()
      .prepare("INSERT INTO events(ts, event, channel, author, slug, data) VALUES(?, ?, ?, ?, ?, ?)")
      .run(ts, event, channel || "", author || "", slug || "", Object.keys(rest).length ? JSON.stringify(rest) : null);
  } catch (err) {
    countDrop("events", err); // logging must never break a run, but drops should be visible
  }
  const brief = Object.entries(fields)
    .filter(([k]) => ["channel", "author", "slug", "costUSD", "durationMs", "error"].includes(k))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(`[run] ${event} ${brief}`);
}

// Recent events, newest-first, flattened back to the { ts, event, ...fields } shape the Audit feed
// expects. Powers GET /api/audit/events.
export function readEvents({ limit = 200 } = {}) {
  try {
    const rows = getDb()
      .prepare("SELECT ts, event, channel, author, slug, data FROM events ORDER BY id DESC LIMIT ?")
      .all(Math.max(0, Number(limit) || 0));
    return rows.map((r) => {
      let extra = {};
      if (r.data) {
        try {
          extra = JSON.parse(r.data);
        } catch {
          extra = {};
        }
      }
      const out = { ts: r.ts, event: r.event, ...extra };
      if (r.channel) out.channel = r.channel;
      if (r.author) out.author = r.author;
      if (r.slug) out.slug = r.slug;
      return out;
    });
  } catch {
    return [];
  }
}
