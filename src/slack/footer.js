// Reply-footer cluster: the run-stats line ("Opus 4.8 1M · 14.4s · 36.8k/192 · $0.31 · 18%"),
// its Block Kit form, and the reply menu (📂 Files / 🔑 Variables / ⚙️ Settings) that rides under it.
// Extracted from slack/app.js (the 2026-08 restructure notes (internal repo) Phase 2.4) so
// unattended delivery (slack/deliver.js) and the Bolt wiring share one implementation without
// importing the whole app module.
import path from "node:path";
import { realpathSync, statSync } from "node:fs";
import { resumeCommandFor } from "../engines/registry.js";
import { footerText } from "../gateway/reply-stats.js";
export { footerText } from "../gateway/reply-stats.js";
import { actionValue as fileActionValue, FILES_ACTION_ID } from "./file-explorer.js";
import { actionValue as secretActionValue, SECRETS_ACTION_ID } from "./secret-explorer.js";
import { actionValue as settingsActionValue, CHANNEL_SETTINGS_ACTION_ID } from "./channel-settings.js";

// The terminal command that reopens a thread's session locally. It `cd`s into the channel's
// working folder first, because Claude/Codex locate a session by the directory you run them in
// (running it elsewhere gives "No conversation found"). Returns "" without a session/cwd.
// `target` (a RuntimeTarget) is optional and only matters for a runtime whose sessions cannot be
// reopened from a bare shell: resumeCommandFor wraps the engine's own command in the backend's form
// (an exec into the channel's container), and the `cd` that a host resume needs is then already
// carried by that command. A host target — or none — returns the engine command verbatim, so this
// stays today's `cd "<folder>" && <cmd>` line, byte for byte.
export function buildResumeCommand(cwd, sessionId, engine, target = null) {
  if (!sessionId || !cwd) return "";
  const base = resumeCommandFor(engine, sessionId);
  const wrapped = target ? resumeCommandFor(engine, sessionId, { target }) : base;
  if (wrapped && wrapped !== base) return wrapped;
  return `cd ${JSON.stringify(cwd)} && ${base}`;
}

// The reply MENU — 📂 Files · 🔑 Variables · ⚙️ Settings — rides the end of EVERY answer the AI
// posts into Slack: a streamed or classic reply, an error, a stop, a scheduled/background/API/
// recovery delivery, and the `/menu` card. It is one fixed set with visible labels, so a reply never
// shows a partial or icon-only variant of it. The resume command is deliberately NOT here: it lives
// in Channel Settings → Resume Session and `/resume`.
//
// Binding: a button carries the requester (`u`) when the post has one, and the handlers refuse a
// different clicker. An automation post (schedule, background job, API run, restart recovery) has
// no Slack requester, so its menu is UNBOUND (`u: ""`) and opens for whoever clicks. That grants
// nothing: every open re-applies the clicker's own live channel authorization, and the modal it
// opens is bound to that clicker.
export function filesButton(channelId, threadTs, authorId = "", label = "📂 Files") {
  if (!channelId) return null;
  return {
    type: "button",
    action_id: FILES_ACTION_ID,
    text: { type: "plain_text", text: String(label).slice(0, 75), emoji: true },
    accessibility_label: "Open channel files",
    value: fileActionValue("open", { c: channelId, t: threadTs || "", u: authorId || "" }),
  };
}

// Opens this channel's environment variables (config/channel-env.js), including when the channel
// has none yet, so the first one can be added without knowing `/secrets`.
export function secretsButton(channelId, threadTs, authorId = "", label = "🔑 Variables") {
  if (!channelId) return null;
  return {
    type: "button",
    action_id: SECRETS_ACTION_ID,
    text: { type: "plain_text", text: String(label).slice(0, 75), emoji: true },
    accessibility_label: "Manage channel variables",
    value: secretActionValue("open", { c: channelId, t: threadTs || "", u: authorId || "" }),
  };
}

// Opens the current channel setup. The action handler applies the live authorization check, so a
// stale button never preserves old privileges and there is nothing to gate at render time.
export function settingsButton(channelId, threadTs, authorId = "", label = "⚙️ Settings") {
  if (!channelId) return null;
  return {
    type: "button",
    action_id: CHANNEL_SETTINGS_ACTION_ID,
    text: { type: "plain_text", text: String(label).slice(0, 75), emoji: true },
    accessibility_label: "View channel settings",
    value: settingsActionValue("open", { c: channelId, t: threadTs || "", u: authorId || "" }),
  };
}

// The fixed menu: always all three, in this order, or nothing (no channel to bind to).
export function menuButtons({ channel = "", threadTs = "", authorId = "" } = {}) {
  if (!channel) return [];
  return [
    filesButton(channel, threadTs, authorId),
    secretsButton(channel, threadTs, authorId),
    settingsButton(channel, threadTs, authorId),
  ];
}

// The menu as a standalone actions row, for a message that carries no run stats (an error, a stop).
export function menuBlocks(context = {}) {
  const buttons = menuButtons(context);
  return buttons.length ? [{ type: "actions", elements: buttons }] : [];
}

// Slack caps one section block's text at 3,000 characters.
const MAX_SECTION_CHARS = 3000;

// A gateway notice (an error, "🛑 Stopped.") with the menu under it, as one message's blocks.
// Returns null when the text cannot ride a section block, so the caller posts it plainly and the
// menu separately rather than truncating the notice.
export function noticeWithMenuBlocks(text, context = {}) {
  const body = String(text || "").trim();
  const menu = menuBlocks(context);
  if (!body || !menu.length || body.length > MAX_SECTION_CHARS) return null;
  return [{ type: "section", text: { type: "mrkdwn", text: body } }, ...menu];
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
  if (!channel) return [];
  return referencedWorkspaceFiles(result?.content, result?.cwd).map((file, index) => ({
    type: "button",
    // Slack rejects duplicate action_ids inside one actions block. Keep the stable prefix so the
    // shared FILES_ACTION_PATTERN handler still owns every direct-preview control.
    action_id: `${FILES_ACTION_ID}_review_${index}`,
    text: { type: "plain_text", text: `📄 ${file.name}`.slice(0, 75), emoji: true },
    accessibility_label: `Open ${file.name} in channel files`.slice(0, 75),
    value: fileActionValue("open_file", { c: channel, t: threadTs || "", u: authorId || "", p: file.relative }),
  }));
}

export function footerButtons(result, { channel = "", threadTs = "", authorId = "" } = {}) {
  const menu = menuButtons({ channel, threadTs, authorId });
  if (!menu.length) return [];
  return [...menu, ...reviewFileButtons(result, { channel, threadTs, authorId })];
}

// Same run-stats footer as footerText, but as Block Kit — used to append the footer to a
// streamed reply (chat.stopStream takes `blocks`, not appended text): the compact stats context
// directly above the actions row holding the menu (and any referenced-file buttons).
export function footerBlocks(result, context = {}) {
  const buttons = footerButtons(result, context);
  const stats = { type: "context", elements: [{ type: "mrkdwn", text: footerText(result) }] };
  return buttons.length ? [stats, { type: "actions", elements: buttons }] : [stats];
}
