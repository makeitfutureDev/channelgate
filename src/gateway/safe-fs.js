// Symlink-safe filesystem primitives for gateway-managed files that live BENEATH agent-writable
// workspace folders. The daemon runs unsandboxed while agents can rewrite the workspace between
// (and during) turns, so a planted symlink at a managed path would otherwise make the daemon read
// secrets into agent-visible files or write over host files (a shell rc file is delayed code
// execution). Same posture as file-explorer.js (lstat/realpath-verified paths) and
// run-grant-artifacts.js (exclusive temp + atomic rename): never read or write THROUGH a link the
// gateway didn't create — operate on the link NODE, never its target.
import { open, lstat, mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

// The failures that mean "there is no managed FILE here", all of which callers already treat like
// a missing file: ENOENT (absent), the two spellings of "O_NOFOLLOW refused a symlink" (ELOOP on
// Linux; EMLINK is the BSD spelling, kept so a planted link can never read as a real error), and
// the two shapes of "something that isn't a file is squatting on the
// path" — EISDIR (a directory planted on a file name; folders.js then rm -r's the junk) and
// ENOTDIR (a parent component is a file). Anything else is a real I/O failure — see readNoFollow.
const ABSENT_CODES = new Set(["ENOENT", "ELOOP", "EMLINK", "EISDIR", "ENOTDIR"]);

// Read a managed file without following a symlink at its path. Returns null when the file is
// absent OR is a symlink (ELOOP, or the BSD spelling EMLINK — both mean "refused to follow"),
// so callers treat a planted link exactly like a missing file (see ABSENT_CODES for the full set).
// Every OTHER error — EACCES, EIO, EMFILE… — is a REAL failure and propagates: swallowing it made
// a read-modify-write caller (channel-memory's `add`) treat an unreadable MEMORY.md as empty and
// blank the file on the next write, which is data loss disguised as a symlink guard.
export async function readNoFollow(file) {
  let fh;
  try {
    fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    return await fh.readFile("utf8");
  } catch (error) {
    if (ABSENT_CODES.has(error?.code)) return null;
    throw error;
  } finally {
    await fh?.close();
  }
}

// Replace a managed file atomically without ever writing through a symlink: exclusive temp file
// (O_NOFOLLOW | O_CREAT | O_EXCL) in the same directory, then rename() over the destination.
// rename replaces a symlink NODE sitting at the target path — the link's target is untouched —
// and concurrent readers only ever observe the old or the complete new content, never a
// truncate/write window.
export async function writeNoFollow(file, content, { mode = 0o644 } = {}) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  const fh = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    await fh.writeFile(content);
  } finally {
    await fh.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

// Create a NEW managed file exclusively. O_EXCL fails on ANY existing node at the path —
// including a symlink, even a dangling one — so a planted link can never draw a seed write to
// its target. Throws EEXIST when something already sits there; seed-once callers swallow that.
export async function createExclusive(file, content, { mode = 0o644 } = {}) {
  const fh = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    await fh.writeFile(content);
  } finally {
    await fh.close();
  }
}

// A symlink is tolerable at a managed path ONLY when it points at a real directory that still
// lives inside the trusted root. Returns that resolved directory, or null for a dangling link, a
// link to a non-directory, or one that escapes the root — all of which the caller removes.
async function realDirWithin(root, link) {
  try {
    const target = await realpath(link);
    const rel = path.relative(root, target);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
    return (await stat(target)).isDirectory() ? target : null;
  } catch {
    return null; // dangling, unreadable, or a broken chain
  }
}

// Ensure base/…segments exists as REAL directories, replacing any plain file (or hostile link)
// squatting at a component (remove the planted NODE, never what it points at) — no blind
// `mkdir -p` through whatever happens to exist. `base` itself must be a trusted, daemon-derived
// path; only the segments below it are verified. Returns the final directory path.
//
// One deliberate exception: a symlink that resolves to a real directory STILL INSIDE `base` is
// kept and walked through. Channels can point at a CUSTOM working folder — a dotfiles repo, a
// monorepo package — where such links are the operator's own intentional layout, and deleting
// them (the previous behaviour for every non-directory node) silently mangled their project.
// Everything else stays fail-closed: a link that dangles or escapes `base` is removed, loudly.
export async function ensureRealDir(base, ...segments) {
  await mkdir(base, { recursive: true });
  let root;
  try {
    root = await realpath(base);
  } catch {
    root = path.resolve(base); // unresolvable base — containment still compares against it
  }
  let dir = base;
  for (const segment of segments) {
    dir = path.join(dir, segment);
    let info = null;
    try {
      info = await lstat(dir);
    } catch {
      /* absent — created below */
    }
    if (info?.isSymbolicLink()) {
      const resolved = await realDirWithin(root, dir);
      if (resolved) {
        dir = resolved; // operator-owned link into their own tree — keep it, build below the target
        continue;
      }
      console.warn(`[safe-fs] replacing symlink at managed path ${dir} — it dangles or points outside ${root}`);
    }
    if (info && !info.isDirectory()) {
      // lstat never follows: a plain file, or a rejected symlink from the branch above, lands here.
      await rm(dir, { force: true });
      info = null;
    }
    if (!info) {
      try {
        await mkdir(dir);
      } catch (error) {
        // Losing a creation race is fine — but only when what won is a real directory.
        if (error?.code !== "EEXIST" || !(await lstat(dir)).isDirectory()) throw error;
      }
    }
  }
  return dir;
}
