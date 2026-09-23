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
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
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

/**
 * Stage one already-resolved absolute path into Composio storage.
 *
 * `absolutePath` must already have been confined to the channel's working folder by the caller —
 * this module does no path authorization of its own and must never be handed a model-supplied
 * path directly. `fetchImpl` is injectable so the tests can drive the whole three-step flow
 * without a network.
 *
 * Returns the exact `FileUploadable` the Composio tool expects, plus `deduplicated` so the caller
 * can say whether bytes actually moved.
 */
export async function stageFileForComposio({
  apiKey,
  absolutePath,
  toolSlug,
  toolkitSlug = "",
  filename = "",
  mimetype = "",
  apiBase = "",
  maxBytes = COMPOSIO_STAGE_MAX_BYTES,
  fetchImpl = fetch,
} = {}) {
  const key = String(apiKey || "");
  if (!key) throw new Error("no Composio API key resolved for this identity");
  const tool = normalizeSlug(toolSlug, "tool");
  const toolkit = toolkitSlug ? normalizeSlug(toolkitSlug, "toolkit") : toolkitFromToolSlug(tool);
  const name = String(filename || path.basename(absolutePath || "")).trim();
  if (!name) throw new Error("the file to stage needs a name");

  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error("only a regular file can be staged");
  if (info.size > maxBytes) throw new Error(`file is ${info.size} bytes; the staging limit is ${maxBytes}`);

  // O_NOFOLLOW on the final open, for the same reason the download router uses it: the caller
  // proved this path at lookup time, and a symlink swapped in between then and now must not
  // redirect the read.
  const handle = await open(absolutePath, "r");
  let bytes;
  try {
    bytes = await handle.readFile();
  } finally {
    await handle.close().catch(() => {});
  }

  const type = String(mimetype || "").trim() || guessMimeType(name);
  const md5 = createHash("md5").update(bytes).digest("hex");
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
  };
}
