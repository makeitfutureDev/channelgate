// Native personal-chat file sending. Only the verified invoke wrapper calls handle().
// Microsoft documents the consent PUT and file.info flow at:
// https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { resolveVisiblePath } from "../../slack/file-explorer.js";
import { isAllowedDownloadUrl } from "./activity.js";
import { isConversationId } from "./api.js";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PENDING = 10;
const TTL_MS = 10 * 60_000;
const within = (root, item) => item === root || item.startsWith(`${root}${path.sep}`);
const response = (status, message) => ({ status, body: { message } });
function microsoftUrl(value) {
  if (!isAllowedDownloadUrl(value)) return false;
  const url = new URL(value);
  return !url.username && !url.password && !url.hash && (!url.port || url.port === "443");
}
async function snapshot(root, relative) {
  const target = await resolveVisiblePath(root, relative, { kind: "file" });
  const fd = await open(target.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const [opened, info] = await Promise.all([realpath(`/proc/self/fd/${fd.fd}`), fd.stat()]);
    if (!info.isFile() || !within(target.rootReal, opened)) throw new Error("File is outside the authorized workspace.");
    if (!info.size || info.size > MAX_BYTES) throw new Error("Native Teams sending supports nonempty files up to 10 MB. Use the browser download link for this file.");
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await fd.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error("The file changed while preparing the upload. Try again.");
      offset += read.bytesRead;
    }
    const after = await fd.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error("The file changed while preparing the upload. Try again.");
    return { bytes, root: target.rootReal, relative: target.relative, name: path.basename(target.relative) };
  } finally { await fd.close(); }
}

export function createTeamsFileConsent({ connector, authorizeWorkspace, fetchImpl = fetch, now = Date.now } = {}) {
  if (!connector?.api?.sendActivity || typeof authorizeWorkspace !== "function") throw new TypeError("Teams file consent requires a connector and workspace authorization");
  const pending = new Map();
  let activeUploads = 0;
  let stopped = false;
  const uploads = new Set();
  const aborts = new Set();
  function remove(id) {
    const row = pending.get(id);
    clearTimeout(row?.timer);
    pending.delete(id);
    return row;
  }
  function prune() {
    for (const [id, row] of pending) if (row.expiresAt <= now()) remove(id);
  }
  async function send({ message, entry, sessionKey = "", relative } = {}) {
    if (stopped) throw new Error("Teams file sending is disconnected.");
    prune();
    if (!message?.userId || !message.conversationId || !entry?.slug || typeof relative !== "string" || !relative.trim()) throw new Error("Choose one file from this conversation's workspace.");
    if (pending.size + activeUploads >= MAX_PENDING) throw new Error("Too many pending Teams uploads. Accept or decline an existing request first.");
    const id = randomUUID();
    // Reserve before any asynchronous work, so concurrent preparations share the same memory cap.
    const row = { expiresAt: now() + TTL_MS, actorId: message.userId, source: { message, entry, sessionKey, relative }, ready: false };
    row.timer = setTimeout(() => remove(id), TTL_MS);
    row.timer.unref?.();
    pending.set(id, row);
    try {
      const authorized = await authorizeWorkspace(row.source);
      if (!authorized?.root) throw new Error("Workspace access was not authorized.");
      const file = await snapshot(authorized.root, relative);
      const destination = message.isDM || message.kind === "dm" ? message.rawConversationId : await connector.openDm(message.userId);
      if (!isConversationId(destination)) throw new Error("Cannot open your personal Teams chat. Install the app personally and try again.");
      if (!pending.has(id) || row.expiresAt <= now()) throw new Error("File consent preparation expired. Try again.");
      Object.assign(row, file, { conversationId: destination, ready: true });
      const sent = await connector.api.sendActivity(destination, {
        text: `Accept to receive ${file.name}. This request expires in 10 minutes.`,
        attachments: [{ contentType: "application/vnd.microsoft.teams.card.file.consent", name: file.name,
          content: { description: "Send the prepared snapshot of this workspace file to your OneDrive.", sizeInBytes: file.bytes.length,
            acceptContext: { id }, declineContext: { id } } }],
      });
      return { status: 200, body: { message: "File consent sent to your personal Teams chat." }, conversationId: destination, messageId: sent?.messageId || "", id };
    } catch (error) { remove(id); throw error; }
  }
  async function handle(activity) {
    if (stopped) return response(410, "Teams file sending is disconnected.");
    if (activity?.name !== "fileConsent/invoke" || activity.type !== "invoke") return response(400, "Unsupported file consent event");
    prune();
    const value = activity.value || {};
    const id = value.context?.id;
    const row = typeof id === "string" ? pending.get(id) : null;
    if (!row || !row.ready) return response(410, "File request expired or was already handled. Request the file again.");
    if (activity.from?.id !== row.actorId || activity.conversation?.id !== row.conversationId) return response(403, "File consent belongs to another person or conversation.");
    if (value.type !== "fileUpload" || !["accept", "decline"].includes(value.action)) return response(400, "Invalid file consent decision");
    if (value.action === "decline") { remove(id); return response(200, "File upload declined."); }
    const upload = value.uploadInfo;
    if (!upload || !microsoftUrl(upload.uploadUrl) || !microsoftUrl(upload.contentUrl) || typeof upload.uniqueId !== "string" || !/^[A-Za-z0-9_.!:-]{1,256}$/.test(upload.uniqueId)) return response(400, "Invalid Microsoft file upload destination.");
    try {
      const authorized = await authorizeWorkspace(row.source);
      if (!authorized?.root || await realpath(authorized.root) !== row.root) return response(403, "The source workspace is no longer authorized.");
    } catch { return response(403, "The source workspace is no longer authorized."); }
    // Recheck after authorization's await: another callback may already have consumed this grant.
    if (stopped || pending.get(id) !== row || row.expiresAt <= now()) return response(410, "File request expired or was already handled.");
    remove(id); // Consume before PUT. An uncertain upload is never automatically repeated.
    activeUploads++;
    const abort = new AbortController();
    aborts.add(abort);
    // The invoke response must not wait for a network upload. Track completion so stop can
    // abort work and tests can drain it; a failed upload reports only into the bound personal DM.
    let task;
    task = Promise.resolve().then(async () => {
      try {
        const uploaded = await fetchImpl(upload.uploadUrl, {
          method: "PUT", body: row.bytes, redirect: "error", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]),
          headers: { "Content-Type": "application/octet-stream", "Content-Length": String(row.bytes.length), "Content-Range": `bytes 0-${row.bytes.length - 1}/${row.bytes.length}` },
        });
        if (![200, 201].includes(uploaded.status)) throw new Error("Upload not confirmed");
        await connector.api.sendActivity(row.conversationId, {
          text: `${row.name} uploaded.`,
          attachments: [{ contentType: "application/vnd.microsoft.teams.card.file.info", name: row.name, contentUrl: upload.contentUrl,
            content: { uniqueId: upload.uniqueId, fileType: path.extname(row.name).slice(1) } }],
        });
      } catch {
        await connector.api.sendActivity(row.conversationId, {
          text: "File upload outcome could not be confirmed. Check OneDrive before requesting the file again. This upload will not be retried automatically.",
        }).catch(() => {});
      } finally {
        activeUploads--;
        aborts.delete(abort);
        uploads.delete(task);
      }
    }).catch(() => {});
    uploads.add(task);
    return response(200, "File upload accepted. Completion will be reported in your personal Teams chat.");
  }
  return {
    send, handle,
    drain: () => Promise.allSettled([...uploads]),
    stop() {
      stopped = true;
      for (const id of pending.keys()) remove(id);
      for (const abort of aborts) abort.abort();
    },
  };
}
