// The Settings page saves a DIFF, and the server merges it under a version check.
//
// The bug this pins: the single "Save changes" button used to re-submit the WHOLE form from the
// snapshot the page loaded with, so any value written afterwards — by another admin, by the skills
// sync, by a license or first-boot password write — was silently reverted by an unrelated save
// minutes later (observed live: a restored channelTemplate.effort reverted by a save of
// scheduleMaxPerChannel). Two halves fix it: the client sends only what it changed, and the server
// refuses a save whose echoed version is no longer the stored one.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const settings = await import("../src/config/settings.js");
const { createAdminRouter } = await import("../src/web/routes/admin.js");

const slackStub = {
  snapshot: () => ({ status: "disconnected", connected: false }),
  connect: async () => ({ status: "disconnected", connected: false }),
};
const app = express();
app.use(express.json());
app.use(createAdminRouter({ slack: slackStub }));
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const getSettings = async () => {
  const response = await fetch(`${base}/settings`);
  assert.equal(response.status, 200);
  return response.json();
};
const putSettings = async (body) => {
  const response = await fetch(`${base}/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectSlack: false, ...body }),
  });
  return { status: response.status, body: await response.json() };
};

// ── The version stamp ────────────────────────────────────────────────────────────
test("every write moves the version the API hands out", () => {
  const before = settings.getSettingsVersion();
  settings.saveSettings({ sessionKeepalive: "12m" });
  const after1 = settings.getSettingsVersion();
  assert.notEqual(after1, before);
  assert.ok(Number(after1) > Number(before), "the version is monotonic");
  assert.equal(settings.settingsForApi().settingsVersion, after1);
  settings.saveSettings({ sessionKeepalive: "13m" });
  assert.ok(Number(settings.getSettingsVersion()) > Number(after1));
});

test("saveSettings refuses a stale expectVersion and writes nothing", () => {
  settings.saveSettings({ noResponseReminderHours: 7 });
  const stale = String(Number(settings.getSettingsVersion()) - 1);
  assert.throws(
    () => settings.saveSettings({ noResponseReminderHours: 9 }, { expectVersion: stale }),
    (error) => error.code === "settings_version_conflict",
  );
  assert.equal(settings.getSettings().noResponseReminderHours, 7);
  // The current version still round-trips, so a caller that re-reads can save immediately.
  settings.saveSettings({ noResponseReminderHours: 9 }, { expectVersion: settings.getSettingsVersion() });
  assert.equal(settings.getSettings().noResponseReminderHours, 9);
});

// ── The route ────────────────────────────────────────────────────────────────────
test("a partial save leaves every key it does not carry intact", async () => {
  settings.saveSettings({
    channelTemplate: { engine: "claude", effort: "high", mode: "auto" },
    scheduleMaxPerChannel: 20,
    memoryReviewModel: "haiku",
  });

  const loaded = await getSettings();
  const saved = await putSettings({ scheduleMaxPerChannel: 44, settingsVersion: loaded.settingsVersion });

  assert.equal(saved.status, 200);
  assert.equal(settings.getSettings().scheduleMaxPerChannel, 44);
  // The fields the admin never touched are untouched — this is the lost update, gone.
  assert.equal(settings.getChannelTemplate().effort, "high");
  assert.equal(settings.getSettings().memoryReviewModel, "haiku");
  assert.equal(saved.body.settingsVersion, settings.getSettingsVersion());
  assert.notEqual(saved.body.settingsVersion, loaded.settingsVersion);
});

test("a stale version is refused with 409, the current settings, and no write", async () => {
  settings.saveSettings({ channelTemplate: { engine: "claude", effort: "high", mode: "auto" }, contextWindow: 200000 });
  const loaded = await getSettings();
  // Somebody else writes while this page sits open.
  settings.saveSettings({ channelTemplate: { engine: "claude", effort: "low", mode: "auto" } });

  const refused = await putSettings({ contextWindow: 111111, settingsVersion: loaded.settingsVersion });

  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "settings_version_conflict");
  assert.match(refused.body.error, /changed elsewhere/i);
  assert.equal(settings.getSettings().contextWindow, 200000, "a refused save writes nothing at all");
  // The refusal carries the same representation a GET would, so the page can repaint from it.
  assert.equal(refused.body.settingsVersion, settings.getSettingsVersion());
  assert.equal(refused.body.channelTemplate.effort, "low");
  assert.ok(Array.isArray(refused.body.engines));
  assert.ok(Array.isArray(refused.body.platforms));
  assert.ok(refused.body.slack);
});

test("two admins changing different fields both survive", async () => {
  settings.saveSettings({ scheduleMaxPerChannel: 20, noResponseReminderHours: 24 });
  const first = await getSettings();

  const a = await putSettings({ scheduleMaxPerChannel: 33, settingsVersion: first.settingsVersion });
  assert.equal(a.status, 200);

  // The second admin loaded the same page as the first, so their save is refused rather than
  // silently reverting scheduleMaxPerChannel back to 20.
  const stale = await putSettings({ noResponseReminderHours: 6, settingsVersion: first.settingsVersion });
  assert.equal(stale.status, 409);

  // Re-reading (which is what the page does with the 409's payload) lets it land, keeping both.
  const b = await putSettings({ noResponseReminderHours: 6, settingsVersion: stale.body.settingsVersion });
  assert.equal(b.status, 200);
  assert.equal(settings.getSettings().scheduleMaxPerChannel, 33);
  assert.equal(settings.getSettings().noResponseReminderHours, 6);
});

test("a caller that sends no version is merged in, exactly as before", async () => {
  settings.saveSettings({ scheduleMaxPerChannel: 20, memoryReviewModel: "haiku" });
  // An older UI or a script POSTing the whole object it knows about, with no version at all.
  const saved = await putSettings({ scheduleMaxPerChannel: 21 });
  assert.equal(saved.status, 200);
  assert.equal(settings.getSettings().scheduleMaxPerChannel, 21);
  assert.equal(settings.getSettings().memoryReviewModel, "haiku");
});

test("a save's own version echo cannot be frozen by the patch", async () => {
  const loaded = await getSettings();
  // settingsRev is not a settable field: the route never copies it into the patch, and saveSettings
  // bumps it after applying one.
  const saved = await putSettings({ settingsRev: 1, sessionKeepalive: "14m", settingsVersion: loaded.settingsVersion });
  assert.equal(saved.status, 200);
  assert.ok(Number(settings.getSettingsVersion()) > Number(loaded.settingsVersion));
});

// ── The client contract ──────────────────────────────────────────────────────────
test("the Settings page sends a diff against what it was painted from", () => {
  const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const paint = client.slice(client.indexOf("function paintSettings(s) {"), client.indexOf("async function loadSettings()"));
  const save = client.slice(
    client.indexOf('document.getElementById("save-settings")'),
    client.indexOf('document.getElementById("reconnect-slack")'),
  );

  // The form reader is shared: the baseline and the save must read the SAME fields, or the diff
  // would compare two different shapes and re-assert whatever only one of them knows about.
  assert.match(client, /function readSettingsForm\(\) \{/);
  assert.match(paint, /SETTINGS_BASELINE = readSettingsForm\(\)/);
  assert.match(paint, /SETTINGS_VERSION = s\?\.settingsVersion/);
  assert.match(save, /const patch = diffSettingsPayload\(SETTINGS_BASELINE \|\| \{\}, form\)/);
  assert.match(save, /\.\.\.patch,/);
  assert.match(save, /settingsVersion: SETTINGS_VERSION/);
  // A refused save repaints from the refusal's payload instead of leaving stale values on screen.
  assert.match(save, /e\.status === 409/);
  assert.match(save, /paintSettings\(e\.body\)/);
  assert.match(save, /changedSettingKeys\(SETTINGS_SNAPSHOT/);
  // Nothing pending may survive a repaint, or the baseline would swallow it.
  assert.match(paint, /clear-tok\.armed/);
});


test("Testing with AI defaults closed and validates, deduplicates, persists and clears Slack users", async () => {
  assert.deepEqual(settings.getAiTestingUsers(), []);
  assert.deepEqual((await getSettings()).aiTestingUsers, []);
  const saved = await putSettings({ aiTestingUsers: [" UTEST123 ", "UTEST123", "WTEST456"] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.aiTestingUsers, ["UTEST123", "WTEST456"]);
  assert.deepEqual((await getSettings()).aiTestingUsers, ["UTEST123", "WTEST456"]);
  for (const value of ["UTEST123", null, [42], ["*"], ["CTEST123"], [""], ["UTEST123", {}]]) {
    assert.equal((await putSettings({ aiTestingUsers: value })).status, 400);
    assert.deepEqual(settings.getAiTestingUsers(), ["UTEST123", "WTEST456"]);
  }
  assert.equal((await putSettings({ aiTestingUsers: [] })).status, 200);
  assert.deepEqual((await getSettings()).aiTestingUsers, []);
  settings.saveSettings({ aiTestingUsers: "UTEST123" });
  assert.deepEqual(settings.getAiTestingUsers(), [], "malformed hand-edited settings fail closed");
  settings.saveSettings({ aiTestingUsers: [null, "*", "UTEST123", "UTEST123"] });
  assert.deepEqual(settings.getAiTestingUsers(), ["UTEST123"]);
  settings.saveSettings({ aiTestingUsers: [] });
});
