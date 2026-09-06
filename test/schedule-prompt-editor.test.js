import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { readFileSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { createAdminRouter } = await import("../src/web/routes/admin.js");
const { addSchedule, getSchedules } = await import("../src/config/schedules.js");
const { setUser, upsertChannelEntry } = await import("../src/config/store.js");

const app = express();
app.use(express.json());
app.use(createAdminRouter());
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

function schedule(id) {
  return getSchedules().find((item) => item.id === id);
}

test("schedule prompt updates preserve the exact text and unrelated fields", async () => {
  const created = addSchedule({
    channelId: "C_PROMPT_EDITOR",
    slug: "prompt-editor",
    cron: "0 9 * * 1-5",
    prompt: "Original prompt",
    description: "Weekday report",
    createdBy: "U_ADMIN",
    notify: "user",
    notifyUserId: "U_RECIPIENT",
  });
  const nextPrompt = "Read the full backlog.\n\nPost only genuinely blocked items.";

  const response = await fetch(`${base}/schedules/${created.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: nextPrompt }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.schedule.prompt, nextPrompt);
  assert.deepEqual(
    {
      cron: body.schedule.cron,
      description: body.schedule.description,
      notify: body.schedule.notify,
      notifyUserId: body.schedule.notifyUserId,
      enabled: body.schedule.enabled,
    },
    {
      cron: created.cron,
      description: created.description,
      notify: created.notify,
      notifyUserId: created.notifyUserId,
      enabled: created.enabled,
    },
  );
  assert.equal(schedule(created.id).prompt, nextPrompt);
});

test("schedule prompt updates reject blank text without mutating the record", async () => {
  const created = addSchedule({
    channelId: "C_PROMPT_BLANK",
    slug: "prompt-blank",
    cron: "0 10 * * *",
    prompt: "Keep this prompt",
    description: "Daily report",
    createdBy: "U_ADMIN",
    notify: "none",
  });

  const response = await fetch(`${base}/schedules/${created.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "  \n\t  " }),
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.match(body.error, /prompt.*empty/i);
  assert.equal(schedule(created.id).prompt, "Keep this prompt");
});

test("schedule delivery can opt into daily threads and resets a stale anchor", async () => {
  const created = addSchedule({
    channelId: "C_DELIVERY_EDITOR", slug: "delivery-editor", cron: "0 * * * *",
    prompt: "Monitor the queue", createdBy: "U_ADMIN", notify: "none",
  });
  const response = await fetch(`${base}/schedules/${created.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ delivery: "daily-thread" }),
  });
  assert.equal(response.status, 200);
  const stored = schedule(created.id);
  assert.equal(stored.delivery, "daily-thread");
  assert.equal(stored.dailyThreadDate, "");
  assert.equal(stored.dailyThreadTs, "");
});

test("schedule prompt updates return 404 for an unknown schedule", async () => {
  const response = await fetch(`${base}/schedules/not-found`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "A valid replacement prompt" }),
  });

  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /unknown schedule/i);
});

test("one automation update atomically edits timing, title, notification, delivery, state, and prompt", async () => {
  const created = addSchedule({ channelId: "C_FULL_EDITOR", slug: "full-editor", cron: "0 9 * * *", prompt: "Old", description: "Old title", createdBy: "U_ADMIN", notify: "none" });
  const response = await fetch(`${base}/schedules/${created.id}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ cron: "30 14 * * 1-5", prompt: "New prompt", description: "New title", notify: "user", notifyUserId: "<@U_PERSON>", delivery: "channel", enabled: false }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    Object.fromEntries(["cron", "prompt", "description", "notify", "notifyUserId", "delivery", "enabled"].map((key) => [key, schedule(created.id)[key]])),
    { cron: "30 14 * * 1-5", prompt: "New prompt", description: "New title", notify: "user", notifyUserId: "U_PERSON", delivery: "channel", enabled: false },
  );
});

test("an invalid full edit is rejected without partially mutating the schedule", async () => {
  const created = addSchedule({ channelId: "C_ATOMIC_EDITOR", slug: "atomic-editor", cron: "0 9 * * *", prompt: "Keep", description: "Keep title", createdBy: "U_ADMIN", notify: "none" });
  const response = await fetch(`${base}/schedules/${created.id}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ cron: "not cron", description: "Must not save", prompt: "Must not save" }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual({ cron: schedule(created.id).cron, description: schedule(created.id).description, prompt: schedule(created.id).prompt }, { cron: "0 9 * * *", description: "Keep title", prompt: "Keep" });
});

test("automation listings resolve a DM slug to the person's display name", async () => {
  await setUser("UDMPERSON", { name: "Ada Lovelace", approved: true });
  await upsertChannelEntry("DDMPERSON", { name: "dm-UDMPERSON", type: "im", isDM: true });
  addSchedule({ channelId: "DDMPERSON", slug: "dm-UDMPERSON", cron: "0 8 * * *", prompt: "Brief me", description: "Daily briefing", createdBy: "UDMPERSON", notify: "none" });
  const response = await fetch(`${base}/schedules`);
  const body = await response.json();
  assert.equal(body.schedules.find((item) => item.channelId === "DDMPERSON").channelName, "DM · Ada Lovelace");
});

test("the Automations page provides a dedicated accessible prompt editor modal", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

  assert.match(html, /id="schedule-modal" class="modal" hidden/);
  assert.match(html, /class="modal-card schedule-card"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /id="schedule-modal-title"/);
  assert.match(html, /id="schedule-modal-close"[^>]*aria-label="Close"/);
  assert.match(html, /id="schedule-modal-details"/);
  assert.match(html, /id="schedule-search"/);
  assert.match(html, /id="schedule-frequency"/);
  assert.match(html, /id="schedule-modal-description"/);
  assert.match(html, /id="schedule-modal-notify"/);
  assert.match(html, /id="schedule-modal-delivery"/);
  assert.match(html, /textarea id="schedule-modal-prompt"/);
  assert.match(html, /id="schedule-modal-error"[^>]*role="alert"/);
  assert.match(html, /id="schedule-modal-cancel"/);
  assert.match(html, /id="schedule-modal-save"/);
});

test("automation row activation and modal saves preserve control isolation and prompt drafts", () => {
  const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(client, /function openScheduleEditor\(schedule\)/);
  assert.match(client, /schedule-modal-prompt[\s\S]*?\.value = schedule\.prompt \|\| ""/);
  assert.match(client, /<button type="button" class="sched-open"/);
  assert.match(client, /querySelector\("\.sched-open"\)\.addEventListener\("click", \(\) => openScheduleEditor\(s\)\)/);
  assert.match(client, /row\.addEventListener\("click", \(e\) => \{[\s\S]*?closest\("input, select, button, label"\)[\s\S]*?openScheduleEditor\(s\)/);
  assert.match(client, /function friendlySchedule\(schedule\)/);
  assert.match(client, /function cronFromScheduleEditor\(\)/);
  assert.match(client, /schedule-search[\s\S]*?addEventListener\("input", renderSchedules\)/);
  assert.match(client, /body: JSON\.stringify\(body\)/);
  assert.match(client, /Object\.assign\(scheduleEditor\.schedule, result\.schedule\)/);
  assert.match(client, /catch \(error\) \{[\s\S]*?schedule-modal-error[\s\S]*?error\.message/);
  assert.match(client, /if \(e\.target === scheduleModal\) closeScheduleEditor\(\)/);
  assert.match(client, /e\.key === "Escape"[\s\S]*?closeScheduleEditor\(\)/);
});

test("automation prompt editing has visible row, modal, saving, and error states", () => {
  const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(css, /\.sched-open\s*\{[\s\S]*?cursor:\s*pointer/);
  assert.match(css, /\.sched-open:hover[\s\S]*?\.sched-open:focus-visible/);
  assert.match(css, /\.schedule-card\s*\{/);
  assert.match(css, /\.schedule-details\s*\{/);
  assert.match(css, /\.schedule-prompt-field textarea\s*\{[\s\S]*?resize:\s*vertical/);
  assert.match(css, /\.schedule-modal-error\s*\{/);
  assert.match(css, /#schedule-modal-save:disabled\s*\{/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.sched-row[\s\S]*?\.schedule-card/);
});
