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
import { ensureRealDir, writeNoFollow, writeStreamNoFollow } from "../gateway/safe-fs.js";
import { ATTACHMENT_MAX_BYTES, formatBytes, oversizeMessage } from "../util/bounded-bytes.js";
import { listChannelIds } from "./lists.js";
import { botApiCall } from "./read.js";

// A download this large gets its own pre-run status line, so a person watching the thread can
// tell the gateway is fetching their file rather than sitting idle.
export const ANNOUNCE_DOWNLOAD_BYTES = 8 * 1024 * 1024;

const HTML_HEAD = "Slack returned a sign-in or error page instead of the file — check the bot's file access and files:read scope";
const HTML_INSPECT_BYTES = 16 * 1024;

function isSlackAuthUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)slack\.com$/i.test(url.hostname)
      && /^\/(?:signin|sign_in|login|auth|ssb|checkcookie)(?:[/.]|$)/i.test(url.pathname);
  } catch { return false; }
}

function slackHtmlError() {
  const error = new Error(HTML_HEAD);
  error.code = "EHTMLBODY";
  return error;
}

// HTML is a supported attachment format, including HTML uploaded as .txt. Detect Slack's
// authentication/error document, not the MIME type or the opening HTML tag. Inspect a bounded
// prefix across stream chunks; the no-follow writer publishes nothing until the stream succeeds.
function inspectSlackDownload(res) {
  let prefix = Buffer.alloc(0);
  const body = res.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      if (prefix.length < HTML_INSPECT_BYTES) {
        prefix = Buffer.concat([prefix, Buffer.from(chunk.buffer, chunk.byteOffset, Math.min(chunk.byteLength, HTML_INSPECT_BYTES - prefix.length))]);
        const html = prefix.toString("utf8");
        if (/<(?:!doctype\s+html|html)\b/i.test(html)) {
          const title = html.match(/<title[^>]*>([^<]*)<\/title\s*>/i)?.[1] || "";
          const slackTitle = /\bslack\b/i.test(title);
          const authTitle = /^(?:(?:sign[ -]?in|log[ -]?in)(?: to)?(?:\s*[-|]\s*|\s+)slack|slack\s*[-|]\s*(?:sign[ -]?in|log[ -]?in|file not found|access denied|error|not authorized))\s*$/i.test(title.trim());
          const authForm = /<form\b[^>]*\b(?:id=["']signin_form["']|action=["'](?:https:\/\/(?:[a-z0-9-]+\.)?slack\.com)?\/(?:signin|ssb)(?:[/?"']))/i.test(html);
          const slackError = slackTitle && /\bclass=["'][^"']*\bp-error_page\b/i.test(html);
          if (authTitle || authForm || slackError) throw slackHtmlError();
        }
      }
      controller.enqueue(chunk);
    },
  }));
  return { headers: res.headers, body };
}

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

// Successful delivery survives cleanup of the original media. This tiny marker has no URL,
// credential or content. It suppresses inferred root retries only; explicit downloads ignore it.
export async function wasAttachmentDelivered(root, sub, file) {
  if (!/^[A-Za-z0-9_.-]+$/.test(String(sub || ""))) return false;
  try {
    const uploads = path.join(root, "uploads");
    const thread = path.join(uploads, sub);
    const history = path.join(thread, ".downloaded");
    for (const dir of [uploads, thread, history]) {
      if (!(await lstat(dir)).isDirectory()) return false;
    }
    const info = await lstat(path.join(history, attachmentFileName(file)));
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
      // Fetch follows Slack redirects; an authentication landing URL is never a file.
      if (isSlackAuthUrl(res.url)) {
        await res.body?.cancel?.().catch(() => {});
        saved.push({ name: f.name, skipped: HTML_HEAD });
        continue;
      }
      const safeName = attachmentFileName(f);
      destDir ||= await ensureRealDir(root, "uploads", sub);
      const dest = path.join(destDir, safeName);
      const source = res.body?.pipeThrough ? inspectSlackDownload(res) : res;
      const { bytes } = await writeStreamNoFollow(dest, source, { maxBytes });
      if (bytes > 0) {
        const history = await ensureRealDir(root, "uploads", sub, ".downloaded");
        await writeNoFollow(path.join(history, safeName), "delivered\n");
      }
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
