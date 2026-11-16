// Additional folders a channel's container mounts beside its work folder (`meta.extraFolders`).
//
// Why this exists: one host directory shared by several conversations (a client project every
// team channel needs, a mounted file server, a sibling repository) with each channel keeping its
// OWN work folder. A symlink inside the work folder cannot do it — its target is not in the
// container, so the link is broken there — and the daemon must never FOLLOW a link it finds in an
// agent-writable tree to decide a mount (lifecycle.js assertSafeBindSource), or the agent would
// pick its own mounts. So the list is declared by an admin, stored as real paths, and every entry
// is re-checked at every spawn exactly like the work folder: inside the allowlisted root, an
// existing real directory, none of the daemon's own trees or another conversation's default folder
// (src/gateway/workdir-boundary.js), and never overlapping the work folder or another entry (two
// mounts of one host tree alias each other inside the container, which Codex's sandbox refuses).
//
// Each entry is bind-mounted at its IDENTICAL host path, read-write or read-only. Once mounted, a
// symlink in the work folder pointing at it is a legitimate convenience and resolves.
import path from "node:path";
import { realpathSync, statSync } from "node:fs";

import { allowedFsRoot, resolveWithinRoot } from "../web/security.js";
import { forbiddenWorkDirReason } from "./workdir-boundary.js";

export const EXTRA_FOLDER_MODES = ["rw", "ro"];
export const MAX_EXTRA_FOLDERS = 16;

/** Normalize a stored or submitted list to `[{ path, mode }]` — absolute paths, known modes, no duplicates. Pure. */
export function normalizeExtraFolders(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const entry = typeof raw === "string" ? { path: raw } : raw;
    const p = String(entry?.path || "").trim();
    if (!p || !path.isAbsolute(p)) continue;
    const normalized = path.resolve(p);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ path: normalized, mode: entry?.mode === "ro" ? "ro" : "rw" });
    if (out.length >= MAX_EXTRA_FOLDERS) break;
  }
  return out;
}

function within(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function overlaps(a, b) {
  return within(a, b) || within(b, a);
}

/**
 * Validate ONE candidate against the channel's work folder and the other entries. Returns
 * `{ path }` (the real path to store) or `{ error }` (a sentence naming the reason).
 *
 * @param {string} candidate   the submitted path
 * @param {object} options
 * @param {string} options.slug         the channel being configured
 * @param {string} options.workDir      the channel's EFFECTIVE work folder (real path)
 * @param {Array}  [options.others]     the other entries already on the list (normalized)
 * @param {string} [options.root]       the allowlisted root (tests)
 */
export function validateExtraFolder(candidate, { slug = "", workDir = "", others = [], root = allowedFsRoot() } = {}) {
  const refuse = (reason, { prefix = "Refused: ", subject = "" } = {}) => ({ error: `${prefix}${subject ? `${subject} ` : ""}${reason}.`, reason });
  const p = String(candidate || "").trim();
  if (!p || !path.isAbsolute(p)) return refuse("is not an absolute path to an existing directory", { prefix: "" , subject: p || "(empty)" });
  const real = resolveWithinRoot(root, p);
  if (!real) return refuse(`does not exist or is outside the allowed root (${root})`, { prefix: "", subject: p });
  let isDir = false;
  try {
    isDir = statSync(real).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return refuse("is not a directory", { prefix: "", subject: real });
  // The same trees the work folder may never be: it is mounted the same way. Another conversation's
  // DEFAULT folder is refused outright — the work folder's "link to that shared setup" exception
  // has no meaning for an extra mount; another channel's CUSTOM project folder stays allowed.
  const forbidden = forbiddenWorkDirReason(real, { slug });
  if (forbidden) return refuse(`is ${forbidden}`, { subject: real });
  const wd = workDir ? realOrResolved(workDir) : "";
  if (wd && overlaps(wd, real)) {
    if (real === wd) return refuse("is already this channel's working folder", { subject: real });
    if (within(wd, real)) return refuse(`is inside this channel's working folder (${wd}) and is already visible there`, { subject: real });
    return refuse(`contains this channel's working folder (${wd}); a folder and its parent cannot both be mounted`, { subject: real });
  }
  for (const other of others) {
    const otherPath = realOrResolved(other?.path || "");
    if (!otherPath) continue;
    if (otherPath === real) return refuse("is already on this channel's additional folders", { subject: real });
    if (overlaps(otherPath, real)) return refuse(`overlaps the additional folder ${otherPath}; a folder and its parent cannot both be mounted`, { subject: real });
  }
  return { path: real };
}

function realOrResolved(p) {
  const resolved = path.resolve(String(p || ""));
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** The sentence a refused spawn shows for an already-stored entry, with the remedy. */
export function forbiddenExtraFolderMessage(slug, dir, reason) {
  return `This conversation's additional folder ${dir} ${reason}. ChannelGate never mounts that into a container: ` +
    `an admin must remove it (remove_channel_folder, or Settings → Additional folders) or fix the directory.${slug ? ` [${slug}]` : ""}`;
}

/**
 * Resolve the channel's stored list for a SPAWN: every entry must still pass every check, or the
 * spawn fails closed with the remedy — exactly like a stored forbidden work folder. Returns the
 * list of `{ path, mode }` to mount. Called at every spawn (turns, jobs, schedules, reviews).
 */
export function resolveExtraFoldersForSpawn(slug, meta = {}, { workDir = "", root = allowedFsRoot() } = {}) {
  const entries = normalizeExtraFolders(meta?.extraFolders);
  const out = [];
  for (const entry of entries) {
    const checked = validateExtraFolder(entry.path, { slug, workDir, others: out, root });
    if (checked.error) throw Object.assign(new Error(forbiddenExtraFolderMessage(slug, entry.path, checked.reason)), { code: "extra_folder_refused" });
    out.push({ path: checked.path, mode: entry.mode });
  }
  return out;
}

/** The bind mounts for a resolved list (lifecycle.js buildMounts). Identical host and container paths. */
export function extraFolderMounts(base) {
  return (Array.isArray(base?.extraFolders) ? base.extraFolders : [])
    .filter((entry) => entry?.path && path.isAbsolute(entry.path))
    .map((entry) => ({ kind: "extra-folder", type: "bind", source: entry.path, target: entry.path, mode: entry.mode === "ro" ? "ro" : "rw" }));
}

/** The additional folder targets a resolved target actually mounts, read off its mount list. */
export function extraFolderDirectories(target) {
  return (target?.container?.mounts || [])
    .filter((m) => m.kind === "extra-folder" && m.target)
    .map((m) => ({ path: m.target, mode: m.mode === "ro" ? "ro" : "rw" }));
}

/** One line per mounted folder for the admin UI, tool answers and the run preamble. */
export function describeExtraFolders(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return "";
  return list.map((entry) => `${entry.path} (${entry.mode === "ro" ? "read-only" : "read-write"})`).join(", ");
}
