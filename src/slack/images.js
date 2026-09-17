// Slack's native Markdown renderer keeps a Markdown image reachable as a link, but it does not
// render the image inline. Public URLs can become Block Kit image blocks. Images created in the
// channel workspace are better: after the text answer lands, upload those through Slack's Files
// API so Slack renders the same native thumbnail/file card as a human attachment. Local paths are
// resolved through the file explorer's realpath confinement before a byte is read.
import { splitFences } from "../platforms/format/degrade.js";
import path from "node:path";
import { resolveVisiblePath } from "./file-explorer.js";
import { MAX_FILE_UPLOAD_BYTES, uploadLocalFile } from "./upload.js";

export const MAX_ANSWER_IMAGE_BLOCKS = 5;
export const MAX_ANSWER_IMAGE_FILES = 5;
const MAX_IMAGE_URL_CHARS = 3000;
const MAX_IMAGE_TEXT_CHARS = 2000;
const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".webp"]);

// One balanced parenthesis level covers common image URLs such as `/chart_(final).png` without
// letting the match consume the closing Markdown delimiter. Optional Markdown titles may use the
// three CommonMark forms: "title", 'title', or (title).
const MARKDOWN_IMAGE_RE = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|((?:[^()\s]|\([^()\s]*\))+))(?:\s+(?:"([^"\n]*)"|'([^'\n]*)'|\(([^)\n]*)\)))?\s*\)/gi;

function plainText(value) {
  return String(value || "")
    .replace(/\\([\\`*_[\]{}()#+.!~>-])/g, "$1")
    .replace(/<[^>\n]*>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_IMAGE_TEXT_CHARS);
}

function publicImageUrl(value) {
  const candidate = String(value || "").trim();
  if (!candidate || candidate.length > MAX_IMAGE_URL_CHARS) return "";
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return candidate;
  } catch {
    return "";
  }
}

export function answerImageBlocks(markdown, limit = MAX_ANSWER_IMAGE_BLOCKS) {
  const max = Math.max(0, Math.min(MAX_ANSWER_IMAGE_BLOCKS, Number(limit) || 0));
  if (!markdown || max === 0) return [];
  const blocks = [];
  const seen = new Set();
  for (const segment of splitFences(markdown)) {
    if (segment.code) continue;
    for (const match of segment.text.matchAll(MARKDOWN_IMAGE_RE)) {
      const imageUrl = publicImageUrl(match[2] || match[3]);
      if (!imageUrl || seen.has(imageUrl)) continue;
      seen.add(imageUrl);
      const alt = plainText(match[1]);
      const title = plainText(match[4] || match[5] || match[6] || alt);
      blocks.push({
        type: "image",
        image_url: imageUrl,
        alt_text: alt || title || "Image preview",
        ...(title ? { title: { type: "plain_text", text: title, emoji: true } } : {}),
      });
      if (blocks.length >= max) return blocks;
    }
  }
  return blocks;
}

function localDestination(value, cwd) {
  let candidate = String(value || "").trim();
  if (!candidate || candidate.length > MAX_IMAGE_URL_CHARS || !cwd) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate) || candidate.startsWith("#")) return "";
  try { candidate = decodeURIComponent(candidate); } catch { return ""; }
  const root = path.resolve(cwd);
  if (path.isAbsolute(candidate)) {
    const relative = path.relative(root, path.resolve(candidate));
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return "";
    candidate = relative;
  }
  candidate = candidate.replace(/^\.\//, "").split(path.sep).join("/");
  if (!IMAGE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) return "";
  return candidate;
}

// Resolve the model-authored local image references without trusting their spelling. Missing
// files, traversal, escaping symlinks, non-images and oversized files are simply not promoted;
// the authoritative text answer must still be deliverable.
export async function answerImageFiles(markdown, cwd, limit = MAX_ANSWER_IMAGE_FILES) {
  const max = Math.max(0, Math.min(MAX_ANSWER_IMAGE_FILES, Number(limit) || 0));
  if (!markdown || !cwd || max === 0) return [];
  const files = [];
  const seen = new Set();
  for (const segment of splitFences(markdown)) {
    if (segment.code) continue;
    for (const match of segment.text.matchAll(MARKDOWN_IMAGE_RE)) {
      const relative = localDestination(match[2] || match[3], cwd);
      if (!relative) continue;
      try {
        const resolved = await resolveVisiblePath(cwd, relative, { kind: "file" });
        if (resolved.stat.size > MAX_FILE_UPLOAD_BYTES || seen.has(resolved.path)) continue;
        seen.add(resolved.path);
        const filename = path.basename(resolved.relative);
        files.push({
          path: resolved.path,
          relative: resolved.relative,
          filename,
          title: plainText(match[4] || match[5] || match[6] || match[1] || filename),
        });
        if (files.length >= max) return files;
      } catch {
        // A broken or forbidden image reference remains ordinary answer text.
      }
    }
  }
  return files;
}

function uploadFailureLabel(error) {
  return String(error?.data?.error || error?.code || error?.message || "unknown error")
    .replace(/[\r\n]/g, " ")
    .slice(0, 160);
}

// Best-effort by design: answer delivery has already succeeded when this runs. One unavailable
// image or a missing Slack files:write scope must not turn a completed agent run into an error.
export async function shareAnswerImageFiles({ markdown, cwd, channel, threadTs, uploadFile = uploadLocalFile, onError = null } = {}) {
  const files = await answerImageFiles(markdown, cwd);
  const shared = [];
  for (const file of files) {
    try {
      const uploaded = await uploadFile({
        filePath: file.path,
        rootPath: cwd,
        filename: file.filename,
        title: file.title || file.filename,
        channelId: channel,
        threadTs,
      });
      shared.push({ ...file, ...uploaded });
    } catch (error) {
      if (onError) onError(error, file);
      else console.warn(`[slack] Could not attach answer image ${JSON.stringify(file.filename)}: ${uploadFailureLabel(error)}`);
    }
  }
  return shared;
}
