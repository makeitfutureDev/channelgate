// Upload a file/snippet to Slack with the workspace BOT token (needs the `files:write` scope).
// Used by the gateway control MCP so the agent can post a big/wide table as a CSV/TSV file that
// Slack renders as a scrollable spreadsheet preview — far better than a cramped message code block
// or a 100-row Slack List. Runs in the gateway's own subprocess (outside the run sandbox), so it
// needs neither Bash nor network egress in the channel; the daemon does the upload.
//
// Uses Slack's modern external-upload flow (files.upload is deprecated):
//   1. files.getUploadURLExternal(filename, length)         → { upload_url, file_id }
//   2. POST the bytes to upload_url (multipart/form-data)
//   3. files.completeUploadExternal({ files, channel_id?, thread_ts?, initial_comment? })
import { resolveSlackConfig } from "../config/settings.js";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";

export const MAX_FILE_UPLOAD_BYTES = 25 * 1024 * 1024;

const API = "https://slack.com/api";

function botToken() {
  return resolveSlackConfig().botToken || "";
}

// A safe filename derived from a title (or a default), preserving a sensible extension. `.csv`/
// `.tsv` make Slack render a spreadsheet grid; text/code extensions render a text snippet.
export function snippetFilename(title, filename, fallbackExt = "csv") {
  const explicit = String(filename || "").trim();
  if (explicit) return explicit.replace(/[/\\]/g, "_").slice(0, 120);
  const base = String(title || "table").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "table";
  return `${base.slice(0, 80)}.${fallbackExt}`;
}

function safeLocalFilename(filename) {
  return (path.basename(String(filename || "file")) || "file").replace(/[\r\n]/g, "_").slice(0, 120);
}

async function slackForm(method, params) {
  const token = botToken();
  if (!token) throw new Error("Slack bot token isn't configured (set it in the admin Settings).");
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error || "unknown error"}`);
  return data;
}

async function slackJson(method, body) {
  const token = botToken();
  if (!token) throw new Error("Slack bot token isn't configured (set it in the admin Settings).");
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error || "unknown error"}`);
  return data;
}

async function uploadBytes({ bytes, filename, title = "", channelId = "", threadTs = "", comment = "" }) {
  const name = safeLocalFilename(filename);
  // 1) reserve an upload URL for these bytes
  const { upload_url, file_id } = await slackForm("files.getUploadURLExternal", { filename: name, length: String(bytes.length) });
  if (!upload_url || !file_id) throw new Error("Slack didn't return an upload URL.");

  // 2) PUT the bytes to the reserved URL (multipart/form-data — matches Slack's SDK)
  const fd = new FormData();
  fd.append("file", new Blob([bytes]), name);
  const up = await fetch(upload_url, { method: "POST", body: fd, signal: AbortSignal.timeout(30_000) });
  if (!up.ok) throw new Error(`Uploading the file bytes failed (HTTP ${up.status}).`);

  // 3) finalize + (optionally) share into the channel/thread
  const fileEntry = { id: file_id };
  if (title) fileEntry.title = String(title).replace(/[\r\n]/g, " ").slice(0, 120);
  const body = { files: [fileEntry] };
  if (channelId) body.channel_id = channelId;
  if (channelId && threadTs) body.thread_ts = threadTs;
  if (channelId && comment) body.initial_comment = comment;
  const done = await slackJson("files.completeUploadExternal", body);
  const f = (done.files && done.files[0]) || {};
  return { fileId: f.id || file_id, permalink: f.permalink || "" };
}

// Upload `content` as a file named `filename` and (optionally) share it to `channelId` in
// `threadTs`, with an optional `comment` (initial_comment). Omit channelId to create the file
// unshared (used by the verification harness). Returns { fileId, permalink }.
export async function uploadSnippet({ content, filename, title = "", channelId = "", threadTs = "", comment = "" } = {}) {
  const bytes = Buffer.from(String(content ?? ""), "utf8");
  if (!bytes.length) throw new Error("Nothing to upload — `content` is empty.");
  return uploadBytes({ bytes, filename: snippetFilename(title, filename), title, channelId, threadTs, comment });
}

// Share an existing local file through the same modern external-upload flow. The caller is
// responsible for confinement and passes a realpath-validated file from the current channel root.
// Capping at 25 MB keeps the daemon's in-memory Blob bounded; bigger files stay browseable but the
// explorer explains that they need another transfer mechanism.
export async function uploadLocalFile({ filePath, filename = "", title = "", channelId = "", threadTs = "", comment = "" } = {}) {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("Only regular files can be shared.");
  if (info.size > MAX_FILE_UPLOAD_BYTES) throw new Error(`File is larger than the ${Math.round(MAX_FILE_UPLOAD_BYTES / 1024 / 1024)} MB explorer limit.`);
  const bytes = await readFile(filePath);
  if (bytes.length > MAX_FILE_UPLOAD_BYTES) throw new Error(`File grew larger than the ${Math.round(MAX_FILE_UPLOAD_BYTES / 1024 / 1024)} MB explorer limit before it could be shared.`);
  return uploadBytes({ bytes, filename: filename || path.basename(filePath), title, channelId, threadTs, comment });
}

// Delete a Slack file by id (used by the verification harness to clean up test uploads).
export async function deleteFile(fileId) {
  if (!fileId) return;
  await slackForm("files.delete", { file: fileId });
}
