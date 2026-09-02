import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const settings = await import("../src/config/settings.js");
const { createAdminRouter } = await import("../src/web/routes/admin.js");
const { setUser, getUser, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");

test("Composio mode defaults to personal", () => {
  assert.equal(settings.getComposioMode(), "personal");
});

test("switching Composio modes preserves organization credentials", () => {
  settings.saveSettings({
    defaultComposioToken: "legacy-org-token",
    composioSdkApiKey: "sdk-secret",
    composioMode: "sdk",
  });
  settings.saveSettings({ composioMode: "personal" });

  assert.equal(settings.getDefaultComposioToken(), "legacy-org-token");
  assert.equal(settings.getComposioSdkApiKey(), "sdk-secret");
  assert.equal(settings.getComposioMode(), "personal");
});

test("settings API masks the Composio SDK key", () => {
  settings.saveSettings({ composioSdkApiKey: "sdk-secret" });
  const api = settings.settingsForApi();

  assert.equal(api.hasComposioSdkApiKey, true);
  assert.equal(api.composioSdkApiKeyLast4, "cret");
  assert.equal("composioSdkApiKey" in api, false);
});

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

test("saving only Composio mode through the admin route preserves every credential scope", async () => {
  settings.saveSettings({
    defaultComposioToken: "legacy-org-token",
    composioSdkApiKey: "sdk-secret",
    composioMode: "personal",
  });
  await setUser("U_TEST", { name: "Test User", composioToken: "legacy-user-token" });
  await saveChannelMeta("sdk-test", { channelId: "C_TEST", composioToken: "legacy-channel-token" });

  const response = await fetch(`${base}/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ composioMode: "sdk", connectSlack: false }),
  });

  assert.equal(response.status, 200);
  assert.equal(settings.getComposioMode(), "sdk");
  assert.equal(settings.getDefaultComposioToken(), "legacy-org-token");
  assert.equal(settings.getComposioSdkApiKey(), "sdk-secret");
  assert.equal((await getUser("U_TEST")).composioToken, "legacy-user-token");
  assert.equal((await getChannelMeta("sdk-test")).composioToken, "legacy-channel-token");
});
