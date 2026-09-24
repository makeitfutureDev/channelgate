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
  isConsumerKey,
  normalizeSlug,
  sandboxFileName,
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
    apiKey: "ak_secret",
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
  assert.equal(request.init.headers["x-api-key"], "ak_secret");
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
      apiKey: "ak_secret_value",
      absolutePath: file,
      toolSlug: "GOOGLEDRIVE_UPLOAD_FILE",
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => "invalid api key" }),
    }),
    (error) => {
      assert.match(error.message, /upload request failed \(HTTP 401\)/);
      assert.match(error.message, /invalid api key/);
      assert.ok(!error.message.includes("ak_secret_value"));
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

// ── Consumer keys (`ck_…`, the hosted MCP's credential): staged through the MCP workbench ─────

// A fake Composio MCP endpoint: answers initialize, swallows the notification, and executes the
// staging code's two shapes (append a base64 chunk / verify + mint a key) against an in-memory
// sandbox, the way the real workbench's stdout reports them.
function fakeWorkbench({ failWith = "", corrupt = false } = {}) {
  const calls = [];
  const files = new Map();
  const fetchImpl = async (url, init) => {
    const rpc = JSON.parse(init.body);
    calls.push({ url, key: init.headers["x-consumer-api-key"], rpc });
    const headers = new Map([["mcp-session-id", "wb-session"]]);
    const reply = (payload) => ({ ok: true, status: 200, headers: { get: (h) => headers.get(h) || null }, text: async () => (payload === null ? "" : JSON.stringify(payload)) });
    if (rpc.id === undefined) return reply(null);
    if (rpc.method !== "tools/call") return reply({ jsonrpc: "2.0", id: rpc.id, result: { capabilities: {} } });
    assert.equal(rpc.params.name, "COMPOSIO_REMOTE_WORKBENCH");
    const code = rpc.params.arguments.code_to_execute;
    const target = code.match(/open\('([^']+)'/)[1];
    let stdout = "";
    const chunk = code.match(/b64decode\('([^']*)'\)/);
    if (failWith) return reply({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify({ data: { stdout: "", error: failWith }, successful: false }) }] } });
    if (chunk) {
      const prior = code.includes("'wb'") ? Buffer.alloc(0) : files.get(target) || Buffer.alloc(0);
      files.set(target, Buffer.concat([prior, Buffer.from(chunk[1], "base64")]));
    } else {
      let data = files.get(target) || Buffer.alloc(0);
      if (corrupt) data = data.subarray(1);
      const md5 = createHash("md5").update(data).digest("hex");
      stdout = `CGSTAGE${JSON.stringify({ md5, bytes: data.length, s3key: `wb/${path.basename(target)}` })}\n`;
    }
    return reply({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify({ data: { stdout, error: "" }, successful: true }) }] } });
  };
  return { calls, files, fetchImpl };
}

test("a consumer key stages through the MCP workbench in chunks and never touches the REST API", async (t) => {
  const contents = Buffer.from("0123456789abcdefghij"); // 20 bytes → 3 chunks of 8
  const file = await scratchFile(t, "report.pdf", contents);
  const wb = fakeWorkbench();
  const staged = await stageFileForComposio({
    apiKey: "ck_consumer",
    absolutePath: file,
    toolSlug: "GOOGLEDRIVE_UPLOAD_FILE",
    mcpUrl: "https://mcp.example.test/mcp",
    workbenchChunkBytes: 8,
    fetchImpl: wb.fetchImpl,
  });
  assert.equal(staged.route, "workbench");
  assert.deepEqual(staged.file, { name: "report.pdf", mimetype: guessMimeType("report.pdf"), s3key: "wb/report.pdf" });
  assert.ok(wb.calls.every((call) => call.url === "https://mcp.example.test/mcp" && call.key === "ck_consumer"));
  const codes = wb.calls.filter((call) => call.rpc.method === "tools/call").map((call) => call.rpc.params.arguments.code_to_execute);
  assert.equal(codes.length, 4, "three chunks plus the verification call");
  assert.match(codes[0], /'wb'/);
  assert.ok(codes.slice(1, 3).every((code) => /'ab'/.test(code)), "later chunks append");
  assert.deepEqual([...wb.files.values()][0], contents, "the sandbox holds exactly the file's bytes");
  assert.match(codes[3], /get_mount_file_s3_key/);
});

test("the sandbox path cannot carry code: the file name is reduced to safe characters", async (t) => {
  const file = await scratchFile(t, "plain.txt", "x");
  const wb = fakeWorkbench();
  const staged = await stageFileForComposio({
    apiKey: "ck_consumer",
    absolutePath: file,
    toolSlug: "GOOGLEDRIVE_UPLOAD_FILE",
    filename: "q'); import os; os.system('id') #.txt",
    mcpUrl: "https://mcp.example.test/mcp",
    fetchImpl: wb.fetchImpl,
  });
  const code = wb.calls.find((call) => call.rpc.method === "tools/call").rpc.params.arguments.code_to_execute;
  assert.ok(!code.includes("import os; os.system"), "the caller's name never reaches the Python source");
  assert.match(code, /channelgate-stage\/[0-9a-f]{16}\/q_import_os_os.system_id_.txt'/);
  // The FileUploadable still carries the name the caller asked for.
  assert.equal(staged.file.name, "q'); import os; os.system('id') #.txt");
});

test("an incomplete transfer is refused rather than staged", async (t) => {
  const file = await scratchFile(t, "data.csv", "a,b\n1,2\n");
  const wb = fakeWorkbench({ corrupt: true });
  await assert.rejects(
    stageFileForComposio({ apiKey: "ck_consumer", absolutePath: file, toolSlug: "GOOGLEDRIVE_UPLOAD_FILE", mcpUrl: "https://mcp.example.test/mcp", fetchImpl: wb.fetchImpl }),
    /incomplete; nothing was staged/,
  );
});

test("a sandbox error surfaces as an error, without the key", async (t) => {
  const file = await scratchFile(t, "data.csv", "a,b\n");
  const wb = fakeWorkbench({ failWith: "PermissionError: /mnt/files is read-only" });
  await assert.rejects(
    stageFileForComposio({ apiKey: "ck_consumer", absolutePath: file, toolSlug: "GOOGLEDRIVE_UPLOAD_FILE", mcpUrl: "https://mcp.example.test/mcp", fetchImpl: wb.fetchImpl }),
    (error) => /PermissionError/.test(error.message) && !error.message.includes("ck_consumer"),
  );
});

test("a consumer key has its own, lower size cap, checked before any call", async (t) => {
  const file = await scratchFile(t, "big.bin", Buffer.alloc(64));
  const wb = fakeWorkbench();
  await assert.rejects(
    stageFileForComposio({ apiKey: "ck_consumer", absolutePath: file, toolSlug: "GOOGLEDRIVE_UPLOAD_FILE", mcpUrl: "https://mcp.example.test/mcp", workbenchMaxBytes: 32, fetchImpl: wb.fetchImpl }),
    /staging limit is 32 with a Composio consumer key/,
  );
  assert.equal(wb.calls.length, 0);
});

test("consumer and project keys are told apart by prefix", () => {
  assert.equal(isConsumerKey("ck_abc"), true);
  assert.equal(isConsumerKey("ak_abc"), false);
  assert.equal(isConsumerKey(""), false);
  assert.equal(sandboxFileName("../../etc/passwd"), "etc_passwd");
  assert.equal(sandboxFileName(""), "file");
});
