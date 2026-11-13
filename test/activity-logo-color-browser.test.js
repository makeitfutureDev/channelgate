// Real admin form + PNG decoding in Chromium; all state is disposable.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();

test("logo color previews, persists and reaches real PNGs, manifests and Activity pages", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const { createAdminRouter } = await import("../src/web/routes/admin.js");
  const { createActivityRouter } = await import("../src/web/activity.js");
  const { activityPage } = await import("../src/web/activity-page.js");
  const settings = await import("../src/config/settings.js");
  let base;
  const app = express(); app.use(express.json());
  app.get("/api/auth/me", (_req, res) => res.json({ bootstrap: false, linkRequired: false, fresh: true, account: { userId: "U_BROWSER_ADMIN" }, passkeys: [] }));
  app.get("/api/skills", (_req, res) => res.json({ skills: [] }));
  app.get("/api/mcp/available", (_req, res) => res.json({ servers: [] }));
  app.get("/api/health", (_req, res) => res.json({ slack: { connected: false, status: "off" }, engines: {} }));
  app.use("/api", createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }) } }));
  const id = "LogoFixture12345";
  app.get(`/activity/${id}/settings`, (_req, res) => res.type("html").send(activityPage({ sessionId: id, csrf: "fixture", view: "settings" }).html));
  app.get(`/activity/${id}/api/settings`, (_req, res) => res.json({ account: { name: "Browser admin", role: "admin" }, general: { nudges: false, replyMentions: false } }));
  app.use("/activity", createActivityRouter({ getClient: () => null, getTeamId: () => "T_FIXTURE", getBaseUrl: () => base }));
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  app.use(express.static(publicDir, { dotfiles: "allow" }));
  app.get("/settings", (_req, res) => res.sendFile(path.join(publicDir, "index.html"), { dotfiles: "allow" }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1366, height: 1000 } }); page.setDefaultTimeout(10000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base + "/settings#set-appearance");
  await page.waitForFunction(() => globalThis.document.querySelector("#set-max-concurrent-runs")?.value === "8");
  assert.equal(settings.getPublicUrl(), "", "preview also works without Public URL setup");
  const hex = page.locator("#set-logo-hex"), picker = page.locator("#set-logo-color");
  await hex.fill("#2266ee");
  assert.equal(await picker.inputValue(), "#2266ee");
  assert.equal(await page.locator("#set-logo-preview rect").getAttribute("fill"), "#2266ee");
  assert.match(await page.locator("#set-appearance").textContent(), /reinstall/);
  const response = page.waitForResponse((r) => r.url().endsWith("/api/settings") && r.request().method() === "PUT");
  await page.locator("#save-settings").click(); assert.equal((await response).status(), 200);
  await page.waitForFunction(() => globalThis.document.querySelector("#settings-dirty-msg")?.textContent === "All changes saved");
  assert.equal(settings.getLogoColor(), "#2266ee");
  await page.reload(); await page.waitForFunction(() => globalThis.document.querySelector("#set-logo-hex")?.value === "#2266ee");
  await hex.fill("bad"); await page.locator("#save-settings").click();
  await page.waitForFunction(() => globalThis.document.querySelector("#settings-saved")?.textContent.includes("six-digit hex"));
  assert.equal(settings.getLogoColor(), "#2266ee");
  await page.locator("#reset-logo-color").click(); assert.equal(await hex.inputValue(), "#ff642f");
  assert.equal(settings.getLogoColor(), "#2266ee", "preview/reset does not persist before Save");

  await page.goto(base + `/activity/${id}/settings`);
  await page.getByRole("link", { name: "Change app logo color" }).waitFor();
  assert.match(await page.getByRole("link", { name: "Change app logo color" }).getAttribute("href"), /settings#set-appearance/);
  assert.equal(await page.locator(".agent-mark rect").getAttribute("fill"), "#2266ee");
  assert.match(await page.locator('link[rel="icon"]').getAttribute("href"), /color=2266ee/);
  const result = await page.evaluate(async () => {
    const manifest = await (await fetch("/activity/manifest.webmanifest")).json();
    const pixels = [];
    for (const icon of manifest.icons) {
      const image = new globalThis.Image(); image.src = icon.src; await image.decode();
      const canvas = globalThis.document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
      const alpha = ctx.getImageData(0, 0, image.width, image.height).data;
      const original = new globalThis.Image(); original.src = icon.src.replace("color=2266ee", "color=ff642f"); await original.decode();
      ctx.clearRect(0, 0, image.width, image.height); ctx.drawImage(original, 0, 0);
      const originalPixels = ctx.getImageData(0, 0, image.width, image.height).data;
      const sameAlpha = alpha.every((value, index) => index % 4 !== 3 || value === originalPixels[index]);
      ctx.clearRect(0, 0, image.width, image.height); ctx.drawImage(image, 0, 0);
      pixels.push({ sameAlpha, src: icon.src, width: image.width, height: image.height, pixel: [...ctx.getImageData(image.width / 2, 2, 1, 1).data], corner: [...ctx.getImageData(0, 0, 1, 1).data] });
    }
    return { manifest, pixels };
  });
  assert.equal(result.manifest.id, "/activity/app");
  for (const entry of result.pixels) {
    assert.equal(entry.sameAlpha, true, "every alpha pixel matches the reviewed original artwork");
    assert.match(entry.src, /color=2266ee$/); assert.deepEqual(entry.pixel, [34, 102, 238, 255]);
    if (!entry.src.includes("maskable")) assert.equal(entry.corner[3], 0);
  }
  await page.goto(base + "/activity/login");
  assert.match(await page.locator('link[rel="manifest"]').getAttribute("href"), /color=2266ee/);
  assert.match(await page.locator('link[rel="apple-touch-icon"]').getAttribute("href"), /color=2266ee/);
  assert.match(await page.locator('link[rel="icon"]').getAttribute("href"), /color=2266ee/);
  await page.goto(base + "/settings#set-appearance");
  await page.waitForFunction(() => globalThis.document.querySelector("#set-logo-hex")?.value === "#2266ee");
  await page.setViewportSize({ width: 390, height: 844 }); await hex.scrollIntoViewIfNeeded();
  assert.equal(await hex.isVisible(), true);
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
  assert.deepEqual(errors, []);
});
