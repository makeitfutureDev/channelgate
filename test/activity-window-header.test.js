import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { activityPage } = await import("../src/web/activity-page.js");
const { activityManifest } = await import("../src/web/activity-app.js");
const { setUser } = await import("../src/config/store.js");
const { createActivityRouter, createActivityGrantUrl, resetActivityStateForTests } = await import("../src/web/activity.js");

test("Activity opts into the window overlay with a standalone fallback and paints saved chrome colors before scripts", () => {
  assert.deepEqual(activityManifest().display_override, ["window-controls-overlay"]);
  assert.equal(activityManifest().display, "standalone");
  for (const view of ["activity", "subscriptions", "settings"]) {
    for (const [theme, color] of [["dark", "#080e0d"], ["light", "#f6f7f4"]]) {
      const html = activityPage({ sessionId: "s", csrf: "c", theme, view }).html;
      const colors = [...html.matchAll(/<meta id="app-theme-[^"]+" name="theme-color" content="([^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual(colors, [color, color], `${view}/${theme} ignores the OS before paint`);
    }
  }
});

test("Activity title bar follows theme across views and stays usable in a tab or installed window", {
  skip: !process.env.CG_BROWSER_MODULE, timeout: 60_000,
}, async (t) => {
  resetActivityStateForTests();
  const ownerId = "UACTIVITYWINDOW";
  await setUser(ownerId, { approved: true, activityTheme: "dark" });
  let base;
  const app = express();
  app.use("/fonts", express.static(fileURLToPath(new URL("../public/fonts", import.meta.url))));
  app.use("/activity", createActivityRouter({ getClient: () => ({}), getTeamId: () => "TWINDOW", getBaseUrl: () => base,
    getBotIdentity: () => ({ handle: "Fixture" }), snapshot: async () => ({ rows: [], total: 0 }), voiceAvailable: () => true,
    readSubscriptions: async () => ({ refreshAfterSeconds: 600, subscriptions: ["Claude", "Codex", "Codex EU"].map((name) => ({ name, kind: "subscription", status: "ok", windows: [{ label: "Weekly", usedPercent: 63 }] })) }) }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => { resetActivityStateForTests(); server.closeAllConnections(); server.close(resolve); }));
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const profile = await mkdtemp(join(tmpdir(), "cg-activity-window-"));
  const nativeWindow = process.env.CG_BROWSER_WINDOW === "1";
  const context = await chromium.launchPersistentContext(profile, { headless: !nativeWindow, executablePath: process.env.CG_BROWSER_EXECUTABLE,
    viewport: null, colorScheme: "light", args: ["--window-size=1200,900", ...(nativeWindow ? ["--enable-features=DesktopPWAsWindowControlsOverlayWithNoToggle"] : [])] });
  t.after(async () => { await context.close(); await rm(profile, { recursive: true, force: true }); });
  let page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(createActivityGrantUrl({ baseUrl: base, ownerId, teamId: "TWINDOW" }));
  await page.waitForURL(/\/activity\/[A-Za-z0-9_-]{16}$/);
  const dashboard = page.url();
  assert.equal(await page.locator(".top").evaluate((el) => globalThis.getComputedStyle(el).webkitAppRegion), "none", "regular tabs keep the normal header");
  if (nativeWindow) {
    const cdp = await context.newCDPSession(page);
    const manifestId = base + "/activity/app";
    await cdp.send("PWA.install", { manifestId });
    await cdp.send("PWA.changeAppUserSettings", { manifestId, displayMode: "standalone" });
    // Move this exact session into its installed window; launch_handler may otherwise
    // reuse the existing target instead of creating a new Playwright page.
    await cdp.send("PWA.openCurrentPageInApp", { manifestId });
    await page.waitForFunction(() => globalThis.navigator.windowControlsOverlay?.visible === true);
    assert.equal(await page.evaluate(() => globalThis.matchMedia("(display-mode:window-controls-overlay)").matches), true);
  }
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const chromeColors = () => page.locator('meta[name="theme-color"]').evaluateAll((nodes) => nodes.map((n) => n.content));
  for (const view of ["", "/subscriptions", "/settings"]) {
    await page.goto(dashboard + view);
    if (!view) await page.locator(".subscription-quick").nth(2).waitFor();
    assert.deepEqual(await chromeColors(), ["#080e0d", "#080e0d"], `${view}: saved dark with light OS`);
    await page.getByRole("button", { name: "Switch to light theme" }).click();
    await page.waitForFunction(() => globalThis.document.querySelector('#theme-toggle').dataset.theme === "light");
    assert.deepEqual(await chromeColors(), ["#f6f7f4", "#f6f7f4"]);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => globalThis.document.querySelector('#theme-toggle').dataset.theme === "dark");
    assert.deepEqual(await chromeColors(), ["#080e0d", "#080e0d"], "System tracks OS changes");
    // Pin dark against a light OS again, then verify the persisted choice after reload.
    await page.emulateMedia({ colorScheme: "light" });
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/theme") && r.request().method() === "POST"),
      page.getByRole("button", { name: "Switch to dark theme" }).click(),
    ]);
    await page.reload();
    if (!view) await page.locator(".subscription-quick").nth(2).waitFor();
    assert.deepEqual(await chromeColors(), ["#080e0d", "#080e0d"]);
    if (nativeWindow) {
      const cdp = await context.newCDPSession(page);
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      for (const width of [1200, 640, 480]) {
        await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width, height: 900 } });
        await page.evaluate(() => new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))));
        const geometry = await page.evaluate(() => {
          const safe = globalThis.navigator.windowControlsOverlay.getTitlebarAreaRect(), header = globalThis.document.querySelector(".top"), css = globalThis.getComputedStyle(header);
          return { safe: { x: safe.x, width: safe.width, height: safe.height }, drag: css.webkitAppRegion,
            left: parseFloat(css.paddingLeft), right: globalThis.innerWidth - parseFloat(css.paddingRight), height: header.getBoundingClientRect().height,
            overflow: globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
            controls: [...header.querySelectorAll("a,button")].map((el) => ({ drag: globalThis.getComputedStyle(el).webkitAppRegion, x: el.getBoundingClientRect().x, right: el.getBoundingClientRect().right })) };
        });
        assert.equal(geometry.drag, "drag");
        assert.equal(geometry.overflow, false);
        assert.ok(geometry.left >= geometry.safe.x && geometry.right <= geometry.safe.x + geometry.safe.width);
        assert.ok(geometry.height >= geometry.safe.height);
        for (const button of geometry.controls) {
          assert.equal(button.drag, "no-drag");
          assert.ok(button.x >= geometry.left && button.right <= geometry.right + 1, JSON.stringify({ width, view, geometry }));
        }
      }
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: 1200, height: 900 } });
    }
  }
  if (process.env.CG_BROWSER_SCREENSHOTS) {
    await mkdir(process.env.CG_BROWSER_SCREENSHOTS, { recursive: true });
    await page.goto(dashboard);
    await page.locator(".subscription-quick").nth(2).waitFor();
    await page.screenshot({ path: join(process.env.CG_BROWSER_SCREENSHOTS, nativeWindow ? "installed-header.png" : "tab-header.png") });
  }
  assert.deepEqual(errors, []);
});
