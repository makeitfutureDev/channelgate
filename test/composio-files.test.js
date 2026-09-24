// The Composio staging flow: request a key, PUT the bytes, hand back a FileUploadable. Driven
// against an injected fetch so the whole three-step contract is asserted without a network.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import {
  COMPOSIO_UPLOAD_REQUEST_PATH,
  normalizeSlug,
  stageFileForComposio,
  toolkitFromToolSlug,
} from "../src/gateway/composio-files.js";
import { guessMimeType } from "../src/util/mime.js";

function ok(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

async function scratchFile(t, name, contents) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gateway-composio-files-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  await writeFile(file, contents);
  return file;
}

test("staging requests a key, uploads the bytes and returns the FileUploadable", async (t) => {
  const contents = Buffer.from("%PDF-1.7 proposal bytes\n");
  const file = await scratchFile(t, "PROPOSAL.pdf", contents);
  const calls = [];

  const staged = await stageFileForComposio({
    apiKey: "ck_secret",
    absolutePath: file,
    toolSlug: "googledrive_upload_file",
    apiBase: "https://backend.example.test/",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (String(url).endsWith(COMPOSIO_UPLOAD_REQUEST_PATH)) {
        return ok({ id: "req_1", key: "org/abc/PROPOSAL.pdf", new_presigned_url: "https://s3.example.test/put?sig=1" });
      }
      return ok({});
    },
  });

  assert.equal(calls.length, 2);

  const [request, upload] = calls;
  assert.equal(request.url, `https://backend.example.test${COMPOSIO_UPLOAD_REQUEST_PATH}`);
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers["x-api-key"], "ck_secret");
  assert.deepEqual(JSON.parse(request.init.body), {
    // The tool slug is upper-cased and the toolkit derived from its leading segment, so a caller
    // never has to state the same thing twice.
    toolkit_slug: "GOOGLEDRIVE",
    tool_slug: "GOOGLEDRIVE_UPLOAD_FILE",
    filename: "PROPOSAL.pdf",
    mimetype: "application/pdf",
    md5: createHash("md5").update(contents).digest("hex"),
  });

  assert.equal(upload.url, "https://s3.example.test/put?sig=1");
  assert.equal(upload.init.method, "PUT");
  assert.equal(upload.init.headers["Content-Type"], "application/pdf");
  assert.deepEqual(Buffer.from(upload.init.body), contents);
  // The presigned PUT must NOT carry our API key — it is a bearer URL for a third party.
  assert.equal(upload.init.headers["x-api-key"], undefined);

  assert.deepEqual(staged.file, { name: "PROPOSAL.pdf", mimetype: "application/pdf", s3key: "org/abc/PROPOSAL.pdf" });
  assert.equal(staged.bytes, contents.length);
  assert.equal(staged.deduplicated, false);
});

test("a deduplication hit returns the key without a second request", async (t) => {
  const file = await scratchFile(t, "notes.txt", "already there");
  let calls = 0;

  const staged = await stageFileForComposio({
    apiKey: "ck",
    absolutePath: file,
    toolSlug: "GMAIL_SEND_EMAIL",
    fetchImpl: async () => {
      calls++;
      // Composio deduplicates on the md5 and mints no presigned URL when it already holds the
      // bytes. That is a hit, not a failure.
      return ok({ key: "org/abc/notes.txt" });
    },
  });

  assert.equal(calls, 1);
  assert.equal(staged.deduplicated, true);
  assert.equal(staged.file.s3key, "org/abc/notes.txt");
  assert.equal(staged.file.mimetype, "text/plain");
  assert.equal(staged.toolkit, "GMAIL");
});

test("a failed upload request names the step and the status without leaking the key", async (t) => {
  const file = await scratchFile(t, "x.pdf", "x");
  await assert.rejects(
    stageFileForComposio({
      apiKey: "ck_secret_value",
      absolutePath: file,
      toolSlug: "GOOGLEDRIVE_UPLOAD_FILE",
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => "invalid api key" }),
    }),
    (error) => {
      assert.match(error.message, /upload request failed \(HTTP 401\)/);
      assert.match(error.message, /invalid api key/);
      assert.ok(!error.message.includes("ck_secret_value"));
      return true;
    },
  );
});

test("a failed storage PUT is reported as its own step", async (t) => {
  const file = await scratchFile(t, "x.pdf", "x");
  await assert.rejects(
    stageFileForComposio({
      apiKey: "ck",
      absolutePath: file,
      toolSlug: "GOOGLEDRIVE_UPLOAD_FILE",
      fetchImpl: async (url) => (String(url).includes("/files/upload/request")
        ? ok({ key: "k", new_presigned_url: "https://s3.example.test/put" })
        : { ok: false, status: 403, text: async () => "expired signature" }),
    }),
    /storage upload failed \(HTTP 403\): expired signature/,
  );
});

test("a response with no storage key is an error, not a silent success", async (t) => {
  const file = await scratchFile(t, "x.pdf", "x");
  await assert.rejects(
    stageFileForComposio({ apiKey: "ck", absolutePath: file, toolSlug: "GOOGLEDRIVE_UPLOAD_FILE", fetchImpl: async () => ok({ id: "req" }) }),
    /no storage key/,
  );
});

test("staging refuses an oversize file before any network call", async (t) => {
  const file = await scratchFile(t, "big.bin", Buffer.alloc(4096));
  let called = false;
  await assert.rejects(
    stageFileForComposio({
      apiKey: "ck",
      absolutePath: file,
      toolSlug: "GOOGLEDRIVE_UPLOAD_FILE",
      maxBytes: 1024,
      fetchImpl: async () => { called = true; return ok({}); },
    }),
    /staging limit is 1024/,
  );
  assert.equal(called, false);
});

test("staging refuses a missing key and a non-slug tool", async (t) => {
  const file = await scratchFile(t, "x.pdf", "x");
  await assert.rejects(
    stageFileForComposio({ apiKey: "", absolutePath: file, toolSlug: "GOOGLEDRIVE_UPLOAD_FILE" }),
    /no Composio API key/,
  );
  await assert.rejects(
    stageFileForComposio({ apiKey: "ck", absolutePath: file, toolSlug: "drop table; --" }),
    /must be a Composio slug/,
  );
});

test("slug normalization and toolkit derivation", () => {
  assert.equal(normalizeSlug("  googledrive_upload_file ", "tool"), "GOOGLEDRIVE_UPLOAD_FILE");
  assert.equal(toolkitFromToolSlug("HUBSPOT_CREATE_NOTE"), "HUBSPOT");
  assert.throws(() => normalizeSlug("has spaces", "tool"), /Composio slug/);
  assert.throws(() => normalizeSlug("a", "tool"), /Composio slug/);
});

test("unknown extensions fall back to octet-stream rather than guessing", () => {
  assert.equal(guessMimeType("deck.pptx"), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  assert.equal(guessMimeType("archive.unknownext"), "application/octet-stream");
  assert.equal(guessMimeType("README"), "application/octet-stream");
});
