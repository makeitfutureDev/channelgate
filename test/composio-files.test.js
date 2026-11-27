// The Composio staging flow: request a key, PUT the bytes, hand back a FileUploadable. Driven
// against an injected fetch so the whole three-step contract is asserted without a network.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm, symlink, unlink, writeFile } from "node:fs/promises";

import {
  COMPOSIO_UPLOAD_REQUEST_PATH,
  isConsumerKey,
  isProjectApiKey,
  normalizeSlug,
  sandboxFileName,
  scrubStagingText,
  stageFileForComposio,
  toolkitFromToolSlug,
  verifyStoredFile,
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
    apiKey: "ak_test",
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
      apiKey: "ak_test",
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
    stageFileForComposio({ apiKey: "ak_test", absolutePath: file, toolSlug: "GOOGLEDRIVE_UPLOAD_FILE", fetchImpl: async () => ok({ id: "req" }) }),
    /no storage key/,
  );
});

test("staging refuses an oversize file before any network call", async (t) => {
  const file = await scratchFile(t, "big.bin", Buffer.alloc(4096));
  let called = false;
  await assert.rejects(
    stageFileForComposio({
      apiKey: "ak_test",
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
// staging code's two shapes (append a base64 chunk / verify + upload) against an in-memory
// sandbox, the way the real workbench's stdout reports them, then serves the verification GET of
// the uploaded object's download URL. `sse` answers as server-sent events with a server-to-client
// ping (it has an id AND a method) ahead of the real answer. `noHelper` plays a workbench without
// `upload_local_file` (the mount fallback: a key, no URL); `uploadError` is the helper's own
// error; `verifyStatus` / `storedBytes` shape the verification GET's answer.
function fakeWorkbench({ failWith = "", corrupt = false, sse = false, isError = false, rpcError = false, httpStatus = 0, echoKeyInError = false, noHelper = false, uploadError = "", verifyStatus = 206, storedBytes = null } = {}) {
  const calls = [];
  const files = new Map();
  const uploaded = new Map();
  const fetchImpl = async (url, init) => {
    if (init.method === "GET") {
      calls.push({ url, method: "GET", headers: init.headers, redirect: init.redirect });
      const object = uploaded.get(url);
      if (!object || verifyStatus === 404) return { ok: false, status: 404, headers: { get: () => null }, text: async () => "NoSuchKey", body: { cancel: async () => {} } };
      const size = storedBytes ?? object.length;
      const headers = verifyStatus === 206
        ? { "content-range": `bytes 0-0/${size}`, "content-length": "1" }
        : { "content-length": String(size) };
      return { ok: true, status: verifyStatus, headers: { get: (h) => headers[h.toLowerCase()] ?? null }, body: { cancel: async () => {} } };
    }
    if (init.method === "DELETE") {
      calls.push({ url, method: "DELETE", headers: init.headers });
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => "" };
    }
    const rpc = JSON.parse(init.body);
    calls.push({ url, method: "POST", headers: init.headers, key: init.headers["x-consumer-api-key"], rpc });
    const respond = (payload) => {
      const body = payload === null ? "" : sse
        ? `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: payload.id, method: "ping" })}\n\nevent: message\ndata: ${JSON.stringify(payload)}\n\n`
        : JSON.stringify(payload);
      return { ok: true, status: 200, headers: { get: (h) => (h === "mcp-session-id" ? "wb-session" : null) }, text: async () => body };
    };
    if (rpc.id === undefined) return respond(null);
    if (rpc.method !== "tools/call") return respond({ jsonrpc: "2.0", id: rpc.id, result: { capabilities: {} } });
    if (httpStatus) return { ok: false, status: httpStatus, headers: { get: () => null }, text: async () => `upstream said no to ${echoKeyInError ? init.headers["x-consumer-api-key"] : "you"}` };
    if (rpcError) return respond({ jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: "tool unavailable" } });
    const answer = (text, extra = {}) => respond({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text }], ...extra } });
    if (isError) return answer("upstream tool exploded", { isError: true });
    if (failWith !== "") {
      const error = echoKeyInError ? `${failWith} (key ${init.headers["x-consumer-api-key"]})` : failWith;
      return answer(JSON.stringify({ data: { stdout: "", error }, successful: false }));
    }
    const code = rpc.params.arguments.code_to_execute;
    const target = code.match(/open\('([^']+)'/)[1];
    let stdout = "";
    const chunk = code.match(/b64decode\('([^']*)'\)/);
    if (chunk) {
      const prior = code.includes("'wb'") ? Buffer.alloc(0) : files.get(target) || Buffer.alloc(0);
      files.set(target, Buffer.concat([prior, Buffer.from(chunk[1], "base64")]));
    } else {
      let data = files.get(target) || Buffer.alloc(0);
      if (corrupt) data = data.subarray(1);
      const md5 = createHash("md5").update(data).digest("hex");
      // The real cell uploads only when the md5 matched; the fake mirrors that so a corrupt
      // transfer never "uploads".
      const matched = code.includes(`'${md5}'`);
      const s3key = `session_scope/ok_x/pr_y/trs_z/files/${path.basename(target)}`;
      let report;
      if (!matched) report = { md5, bytes: data.length, s3key: null, url: null, error: "", route: "upload" };
      else if (uploadError) report = { md5, bytes: data.length, s3key: null, url: null, error: uploadError, route: "upload" };
      else if (noHelper) report = { md5, bytes: data.length, s3key, url: null, error: "", route: "mount" };
      else {
        const url = `https://backend.example.test/api/v3/sl/${path.basename(target)}`;
        uploaded.set(url, data);
        report = { md5, bytes: data.length, s3key, url, error: "", route: "upload" };
      }
      stdout = `CGSTAGE${JSON.stringify(report)}\n`;
    }
    return answer(JSON.stringify({ data: { stdout, error: "" }, successful: true }));
  };
  const toolCalls = () => calls.filter((call) => call.rpc?.method === "tools/call");
  return { calls, files, uploaded, fetchImpl, toolCalls };
}

const MCP = "https://mcp.example.test/mcp";
const stage = (overrides) => stageFileForComposio({ apiKey: "ck_consumer", toolSlug: "GOOGLEDRIVE_UPLOAD_FILE", mcpUrl: MCP, ...overrides });

test("a consumer key stages through the MCP workbench in chunks, in ONE session, and never touches REST", async (t) => {
  const contents = Buffer.from("0123456789abcdefghij"); // 20 bytes → 3 chunks of 8
  const file = await scratchFile(t, "report.pdf", contents);
  const wb = fakeWorkbench();
  const staged = await stage({ absolutePath: file, workbenchChunkBytes: 8, fetchImpl: wb.fetchImpl });
  assert.equal(staged.route, "workbench");
  assert.deepEqual(staged.file, { name: "report.pdf", mimetype: guessMimeType("report.pdf"), s3key: "session_scope/ok_x/pr_y/trs_z/files/report.pdf" });
  const mcpCalls = wb.calls.filter((call) => call.method !== "GET");
  assert.ok(mcpCalls.every((call) => call.url === MCP && call.headers["x-consumer-api-key"] === "ck_consumer"));
  // Every request after initialize carries the session the server minted: the sandbox only keeps
  // the appended chunks for the life of that one session.
  const afterInit = mcpCalls.slice(1);
  assert.ok(afterInit.length >= 5 && afterInit.every((call) => call.headers["mcp-session-id"] === "wb-session"), "the session id is sent back on every later request");
  const codes = wb.toolCalls().map((call) => call.rpc.params.arguments.code_to_execute);
  assert.equal(codes.length, 4, "three chunks plus the verify-and-upload call");
  assert.match(codes[0], /'wb'/);
  assert.ok(codes.slice(1, 3).every((code) => /'ab'/.test(code)), "later chunks append");
  assert.deepEqual([...wb.files.values()][0], contents, "the sandbox holds exactly the file's bytes");
  // The chunks are assembled under the sandbox's own /tmp, never on the s3fs mount, and the final
  // cell uploads with the workbench's checked helper; the mount key is only the fallback.
  assert.ok(codes.every((code) => /open\('\/tmp\/channelgate-stage\//.test(code)), "never written under /mnt/files");
  assert.match(codes[3], /upload_local_file\('\/tmp\/channelgate-stage\//);
  assert.match(codes[3], /'upload_local_file' in globals\(\)/);
  assert.match(codes[3], /get_mount_file_s3_key/, "the mount route remains the fallback");
  assert.match(codes[3], /shutil\.rmtree/, "the temporary copy is removed; the s3key names the uploaded object");
  // The uploaded object was then PROVEN retrievable with a one-byte ranged GET, before the key was
  // returned — and the session is ended last.
  const verify = wb.calls.find((call) => call.method === "GET");
  assert.ok(verify, "the download URL was fetched");
  assert.equal(verify.url, "https://backend.example.test/api/v3/sl/report.pdf");
  assert.equal(verify.headers.Range, "bytes=0-0");
  assert.equal(verify.redirect, "follow", "the helper's URL is a redirect to the presigned object");
  assert.ok(!verify.headers["x-consumer-api-key"], "the key is not sent to storage");
  assert.equal(wb.calls.at(-1).method, "DELETE");
});

test("a key is never returned for an object storage cannot serve", async (t) => {
  const file = await scratchFile(t, "invoice.pdf", "%PDF-1.4 invoice");
  // The failure this exists for: the upload "succeeded" but a GET of the object is a 404 — exactly
  // what Drive, Gmail and Slack would then hit. The tool must fail, naming the status.
  const missing = fakeWorkbench({ verifyStatus: 404 });
  await assert.rejects(stage({ absolutePath: file, fetchImpl: missing.fetchImpl }), /cannot be retrieved \(HTTP 404\)/);
  // The stored object is a different size than what was staged.
  const short = fakeWorkbench({ storedBytes: 3 });
  await assert.rejects(stage({ absolutePath: file, fetchImpl: short.fetchImpl }), /stored file is 3 bytes, not the 16 staged/);
  // A server that ignores Range and answers 200 with the right Content-Length passes.
  const whole = fakeWorkbench({ verifyStatus: 200 });
  const staged = await stage({ absolutePath: file, fetchImpl: whole.fetchImpl });
  assert.equal(staged.file.s3key, "session_scope/ok_x/pr_y/trs_z/files/invoice.pdf");
  // The helper's own error is surfaced as the staging error, and no key is handed out.
  const refused = fakeWorkbench({ uploadError: "Failed to upload to S3. Status: 403, Response: AccessDenied" });
  await assert.rejects(stage({ absolutePath: file, fetchImpl: refused.fetchImpl }), /could not upload the file: Failed to upload to S3\. Status: 403/);
  // A verification that cannot even be attempted is a failure too, with no key.
  const unreachable = fakeWorkbench();
  const dropping = async (url, init) => {
    if (init.method === "GET") throw new Error("ECONNRESET");
    return unreachable.fetchImpl(url, init);
  };
  await assert.rejects(stage({ absolutePath: file, fetchImpl: dropping }), /could not be verified in Composio storage: ECONNRESET/);
});

test("a workbench without the upload helper falls back to the mount key, unverified", async (t) => {
  const file = await scratchFile(t, "legacy.txt", "legacy bytes");
  const wb = fakeWorkbench({ noHelper: true });
  const staged = await stage({ absolutePath: file, fetchImpl: wb.fetchImpl });
  assert.equal(staged.file.s3key, "session_scope/ok_x/pr_y/trs_z/files/legacy.txt");
  assert.ok(!wb.calls.some((call) => call.method === "GET"), "no download URL, so nothing to verify");
});

test("verifyStoredFile accepts an empty object on any 2xx and reads the ranged total", async () => {
  const seen = [];
  const serve = (status, headers = {}) => async (url, init) => {
    seen.push(init);
    return { ok: status < 300, status, headers: { get: (h) => headers[h.toLowerCase()] ?? null }, body: { cancel: async () => {} } };
  };
  await verifyStoredFile({ url: "https://x.test/a", bytes: 0, fetchImpl: serve(200) });
  assert.deepEqual(seen[0].headers, {}, "an empty file is not ranged");
  await verifyStoredFile({ url: "https://x.test/a", bytes: 10, fetchImpl: serve(206, { "content-range": "bytes 0-0/10" }) });
  await assert.rejects(verifyStoredFile({ url: "https://x.test/a", bytes: 10, fetchImpl: serve(206, { "content-range": "bytes 0-0/11" }) }), /is 11 bytes, not the 10 staged/);
  await assert.rejects(verifyStoredFile({ url: "https://x.test/a", bytes: 10, fetchImpl: serve(403) }), /HTTP 403/);
});

test("zero-length files and exact chunk multiples both reassemble exactly", async (t) => {
  for (const [label, contents, chunks] of [["empty", Buffer.alloc(0), 1], ["exact", Buffer.from("abcdefgh12345678"), 2]]) {
    const file = await scratchFile(t, `${label}.txt`, contents);
    const wb = fakeWorkbench();
    const staged = await stage({ absolutePath: file, workbenchChunkBytes: 8, fetchImpl: wb.fetchImpl });
    assert.equal(staged.bytes, contents.length, label);
    assert.equal(wb.toolCalls().length, chunks + 1, `${label}: ${chunks} write call(s) + verify`);
    assert.deepEqual([...wb.files.values()][0], contents, label);
  }
});

test("server-sent events are parsed, and a server ping is never taken for the answer", async (t) => {
  const file = await scratchFile(t, "sse.txt", "hello");
  const wb = fakeWorkbench({ sse: true });
  const staged = await stage({ absolutePath: file, fetchImpl: wb.fetchImpl });
  assert.equal(staged.file.s3key, "session_scope/ok_x/pr_y/trs_z/files/sse.txt");
});

test("the bytes come from the proven descriptor, even if the path is swapped for a symlink", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gateway-composio-race-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const inside = path.join(dir, "deliverable.txt");
  const outside = path.join(dir, "operator-secret.txt");
  await writeFile(inside, "the deliverable\n");
  await writeFile(outside, "OPERATOR SECRET\n");
  const handle = await open(inside, constants.O_RDONLY | constants.O_NOFOLLOW);
  t.after(() => handle.close().catch(() => {}));
  // The race the confinement proof is meant to win: after the proof, the container replaces the
  // proven name with a symlink to a file outside the folder.
  await unlink(inside);
  await symlink(outside, inside);
  const wb = fakeWorkbench();
  const staged = await stage({ handle, filename: "deliverable.txt", fetchImpl: wb.fetchImpl });
  assert.deepEqual([...wb.files.values()][0], Buffer.from("the deliverable\n"), "what was proven is what was sent");
  assert.equal(staged.bytes, 16);
  // A direct caller handing a path gets O_NOFOLLOW: a symlink is refused, not followed.
  await assert.rejects(stage({ absolutePath: inside, fetchImpl: wb.fetchImpl }), /ELOOP|symbolic link/i);
});

test("a file that grows past the cap after the size check is refused, not read whole", async () => {
  let reads = 0;
  const growing = {
    stat: async () => ({ isFile: () => true, size: 4 }),
    read: async (buffer) => {
      reads += 1;
      buffer.fill(0x61, 0, 16);
      return { bytesRead: 16 };
    },
  };
  const wb = fakeWorkbench();
  await assert.rejects(stage({ handle: growing, filename: "grow.bin", workbenchMaxBytes: 40, fetchImpl: wb.fetchImpl }), /staging limit is 40/);
  assert.ok(reads <= 3, "reading stops one chunk past the limit");
  assert.equal(wb.calls.length, 0, "nothing was sent");
});

test("the sandbox path cannot carry code: the file name is reduced to safe characters", async (t) => {
  const file = await scratchFile(t, "plain.txt", "x");
  const wb = fakeWorkbench();
  const staged = await stage({ absolutePath: file, filename: "q'); import os; os.system('id') #.txt", fetchImpl: wb.fetchImpl });
  const code = wb.toolCalls()[0].rpc.params.arguments.code_to_execute;
  assert.ok(!code.includes("import os; os.system"), "the caller's name never reaches the Python source");
  assert.match(code, /channelgate-stage\/[0-9a-f]{16}\/q_import_os_os.system_id_.txt'/);
  assert.equal(staged.file.name, "q'); import os; os.system('id') #.txt", "the FileUploadable keeps the real name");
});

test("every workbench failure mode is an error, and none carries the key", async (t) => {
  const file = await scratchFile(t, "data.csv", "a,b\n1,2\n");
  const cases = [
    [{ corrupt: true }, /incomplete; nothing was staged/],
    [{ failWith: "PermissionError: /tmp is read-only", echoKeyInError: true }, /PermissionError/],
    [{ isError: true }, /upstream tool exploded/],
    [{ rpcError: true }, /tool unavailable/],
    [{ httpStatus: 500, echoKeyInError: true }, /HTTP 500/],
  ];
  for (const [options, pattern] of cases) {
    const wb = fakeWorkbench(options);
    await assert.rejects(stage({ absolutePath: file, fetchImpl: wb.fetchImpl }), (error) => {
      assert.match(error.message, pattern, JSON.stringify(options));
      assert.ok(!error.message.includes("ck_consumer"), `no key in: ${error.message}`);
      return true;
    });
  }
  // successful:false with NO error text still fails.
  const silent = fakeWorkbench();
  const failing = async (url, init) => {
    const reply = await silent.fetchImpl(url, init);
    const rpc = init.body ? JSON.parse(init.body) : {};
    if (rpc.method !== "tools/call") return reply;
    return { ...reply, text: async () => JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify({ data: { stdout: "", error: "" }, successful: false }) }] } }) };
  };
  await assert.rejects(stage({ absolutePath: file, fetchImpl: failing }), /the sandbox reported a failure/);
});

test("an upstream body that echoes the key is scrubbed on the REST route too", async (t) => {
  const file = await scratchFile(t, "x.pdf", "%PDF");
  await assert.rejects(
    stageFileForComposio({
      apiKey: "ak_project_key_value",
      absolutePath: file,
      toolSlug: "GOOGLEDRIVE_UPLOAD_FILE",
      apiBase: "https://backend.example.test",
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => `{"message":"Invalid API key: ak_project_key_value"}` }),
    }),
    (error) => /HTTP 401/.test(error.message) && !error.message.includes("ak_project_key_value") && /\[redacted\]/.test(error.message),
  );
});

test("a hung workbench is bounded by the overall deadline", async (t) => {
  const file = await scratchFile(t, "slow.txt", "slow");
  const hanging = (url, init) => new Promise((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });
  // AbortSignal.timeout's timer is unref'd: in the daemon the event loop is always alive, but a
  // lone test process would exit before it fired. Hold the loop open for the test's duration.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(stage({ absolutePath: file, fetchImpl: hanging, workbenchDeadlineMs: 50 }), /timed out/);
  } finally {
    clearInterval(keepAlive);
  }
});

test("a consumer key has its own, lower size cap, checked before any call", async (t) => {
  const file = await scratchFile(t, "big.bin", Buffer.alloc(64));
  const wb = fakeWorkbench();
  await assert.rejects(stage({ absolutePath: file, workbenchMaxBytes: 32, fetchImpl: wb.fetchImpl }), /staging limit is 32 with a Composio consumer key/);
  assert.equal(wb.calls.length, 0);
});

test("only a known project key takes the REST route; everything else is a consumer key", () => {
  assert.equal(isProjectApiKey("ak_abc"), true);
  assert.equal(isConsumerKey("ck_abc"), true);
  assert.equal(isConsumerKey("some-unprefixed-token"), true, "an unknown shape goes where stored tokens work");
  assert.equal(isConsumerKey("ak_abc"), false);
  assert.equal(isConsumerKey(""), false);
  assert.equal(sandboxFileName("../../etc/passwd"), "etc_passwd");
  assert.equal(sandboxFileName(""), "file");
  assert.equal(scrubStagingText("key ck_secret1 and " + "A".repeat(60), "ck_secret1"), "key [redacted] and [data]");
});
