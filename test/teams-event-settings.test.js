import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const settings = await import("../src/config/settings.js");
const { createAdminRouter } = await import("../src/web/routes/admin.js");

const app = express();
app.use(express.json());
app.use(createAdminRouter({ slack: { snapshot: () => ({ connected: false }) } }));
const server = await new Promise(resolve => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

async function patch(body) {
  const response = await fetch(`${base}/settings`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("Teams all-message observation is opt-in and never exposes its credential", async () => {
  assert.equal(settings.resolveTeamsConfig().allMessageEvents, false);
  assert.equal(settings.settingsForApi().teams.allMessageEvents, false);
  settings.saveSettings({ teamsAppPassword: "fixture-teams-private-value" });
  await patch({ teamsAllMessageEvents: true, publicUrl: "events.example.test/" });
  assert.equal(settings.resolveTeamsConfig().allMessageEvents, true);
  assert.equal(settings.resolveTeamsConfig().publicUrl, "https://events.example.test");
  const masked = settings.settingsForApi().teams;
  assert.equal(masked.allMessageEvents, true);
  assert.equal(masked.hasAppPassword, true);
  assert.equal(JSON.stringify(masked).includes("fixture-teams-private-value"), false);
  await patch({ teamsAllMessageEvents: false });
  assert.equal(settings.resolveTeamsConfig().allMessageEvents, false);
  assert.equal(settings.resolveTeamsConfig().appPassword, "fixture-teams-private-value");
});

test("nonboolean settings payloads cannot enable all-message observation", async () => {
  await patch({ teamsAllMessageEvents: false });
  for (const value of ["true", 1, {}, null]) {
    await patch({ teamsAllMessageEvents: value });
    assert.equal(settings.resolveTeamsConfig().allMessageEvents, false);
  }
  settings.saveSettings({ teamsAllMessageEvents: "true" });
  assert.equal(settings.resolveTeamsConfig().allMessageEvents, false);
});
