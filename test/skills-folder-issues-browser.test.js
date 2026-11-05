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

test("library shows missing SKILL.md folders and filters without offering governance", { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
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

  const source = tempDir("cg-missing-manifest-browser-");
  await mkdir(path.join(source, "synced", "nested"), { recursive: true });
  await writeFile(path.join(source, "synced", "nested", "SKILL.md"), "# Nested\n");
  const previous = process.env.GATEWAY_SKILL_SOURCES;
  process.env.GATEWAY_SKILL_SOURCES = source;
  t.after(() => { if (previous == null) delete process.env.GATEWAY_SKILL_SOURCES; else process.env.GATEWAY_SKILL_SOURCES = previous; });
  const { setUser } = await import("../src/config/store.js");
  await setUser("U_ISSUE_BROWSER", { name: "Folder User", skills: ["synced"] });
  const { createLocalSkill } = await import("../src/gateway/skills/authoring.js");
  await createLocalSkill({ files: [{ path: "SKILL.md", content: "---\nname: valid\ndescription: Valid skill\n---\n# Valid\n" }] });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.locator('.skills-tab[data-tab="catalog"]').click();
  const issue = page.locator('.skills-table tr[data-slug="synced"]');
  await issue.waitFor();
  assert.match(await issue.textContent(), /Missing SKILL.md/);
  assert.match(await issue.textContent(), /Folder User/);
  assert.match(await issue.textContent(), /synced/);
  assert.equal(await issue.locator("input,button").count(), 0);
  await page.getByRole("combobox", { name: "Skill file status", exact: true }).selectOption("1");
  await page.waitForFunction(() => globalThis.document.querySelectorAll('.skills-table tr[data-slug]').length === 1);
  assert.equal(await issue.count(), 1);
  await page.getByRole("combobox", { name: "Skill file status", exact: true }).selectOption("0");
  await page.waitForFunction(() => !globalThis.document.querySelector('.skills-table tr[data-slug="synced"]'));
  await page.getByRole("combobox", { name: "Skill file status", exact: true }).selectOption("1");
  await issue.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.getByRole("combobox", { name: "Skill file status", exact: true }).isVisible(), true);
  assert.deepEqual(errors, []);
});
