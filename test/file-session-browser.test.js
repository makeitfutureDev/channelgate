import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { ensureTestEnv } from "./helpers.js";
import { createFileEditorGrantUrl, createFileEditorRouter, resetFileEditorStateForTests } from "../src/web/file-editor.js";
import { createFileUploadGrantUrl, createFileUploadRouter, resetFileUploadStateForTests } from "../src/web/file-upload.js";

ensureTestEnv();

for (const kind of ["editor", "upload"]) {
  test(`cross-site ${kind} link opens on the first click without weakening write protection`, { skip: !process.env.CG_BROWSER_MODULE }, async (t) => {
    resetFileEditorStateForTests();
    resetFileUploadStateForTests();
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-file-session-browser-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "docs"));
    const original = "Original fixture\n";
    await writeFile(path.join(root, "notes.md"), original);
    let allowed = true;
    let checks = 0;
    const audits = [];
    const requests = [];
    const authorize = async (grant) => {
      checks++;
      assert.equal(grant.ownerId, "U_BROWSER");
      assert.equal(grant.channelId, "C_BROWSER");
      if (!allowed) throw Error("Fixture access revoked");
      return { root };
    };
    const app = express();
    app.use((req, _res, next) => {
      // Model TLS termination. Chromium accepts Secure cookies on loopback; never insert cookies
      // through the automation API, so real SameSite and HttpOnly enforcement remain under test.
      req.headers["x-forwarded-proto"] = "https";
      if (req.path.startsWith(`/file-${kind}/`)) requests.push({
        method: req.method, exchange: req.path.includes("/open/"),
        cookie: Boolean(req.headers.cookie), site: req.headers["sec-fetch-site"],
      });
      next();
    });
    const router = kind === "editor" ? createFileEditorRouter : createFileUploadRouter;
    app.use(`/file-${kind}`, router({ authorize, audit: async (event) => audits.push(event) }));
    let link;
    app.get("/source", (_req, res) => res.type("html").send(`<a href="${link}">Open fixture</a>`));
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, "0.0.0.0", () => resolve(listening));
    });
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const sourceUrl = `http://localhost:${port}/source`;
    const create = kind === "editor" ? createFileEditorGrantUrl : createFileUploadGrantUrl;
    link = create({ baseUrl, channelId: "C_BROWSER", slug: "browser", ownerId: "U_BROWSER",
      relative: kind === "editor" ? "notes.md" : "docs",
      expectedHash: crypto.createHash("sha256").update(original).digest("hex") });
    const { chromium } = await import(process.env.CG_BROWSER_MODULE);
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CG_BROWSER_EXECUTABLE, args: ["--no-sandbox"] });
    t.after(() => browser.close());
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(sourceUrl);
    const firstResponse = page.waitForResponse((response) => new URL(response.url()).pathname.startsWith(`/file-${kind}/`) && !new URL(response.url()).pathname.includes("/open/"));
    await page.getByRole("link", { name: "Open fixture" }).click();
    assert.equal((await firstResponse).status(), 200, "the first cross-site redirect must serve the tool, without reload or manual cookies");
    const sessionUrl = page.url();
    assert.ok(requests.some((r) => r.exchange && r.site === "cross-site"));
    assert.ok(requests.some((r) => !r.exchange && r.method === "GET" && r.cookie));
    const cookies = await context.cookies();
    assert.equal(cookies.length, 1);
    assert.equal(cookies[0].sameSite, "Lax");
    assert.equal(cookies[0].httpOnly, true);
    assert.equal(cookies[0].secure, true);
    assert.equal(cookies[0].path, new URL(sessionUrl).pathname);
    assert.equal(await page.evaluate(() => globalThis.document.cookie), "", "the session secret stays HttpOnly");
    const endpoint = `${new URL(sessionUrl).pathname}/api/${kind === "editor" ? "save" : "upload?path=forged.txt"}`;
    const denied = await page.evaluate(async (url) => (await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json", "X-CG-CSRF": "wrong" },
      body: JSON.stringify({ content: "forged" }),
    })).status, endpoint);
    assert.equal(denied, 403, "a valid session still requires the unguessable CSRF header");
    if (kind === "editor") {
      await page.locator("#editor").fill("Saved fixture\n");
      const saved = page.waitForResponse((response) => response.request().method() === "POST");
      await page.locator("#save").click();
      assert.equal((await saved).status(), 200);
      assert.equal(await readFile(path.join(root, "notes.md"), "utf8"), "Saved fixture\n");
    } else {
      await page.locator("#files").setInputFiles({ name: "uploaded.txt", mimeType: "text/plain", buffer: Buffer.from("Uploaded fixture\n") });
      const uploaded = page.waitForResponse((response) => response.request().method() === "POST");
      await page.locator("#upload").click();
      assert.equal((await uploaded).status(), 200);
      assert.equal(await readFile(path.join(root, "docs", "uploaded.txt"), "utf8"), "Uploaded fixture\n");
    }
    assert.equal(audits.length, 1);
    // A fresh cross-site top-level POST must NOT receive even a newly minted Lax cookie.
    await page.goto(sourceUrl);
    const csrfResponse = page.waitForResponse((response) => response.request().method() === "POST");
    await page.evaluate((action) => {
      const form = globalThis.document.createElement("form"); form.method = "POST"; form.action = action;
      globalThis.document.body.append(form); form.submit();
    }, `${baseUrl}${endpoint}`);
    assert.equal((await csrfResponse).status(), 401);
    await page.waitForURL((url) => url.pathname === new URL(`${baseUrl}${endpoint}`).pathname);
    assert.ok(requests.some((r) => r.method === "POST" && r.site === "cross-site" && !r.cookie));
    assert.equal(audits.length, 1, "cross-site POST must not write");
    allowed = false;
    assert.equal((await page.goto(sessionUrl)).status(), 403, "every page load rechecks current authority");
    assert.ok(checks >= 4);
    assert.equal((await page.goto(link)).status(), 410, "the grant is still single-use");
  });
}
