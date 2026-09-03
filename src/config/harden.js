// Filesystem permissions for the runtime secrets.
//
// ~/.channelgate holds Slack tokens, every user's personal Composio/Skills/Toolbox token, the
// run-API key and the admin password. Those files were created with the default umask (0644 —
// world-readable), so any other account on the host could read the lot. The daemon already gets
// this right for internal-auth.json and drive-sa.json; this module makes it uniform.
//
// chmod (not just a create-time `mode`) because the files already exist on every install that
// predates this — writeFileSync's `mode` only applies when it CREATES the file.
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, renameSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { gatewayRoot, dbFile, settingsFile, usersFile, channelsIndexFile, mcpCatalogFile, runTmpDir } from "./paths.js";

const SECRET_MODE = 0o600;
const DIR_MODE = 0o700;

// Atomically replace a secret-bearing file with a same-directory 0600 temporary file. fsync before
// rename means readers see either the old complete JSON or the new complete JSON, never a torn
// write. Same-directory rename is atomic on Linux. The parent directory is fsynced
// after the rename so a hard crash can't revert the rename itself (losing the newest write —
// still never corruption or a world-readable window); best-effort because directory fsync is
// platform-dependent.
export function writeSecretFile(file, contents) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let fd;
  try {
    fd = openSync(temp, "wx", SECRET_MODE);
    writeFileSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
    // Defend against an unusual pre-existing destination ACL/mode implementation.
    chmodSync(file, SECRET_MODE);
    try {
      const dirFd = openSync(path.dirname(file), "r");
      fsyncSync(dirFd);
      closeSync(dirFd);
    } catch {
      /* directory fsync unsupported here — the data itself is already durable */
    }
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    rmSync(temp, { force: true });
    throw error;
  }
}

// The files under the gateway root that carry credentials, plus SQLite's sidecars (the WAL holds
// the same rows as the DB, so leaving it 0644 would defeat the point).
function secretPaths() {
  const db = dbFile();
  return [settingsFile(), usersFile(), channelsIndexFile(), mcpCatalogFile(), db, `${db}-wal`, `${db}-shm`];
}

// Secure-by-default for NEW installs only.
//
// With no admin password every /api route is open. On a loopback bind that was the local-dev
// convenience, but it means any other process or user on the host can read every stored token and
// start runs — not a defensible default for a product. Refusing to boot, or generating a password
// on an existing install, would lock out operators mid-flight, so this fires only when the gateway
// has never been configured: no settings file at all. Existing installs are untouched and keep
// whatever posture they already had.
//
// Returns the generated password once, so the caller can print it — it is stored hashed and cannot
// be recovered afterwards.
export async function ensureAdminPasswordOnFirstBoot({ settingsExist, hasPassword, save, generate }) {
  if (settingsExist || hasPassword) return "";
  const password = generate();
  await save(password);
  return password;
}

// Tighten the runtime root and its secret-bearing files. Callers MUST treat any returned failure
// as fatal: continuing would knowingly boot with credentials readable outside the daemon account.
export function hardenRuntimeFiles() {
  const failed = [];
  const tighten = (p, mode) => {
    if (!existsSync(p)) return;
    try {
      chmodSync(p, mode);
    } catch (e) {
      failed.push(`${p}: ${e.message}`);
    }
  };

  tighten(gatewayRoot(), DIR_MODE);
  for (const p of secretPaths()) tighten(p, SECRET_MODE);

  // Per-run MCP config files embed the author's tokens and are deleted when their run settles;
  // a daemon crash mid-run can strand one. Nothing here outlives a run, so clearing the whole
  // directory at boot is safe and keeps stale credentials from lingering on disk.
  try {
    rmSync(runTmpDir(), { recursive: true, force: true });
  } catch (e) {
    failed.push(`${runTmpDir()}: ${e.message}`);
  }
  return { failed };
}

// One boot-security chokepoint, split out so the fail-closed contract is unit-testable without
// importing server.js (which starts the daemon as a side effect).
export function assertRuntimeHardening({ failed } = {}) {
  if (!Array.isArray(failed) || !failed.length) return;
  throw new Error(`refusing to boot: couldn't secure runtime path(s): ${failed.join("; ")}`);
}
