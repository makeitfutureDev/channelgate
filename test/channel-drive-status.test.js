import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { saveSettings } = await import("../src/config/settings.js");
const { register } = await import("../src/mcp/tools/channel-admin.js");

function readStatus(engine, link = "") {
  const handlers = new Map();
  register({ registerTool(name, _schema, handler) { handlers.set(name, handler); } }, {
    channelId: "C_DRIVE_STATUS", slug: "drive-status", activeEngine: engine,
    text: value => value, loadMeta: async () => ({ syncDriveFolder: link }),
    daemon: { available: () => false },
  });
  return handlers.get("get_channel_drive_folder")();
}

test("unlinked Drive status reports global readiness without promising this channel will sync", async () => {
  saveSettings({ driveSyncEnabled: true, driveSyncKeyFile: "/fixture/service-account.json", driveSyncKeyJson: "" });
  for (const engine of ["claude", "codex"]) {
    const result = await readStatus(engine);
    assert.match(result, /No Google Drive folder is linked/);
    assert.match(result, /Drive sync is enabled and a service-account key is configured/);
    assert.match(result, /Link a folder to this channel to enable its sync/);
    assert.doesNotMatch(result, /will sync|next sweep/);
  }
});

test("linked Drive status retains scheduling and missing global prerequisites", async () => {
  const link = "https://drive.google.com/drive/folders/fixturefolder123";
  for (const engine of ["claude", "codex"]) {
    saveSettings({ driveSyncEnabled: true, driveSyncKeyFile: "/fixture/service-account.json", driveSyncKeyJson: "" });
    assert.match(await readStatus(engine, link), /this folder will sync on the next sweep/);
    saveSettings({ driveSyncEnabled: false, driveSyncKeyFile: "", driveSyncKeyJson: "" });
    const dormant = await readStatus(engine, link);
    assert.match(dormant, /global switch is OFF/);
    assert.match(dormant, /no service-account key is configured/);
    assert.doesNotMatch(dormant, /will sync|next sweep/);
    assert.match(await readStatus(engine), /Not syncing yet/);
  }
});
