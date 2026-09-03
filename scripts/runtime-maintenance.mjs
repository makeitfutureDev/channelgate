import { readdirSync, lstatSync, unlinkSync, copyFileSync, truncateSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

const root = process.env.CHANNELGATE_DIR || process.env.CLAUDE_GATEWAY_DIR || path.join(process.env.HOME, ".channelgate");
const now = Date.now();
const retentionDays = Math.max(1, Number(process.env.CG_RETENTION_DAYS || 30));
const maxLogBytes = Math.max(1024 * 1024, Number(process.env.CG_MAX_LOG_BYTES || 10 * 1024 * 1024));
const cutoff = now - retentionDays * 86400_000;
for (const dirName of ["backups", "update-backups"]) {
  const dir = path.join(root, dirName);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = lstatSync(file); // never follow symlinks in a deletion routine
    const eligible = dirName === "update-backups" || /^config-\d{4}-.*\.tar\.gz\.enc$/.test(name);
    if (eligible && stat.mtimeMs < cutoff) rmSync(file, { recursive: stat.isDirectory(), force: true });
  }
}
const logs = path.join(root, "logs");
if (existsSync(logs)) for (const name of readdirSync(logs)) {
  if (name.endsWith(".1")) continue; // an already-rotated generation: never rotate it again into .1.1…
  const file = path.join(logs, name);
  const stat = lstatSync(file); // never follow symlinks in a deletion routine
  if (stat.isFile() && stat.size > maxLogBytes) {
    // Copy-truncate, NOT rename: systemd keeps the daemon's stdout/stderr fd open, so a
    // renamed file would keep growing under the new name and the size cap would never apply to
    // the live log. Truncating in place keeps the open fd on a now-empty inode. (A write landing
    // between copy and truncate is lost — acceptable for logs, standard copytruncate trade-off.)
    const rotated = `${file}.1`;
    if (existsSync(rotated)) unlinkSync(rotated); // no .1 → .2 chains, same as before
    copyFileSync(file, rotated);
    truncateSync(file, 0);
  }
}
console.log(`Maintenance complete (retention=${retentionDays}d, maxLogBytes=${maxLogBytes}).`);
