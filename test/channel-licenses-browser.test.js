import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestEnv, testLicenseEnv } from "./helpers.js";

ensureTestEnv();

test("channel settings list this channel's licenses and add one through the Settings → Licenses form, locked to the channel", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  testLicenseEnv({ tier: "enterprise" }); // a license limited to one channel is an Enterprise capability
  const { createAdminRouter } = await import("../src/web/routes/admin.js");
  const { upsertChannelEntry, defaultChannelMeta, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");
  const id = "C_CODEX_BROWSER";
  const entry = await upsertChannelEntry(id, { name: "codex-browser", type: "channel", isDM: false });
  await saveChannelMeta(entry.slug, defaultChannelMeta({ channelId: id, name: entry.name, type: "channel", isDM: false }));
  const app = express();
  app.use(express.json());
  // This focused router fixture represents an authenticated admin; real login is tested separately.
  app.get("/api/auth/me", (_req, res) => res.json({ bootstrap: false, linkRequired: false, fresh: true, account: { userId: "U_BROWSER_ADMIN" }, passkeys: [] }));
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  app.use("/api", createAdminRouter({ slack: { getClient: () => null, snapshot: () => ({ status: "disconnected" }) } }));
  app.use(express.static(publicDir, { dotfiles: "allow" }));
  app.get(`/conversations/channel/${id}`, (_req, res) => res.sendFile(path.join(publicDir, "index.html"), { dotfiles: "allow" }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1150, height: 850 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const created = [];
  await page.route("**/api/engine-licenses", async (route) => {
    if (route.request().method() === "POST") created.push(route.request().postDataJSON());
    await route.fallback();
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/conversations/channel/${id}`);
  await page.locator('[data-pane="runtime"].subtab').click();
  // The legacy "Connect a Codex account for this channel" block is gone.
  assert.equal(await page.locator(".ch-codex-auth-source").count(), 0);
  assert.equal(await page.locator(".ch-auth-channel-panel").count(), 0);
  const card = page.locator(".ch-licenses-card");
  await card.locator(".lic-add").waitFor();
  assert.ok(await card.locator(".ch-licenses-all").count(), "a link to Settings → Licenses");
  await card.locator(".lic-add").click();
  const form = card.locator(".lic-form");
  // The same add form as Settings → Licenses: harness, kind (sign-in or provider), name, type.
  assert.ok(await form.locator('.lic-harness option[value="claude"]').count());
  assert.ok(await form.locator('.lic-harness option[value="codex"]').count());
  assert.ok(await form.locator('.lic-kind option[value="codex-login"]').count());
  assert.ok(await form.locator('.lic-kind option[value="codex-api"]').count());
  assert.equal(await form.locator(".lic-channel").isDisabled(), true, "the limit is locked to this channel");
  assert.equal(await form.locator(".lic-channel").inputValue(), id);
  await form.locator(".lic-harness").selectOption("claude");
  await card.locator('.lic-form .lic-kind option[value="claude-login"]').waitFor({ state: "attached" });
  await card.locator(".lic-form .lic-label").fill("Channel Claude");
  await card.locator(".lic-form .lic-save").click();
  await card.locator('.lic-row .lic-name', { hasText: "Channel Claude" }).waitFor();
  assert.equal(created.length, 1);
  assert.equal(created[0].kind, "claude-login");
  assert.equal(created[0].channelId, id);
  assert.deepEqual(errors, []);
});
