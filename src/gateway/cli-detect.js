// Where a host binary lives: a pure-Node PATH scan (no subprocess) that also searches the
// well-known install dirs a daemon's minimal PATH misses. Used by the host-sandbox toolchain read
// grants (toolchain-paths.js) and the Codex runner; the admin-UI "installed" badges that used to
// live here went with the CLI-integrations setting (2026-09-03).
import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

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
