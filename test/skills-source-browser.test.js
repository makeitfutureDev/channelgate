// Optional browser acceptance, with the real Skills module and admin router against disposable
// source fixtures. Run with CG_BROWSER_MODULE=/absolute/path/to/playwright/index.mjs node --test
// test/skills-source-browser.test.js. No production account, daemon, or skill is changed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();

test("source cards open only their skills and governance switches persist after reload", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const { createAdminRouter } = await import("../src/web/routes/admin.js");
  const { getSkill } = await import("../src/gateway/skills/catalog.js");
  const app = express();
  app.use(express.json());
  app.use("/api", createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }) } }));
  app.get("/", (_req, res) => res.send(`<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><main style="padding:32px;max-width:1400px;margin:auto"><div id="skills-summary"></div><button id="skills-refresh">Refresh</button><button class="skills-tab" data-tab="catalog">Catalog</button><button class="skills-tab" data-tab="sources">Sources</button><span id="skills-review-badge"></span><div id="skills-body"></div></main><script type="module">import { loadSkills } from '/admin-skills.js'; await loadSkills();</script></body></html>`));
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sourceIds = [];
  for (const [label, slugs] of [["Alpha source", ["alpha-active", "alpha-disabled"]], ["Beta source", ["beta-only"]]]) {
    const dir = tempDir("cg-source-browser-");
    for (const slug of slugs) {
      await mkdir(path.join(dir, slug));
      await writeFile(path.join(dir, slug, "SKILL.md"), `---\nname: ${slug}\ndescription: A source skill for browser governance acceptance.\ncategory: Development\n---\n\n# ${slug}\n`);
    }
    const response = await fetch(`${base}/api/skills/sources`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "folder", url: dir, label, mode: "auto" }) });
    assert.equal(response.status, 201);
    sourceIds.push((await response.json()).source.id);
  }
  await fetch(`${base}/api/skills/catalog/alpha-disabled/governance`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.locator('.skills-tab[data-tab="sources"]').click();
  await page.locator(".skills-source-card").first().waitFor();
  assert.equal(await page.locator(".skills-source-card").count(), 2);
  assert.equal(await page.locator('input[type="password"]').count(), 0, "source list does not expose token controls");
  if (process.env.CG_UI_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.CG_UI_SCREENSHOTS, "sources.png"), fullPage: true });
  await page.getByRole("button", { name: /Alpha source/ }).click();
  await page.getByRole("switch", { name: "Enabled: alpha-disabled", exact: true }).waitFor();
  assert.equal(await page.locator(".skills-source-table tbody tr").count(), 2);
  assert.equal(await page.getByText("beta-only", { exact: true }).count(), 0);
  const change = async (name, key, slug, checked) => {
    const response = page.waitForResponse((r) => r.url().endsWith(`/catalog/${slug}/governance`) && r.request().method() === "POST");
    await page.getByRole("switch", { name, exact: true }).setChecked(checked);
    assert.equal((await response).status(), 200);
    await page.waitForFunction(() => globalThis.document.querySelector(".skills-ok")?.textContent === "Skill governance updated.");
    assert.equal(key === "enabled" ? !getSkill(slug).deleted : getSkill(slug)[key], checked);
  };
  await change("Enabled: alpha-disabled", "enabled", "alpha-disabled", true);
  await change("Discoverable organization-wide: alpha-active", "discoverable", "alpha-active", false);
  await page.getByRole("switch", { name: "Mandatory: alpha-active", exact: true }).check();
  await page.waitForFunction(() => globalThis.document.querySelector('[data-action="skill-discoverable"][data-slug="alpha-active"]')?.disabled);
  assert.equal(getSkill("alpha-active").discoverable, true);
  await page.reload();
  await page.locator('.skills-tab[data-tab="sources"]').click();
  await page.getByRole("button", { name: /Alpha source/ }).click();
  await page.getByRole("switch", { name: "Enabled: alpha-disabled", exact: true }).waitFor();
  assert.equal(await page.getByRole("switch", { name: "Enabled: alpha-disabled", exact: true }).isChecked(), true);
  assert.equal(await page.getByRole("switch", { name: "Mandatory: alpha-active", exact: true }).isChecked(), true);
  if (process.env.CG_UI_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.CG_UI_SCREENSHOTS, "source-skills.png"), fullPage: true });
  await page.getByRole("searchbox", { name: "Search this source’s skills" }).fill("disabled");
  assert.equal(await page.locator(".skills-source-table tbody tr").count(), 1);
  await page.locator('.skills-tab[data-tab="catalog"]').click();
  await page.getByRole("combobox", { name: "Source", exact: true }).selectOption(String(sourceIds[1]));
  await page.waitForFunction(() => globalThis.document.querySelector('.skills-table tbody')?.textContent.includes('beta-only') && !globalThis.document.querySelector('.skills-table tbody')?.textContent.includes('alpha-active'));
  assert.equal(await page.locator('.skills-table tbody tr[data-slug]').count(), 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.skills-tab[data-tab="sources"]').click();
  await page.getByRole("button", { name: "← All sources" }).click();
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true, "source cards fit narrow screens");
  assert.deepEqual(errors, []);
});
