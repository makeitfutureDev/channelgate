// Inbound attachments → files inside the channel's gated folder.
//
// Same destination and the same write discipline as the Slack path (uploads/<thread>/<intake>/<name>, real
// directories, no-follow writes): the workspace beneath the folder is agent-writable, so a symlink
// planted at any of those paths must be REPLACED as a node, never written through. The download
// itself differs per platform — a Chat attachment needs the service-account bearer, a Teams one has
// a pre-authenticated URL — which is why each transport hands us a `download()` and this file never
// touches the network itself.
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureRealDir, writeStreamNoFollow } from "../gateway/safe-fs.js";
import { effectiveWorkDir } from "../gateway/folders.js";
import { ATTACHMENT_MAX_BYTES } from "../util/bounded-bytes.js";

// Same ceiling the Slack path uses, enforced the same way: a transport's download() hands back the
// fetch Response (or a bare web stream) and the bytes stream straight into the channel folder with
// the running total checked per chunk — a Buffer is accepted too, for a small body or a test
// double, and gets the same cap. `maxBytes` exists for tests; production uses the shared constant.

export function safeFileName(name, index = 0) {
  const base = path.basename(String(name || ""))
    .replace(/[^a-zA-Z0-9._\- ]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return base || `attachment-${index + 1}`;
}

// Returns { paths, skipped } — `paths` are absolute files to hand the model, `skipped` are names we
// could not fetch, so the caller can SAY so instead of dropping the user's file silently.
export async function saveInboundAttachments(message, { slug, meta, log = console, maxBytes = ATTACHMENT_MAX_BYTES } = {}) {
  const paths = [];
  const skipped = [];
  if (!message.attachments?.length) return { paths, skipped };

  const root = effectiveWorkDir(slug, meta);
  // The thread groups a conversation's files. Platform thread handles are resource names full of
  // slashes and colons, so the subfolder is a sanitized form — it is a grouping label, not an id.
  const sub = String(message.threadKey || "thread").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "thread";
  // Session keys and native reply addresses are not storage identities. Two independent flat
  // group messages (or revisions) can have the same filename and no thread handle. Each intake
  // gets its own directory so one run cannot replace bytes another is transcribing/reading.
  const intake = randomUUID();
  let destDir = "";

  for (const [index, attachment] of message.attachments.entries()) {
    const name = safeFileName(attachment.name, index);
    if (typeof attachment.download !== "function") {
      skipped.push(name);
      continue;
    }
    try {
      const source = await attachment.download();
      if (!source || (Buffer.isBuffer(source) && !source.length)) { skipped.push(name); continue; }
      destDir ||= await ensureRealDir(root, "uploads", sub, intake);
      const dest = path.join(destDir, `${index + 1}-${name}`);
      const { bytes } = await writeStreamNoFollow(dest, source, { maxBytes });
      if (!bytes) { skipped.push(name); continue; }
      paths.push(dest);
    } catch (err) {
      log.warn?.(`[${message.platform}] attachment ${name} failed: ${err?.message || err}`);
      // The caller relays `skipped` to the user verbatim, so an oversize refusal carries its reason.
      skipped.push(err?.code === "ETOOLARGE" ? `${name} (${String(err.message).replace(/^downloaded file /, "")})` : name);
    }
  }
  return { paths, skipped };
}
