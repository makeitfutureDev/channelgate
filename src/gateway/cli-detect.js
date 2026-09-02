// Live detection of which catalog CLIs are installed on THIS machine, so the admin UI can badge
// the Settings → CLI integrations checklist ("installed" / "not installed"). Detection informs —
// it never grants: the sandbox carve-outs still come only from the reviewed catalog entry an
// admin enables. Pure-Node PATH scan (no subprocess): the daemon under launchd/systemd often has
// a minimal PATH that misses Homebrew and per-user bins, so well-known install dirs are searched
// too. macOS + Linux only (this daemon never targets Windows).
import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI_INTEGRATIONS } from "../config/cli-catalog.js";

// Searched AFTER the daemon's own PATH. Order matters only for reporting, not for authority —
// existence anywhere counts as installed.
const EXTRA_BIN_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  path.join(os.homedir(), ".local", "bin"),
  path.join(os.homedir(), "bin"),
  path.join(os.homedir(), ".npm-global", "bin"),
];

function searchDirs() {
  const fromPath = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return [...new Set([...fromPath, ...EXTRA_BIN_DIRS])];
}

// First executable named `bin` across the search dirs, as an absolute path — or null. Detection
// uses it as a boolean; the sandbox read-grants (toolchain-paths.js) need the path itself, so the
// two callers must never drift on WHERE a binary is looked for.
export function resolveBinPath(bin, dirs = searchDirs()) {
  for (const dir of dirs) {
    const candidate = path.join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* not here */
    }
  }
  return null;
}

function binOnDisk(bin, dirs) {
  return resolveBinPath(bin, dirs) !== null;
}

// TTL cache: /api/settings is polled by the admin UI, and a stat sweep across ~20 dirs per bin is
// cheap but not free. Detection state changes at human speed (someone installs a CLI).
const TTL_MS = 60_000;
let cache = { at: 0, result: null };

// id → true (a listed bin is installed) | false (bins listed, none found) | null (API-only entry,
// nothing to detect — the UI shows no badge). `dirs` override is a test hook: it bypasses both
// the PATH+well-known sweep and the cache so scenarios can't leak into each other.
export function detectInstalledClis({ now = Date.now(), dirs: dirsOverride } = {}) {
  if (!dirsOverride && cache.result && now - cache.at < TTL_MS) return cache.result;
  const dirs = dirsOverride || searchDirs();
  const result = {};
  for (const [id, entry] of Object.entries(CLI_INTEGRATIONS)) {
    const bins = entry.bins || [];
    result[id] = bins.length === 0 ? null : bins.some((b) => binOnDisk(b, dirs));
  }
  if (!dirsOverride) cache = { at: now, result };
  return result;
}

// Test hook — detection results must never leak between test scenarios.
export function resetCliDetectionCache() {
  cache = { at: 0, result: null };
}
