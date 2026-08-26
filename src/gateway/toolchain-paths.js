// Which absolute paths the folder sandbox must re-allow for READING so the agent's own toolchain
// still exists inside a run.
//
// The lockdown denies reading all of $HOME and re-allows only the work dir (see folders.js
// buildSettings). On macOS that is invisible: Homebrew installs node/vercel under /opt/homebrew or
// /usr/local, outside $HOME, so nothing is masked. On Linux the same daemon is routinely installed
// per-user — node, npm, npx, vercel, gh under ~/.local/bin — and Claude Code implements denyRead by
// tmpfs-masking $HOME. Those binaries therefore do not become unreadable, they stop EXISTING: a
// Bash channel reports "this sandbox has no node/vercel" while /usr/bin tools (git, python3) keep
// working, and Settings still badges "Vercel: installed" because cli-detect.js scans the DAEMON's
// filesystem, not the sandbox's.
//
// Grants here are READ-ONLY and never widen writes: `bin` and `.local` stay on folders.js's
// SENSITIVE_HOME write-deny list, so the delayed-escape protection (plant a binary now, have it run
// unsandboxed later) is untouched. Scope stays surgical for the same reason — the resolved
// binaries plus the Node install prefix they need, never a whole `~/.local`, which also holds
// application data (`.local/share/…`) a run has no business reading.
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI_INTEGRATIONS, normalizeCliIntegrations } from "../config/cli-catalog.js";
import { resolveBinPath } from "./cli-detect.js";

// The baseline every project task assumes it has. Deliberately NOT "everything on PATH": a grant
// is a reviewed decision, so a tool that is missing from this list stays invisible by design.
// `git` and `python3` are here for the machines that install them under HOME (pyenv, asdf); where
// they live in /usr/bin they resolve outside HOME and are dropped as already-readable.
export const TOOLCHAIN_BINS = ["node", "npm", "npx", "git", "gh", "python3"];

// prefix/bin/node → prefix. npm, npx and every globally-installed CLI (vercel included) are JS
// files under prefix/lib/node_modules with a `#!/usr/bin/env node` shim in prefix/bin, so the
// whole prefix has to be visible or the shim resolves to a file that isn't there.
function nodePrefixOf(execPath) {
  if (!execPath) return null;
  const real = realpathOr(execPath);
  const dir = path.dirname(real);
  // Standard layout is <prefix>/bin/node; anything else, grant just the directory holding it.
  return path.basename(dir) === "bin" ? path.dirname(dir) : dir;
}

function realpathOr(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// `<...>/node_modules/vercel/dist/vc.js` → `<...>/node_modules/vercel` (scoped packages included).
// A globally-installed CLI is almost never one self-contained file: the `bin` entry is a shim that
// reaches the rest of its package through relative imports. Granting the shim alone leaves those
// siblings masked, so the CLI resolves, starts, and then dies on its own first import. This only
// shows up when npm's global root sits OUTSIDE the Node prefix (`~/.local/lib/node_modules` rather
// than `<prefix>/lib/node_modules`) — where it is inside, the prefix grant already covered it,
// which is exactly why the first cut of this module looked correct on one machine and not another.
function packageRootOf(file) {
  const parts = String(file).split(path.sep);
  const i = parts.lastIndexOf("node_modules");
  if (i === -1 || i + 1 >= parts.length) return null;
  const end = parts[i + 1].startsWith("@") ? i + 3 : i + 2;
  return end <= parts.length ? parts.slice(0, end).join(path.sep) : null;
}

// Drop any path already contained in another path in the set, so a directory grant absorbs the
// files under it and the emitted list stays the minimal reviewable set.
function minimize(paths) {
  return paths.filter((p) => !paths.some((other) => other !== p && within(p, other)));
}

function within(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Absolute read-grant paths for the toolchain, filtered to the ones the sandbox would otherwise
// hide. `integrations` are the ids enabled in Settings → the same consent that already unlocks a
// CLI's domains and saved login now also makes its binary reachable.
//
// `home`/`root`/`execPath`/`dirs` are injectable so tests can build a scenario without depending
// on how the host machine happens to be installed.
export function toolchainReadPaths({
  home = os.homedir(),
  root = null,
  execPath = process.execPath,
  integrations = [],
  dirs,
} = {}) {
  const out = new Set();
  const add = (p) => {
    if (!p || !path.isAbsolute(p)) return;
    // Only home is worth re-allowing: it is the one tree buildSettings blanket-denies for reads.
    // Everything else is already readable, and a path inside the gateway root must NEVER be
    // granted — that tree holds every channel's config and tokens.
    if (!within(p, home)) return;
    if (root && within(p, root)) return;
    out.add(p);
  };

  add(nodePrefixOf(execPath));

  const bins = [...TOOLCHAIN_BINS];
  for (const id of normalizeCliIntegrations(integrations)) bins.push(...(CLI_INTEGRATIONS[id].bins || []));

  for (const bin of new Set(bins)) {
    const found = resolveBinPath(bin, dirs);
    if (!found) continue;
    // Grant the PATH entry AND what it resolves to. Granting only the target is not enough: the
    // sandbox refuses at the link itself, long before the allowed destination is reached — the
    // same trap folders.js documents for the synthetic-HOME credential links.
    add(found);
    const real = realpathOr(found);
    add(packageRootOf(real) || real);
  }

  return minimize([...out]).sort();
}
