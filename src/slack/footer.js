// Reply-footer cluster: the run-stats line ("Opus 4.8 1M · 14.4s · 36.8k/192 · $0.31 · 18%"),
// its Block Kit form, and the 💻 Resume / 📂 Files controls that ride under it. Extracted from
// slack/app.js (the 2026-08 restructure notes (internal repo) Phase 2.4) so unattended delivery (slack/deliver.js) and the
// Bolt wiring share one implementation without importing the whole app module.
import path from "node:path";
import { realpathSync, statSync } from "node:fs";
import { getShowMessageCost } from "../config/settings.js";
import { resumeCommandFor } from "../engines/registry.js";
import { normalizeUsage } from "../gateway/usage.js";
import { contextWindowFor, modelLabel } from "../gateway/model-info.js";
import { actionValue as fileActionValue, FILES_ACTION_ID } from "./file-explorer.js";

// The terminal command that reopens a thread's session locally. It `cd`s into the channel's
// working folder first, because Claude/Codex locate a session by the directory you run them in
// (running it elsewhere gives "No conversation found"). Returns "" without a session/cwd.
export function buildResumeCommand(cwd, sessionId, engine) {
  if (!sessionId || !cwd) return "";
  const cmd = resumeCommandFor(engine, sessionId);
  return `cd ${JSON.stringify(cwd)} && ${cmd}`;
}

// A small button that opens the resume-command modal (the "resume_cmd_modal" handler). Rides
// under the stats context line on reply footers (footerBlocks / the postChunkedReply trailer)
// and as the accessory on "🛑 Stopped.". The label stays SHORT — Slack clips button labels to
// ~35 visible chars (stats belong in the context line, never in the label). `/resume` is the
// text alternative. Returns null when there's nothing to resume.
export function resumeButton(cwd, sessionId, engine, label = "💻") {
  if (!buildResumeCommand(cwd, sessionId, engine)) return null;
  return {
    type: "button",
    action_id: "resume_cmd_modal",
    text: { type: "plain_text", text: String(label).slice(0, 75), emoji: true },
    value: JSON.stringify({ cwd, sessionId, engine }),
  };
}

// Opens the existing confined file explorer for this conversation. The value is bound to the
// requester; the shared action handler re-checks that the clicker matches, then applies current
// channel authorization before opening the modal. Returns null for author-less automation posts.
export function filesButton(channelId, threadTs, authorId, label = "📂") {
  if (!channelId || !authorId) return null;
  return {
    type: "button",
    action_id: FILES_ACTION_ID,
    text: { type: "plain_text", text: String(label).slice(0, 75), emoji: true },
    accessibility_label: "Open channel files",
    value: fileActionValue("open", { c: channelId, t: threadTs || "", u: authorId }),
  };
}

const MAX_REVIEW_FILE_BUTTONS = 5;

function decodeFileReference(value) {
  let candidate = String(value || "").trim();
  try { candidate = decodeURIComponent(candidate); } catch { return ""; }
  candidate = candidate.replace(/:\d+(?::\d+)?$/, "");
  return candidate;
}

// A candidate only reaches the filesystem if it reads like a path. Absolute paths always qualify;
// a relative one must carry a directory separator or a file extension, so ordinary inline code
// (`main`, `npm test`, a branch name) never costs a realpath syscall and never becomes a button.
// URLs are rejected outright — they are the other common thing wearing backticks.
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
function looksLikePath(candidate) {
  if (!candidate || candidate.startsWith("-") || SCHEME.test(candidate)) return false;
  if (path.isAbsolute(candidate)) return true;
  return candidate.includes("/") || /\.[a-z0-9]{1,8}$/i.test(candidate);
}

// Bound on how many backticked spans one reply may push through realpath, so a pathological answer
// full of inline code can't turn footer rendering into hundreds of stat calls.
const MAX_PATH_CANDIDATES = 200;

// Agents name local review targets in inline code. An absolute path is taken as written; anything
// else is resolved against the run cwd, because an agent inside a gated channel folder thinks and
// writes in folder-relative terms ("work/sow/RS.pdf") and shouldn't have to paste the host's home
// directory into a Slack message to earn a button. Resolving relative candidates costs nothing in
// safety: every candidate is realpath'd and must still land inside the run cwd, so `../../../etc/
// passwd` is rejected by the same check that has always rejected it. The Markdown-link form stays
// absolute-only — the guide tells agents never to link a local path, and widening it would drag
// every https link in the reply through the filesystem for nothing.
export function referencedWorkspaceFiles(content, cwd, limit = MAX_REVIEW_FILE_BUTTONS) {
  if (!content || !cwd || !path.isAbsolute(cwd) || limit <= 0) return [];
  let root;
  try { root = realpathSync(cwd); } catch { return []; }
  const raw = [];
  const source = String(content);
  for (const match of source.matchAll(/\[[^\]\n]+\]\((\/[^)\n]+)\)/g)) raw.push(match[1]);
  for (const match of source.matchAll(/`([^`\n]+)`/g)) raw.push(match[1]);
  const seen = new Set();
  const files = [];
  let examined = 0;
  for (const value of raw) {
    const reference = decodeFileReference(value).trim();
    if (!looksLikePath(reference)) continue;
    if (++examined > MAX_PATH_CANDIDATES) break;
    const absolute = path.resolve(root, reference);
    let target;
    try {
      target = realpathSync(absolute);
      if (!statSync(target).isFile()) continue;
    } catch { continue; }
    const relative = path.relative(root, target);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    const portable = relative.split(path.sep).join("/");
    if (seen.has(portable)) continue;
    seen.add(portable);
    files.push({ relative: portable, name: path.basename(target) });
    if (files.length >= limit) break;
  }
  return files;
}

export function reviewFileButtons(result, { channel = "", threadTs = "", authorId = "" } = {}) {
  if (!channel || !authorId) return [];
  return referencedWorkspaceFiles(result?.content, result?.cwd).map((file, index) => ({
    type: "button",
    // Slack rejects duplicate action_ids inside one actions block. Keep the stable prefix so the
    // shared FILES_ACTION_PATTERN handler still owns every direct-preview control.
    action_id: `${FILES_ACTION_ID}_review_${index}`,
    text: { type: "plain_text", text: `📄 ${file.name}`.slice(0, 75), emoji: true },
    accessibility_label: `Open ${file.name} in channel files`.slice(0, 75),
    value: fileActionValue("open_file", { c: channel, t: threadTs || "", u: authorId, p: file.relative }),
  }));
}

export function footerButtons(result, { channel = "", threadTs = "", authorId = "" } = {}) {
  return [
    resumeButton(result.cwd, result.sessionId, result.engine),
    filesButton(channel, threadTs, authorId),
    ...reviewFileButtons(result, { channel, threadTs, authorId }),
  ].filter(Boolean);
}

// Compact token counts for the footer: 214 → "214", 34799 → "34.8k", 1959778 → "1.96M".
function fmtTok(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1e6) return `${(n / 1e6).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

// Run stats, as SHORT as possible (width-conscious by user request; no icons — user preference):
// "Opus 4.8 1M · 14.4s · 36.8k/192 · $0.31 · 18%" — model · duration · tokens in/out ·
// cost (2 decimals, no ~/est. markers) · context% against the MODEL's own window
// (contextWindowFor). The resume command never rides here as text — 💻 button + `/resume`.
export function footerText(result) {
  const u = result.usage || {};
  // Tolerate both Claude (input_tokens/…) and Codex (prompt_tokens/…) usage shapes.
  const inT = (u.input_tokens ?? u.prompt_tokens ?? 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const outT = u.output_tokens ?? u.completion_tokens ?? 0;
  // Claude reports a real dollar cost; Codex doesn't — the per-model rate estimate from Settings
  // is shown bare (same figure the usage ledger records).
  const est = result.costUSD == null ? normalizeUsage(result) : null;
  const usd = result.costUSD ?? est?.costUSD;
  const parts = [modelLabel(result)];
  if (result.durationMs != null) {
    const s = result.durationMs / 1000;
    parts.push(s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`);
  }
  parts.push(`${fmtTok(inT)}/${fmtTok(outT)}`);
  if (getShowMessageCost() && usd != null) parts.push(`$${usd.toFixed(2)}`);
  // Context window used: this turn's input/cached tokens vs the model's own window.
  if (inT > 0) parts.push(`${Math.min(100, Math.round((100 * inT) / contextWindowFor(result)))}%`);
  return parts.join(" · ");
}

// Same run-stats footer as footerText, but as Block Kit — used to append the footer to a
// streamed reply (chat.stopStream takes `blocks`, not appended text). With a resumable session
// one control uses the section ACCESSORY. With both 💻 Resume and 📂 Files, Slack's section block
// cannot hold two accessories, so the compact stats context sits directly above an actions row
// containing the two adjacent buttons.
export function footerBlocks(result, context = {}) {
  const buttons = footerButtons(result, context);
  const text = { type: "mrkdwn", text: footerText(result) };
  if (buttons.length === 1) return [{ type: "section", text, accessory: buttons[0] }];
  if (buttons.length > 1) return [{ type: "context", elements: [text] }, { type: "actions", elements: buttons }];
  return [{ type: "context", elements: [text] }];
}
