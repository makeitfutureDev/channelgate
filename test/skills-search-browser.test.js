// Optional browser acceptance for the Skills search boxes, against a disposable folder source.
// Run with CG_BROWSER_MODULE=/absolute/path/to/playwright/index.mjs node --test
// test/skills-search-browser.test.js. No production account, daemon, or skill is changed.
//
// The regression: every keystroke re-rendered #skills-body, and the rebuilt input came back
// focused at offset 0, so "beta" was typed as "ateb" and the box was unusable. Searching now
// happens only when the reader asks for it — Enter, the Search button, or clearing the box.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();

const caret = (page, id) => page.evaluate((elementId) => {
  const el = globalThis.document.getElementById(elementId);
  return { value: el.value, start: el.selectionStart, focused: globalThis.document.activeElement === el };
}, id);

test("skills search boxes accept typing and only search on Enter or the Search button", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const { createAdminRouter } = await import("../src/web/routes/admin.js");
  const app = express();
  app.use(express.json());
  app.use("/api", createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }) } }));
  app.get("/", (_req, res) => res.send(`<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><main style="padding:32px;max-width:1400px;margin:auto"><div id="skills-summary"></div><button id="skills-refresh">Refresh</button><button class="skills-tab" data-tab="catalog">Catalog</button><button class="skills-tab" data-tab="sources">Sources</button><span id="skills-review-badge"></span><div id="skills-body"></div></main><script type="module">import { loadSkills } from '/admin-skills.js'; await loadSkills();</script></body></html>`));
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const dir = tempDir("cg-search-browser-");
  for (const slug of ["alpha-one", "alpha-two", "beta-three"]) {
    await mkdir(path.join(dir, slug));
    await writeFile(path.join(dir, slug, "SKILL.md"), `---\nname: ${slug}\ndescription: A source skill for browser search acceptance.\ncategory: Development\n---\n\n# ${slug}\n`);
  }
  const created = await fetch(`${base}/api/skills/sources`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "folder", url: dir, label: "Search source", mode: "auto" }) });
  assert.equal(created.status, 201);

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const catalogRequests = [];
  page.on("request", (request) => { if (request.url().includes("/api/skills/catalog?")) catalogRequests.push(request.url()); });
  await page.goto(base);

  // ── the source panel's local filter ─────────────────────────────────────────────────────────
  await page.locator('.skills-tab[data-tab="sources"]').click();
  await page.getByRole("button", { name: /Search source/ }).click();
  await page.locator("#source-skills-q").waitFor();
  assert.equal(await page.locator(".skills-source-table tbody tr").count(), 3);
  await page.locator("#source-skills-q").click();
  await page.locator("#source-skills-q").pressSequentially("beta", { delay: 30 });
  assert.deepEqual(await caret(page, "source-skills-q"), { value: "beta", start: 4, focused: true }, "characters land in order, caret stays after them");
  assert.equal(await page.locator(".skills-source-table tbody tr").count(), 3, "typing alone does not filter");
  await page.locator("#source-skills-q").press("Enter");
  await page.waitForFunction(() => globalThis.document.querySelectorAll(".skills-source-table tbody tr").length === 1);
  assert.deepEqual(await caret(page, "source-skills-q"), { value: "beta", start: 4, focused: true }, "the committed query keeps the caret and focus");

  // ── the catalog's server-side search ────────────────────────────────────────────────────────
  await page.locator('.skills-tab[data-tab="catalog"]').click();
  await page.locator("#skills-q").waitFor();
  assert.equal(await page.locator(".skills-table tbody tr[data-slug]").count(), 3);
  const before = catalogRequests.length;
  await page.locator("#skills-q").click();
  await page.locator("#skills-q").pressSequentially("beta", { delay: 30 });
  assert.deepEqual(await caret(page, "skills-q"), { value: "beta", start: 4, focused: true });
  assert.equal(catalogRequests.length, before, "no query is sent while the reader is still typing");
  assert.equal(await page.locator(".skills-table tbody tr[data-slug]").count(), 3);
  // The Search button is the click-to-search half of the promise.
  await page.locator('[data-action="search"][data-search="skills-q"]').click();
  await page.waitForFunction(() => globalThis.document.querySelectorAll('.skills-table tbody tr[data-slug]').length === 1);
  assert.ok(catalogRequests.length > before, "clicking Search asks the server once");
  assert.equal(await page.locator('.skills-table tbody tr[data-slug="beta-three"]').count(), 1);

  // Escape clears the box and shows everything again.
  await page.locator("#skills-q").press("Escape");
  await page.waitForFunction(() => globalThis.document.querySelectorAll('.skills-table tbody tr[data-slug]').length === 3);
  assert.equal(await page.inputValue("#skills-q"), "");
  assert.deepEqual(errors, []);
});
