// Inbound attachments → files inside the channel's gated folder.
//
// Same destination and the same write discipline as the Slack path (uploads/<thread>/<name>, real
// directories, no-follow writes): the workspace beneath the folder is agent-writable, so a symlink
// planted at any of those paths must be REPLACED as a node, never written through. The download
// itself differs per platform — a Chat attachment needs the service-account bearer, a Teams one has
// a pre-authenticated URL — which is why each transport hands us a `download()` and this file never
// touches the network itself.
import path from "node:path";
import { ensureRealDir, writeNoFollow } from "../gateway/safe-fs.js";
import { effectiveWorkDir } from "../gateway/folders.js";

// Same ceiling the Slack path uses. The bytes have already been read by the transport's download(),
// so this is a post-hoc guard rather than a streaming bound — worth keeping so one enormous file
// cannot be written into a channel folder.
const MAX_FILE_BYTES = 30 * 1024 * 1024;

export function safeFileName(name, index = 0) {
  const base = path.basename(String(name || ""))
    .replace(/[^a-zA-Z0-9._\- ]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return base || `attachment-${index + 1}`;
}

// Returns { paths, skipped } — `paths` are absolute files to hand the model, `skipped` are names we
// could not fetch, so the caller can SAY so instead of dropping the user's file silently.
export async function saveInboundAttachments(message, { slug, meta, log = console } = {}) {
  const paths = [];
  const skipped = [];
  if (!message.attachments?.length) return { paths, skipped };

  const root = effectiveWorkDir(slug, meta);
  // The thread groups a conversation's files. Platform thread handles are resource names full of
  // slashes and colons, so the subfolder is a sanitized form — it is a grouping label, not an id.
  const sub = String(message.threadKey || "thread").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "thread";
  let destDir = "";

  for (const [index, attachment] of message.attachments.entries()) {
    const name = safeFileName(attachment.name, index);
    if (typeof attachment.download !== "function") {
      skipped.push(name);
      continue;
    }
    try {
      const buf = await attachment.download();
      if (!buf?.length) { skipped.push(name); continue; }
      if (buf.length > MAX_FILE_BYTES) { skipped.push(`${name} (too large)`); continue; }
      destDir ||= await ensureRealDir(root, "uploads", sub);
      const dest = path.join(destDir, `${index + 1}-${name}`);
      await writeNoFollow(dest, buf);
      paths.push(dest);
    } catch (err) {
      log.warn?.(`[${message.platform}] attachment ${name} failed: ${err?.message || err}`);
      skipped.push(name);
    }
  }
  return { paths, skipped };
}
