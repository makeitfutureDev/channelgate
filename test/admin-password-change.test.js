import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { saveSettings, getAdminPassword, getSettings } = await import("../src/config/settings.js");
const { hashPassword, verifyPassword } = await import("../src/web/security.js");
const { createAdminRouter } = await import("../src/web/routes/admin.js");
const { readEvents } = await import("../src/util/logger.js");
const app = express();
app.use(express.json());
app.use(createAdminRouter({ slack: { snapshot: () => ({ connected: false }) } }));
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
after(() => server.close());
const put = (body) => fetch(`http://127.0.0.1:${server.address().port}/settings`, {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, connectSlack: false }),
});

test("an admin session needs the current password for replacement and removal", async () => {
  const old = await hashPassword("test-current-password");
  saveSettings({ adminPassword: old });
  for (const action of [{ adminPassword: "test-new-password" }, { clearAdminPassword: true }]) {
    for (const proof of [undefined, "test-wrong-password"]) {
      const response = await put({ ...action, currentAdminPassword: proof });
      assert.equal(response.status, 403);
      assert.equal(getAdminPassword(), old);
    }
  }
  assert.equal((await put({ adminPassword: "test-new-password", clearAdminPassword: true, currentAdminPassword: "test-current-password" })).status, 400);
  assert.equal((await put({ adminPassword: "test-new-password", currentAdminPassword: "test-current-password" })).status, 200);
  assert.ok(await verifyPassword("test-new-password", getAdminPassword()));
  assert.equal(getSettings().currentAdminPassword, undefined, "proof is never persisted");
  assert.equal((await put({ clearAdminPassword: true, currentAdminPassword: "test-new-password" })).status, 200);
  assert.equal(getAdminPassword(), "");
  const audit = JSON.stringify(readEvents({ limit: 200 }));
  for (const value of ["test-current-password", "test-new-password", "test-wrong-password"]) assert.ok(!audit.includes(value));
});

test("initial password configuration remains available without an existing password", async () => {
  saveSettings({ adminPassword: "" });
  assert.equal((await put({ adminPassword: "test-initial-password" })).status, 200);
  assert.ok(await verifyPassword("test-initial-password", getAdminPassword()));
});
