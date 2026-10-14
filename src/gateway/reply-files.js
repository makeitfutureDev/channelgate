// Which workspace files an answer referenced, for the reply footer's per-file buttons on every
// chat surface (Slack's slack/footer.js, Teams' msteams/reply-menu.js). Pure filesystem logic: no
// platform knowledge, and every candidate is realpath'd and must stay inside the run's folder.
import path from "node:path";
import { realpathSync, statSync } from "node:fs";

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
