// Schedule times carry their ZONE (QA ART-002). The daemon matches crons against its own local
// clock while a channel container runs on Etc/UTC, so a reply that states a bare "09:15" is read
// back by the agent as 09:15 UTC — live, a `15 9 * * 1-5` cron was reported to the channel as
// "9:15 UTC" for a schedule that fires 09:15 in Bucharest. These cover both halves of the fix: the
// zone helpers, the cron "next run" resolution, and the tool replies that carry them.
import test from "node:test";
import assert from "node:assert/strict";

// Set BEFORE anything reads a clock: Node re-resolves the process zone when TZ changes, and every
// assertion below is about a daemon that is deliberately NOT on UTC.
process.env.TZ = "Europe/Bucharest";

import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { daemonTimeZone, formatInZone, isUtcZone, zonedStamp } = await import("../src/util/timezone.js");
const { nextCronRun } = await import("../src/util/cron.js");
const { register, zoneHint } = await import("../src/mcp/tools/schedules.js");
const { deleteSchedule } = await import("../src/config/schedules.js");

// The tool registry, reduced to what these tools use: a handler collector and a text responder.
function registerTools({ channelId = "C_TZ", slug = "tz-test", createdBy = "U_TZ" } = {}) {
  const tools = new Map();
  const server = { registerTool: (name, spec, handler) => tools.set(name, handler) };
  register(server, { channelId, slug, createdBy, text: (s) => ({ content: [{ type: "text", text: s }] }) });
  return async (name, args = {}) => (await tools.get(name)(args)).content[0].text;
}

test("daemonTimeZone prefers an explicit TZ and tolerates the POSIX colon spelling", () => {
  assert.equal(daemonTimeZone({ TZ: "America/New_York" }), "America/New_York");
  assert.equal(daemonTimeZone({ TZ: ":Europe/Bucharest" }), "Europe/Bucharest");
  assert.equal(daemonTimeZone({ TZ: "  " }), Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(daemonTimeZone({}), Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.ok(isUtcZone("Etc/UTC") && isUtcZone("UTC") && !isUtcZone("Europe/Bucharest"));
});

test("zonedStamp names the zone and gives the UTC equivalent", () => {
  const when = new Date("2026-09-08T06:15:00Z"); // 09:15 in Bucharest (EEST, +3)
  assert.equal(formatInZone(when, "Europe/Bucharest"), "2026-09-08 09:15");
  assert.equal(zonedStamp(when, { tz: "Europe/Bucharest" }), "2026-09-08 09:15 Europe/Bucharest (06:15 UTC)");
  // A different calendar day on the two clocks keeps the full UTC date, so nothing is ambiguous.
  assert.equal(
    zonedStamp(new Date("2026-09-07T23:15:00Z"), { tz: "Europe/Bucharest" }),
    "2026-09-08 02:15 Europe/Bucharest (2026-09-07 23:15 UTC)",
  );
  // A UTC daemon would only repeat itself, and an unusable zone must degrade, never throw.
  assert.equal(zonedStamp(when, { tz: "Etc/UTC" }), "2026-09-08 06:15 UTC");
  assert.equal(zonedStamp(when, { tz: "Not/AZone" }), "2026-09-08 06:15 UTC");
  assert.equal(zonedStamp(new Date("nonsense"), { tz: "Europe/Bucharest" }), "");
});

test("nextCronRun resolves the next fire in the daemon's local time", () => {
  const sunday = new Date(2026, 8, 6, 12, 0, 0); // Sun 2026-09-06 12:00 local
  const weekday = nextCronRun("15 9 * * 1-5", sunday);
  assert.equal(formatInZone(weekday, "Europe/Bucharest"), "2026-09-07 09:15");
  // Strictly after `from`, never "now" again.
  assert.equal(formatInZone(nextCronRun("0 * * * *", new Date(2026, 8, 6, 12, 0, 0)), "Europe/Bucharest"), "2026-09-06 13:00");
  // A far-future match still resolves; an impossible one gives null instead of spinning.
  assert.equal(formatInZone(nextCronRun("0 0 1 1 *", sunday), "Europe/Bucharest"), "2027-01-01 00:00");
  assert.equal(nextCronRun("0 0 30 2 *", sunday), null);
  assert.equal(nextCronRun("not a cron", sunday), null);
});

test("create_schedule states the zone for a recurring cron, with the next fire time", async () => {
  const call = await registerTools();
  const reply = await call("create_schedule", { cron: "15 9 * * 1-5", prompt: "Post the QA digest", notify: "none" });
  assert.match(reply, /next run \d{4}-\d{2}-\d{2} \d{2}:\d{2} Europe\/Bucharest \(.*UTC\)/, reply);
  assert.match(reply, /Times are the gateway's local zone, Europe\/Bucharest/, reply);
  assert.match(reply, /09:15 Europe\/Bucharest/, reply);
  const id = reply.match(/id (\S+?)\)/)[1];
  deleteSchedule(id, "C_TZ");
});

test("a one-time schedule reply is stamped with the zone too", async () => {
  const call = await registerTools();
  const reply = await call("create_schedule", { in_minutes: 120, kind: "reminder", prompt: "Call the client", notify: "none" });
  assert.match(reply, /for \d{4}-\d{2}-\d{2} \d{2}:\d{2} Europe\/Bucharest \(.*UTC\)/, reply);
  assert.doesNotMatch(reply, /\bAM\b|\bPM\b/, "a locale-formatted stamp is what got mislabelled — keep it ISO-ish");
  const id = reply.match(/id (\S+?)\)/)[1];
  deleteSchedule(id, "C_TZ");
});

test("list_schedules repeats the zone so a listing cannot be relabelled either", async () => {
  const call = await registerTools();
  const created = await call("create_schedule", { cron: "0 9 * * *", prompt: "Daily digest", notify: "none" });
  const id = created.match(/id (\S+?)\)/)[1];
  const listed = await call("list_schedules", {});
  assert.match(listed, /Europe\/Bucharest/, listed);
  deleteSchedule(id, "C_TZ");
});

test("zoneHint is silent on a UTC daemon (the sentence would say nothing)", () => {
  const real = process.env.TZ;
  try {
    process.env.TZ = "Etc/UTC";
    assert.equal(zoneHint(), "");
  } finally {
    process.env.TZ = real;
  }
  assert.match(zoneHint(), /Europe\/Bucharest/);
});
