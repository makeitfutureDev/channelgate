import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { createChannelsRouter } = await import("../src/web/routes/channels.js");
const { saveSettings } = await import("../src/config/settings.js");
const { upsertChannelEntry, saveChannelMeta, defaultChannelMeta } = await import("../src/config/store.js");
const { authMiddleware, noPasswordLockdown, handleLogin } = await import("../src/web/auth.js");
saveSettings({ adminPassword: "codex-login-web-test" });
const id = "C_CODEX_LOGIN_WEB";
const entry = await upsertChannelEntry(id, { name: "codex-login-web", type: "channel", isDM: false, platform: "slack" });
await saveChannelMeta(entry.slug, defaultChannelMeta({ channelId: id, name: "codex-login-web", type: "channel", isDM: false }));
const app = express();
app.use(express.json());
app.post("/api/login", handleLogin);
app.use(noPasswordLockdown, authMiddleware);
app.use("/api", createChannelsRouter());
const server = await new Promise((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
after(() => { server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${server.address().port}`;

test("channel Codex login API requires an admin session and a CSRF marker", async () => {
  const url = `${base}/api/channels/${id}/codex-login`;
  assert.equal((await fetch(url)).status, 401);
  const login = await fetch(`${base}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "codex-login-web-test" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(url, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ method: "api-key", key: "sk-test-example-123456789" }) })).status, 403);
  const headers = { cookie, "content-type": "application/json", "x-cg-request": "1" };
  assert.equal((await fetch(`${base}/api/channels/UNKNOWN/codex-login`, { headers })).status, 404);
  const invalid = await fetch(url, { method: "POST", headers, body: JSON.stringify({ method: "api-key", key: "invalid" }) });
  assert.equal(invalid.status, 400);
  assert.equal((await fetch(url, { headers })).status, 200);
});
