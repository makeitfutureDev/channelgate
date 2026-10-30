// Disposable real admin UI/API acceptance; no live users or gateway settings are touched.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();

test("company domain policy persists, previews safely and respects manual revocation in the browser", { skip: !process.env.CG_BROWSER_MODULE }, async t => {
  const { chromium } = await import(process.env.CG_BROWSER_MODULE);
  const { createAdminRouter } = await import("../src/web/routes/admin.js");
  const { setUser, getUser } = await import("../src/config/store.js");
  await setUser("UBROWSER1", { name: "Company member" });
  const slack = {
    snapshot: () => ({ connected: false, status: "off" }),
    getClient: () => ({ users: { info: async ({ user }) => ({ user: { id: user, profile: { email: "member@example.com" } } }) } }),
  };
  const app = express();
  app.use(express.json());
  app.get("/api/skills", (_req, res) => res.json({ skills: [] }));
  app.get("/api/mcp/available", (_req, res) => res.json({ servers: [] }));
  app.get("/api/health", (_req, res) => res.json({ slack: slack.snapshot(), engines: {} }));
  app.use("/api", createAdminRouter({ slack }));
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  app.use(express.static(publicDir, { dotfiles: "allow" }));
  app.get("/users", (_req, res) => res.sendFile(path.join(publicDir, "index.html"), { dotfiles: "allow" }));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/users`);
  await page.locator('#users tr[data-id="UBROWSER1"]').waitFor();
  await page.locator("#user-auto-approval summary").click();
  await page.locator("#user-auto-approval-enabled").check();
  await page.locator("#user-auto-approval-domains").fill("EXAMPLE.COM");
  await page.getByRole("button", { name: "Save auto-approval", exact: true }).click();
  await page.getByText("Saved. Applies on the next message.", { exact: false }).waitFor();
  await page.reload();
  await page.locator('#users tr[data-id="UBROWSER1"]').waitFor();
  await page.locator("#user-auto-approval summary").click();
  assert.equal(await page.locator("#user-auto-approval-enabled").isChecked(), true);
  assert.equal(await page.locator("#user-auto-approval-domains").inputValue(), "example.com");
  await page.locator("#user-auto-approval-preview").click();
  await page.getByText("1 eligible users.", { exact: false }).waitFor();
  assert.equal((await getUser("UBROWSER1")).approved, false);
  await page.locator("#user-auto-approval-apply").click();
  await page.getByText("1 users approved after rechecking", { exact: false }).waitFor();
  assert.equal((await getUser("UBROWSER1")).approved, true);
  assert.equal((await getUser("UBROWSER1")).isAdmin, false);
  await page.locator('#users tr[data-id="UBROWSER1"]').click();
  await page.locator(".ud-approved").uncheck();
  await page.locator(".ud-save").click();
  await page.waitForFunction(() => globalThis.document.querySelector('#users tr[data-id="UBROWSER1"]')?.textContent.includes("No access"));
  await page.locator("#user-auto-approval-preview").click();
  await page.getByText("0 eligible users.", { exact: false }).waitFor();
  assert.equal((await getUser("UBROWSER1")).autoApprovalBlocked, true);
  await page.locator("#user-auto-approval-domains").fill("*.example.com");
  await page.getByRole("button", { name: "Save auto-approval", exact: true }).click();
  await page.getByText("Enter exact email domains", { exact: false }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator("#user-auto-approval").evaluate(el => el.scrollWidth <= el.clientWidth), true);
  assert.deepEqual(errors, []);
});
