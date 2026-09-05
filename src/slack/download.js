// Slack attachments → files inside the channel's gated folder. Two callers share this one path:
// the pre-run download of every file on the triggering message (message-pipeline.js) and the
// on-demand `slack_download_file` gateway tool, with which an agent fetches a file it can SEE in
// this channel's history (the root message's video after a "try again" reply, a file shared an
// hour ago) but that no run has delivered yet. Both land at uploads/<thread ts>/<file id>-<name>
// under the same cap, through the same no-follow streaming writer, so a planted symlink is
// replaced as a node and the bytes never sit in the daemon's memory.
//
// The bot token is the only credential and it never leaves the daemon side: the tool hands the
// model a LOCAL path, never a private Slack URL. Scope is fail-closed — a file is downloadable only
// when Slack says it is shared in THIS channel, so the tool cannot become "read any file the bot
// can see anywhere".
import path from "node:path";
import { lstat } from "node:fs/promises";
import { ensureRealDir, writeStreamNoFollow } from "../gateway/safe-fs.js";
import { ATTACHMENT_MAX_BYTES, formatBytes, oversizeMessage } from "../util/bounded-bytes.js";
import { listChannelIds } from "./lists.js";
import { botApiCall } from "./read.js";

// A download this large gets its own pre-run status line, so a person watching the thread can
// tell the gateway is fetching their file rather than sitting idle.
export const ANNOUNCE_DOWNLOAD_BYTES = 8 * 1024 * 1024;

const HTML_HEAD = "Slack returned HTML instead of the file — the bot is missing the files:read scope (update the app manifest and reinstall)";

// On-disk name for one Slack attachment: the Slack file id (globally unique) in front of the
// sanitized original name. Two messages in the same thread that attach "report.pdf" would
// otherwise land on the same path and the second would silently overwrite the first — and the
// agent would then read the wrong bytes for the older message. The original extension survives,
// which the local transcriber relies on.
export function attachmentFileName(f) {
  const id = String(f?.id || "").replace(/[^A-Za-z0-9]/g, "");
  const base = path.basename(String(f?.name || "")).replace(/[^a-zA-Z0-9._\- ]/g, "_").replace(/^\.+/, "").trim();
  return `${id || "file"}${base ? `-${base}` : ""}`;
}

// The uploads/ subfolder for a run: the thread ts groups a conversation's files (a scheduled or
// background run's synthetic key degrades to its digits, or "thread").
export function uploadsSubFor(threadKey) {
  return String(threadKey || "").replace(/[^0-9.]/g, "_") || "thread";
}

// Where a file WOULD land, and whether it already has — the retry and the on-demand tool both
// skip a download whose bytes are already in the folder. lstat, never stat: a planted link at the
// path is "not our file", so the writer replaces it rather than trusting its target.
export function attachmentPath(root, sub, file) {
  return path.join(root, "uploads", sub, attachmentFileName(file));
}

export async function isAttachmentOnDisk(root, sub, file) {
  try {
    const info = await lstat(attachmentPath(root, sub, file));
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

// Download Slack-attached files into the channel's gated folder so the engine can read them with
// its Read tool (which renders images visually). Slack file URLs are private — they require the
// bot token as a Bearer header. Returns the saved file descriptors.
//
// `root` is the channel's work dir (daemon-derived); `sub` the per-thread subfolder. The workspace
// beneath it is agent-writable, so uploads/<sub> is recreated as REAL directories and each file is
// published via an exclusive no-follow temp + rename — a symlink planted at any of those paths is
// replaced as a node, never written through. The bytes never sit in the daemon's memory: each file
// streams into that temp with the cap (ATTACHMENT_MAX_BYTES, or `maxBytes` for a test) enforced per
// chunk. A refusal names the actual size and the limit.
export async function downloadSlackFiles(files, botToken, { root, sub, maxBytes = ATTACHMENT_MAX_BYTES, fetchImpl = fetch }) {
  const saved = [];
  let destDir = "";
  for (const f of files) {
    const url = f.url_private_download || f.url_private;
    if (!url) {
      saved.push({
        name: f.name || f.id || "file",
        skipped: "Slack did not provide a private download URL after canonical message and files.info recovery",
      });
      continue;
    }
    // A declared size is only an early reject — the real cap is enforced while streaming below.
    if (f.size && f.size > maxBytes) {
      saved.push({ name: f.name, skipped: oversizeMessage(f.size, maxBytes) });
      continue;
    }
    try {
      const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${botToken}` }, redirect: "follow" });
      if (!res.ok) {
        saved.push({ name: f.name, skipped: `HTTP ${res.status}` });
        continue;
      }
      // Slack hands back an HTML sign-in/redirect page (not the file bytes) when the bot lacks
      // the files:read scope or can't access the file. Detect it via content-type AND a byte
      // sniff of the first chunk so we never save bogus markup and let the model "read" a web page.
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("text/html")) {
        await res.body?.cancel?.().catch(() => {});
        saved.push({ name: f.name, skipped: HTML_HEAD });
        continue;
      }
      const safeName = attachmentFileName(f);
      destDir ||= await ensureRealDir(root, "uploads", sub);
      const dest = path.join(destDir, safeName);
      const { bytes } = await writeStreamNoFollow(dest, res, {
        maxBytes,
        inspect(head) {
          const text = head.toString("latin1").trimStart().toLowerCase();
          if (text.startsWith("<!doctype") || text.startsWith("<html")) {
            const err = new Error(HTML_HEAD);
            err.code = "EHTMLBODY";
            throw err;
          }
        },
      });
      saved.push({ name: safeName, path: dest, mimetype: f.mimetype, bytes });
    } catch (e) {
      saved.push({ name: f.name, skipped: e.message });
    }
  }
  return saved;
}

// True when the declared sizes are large enough that a person should be told the gateway is
// downloading — a 250 MB screen recording takes long enough to look like nothing is happening.
export function shouldAnnounceDownload(files, threshold = ANNOUNCE_DOWNLOAD_BYTES) {
  return files.reduce((sum, f) => sum + (Number(f?.size) || 0), 0) >= threshold;
}

// A Slack file id, from the bare id ("F0BV4TU6T5L") or any pasted Slack file / permalink URL that
// carries one. Anything else is refused — the tool never guesses.
export function parseSlackFileId(value) {
  const raw = String(value || "").trim();
  if (/^F[A-Z0-9]{8,}$/i.test(raw)) return raw.toUpperCase();
  const m = raw.match(/\/(F[A-Z0-9]{8,})(?:[/?#]|$)/i) || raw.match(/[?&]file=(F[A-Z0-9]{8,})/i);
  return m ? m[1].toUpperCase() : "";
}

// files.info with the bot token, plus the scope check that keeps the tool channel-bound: the file
// must be shared in `channelId` (a channel, private group or DM the bot is in), as Slack reports
// it. `notInChannel` is the only failure a caller may soften — everything else is Slack's own error.
export async function fetchChannelFile(channelId, fileId, { call = botApiCall } = {}) {
  if (!channelId) throw new Error("No channel context here.");
  const id = parseSlackFileId(fileId);
  if (!id) throw new Error("That is not a Slack file id (expected an id like F0BV4TU6T5L, or a Slack file link).");
  const data = await call("files.info", { file: id });
  const file = data?.file || {};
  if (!listChannelIds(file).has(String(channelId))) {
    const err = new Error("that file is not shared in this channel, so it cannot be downloaded here.");
    err.code = "ENOTINCHANNEL";
    throw err;
  }
  return file;
}

// The on-demand path: look the file up, refuse it outside this channel, reuse it when its bytes
// are already in the thread folder, otherwise stream it in under the cap. Returns
// { path, name, bytes, mimetype, reused } or { skipped } with the human reason.
export async function downloadChannelFile({ channelId, fileId, root, sub, botToken, maxBytes = ATTACHMENT_MAX_BYTES, call = botApiCall, fetchImpl = fetch }) {
  const file = await fetchChannelFile(channelId, fileId, { call });
  const dest = attachmentPath(root, sub, file);
  if (await isAttachmentOnDisk(root, sub, file)) {
    const info = await lstat(dest);
    return { path: dest, name: attachmentFileName(file), bytes: info.size, mimetype: file.mimetype || "", reused: true, size: file.size };
  }
  const [saved] = await downloadSlackFiles([file], botToken, { root, sub, maxBytes, fetchImpl });
  if (saved.skipped) return { skipped: saved.skipped, name: file.name || attachmentFileName(file), size: file.size };
  return { path: saved.path, name: saved.name, bytes: saved.bytes, mimetype: saved.mimetype || "", reused: false, size: file.size };
}

export { formatBytes };
