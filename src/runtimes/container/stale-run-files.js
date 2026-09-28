// Stale per-run credential files in a channel's artifact dir.
//
// Before container-secrets P1 every turn wrote its MCP config (`cg-mcp-<uuid>.json`, the memory
// reviewer's `cg-mcp-review-<uuid>.json`) and every Codex run its secret bundle
// (`run/cg-codex-secrets-<uuid>.json` + one `…-<server>.headers.cjs` per header helper) with REAL
// Composio/toolbox tokens into `~/ChannelGate/.runtime/<platform>/<slug>/` — the directory that is
// bind-mounted read-write into the channel's own container. Each run removes its own files in a
// `finally`, but a crashed daemon, a killed process or an interrupted run leaked them, and a
// leftover stays readable by every later turn in that container. The container backend sweeps
// them before every create/start and, for containers already running, at boot.
//
// Age is the liveness test: a live turn's files are minutes old (the reviewer's too), and no
// process that could still read an older one survives a container start or a daemon restart. The
// sweep never follows a symlink — a directory or file an agent replaced with a link is skipped.
import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";

export const STALE_RUN_FILE_MS = 6 * 60 * 60 * 1000;

export const STALE_RUN_FILE_PATTERNS = Object.freeze([
  /^cg-mcp-.+\.json$/, // cg-mcp-<uuid>.json and cg-mcp-review-<uuid>.json
  /^cg-codex-secrets-.+\.json$/,
  /^cg-codex-secrets-.+\.headers\.cjs$/,
]);

// The artifact dir itself and its `run/` subdirectory (Codex writes its bundle there).
const SWEPT_SUBDIRS = Object.freeze(["", "run"]);

function isRealDirectory(dir) {
  try {
    return lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Remove stale per-run credential files from one channel's artifact dir. Returns the number of
 * files removed; never throws (a sweep must not fail a container start).
 */
export function sweepStaleRunCredentialFiles(artifactDir, { now = Date.now(), maxAgeMs = STALE_RUN_FILE_MS } = {}) {
  if (!artifactDir || !isRealDirectory(artifactDir)) return 0;
  const cutoff = now - maxAgeMs;
  let removed = 0;
  for (const sub of SWEPT_SUBDIRS) {
    const dir = sub ? path.join(artifactDir, sub) : artifactDir;
    if (sub && !isRealDirectory(dir)) continue;
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!STALE_RUN_FILE_PATTERNS.some((pattern) => pattern.test(name))) continue;
      const file = path.join(dir, name);
      try {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
        unlinkSync(file); // unlink never follows: a file swapped for a link now removes only the link
        removed += 1;
      } catch {
        /* raced with the run's own cleanup */
      }
    }
  }
  return removed;
}
