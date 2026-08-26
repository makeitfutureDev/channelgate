// Gateway-wide access policy for Slack's channel /model wizard. Normal channel authorization is
// checked before this policy; this test covers the second gate only. DMs intentionally bypass it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { canChangeChannelRuntime, getModelChangeAccess, saveSettings, settingsForApi } = await import("../src/config/settings.js");

test("model changes default to org admins only", () => {
  assert.equal(getModelChangeAccess(), "admins");
  assert.equal(canChangeChannelRuntime(false), false);
  assert.equal(canChangeChannelRuntime(true), true);
  assert.equal(settingsForApi().modelChangeAccess, "admins");
});

test("users policy lets every already-authorized channel user change runtime", () => {
  saveSettings({ modelChangeAccess: "users" });
  assert.equal(getModelChangeAccess(), "users");
  assert.equal(canChangeChannelRuntime(false), true);
  assert.equal(canChangeChannelRuntime(true), true);
  assert.equal(settingsForApi().modelChangeAccess, "users");
});

test("unknown stored policies fail closed", () => {
  saveSettings({ modelChangeAccess: "everyone-on-the-internet" });
  assert.equal(getModelChangeAccess(), "admins");
  assert.equal(canChangeChannelRuntime(false), false);
});
