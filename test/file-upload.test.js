import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import {
  BROWSER_UPLOAD_MAX_FILES,
  BROWSER_UPLOAD_MAX_TOTAL_BYTES,
  createFileUploadGrantUrl,
  createFileUploadRouter,
  FILE_UPLOAD_GRANT_TTL_MS,
  resetFileUploadStateForTests,
} from "../src/web/file-upload.js";

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("browser uploader exchanges a grant, preserves folder paths, and never overwrites collisions", async (t) => {
  resetFileUploadStateForTests();
  t.after(resetFileUploadStateForTests);
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-browser-upload-"));
  await mkdir(path.join(root, "docs"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const audits = [];
  let authorizationChecks = 0;

  const app = express();
  app.use("/file-upload", createFileUploadRouter({
    authorize: async (grant) => {
      authorizationChecks++;
      assert.equal(grant.channelId, "C123");
      assert.equal(grant.ownerId, "U123");
      assert.equal(grant.relative, "docs");
      return { root };
    },
    audit: async (event, fields) => audits.push({ event, fields }),
  }));
  const server = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const grantUrl = createFileUploadGrantUrl({
    baseUrl: base,
    channelId: "C123",
    slug: "channel",
    ownerId: "U123",
    relative: "docs",
  });

  const exchange = await fetch(grantUrl, { redirect: "manual", headers: { "x-forwarded-proto": "https" } });
  assert.equal(exchange.status, 303);
  const uploadPath = exchange.headers.get("location");
  const cookie = exchange.headers.get("set-cookie").split(";")[0];
  assert.match(uploadPath, /^\/file-upload\/[A-Za-z0-9_-]+$/);
  assert.match(exchange.headers.get("set-cookie"), /HttpOnly/);
  assert.match(exchange.headers.get("set-cookie"), /SameSite=Lax/);
  assert.match(exchange.headers.get("set-cookie"), /Secure/);

  assert.equal((await fetch(grantUrl, { redirect: "manual" })).status, 410);
  assert.equal((await fetch(`${base}${uploadPath}`)).status, 401);
  const page = await fetch(`${base}${uploadPath}`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store, max-age=0");
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  const html = await page.text();
  assert.match(html, /webkitdirectory/);
  assert.match(html, new RegExp(`${BROWSER_UPLOAD_MAX_FILES} files`));
  assert.match(html, new RegExp(`${Math.round(BROWSER_UPLOAD_MAX_TOTAL_BYTES / 1024 / 1024)} MB total`));
  const browserScript = /<script nonce="[^"]+">([\s\S]+)<\/script>/.exec(html)?.[1];
  assert.ok(browserScript);
  assert.doesNotThrow(() => new Function(browserScript));
  const csrf = /const CSRF="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
  assert.ok(csrf);

  const badCsrf = await fetch(`${base}${uploadPath}/api/upload?path=Folder%2Fa.txt`, {
    method: "POST",
    headers: { cookie, "content-type": "application/octet-stream", "x-cg-csrf": "wrong" },
    body: "bad",
  });
  assert.equal(badCsrf.status, 403);

  const upload = (relative, body) => fetch(`${base}${uploadPath}/api/upload?path=${encodeURIComponent(relative)}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/octet-stream", "x-cg-csrf": csrf },
    body,
  });
  const first = await upload("Project/assets/logo.txt", "first\n");
  assert.equal(first.status, 200);
  assert.equal((await first.json()).file, "docs/Project/assets/logo.txt");
  const second = await upload("Project/assets/logo.txt", "second\n");
  assert.equal(second.status, 200);
  const secondJson = await second.json();
  assert.equal(secondJson.file, "docs/Project/assets/logo (1).txt");
  assert.equal(secondJson.renamed, true);
  assert.equal(await readFile(path.join(root, "docs", "Project", "assets", "logo.txt"), "utf8"), "first\n");
  assert.equal(await readFile(path.join(root, "docs", "Project", "assets", "logo (1).txt"), "utf8"), "second\n");
  assert.deepEqual(audits.map((entry) => entry.event), ["channel_file_uploaded_in_browser", "channel_file_uploaded_in_browser"]);
  assert.equal(audits[0].fields.source, "Project/assets/logo.txt");

  const traversal = await upload("../outside.txt", "nope");
  assert.equal(traversal.status, 400);
  assert.ok(authorizationChecks >= 4, "authorization must repeat on exchange, page load, and uploads");
});

test("browser upload grants reject invalid inputs and expire before exchange", async () => {
  resetFileUploadStateForTests();
  assert.equal(createFileUploadGrantUrl({ baseUrl: "javascript:alert(1)" }), "");
  const expired = createFileUploadGrantUrl({
    baseUrl: "https://gateway.example",
    channelId: "C1",
    slug: "channel",
    ownerId: "U1",
    now: Date.now() - FILE_UPLOAD_GRANT_TTL_MS - 1,
  });
  const app = express();
  app.use("/file-upload", createFileUploadRouter({ authorize: async () => ({ root: "/missing" }) }));
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(expired.replace("https://gateway.example", base), { redirect: "manual" });
    assert.equal(response.status, 410);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    resetFileUploadStateForTests();
  }
});
