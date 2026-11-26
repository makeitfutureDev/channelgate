import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { upsertChannelEntry, patchChannelMeta } = await import("../src/config/store.js");
const { addSchedule, listForChannel } = await import("../src/config/schedules.js");
const { createScheduleRun, updateScheduleRun } = await import("../src/gateway/schedule-runs.js");
const view = await import("../src/gateway/automations-view.js");
const { activityPage } = await import("../src/web/activity-page.js");

test("cron recurrences read as words, never as the expression", () => {
  const tz = { tz: "Europe/Bucharest" };
  assert.equal(view.cronToWords("0 9 * * 1-5", tz), "At 09:00 on weekdays (Europe/Bucharest)");
  assert.equal(view.cronToWords("*/15 * * * *", tz), "Every 15 minutes");
  assert.equal(view.cronToWords("30 8 1 * *", tz), "At 08:30 on the 1st of the month (Europe/Bucharest)");
  assert.equal(view.cronToWords("0 */2 * * *", tz), "Every 2 hours");
  assert.equal(view.cronToWords("0 10 * * 0,6", { tz: "UTC" }), "At 10:00 on weekends (UTC)");
  for (const odd of ["7,23,41 3-9 * * *", "bogus", ""]) {
    const words = view.cronToWords(odd, tz);
    assert.equal(words, "On a custom schedule");
  }
  assert.equal(view.recurrenceWords({ intervalDays: 3 }), "Every 3 days");
  assert.equal(view.recurrenceWords({ loop: true }), "Repeats in its thread until the loop finishes");
});

test("automations are listed per allowed conversation, the viewer's own DM first, with delete rights", async () => {
  getDb().exec("DELETE FROM schedules; DELETE FROM schedule_runs");
  const ch = await upsertChannelEntry("CAUTO1", { name: "#team", type: "channel" });
  await upsertChannelEntry("CAUTO3", { name: "empty", type: "channel" });
  const dm = await upsertChannelEntry("DAUTO1", { name: "dm", type: "im", isDM: true });
  const other = await upsertChannelEntry("DAUTO2", { name: "dm2", type: "im", isDM: true });
  await patchChannelMeta(dm.slug, { dmUserId: "U1" });
  await patchChannelMeta(other.slug, { dmUserId: "U2" });
  const mine = addSchedule({ channelId: "CAUTO1", slug: ch.slug, cron: "0 9 * * 1-5", prompt: "p", description: "Mine", createdBy: "U1" });
  const theirs = addSchedule({ channelId: "CAUTO1", slug: ch.slug, cron: "0 9 * * *", prompt: "p", description: "Theirs", createdBy: "U9" });
  addSchedule({ channelId: "CAUTO1", slug: ch.slug, cron: "0 9 * * *", prompt: "p", description: "Sudo", createdBy: "U9", sudo: true });
  addSchedule({ channelId: "DAUTO1", slug: dm.slug, cron: "0 7 * * *", prompt: "p", description: "Personal", createdBy: "U1" });
  const run = createScheduleRun(listForChannel("CAUTO1")[0]);
  updateScheduleRun(run.id, { status: "succeeded", summary: "done" });

  const access = { user: { isAdmin: false }, allows: async (e) => ["CAUTO1", "CAUTO3", "DAUTO1", "DAUTO2"].includes(e.channelId) };
  const channels = await view.automationChannels(access, "U1");
  // Another person's DM is never listed; a conversation without automations is not listed either.
  assert.deepEqual(channels.map((c) => c.channelId), ["DAUTO1", "CAUTO1"]);
  assert.equal(channels[1].name, "#team"); // one #, even when the stored name carries its own
  assert.equal(channels[0].personal, true);
  await assert.rejects(view.checkedChannel(access, "U1", "DAUTO2"), { status: 403 });
  await assert.rejects(view.checkedChannel({ ...access, allows: async () => false }, "U1", "CAUTO1"), { status: 403 });

  const entry = await view.checkedChannel(access, "U1", "CAUTO1");
  const rows = view.channelAutomations(access, "U1", entry);
  assert.deepEqual(rows.map((r) => r.title), ["Mine", "Theirs"]); // sudo hidden from non-admins
  assert.equal(rows[0].recurrence.startsWith("At 09:00 on weekdays"), true);
  assert.ok(!JSON.stringify(rows).includes("* *"));
  assert.deepEqual(rows.map((r) => r.canDelete), [true, false]);
  assert.equal(view.automationRuns(access, entry, mine.id)[0].summary, "done");
  assert.throws(() => view.deleteAutomation(access, "U1", entry, theirs.id), { status: 403 });
  assert.equal(view.deleteAutomation(access, "U1", entry, mine.id), true);
  assert.equal(view.automationRuns(access, entry, mine.id).length, 1); // history survives deletion
});

test("the dashboard renders an Automations tab and page", () => {
  const page = activityPage({ sessionId: "s", csrf: "c", view: "automations" });
  assert.match(page.html, /<title>Automations · ChannelGate/);
  assert.match(page.html, /id="ab-root"/);
  assert.match(page.html, /automationBoardBrowser|function automationBoardBrowser/);
  assert.match(page.html, /\/automations" aria-current="page">Automations</);
  assert.match(activityPage({ sessionId: "s", csrf: "c" }).html, />Automations<\/a>/);
});

test("dashboard layout: wide pages, Skills under Settings, automations health board, subscriptions by harness", async () => {
  const { activityPage } = await import("../src/web/activity-page.js");
  const { createSubscriptionUi } = await import("../public/subscription-ui.js");
  const skills = activityPage({ sessionId: "s", csrf: "c", view: "skills" }).html;
  assert.match(skills, /class="settings-tab" href="\/activity\/s\/skills" aria-current="page">Skills/);
  assert.doesNotMatch(skills, /<a href="\/activity\/s\/skills"/);
  assert.match(activityPage({ sessionId: "s", csrf: "c", view: "calls" }).html, /\.calls-page\{max-width:1800px/);
  assert.match(skills, /\.settings-page\{width:100%;max-width:1800px/);
  const automations = activityPage({ sessionId: "s", csrf: "c", view: "automations" }).html;
  assert.match(automations, /\.ab-page\{width:100%;min-width:0;max-width:1480px/);
  const html = createSubscriptionUi().grouped([{ name: "A", harness: "claude" }, { name: "B", harness: "codex" }, { name: "C", harness: "claude" }]);
  assert.deepEqual([...html.matchAll(/subscription-group-title">([^<]+)/g)].map((m) => m[1].trim()), ["Claude Code", "Codex"]);
});
