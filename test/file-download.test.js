import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import {
  createFileDownloadGrantUrl,
  createFileDownloadRouter,
  FILE_DOWNLOAD_GRANT_TTL_MS,
  resetFileDownloadStateForTests,
} from "../src/web/file-download.js";

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("a requester-bound one-use grant downloads the complete confined file and audits it", async (t) => {
  resetFileDownloadStateForTests();
  t.after(resetFileDownloadStateForTests);
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-file-download-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "reports"));
  const contents = Buffer.from("complete report contents\n");
  await writeFile(path.join(root, "reports", "report.txt"), contents);
  const audits = [];
  let authorizationChecks = 0;

  const app = express();
  app.use("/file-download", createFileDownloadRouter({
    authorize: async (grant) => {
      authorizationChecks++;
      assert.equal(grant.channelId, "C123");
      assert.equal(grant.ownerId, "U123");
      assert.equal(grant.slug, "channel");
      return { root };
    },
    audit: async (event, fields) => audits.push({ event, fields }),
  }));
  const server = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const grantUrl = createFileDownloadGrantUrl({
    baseUrl: base,
    channelId: "C123",
    slug: "channel",
    ownerId: "U123",
    relative: "reports/report.txt",
    threadTs: "123.456",
  });

  const response = await fetch(grantUrl);
  assert.equal(response.status, 200);
  assert.equal(Buffer.compare(Buffer.from(await response.arrayBuffer()), contents), 0);
  assert.match(response.headers.get("content-disposition"), /^attachment;.*report\.txt/i);
  assert.equal(response.headers.get("content-length"), String(contents.length));
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(authorizationChecks, 1);
  assert.deepEqual(audits, [{
    event: "channel_file_downloaded",
    fields: {
      channel: "C123",
      author: "U123",
      slug: "channel",
      file: "reports/report.txt",
      bytes: contents.length,
    },
  }]);

  const reused = await fetch(grantUrl);
  assert.equal(reused.status, 410);
  assert.match(await reused.text(), /already used/i);
});

test("download grants reject malformed, expired, unauthorized, and escaping requests", async (t) => {
  resetFileDownloadStateForTests();
  t.after(resetFileDownloadStateForTests);
  assert.equal(createFileDownloadGrantUrl({ baseUrl: "javascript:alert(1)" }), "");
  assert.equal(createFileDownloadGrantUrl({
    baseUrl: "https://gateway.example",
    channelId: "C1",
    slug: "channel",
    ownerId: "U1",
    relative: "../outside.txt",
  }), "");

  const baseDir = await mkdtemp(path.join(os.tmpdir(), "gateway-file-download-denials-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const root = path.join(baseDir, "channel");
  await mkdir(root);
  await writeFile(path.join(baseDir, "outside.txt"), "outside\n");
  await symlink(path.join(baseDir, "outside.txt"), path.join(root, "escape.txt"));

  let allowed = true;
  const app = express();
  app.use("/file-download", createFileDownloadRouter({
    authorize: async () => {
      if (!allowed) throw new Error("You are no longer a channel member.");
      return { root };
    },
  }));
  const server = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const liveBase = `http://127.0.0.1:${server.address().port}`;

  const expired = createFileDownloadGrantUrl({
    baseUrl: "https://gateway.example",
    channelId: "C1",
    slug: "channel",
    ownerId: "U1",
    relative: "escape.txt",
    now: Date.now() - FILE_DOWNLOAD_GRANT_TTL_MS - 1,
  });
  assert.equal((await fetch(expired.replace("https://gateway.example", liveBase))).status, 410);

  const escaping = createFileDownloadGrantUrl({
    baseUrl: liveBase,
    channelId: "C1",
    slug: "channel",
    ownerId: "U1",
    relative: "escape.txt",
  });
  const escapeResponse = await fetch(escaping);
  assert.equal(escapeResponse.status, 403);
  assert.match(await escapeResponse.text(), /outside/i);

  await writeFile(path.join(root, "inside.txt"), "inside\n");
  const unauthorized = createFileDownloadGrantUrl({
    baseUrl: liveBase,
    channelId: "C1",
    slug: "channel",
    ownerId: "U1",
    relative: "inside.txt",
  });
  allowed = false;
  const denied = await fetch(unauthorized);
  assert.equal(denied.status, 403);
  assert.match(await denied.text(), /no longer a channel member/i);
  assert.equal((await fetch(unauthorized)).status, 410, "a denied grant is still consumed");
});
