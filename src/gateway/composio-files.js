// Staging a channel file into Composio's own storage, daemon-side.
//
// Every Composio tool that takes a file — GOOGLEDRIVE_UPLOAD_FILE, GMAIL_SEND_EMAIL's attachments,
// SLACK_UPLOAD_FILE, and the rest — wants a `FileUploadable`: `{ name, mimetype, s3key }`, where
// `s3key` names bytes that ALREADY live in Composio's storage. There is no `content`, no `base64`
// and no `file_path` parameter anywhere in that shape. The MCP surface exposes no staging tool
// either, so a run that generated a PDF in its own container had no way to hand it over: the only
// routes left were relaying the file through the conversation in base64 chunks, or minting a
// public URL for GOOGLEDRIVE_UPLOAD_FROM_URL and pushing a confidential document through it.
//
// Composio documents a three-step REST flow instead, and that is what this module does:
//
//   1. POST <base>/api/v3.1/files/upload/request   (x-api-key)  → { key, new_presigned_url }
//   2. PUT the bytes to `new_presigned_url`
//   3. hand `{ name, mimetype, s3key: key }` to the tool
//
// Step 1 deduplicates on the md5, so a file staged twice can come back with no presigned URL at
// all — that is a HIT, not a failure, and step 2 is skipped.
//
// It runs in the daemon (or in the stdio MCP child on a host run), never in the channel container,
// for one reason: the Composio API key. The key is resolved here from the same channel/author/org
// precedence the MCP config uses, spent against Composio over TLS, and never returned to the
// model, written to the workspace or logged. The only thing that crosses back is the opaque
// `s3key`.
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { guessMimeType } from "../util/mime.js";

// Composio's own limit is larger, but a single buffered read is how this is implemented (the
// presigned PUT wants a known Content-Length and the md5 has to be computed before step 1 anyway),
// so the cap is really "how much is it reasonable to hold in the daemon at once". Deliverables —
// PDFs, decks, spreadsheets, images — sit far below it; a multi-gigabyte archive should not be
// travelling through a chat turn.
export const COMPOSIO_STAGE_MAX_BYTES = 100 * 1024 * 1024;

export const COMPOSIO_API_BASE = "https://backend.composio.dev";
export const COMPOSIO_UPLOAD_REQUEST_PATH = "/api/v3.1/files/upload/request";

export function composioApiBase() {
  const configured = String(process.env.COMPOSIO_API_BASE || "").trim().replace(/\/+$/, "");
  return configured || COMPOSIO_API_BASE;
}

// Composio's toolkit/tool slugs are upper-snake identifiers (`GOOGLEDRIVE`, `GMAIL_SEND_EMAIL`).
// Validate rather than pass through: these are interpolated into a JSON body that authenticates
// with our key, and a caller-shaped value has no business carrying anything else.
const SLUG_RE = /^[A-Za-z0-9_]{2,80}$/;

export function normalizeSlug(value, what) {
  const slug = String(value ?? "").trim().toUpperCase();
  if (!SLUG_RE.test(slug)) throw new Error(`${what} must be a Composio slug like GOOGLEDRIVE_UPLOAD_FILE`);
  return slug;
}

// A toolkit slug is the leading segment of a tool slug (GOOGLEDRIVE_UPLOAD_FILE → GOOGLEDRIVE),
// which is the only part of the pair a caller reliably gets wrong. Derive it when it is missing
// rather than making the model state the same thing twice.
export function toolkitFromToolSlug(toolSlug) {
  return normalizeSlug(toolSlug, "tool").split("_")[0];
}

function failure(step, status, body) {
  const detail = String(body || "").replace(/\s+/g, " ").trim().slice(0, 300);
  return new Error(`Composio ${step} failed (HTTP ${status})${detail ? `: ${detail}` : ""}`);
}

// ── Consumer keys: staging through the Composio MCP workbench ─────────────────────────────────
// The tokens this gateway stores for `composio-user` / `composio-agent` are Composio CONSUMER keys
// (`ck_…`) — the credential of Composio's hosted MCP, sent as `x-consumer-api-key`. The REST upload
// endpoint above does not accept them under either header (401 "Invalid API key" / "No
// authentication provided"), so with a consumer key the three-step flow cannot work, and it never
// did: every personal-mode stage failed before this route existed. What a consumer key CAN do is
// run code in the MCP's own workbench, whose `get_mount_file_s3_key(path)` puts a file from the
// sandbox's /mnt/files into the same storage and returns the s3key GOOGLEDRIVE_UPLOAD_FILE & co.
// expect — and that key is usable from any later MCP session on the same identity, which is what
// lets the daemon stage here and the model use the result in its own session.
//
// It still runs in the daemon, for the same reason as the REST route: the key never reaches the
// model, and neither do the file's bytes. They cross as base64 inside the code the daemon sends,
// in chunks, because one request above ~5 MB of base64 is rejected (413). All chunk calls go
// through ONE MCP session, so they land in the same sandbox and append to one file; a final call
// checks the md5 before minting the key. That makes this route slower than the REST one, hence its
// own, lower size cap and an overall deadline.
//
// The sandbox copy is deliberately NOT deleted afterwards: the s3key IS that mounted file's
// storage, and removing the file makes the upload fail with "the file does not exist in storage"
// (verified live). Ending the MCP session (HTTP DELETE) does not affect the file or the key (also
// verified). So the copy stays in that identity's Composio file storage — and on `composio-agent`
// backed by the organization key, that storage is shared by every conversation using the same
// key, whose own workbench can list it. The random directory name is not a secret.
export const COMPOSIO_WORKBENCH_STAGE_MAX_BYTES = 25 * 1024 * 1024;
export const COMPOSIO_WORKBENCH_CHUNK_BYTES = 768 * 1024;
export const COMPOSIO_WORKBENCH_DEADLINE_MS = 10 * 60_000;
const WORKBENCH_TOOL = "COMPOSIO_REMOTE_WORKBENCH";
const WORKBENCH_CALL_TIMEOUT_MS = 120_000;
const STAGE_MARKER = "CGSTAGE";

/**
 * A Composio PROJECT API key — the only kind the REST upload accepts. Anything else takes the
 * workbench route: the tokens a gateway stores are consumer keys, and src/util/redact.js notes
 * Composio tokens carry no guaranteed prefix, so the unknown case goes where stored tokens work.
 */
export function isProjectApiKey(key) {
  return /^ak_/.test(String(key || ""));
}

export function isConsumerKey(key) {
  return Boolean(String(key || "")) && !isProjectApiKey(key);
}

// The name becomes part of Python source, so it is reduced to characters that cannot end the
// string literal or start a statement. The FileUploadable keeps the real name; only the sandbox
// path uses this one.
export function sandboxFileName(name) {
  const cleaned = String(name || "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 80);
  return cleaned || "file";
}

// Every message that can reach the model passes through here. The daemon never writes the key into
// an error itself, but an upstream body can echo it back; and a sandbox traceback can quote a line
// of the base64 the daemon sent. Neither belongs in a reply.
export function scrubStagingText(text, key = "") {
  let out = String(text || "");
  if (key && String(key).length >= 6) out = out.split(String(key)).join("[redacted]");
  return out.replace(/[A-Za-z0-9+/=]{48,}/g, "[data]");
}

function mcpClient({ url, key, fetchImpl, deadline }) {
  let session = "";
  let nextId = 1;
  const signal = () => AbortSignal.any([AbortSignal.timeout(WORKBENCH_CALL_TIMEOUT_MS), deadline]);
  async function post(body) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "x-consumer-api-key": key,
          ...(session ? { "mcp-session-id": session } : {}),
        },
        body: JSON.stringify(body),
        signal: signal(),
      });
      const minted = response.headers?.get?.("mcp-session-id");
      if (minted) session = minted;
      const raw = await response.text();
      return { response, raw };
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new Error("the Composio workbench timed out");
      throw error;
    }
  }
  async function rpc(method, params) {
    const id = nextId++;
    const { response, raw } = await post({ jsonrpc: "2.0", id, method, params });
    if (!response.ok) throw failure(`workbench ${method}`, response.status, raw);
    return parseRpc(raw, id);
  }
  return {
    async open() {
      const init = await rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "channelgate-stage", version: "1" },
      });
      if (init?.error) throw new Error(`Composio workbench refused the session: ${rpcMessage(init.error)}`);
      await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    },
    async run(code) {
      const reply = await rpc("tools/call", { name: WORKBENCH_TOOL, arguments: { code_to_execute: code, thought: "Stage a channel file for a Composio tool." } });
      if (reply?.error) throw new Error(`Composio workbench call failed: ${rpcMessage(reply.error)}`);
      return workbenchOutput(reply);
    },
    async close() {
      if (!session) return;
      await fetchImpl(url, { method: "DELETE", headers: { "x-consumer-api-key": key, "mcp-session-id": session }, signal: AbortSignal.timeout(10_000) }).catch(() => {});
    },
  };
}

// A JSON-RPC reply arrives either as plain JSON or as server-sent events. Only the message that
// answers THIS request counts: same id, and no `method` (a server-to-client request such as a
// ping also carries an id). An event's data may span several `data:` lines.
function parseRpc(raw, id) {
  const text = String(raw || "");
  const candidates = [];
  if (/^\s*[[{]/.test(text)) {
    try {
      const parsed = JSON.parse(text);
      candidates.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      /* fall through to SSE */
    }
  }
  if (!candidates.length) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      if (!data) continue;
      try {
        candidates.push(JSON.parse(data));
      } catch {
        /* not JSON — skip */
      }
    }
  }
  const match = candidates.find((message) => message && message.id === id && !message.method);
  if (!match) throw new Error("the Composio workbench returned no answer to the request");
  return match;
}

function rpcMessage(error) {
  return String(error?.message || JSON.stringify(error || {})).slice(0, 200);
}

// The tool's text content is itself JSON (`{ data: { stdout, error }, successful }`). Return the
// sandbox's stdout, or throw with the sandbox's own error so a Python failure is not mistaken for
// an empty success. An MCP-level tool error (`isError`) is a failure whatever its text.
function workbenchOutput(reply) {
  const text = (reply?.result?.content || []).map((part) => part?.text || "").join("\n");
  if (reply?.result?.isError) throw new Error(`Composio workbench error: ${text.slice(0, 200) || "the tool reported a failure"}`);
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const data = parsed?.data || {};
  const error = String(data.error || parsed?.error || "").trim();
  if (error || parsed?.successful === false) {
    throw new Error(`Composio workbench error: ${(error || "the sandbox reported a failure").slice(0, 200)}`);
  }
  return String(data.stdout ?? data.results ?? text);
}

/**
 * Stage bytes through the Composio MCP workbench with a consumer key. `fetchImpl` is injectable so
 * the tests drive the whole session; `chunkBytes` is injectable so they can force several chunks.
 */
export async function stageViaWorkbench({
  consumerKey,
  mcpUrl,
  bytes,
  name,
  md5,
  fetchImpl = fetch,
  chunkBytes = COMPOSIO_WORKBENCH_CHUNK_BYTES,
  deadlineMs = COMPOSIO_WORKBENCH_DEADLINE_MS,
} = {}) {
  if (!mcpUrl) throw new Error("no Composio MCP URL is configured for workbench staging");
  const client = mcpClient({ url: mcpUrl, key: consumerKey, fetchImpl, deadline: AbortSignal.timeout(deadlineMs) });
  try {
    await client.open();
    // A fresh directory per stage, so two stages in one sandbox can never append to each other.
    const target = `/mnt/files/channelgate-stage/${randomBytes(8).toString("hex")}/${sandboxFileName(name)}`;
    const step = Math.max(1, Math.floor(chunkBytes));
    for (let offset = 0, first = true; offset < bytes.length || first; offset += step, first = false) {
      const chunk = bytes.subarray(offset, offset + step).toString("base64");
      await client.run(
        "import base64, os\n" +
        `os.makedirs(os.path.dirname('${target}'), exist_ok=True)\n` +
        `with open('${target}', '${first ? "wb" : "ab"}') as handle:\n` +
        `    handle.write(base64.b64decode('${chunk}'))\n`,
      );
      if (bytes.length === 0) break;
    }
    const output = await client.run(
      "import hashlib, json\n" +
      `data = open('${target}', 'rb').read()\n` +
      `digest = hashlib.md5(data).hexdigest()\n` +
      `key = get_mount_file_s3_key('${target}') if digest == '${md5}' else None\n` +
      "key = key[0] if isinstance(key, (tuple, list)) else key\n" +
      `print('${STAGE_MARKER}' + json.dumps({'md5': digest, 'bytes': len(data), 's3key': key}))\n`,
    );
    const line = String(output).split("\n").find((entry) => entry.startsWith(STAGE_MARKER));
    if (!line) throw new Error("the Composio workbench did not report the staged file");
    const report = JSON.parse(line.slice(STAGE_MARKER.length));
    if (report.md5 !== md5 || report.bytes !== bytes.length) {
      throw new Error("the file arrived in the Composio workbench incomplete; nothing was staged");
    }
    const s3key = String(report.s3key || "");
    if (!s3key) throw new Error("the Composio workbench returned no storage key");
    return s3key;
  } finally {
    await client.close();
  }
}

// Read at most `limit` bytes from an already-open descriptor. The size is taken from the SAME
// descriptor (never a second stat of a path), and the read stops one byte past the limit, so a file
// that grows after the check can neither exceed the cap nor be swapped for another file.
async function readBounded(handle, limit, consumer) {
  const tooLarge = (size) => new Error(`file is ${size} bytes; the staging limit is ${limit}${consumer ? " with a Composio consumer key" : ""}`);
  const info = await handle.stat();
  if (!info.isFile()) throw new Error("only a regular file can be staged");
  if (info.size > limit) throw tooLarge(info.size);
  const parts = [];
  let total = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
    if (!bytesRead) break;
    total += bytesRead;
    if (total > limit) throw tooLarge(`more than ${limit}`);
    parts.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(parts, total);
}

/**
 * Stage one file into Composio storage.
 *
 * Pass `handle` — the descriptor `openConfinedFile` proved to be inside the channel's working
 * folder — and the bytes are read from THAT descriptor. Reopening the file by path (as this module
 * once did) let a symlink swapped in between the proof and the read redirect the daemon, which runs
 * unsandboxed, to any file the operator can read. `absolutePath` remains for direct callers and is
 * opened with O_NOFOLLOW; this module does no path authorization of its own and must never be
 * handed a model-supplied path. `fetchImpl` is injectable so the tests drive the whole flow.
 *
 * Returns the exact `FileUploadable` the Composio tool expects, plus `deduplicated` so the caller
 * can say whether bytes actually moved. Every error message is scrubbed of the key.
 */
export async function stageFileForComposio({
  apiKey,
  handle = null,
  absolutePath = "",
  toolSlug,
  toolkitSlug = "",
  filename = "",
  mimetype = "",
  apiBase = "",
  mcpUrl = "",
  maxBytes = COMPOSIO_STAGE_MAX_BYTES,
  workbenchMaxBytes = COMPOSIO_WORKBENCH_STAGE_MAX_BYTES,
  workbenchChunkBytes = COMPOSIO_WORKBENCH_CHUNK_BYTES,
  workbenchDeadlineMs = COMPOSIO_WORKBENCH_DEADLINE_MS,
  fetchImpl = fetch,
} = {}) {
  const key = String(apiKey || "");
  try {
    return await stage();
  } catch (error) {
    throw new Error(scrubStagingText(error?.message || String(error), key));
  }

  async function stage() {
    if (!key) throw new Error("no Composio API key resolved for this identity");
    const tool = normalizeSlug(toolSlug, "tool");
    const toolkit = toolkitSlug ? normalizeSlug(toolkitSlug, "toolkit") : toolkitFromToolSlug(tool);
    const name = String(filename || path.basename(absolutePath || "")).trim();
    if (!name) throw new Error("the file to stage needs a name");

    const consumer = isConsumerKey(key);
    const limit = consumer ? Math.min(maxBytes, workbenchMaxBytes) : maxBytes;
    let bytes;
    if (handle) {
      bytes = await readBounded(handle, limit, consumer);
    } else {
      const own = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        bytes = await readBounded(own, limit, consumer);
      } finally {
        await own.close().catch(() => {});
      }
    }

    const type = String(mimetype || "").trim() || guessMimeType(name);
    const md5 = createHash("md5").update(bytes).digest("hex");

    if (consumer) {
      const s3key = await stageViaWorkbench({ consumerKey: key, mcpUrl, bytes, name, md5, fetchImpl, chunkBytes: workbenchChunkBytes, deadlineMs: workbenchDeadlineMs });
      return { file: { name, mimetype: type, s3key }, bytes: bytes.length, deduplicated: false, toolkit, tool, route: "workbench" };
    }

    const base = String(apiBase || "").trim().replace(/\/+$/, "") || composioApiBase();
    const requested = await fetchImpl(`${base}${COMPOSIO_UPLOAD_REQUEST_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify({ toolkit_slug: toolkit, tool_slug: tool, filename: name, mimetype: type, md5 }),
    });
    if (!requested.ok) throw failure("upload request", requested.status, await requested.text().catch(() => ""));
    const grant = (await requested.json().catch(() => ({}))) || {};
    const s3key = String(grant.key || grant.s3key || "");
    if (!s3key) throw new Error("Composio returned no storage key for the upload request");

    // Dedup hit: Composio already holds these exact bytes and mints no presigned URL for them.
    const presigned = String(grant.new_presigned_url || grant.presigned_url || "");
    if (presigned) {
      const put = await fetchImpl(presigned, {
        method: "PUT",
        headers: { "Content-Type": type, "Content-Length": String(bytes.length) },
        body: bytes,
      });
      if (!put.ok) throw failure("storage upload", put.status, await put.text().catch(() => ""));
    }

    return {
      file: { name, mimetype: type, s3key },
      bytes: bytes.length,
      deduplicated: !presigned,
      toolkit,
      tool,
      route: "rest",
    };
  }
}
