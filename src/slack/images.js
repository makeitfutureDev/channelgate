// Slack's native Markdown renderer keeps a Markdown image reachable as a link, but it does not
// render the image inline. At final delivery, promote public image references from the model's
// authoritative answer into Block Kit image blocks. The Markdown stays in the answer as the
// readable/clickable fallback if Slack cannot fetch the asset.
import { splitFences } from "../platforms/format/degrade.js";

export const MAX_ANSWER_IMAGE_BLOCKS = 5;
const MAX_IMAGE_URL_CHARS = 3000;
const MAX_IMAGE_TEXT_CHARS = 2000;

// One balanced parenthesis level covers common image URLs such as `/chart_(final).png` without
// letting the match consume the closing Markdown delimiter. Optional Markdown titles may use the
// three CommonMark forms: "title", 'title', or (title).
const MARKDOWN_IMAGE_RE = /!\[([^\]\n]*)\]\(\s*(https?:\/\/(?:[^()\s]|\([^()\s]*\))+)(?:\s+(?:"([^"\n]*)"|'([^'\n]*)'|\(([^)\n]*)\)))?\s*\)/gi;

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
      const imageUrl = publicImageUrl(match[2]);
      if (!imageUrl || seen.has(imageUrl)) continue;
      seen.add(imageUrl);
      const alt = plainText(match[1]);
      const title = plainText(match[3] || match[4] || match[5] || alt);
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
