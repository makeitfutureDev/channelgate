// Optional real-browser acceptance with disposable users and the real admin API/UI.
// CG_BROWSER_MODULE=/absolute/path/to/playwright/index.mjs node --test test/user-skills-browser.test.js
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

test("user skill counts survive edits and the editor fits desktop and narrow screens", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const { createAdminRouter } = await import("../src/web/routes/admin.js");
  const { setUser, getUsers } = await import("../src/config/store.js");
  await setUser("U_EMPTY", { name: "Empty User", skills: [] });
  await setUser("U_SKILLS", { name: "Skills User", approved: true, skills: ["alpha", "offline-skill"] });
  const app = express();
  app.use(express.json());
  app.get("/api/skills", (_req, res) => res.json({ skills: ["alpha", "beta", ...Array.from({ length: 30 }, (_, i) => `long-skill-name-for-layout-check-${i}`)] }));
  app.get("/api/mcps", (_req, res) => res.json({ servers: [] }));
  app.use("/api", createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }) } }));
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  app.use(express.static(publicDir, { dotfiles: "allow" }));
  app.get("/users", (_req, res) => res.sendFile(path.join(publicDir, "index.html"), { dotfiles: "allow" }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/users`);
  const row = page.locator('#users tr[data-id="U_SKILLS"]');
  await row.waitFor();
  assert.equal(await page.locator('#users tr[data-id="U_EMPTY"] .user-skills-count').textContent(), "0");
  assert.equal(await row.locator('.user-skills-count').textContent(), "2");
  await row.click();
  const drawer = page.locator('#user-drawer');
  assert.ok((await drawer.boundingBox()).width >= 600, "desktop editor is substantially wider");
  assert.equal(await drawer.locator('.grant-skills input:checked').count(), 2, "offline saved grant stays counted");
  await drawer.locator('.grant-skills-filter').fill("beta");
  await drawer.locator('.grant-skills input[value="beta"]').check();
  await drawer.locator('.ud-save').click();
  await page.waitForFunction(() => globalThis.document.querySelector('#users tr[data-id="U_SKILLS"] .user-skills-count')?.textContent === "3");
  assert.deepEqual((await getUsers()).U_SKILLS.skills.sort(), ["alpha", "beta", "offline-skill"]);
  await page.reload();
  await row.waitFor();
  assert.equal(await row.locator('.user-skills-count').textContent(), "3");
  await row.click();
  if (process.env.CG_UI_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.CG_UI_SCREENSHOTS, "users-desktop.png"), fullPage: true });
  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const panel = await drawer.boundingBox();
    const table = await page.locator('#users').boundingBox();
    assert.ok(panel.y < table.y, "narrow editor precedes the table");
    assert.ok(panel.x >= 0 && panel.x + panel.width <= width, "editor fits viewport");
    assert.equal(await drawer.evaluate((el) => el.scrollWidth <= el.clientWidth), true, "editor has no horizontal overflow");
    await drawer.locator('.ud-save').scrollIntoViewIfNeeded();
    assert.equal(await drawer.locator('.ud-save').isVisible(), true);
  }
  if (process.env.CG_UI_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.CG_UI_SCREENSHOTS, "users-mobile.png"), fullPage: true });
  await drawer.locator('.ud-close').click();
  assert.equal(await drawer.isHidden(), true);
  assert.deepEqual(errors, []);
});
