// Which host directories a channel's WORK FOLDER may never be, whatever the allowlisted fsRoot says.
//
// The work folder is bind-mounted READ-WRITE into the channel's container at its identical path
// and browsed by the Slack file explorer (whose protection is write-only: every contained name can
// be read). The containment root (`allowedFsRoot`, src/web/security.js) defaults to the daemon's
// home, so without this list an admin — or injected content steering an admin's turn, since the
// work-folder tools post no approval card — could point a channel at `~/.channelgate` (gateway.db,
// the IPC/capability signing secret), `~/.ssh`, the home itself, or another channel's folder, and
// the next container would mount it. This module is the one place that says no.
//
// The rule is symmetric for the gateway's own trees (a folder that CONTAINS the gateway root is as
// bad as one inside it) and parent-or-equal for other channels' folders (their subfolders are a
// legitimate shared project). The channel's own folders are always allowed. Nonexistent paths are
// "not forbidden" here — existence is the caller's check — and nothing in this module throws.
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";

import { configDir, gatewayRoot, runtimeArtifactsRoot, workspaceFolder, workspaceRoot } from "../config/paths.js";
import { platformFolderNames } from "../platforms/registry.js";
import { getDb } from "../db/index.js";

function realOrResolved(p) {
  const resolved = path.resolve(String(p || ""));
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function within(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// Project-lane artifact trees live beside the legacy `.runtime` one (src/runtimes/container/names.js).
function artifactRoots() {
  const legacy = runtimeArtifactsRoot();
  return [legacy, `${legacy}-project-v2`];
}

/** The daemon-owned trees a work folder may neither be, contain, nor sit inside. */
export function sensitiveWorkDirRoots({ home = os.homedir() } = {}) {
  const h = realOrResolved(home);
  return [
    { path: h, reason: "the gateway account's home directory", exact: true },
    { path: realOrResolved(gatewayRoot()), reason: "the gateway runtime root (database, config, secrets)" },
    { path: realOrResolved(configDir()), reason: "the gateway config directory" },
    { path: path.join(h, ".ssh"), reason: "the gateway account's SSH directory" },
    { path: path.join(h, ".claude"), reason: "the operator's Claude Code home" },
    { path: path.join(h, ".codex"), reason: "the operator's Codex home" },
    { path: path.join(h, ".config", "containers"), reason: "the container engine's configuration" },
    { path: path.join(h, ".local", "share", "containers"), reason: "the container engine's storage" },
    ...artifactRoots().map((p) => ({ path: realOrResolved(p), reason: "the hidden runtime artifact tree" })),
  ];
}

// Every OTHER channel's folders (default + custom), read synchronously so the runtime resolver
// (sync, called at every spawn) can consult it. A store that cannot be read yields nothing rather
// than an exception: the static roots above still apply.
export function otherChannelWorkDirs({ exceptSlug = "" } = {}) {
  const out = [];
  try {
    const db = getDb();
    const entries = db.prepare("SELECT data FROM channels").all();
    const metas = new Map(db.prepare("SELECT slug, data FROM channel_meta").all().map((row) => {
      try {
        return [row.slug, JSON.parse(row.data || "{}") || {}];
      } catch {
        return [row.slug, {}];
      }
    }));
    for (const row of entries) {
      let entry;
      try {
        entry = JSON.parse(row.data || "{}") || {};
      } catch {
        continue;
      }
      const slug = String(entry.slug || "");
      if (!slug || slug === exceptSlug) continue;
      const meta = metas.get(slug) || {};
      const platform = meta.platform || entry.platform;
      out.push({ slug, path: realOrResolved(workspaceFolder(slug, platform)) });
      const custom = String(meta.workDir || "").trim();
      if (custom && path.isAbsolute(custom)) out.push({ slug, path: realOrResolved(custom) });
    }
  } catch {
    /* no store yet (first boot, tests without a database) — the static roots still apply */
  }
  return out;
}

/**
 * Why `candidate` may not be a channel's work folder, or "" when it may.
 * @param {string} candidate   an absolute directory path (realpath'd by the caller when it exists)
 * @param {object} [options]
 * @param {string} [options.slug]      the channel being configured — its own folders are allowed
 * @param {Array}  [options.channels]  other channels' folders to check instead of reading the store
 * @param {string} [options.home]      override of the daemon home (tests)
 */
export function forbiddenWorkDirReason(candidate, { slug = "", channels, home } = {}) {
  const real = realOrResolved(candidate);
  if (!path.isAbsolute(real)) return "not an absolute path";
  const roots = sensitiveWorkDirRoots(home ? { home } : {});
  const visible = realOrResolved(workspaceRoot());
  // Exact matches first, so the most specific sentence wins (the workspace root contains the
  // artifact tree; the home contains everything).
  for (const root of roots) if (real === root.path) return root.exact ? `${root.reason} itself` : root.reason;
  if (real === visible) return "the ChannelGate workspace root itself (every channel's folder lives under it)";
  if (path.dirname(real) === visible && platformFolderNames().includes(path.basename(real))) return "a platform folder of the ChannelGate workspace (it holds every channel of that surface)";
  // Inside one of the daemon's trees.
  for (const root of roots) if (!root.exact && within(root.path, real)) return `inside ${root.reason}`;
  // Other conversations' folders: equal, then (below) parent-of.
  const others = Array.isArray(channels) ? channels : otherChannelWorkDirs({ exceptSlug: slug });
  for (const other of others) {
    if (!other?.path || other.slug === slug) continue;
    if (real === other.path) return `another conversation's work folder (${other.slug})`;
  }
  // A parent of any of the above is as bad as the thing itself (it would mount it).
  for (const root of roots) if (within(real, root.path)) return `a parent of ${root.reason}`;
  if (within(real, visible)) return "a parent of the ChannelGate workspace root";
  for (const other of others) {
    if (!other?.path || other.slug === slug) continue;
    if (within(real, other.path)) return `a parent of another conversation's work folder (${other.slug})`;
  }
  return "";
}

/** The sentence a refused run or a refused setting shows, with the remedy. */
export function forbiddenWorkDirMessage(slug, dir, reason) {
  return `This conversation's work folder is ${dir}, which is ${reason}. ChannelGate never mounts that into a container: ` +
    "an admin must point the conversation at a project directory (set_channel_workdir, or Settings → Working folder) " +
    `or clear it back to the default folder (clear_channel_workdir).${slug ? ` [${slug}]` : ""}`;
}
