// Symlink-safe filesystem primitives for gateway-managed files that live BENEATH agent-writable
// workspace folders. The daemon runs unsandboxed while agents can rewrite the workspace between
// (and during) turns, so a planted symlink at a managed path would otherwise make the daemon read
// secrets into agent-visible files or write over host files (a shell rc file is delayed code
// execution). Same posture as file-explorer.js (lstat/realpath-verified paths) and
// run-grant-artifacts.js (exclusive temp + atomic rename): never read or write THROUGH a link the
// gateway didn't create — operate on the link NODE, never its target.
import { open, lstat, mkdir, readdir, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { oversizeMessage } from "../util/bounded-bytes.js";

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
    // Agent-writable paths may be special nodes. NONBLOCK prevents opening a FIFO from occupying
    // a libuv worker indefinitely; inspect the opened descriptor before performing any data read.
    // Normal regular-file size policy remains with each caller (attachments and memory differ).
    fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await fh.stat();
    if (info.isDirectory()) return null; // preserve the existing absent-managed-file behavior
    if (!info.isFile()) {
      const error = new Error("Refusing to read a managed path that is not a regular file.");
      error.code = "ENOTREG";
      throw error;
    }
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

// Stream a body into a managed file with the same discipline as writeNoFollow — exclusive
// no-follow temp in the destination directory, rename over the target — but WITHOUT ever holding
// the whole body in memory: chunks go to the temp file as they arrive and the running total is
// checked against `maxBytes` per chunk. `source` is a fetch Response (its web-stream body), a bare
// ReadableStream, or a Buffer (small bodies and test doubles take the same path). A declared
// Content-Length above the cap is rejected before a byte is read; a body that then overruns the
// cap is cut off, the temp removed, and the error says so — the destination is never touched.
// `inspect(head)` sees the first chunk (up to 64 bytes) BEFORE anything is committed; throwing
// from it aborts the write, so a caller can refuse a body that turns out to be an HTML sign-in
// page instead of the file. Resolves { bytes } written.
export async function writeStreamNoFollow(file, source, { maxBytes = Infinity, mode = 0o644, inspect = null } = {}) {
  const fail = (actual) => {
    const err = new Error(`downloaded file ${oversizeMessage(actual, maxBytes)}`);
    err.code = "ETOOLARGE";
    return err;
  };
  const declared = Number(source?.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw fail(declared);

  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  const fh = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  let reader = null;
  let total = 0;
  let inspected = false;
  const check = async (chunk) => {
    if (!inspected && inspect) {
      inspected = true;
      await inspect(chunk.subarray(0, 64));
    }
    total += chunk.byteLength;
    if (total > maxBytes) throw fail(null);
  };
  try {
    if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
      const chunk = Buffer.from(source);
      await check(chunk);
      await fh.writeFile(chunk);
    } else {
      const stream = typeof source?.getReader === "function" ? source : source?.body;
      if (!stream?.getReader) {
        // A Response whose body is already buffered by the runtime (or a test double without a
        // web stream): the only remaining option is arrayBuffer(), still capped before the write.
        const chunk = Buffer.from(await source.arrayBuffer());
        await check(chunk);
        await fh.writeFile(chunk);
      } else {
        reader = stream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          await check(chunk);
          await fh.write(chunk);
        }
      }
    }
  } catch (error) {
    await reader?.cancel().catch(() => {});
    await fh.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  await fh.close();
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return { bytes: total };
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

// Remove one gateway-managed regular file only when its resolved path remains beneath a trusted
// root. Attachment folders are agent-writable between turns, so a path that has been replaced by
// a symlink or moved outside the upload root is refused instead of followed. Missing files are
// already clean and therefore return false without failing the completed media operation.
export async function removeRegularFileWithin(root, file) {
  try {
    const resolvedRoot = await realpath(root);
    const candidate = path.resolve(String(file || ""));
    const resolvedParent = await realpath(path.dirname(candidate));
    const parentRelative = path.relative(resolvedRoot, resolvedParent);
    if (parentRelative === ".." || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) return false;

    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    const resolvedCandidate = await realpath(candidate);
    const fileRelative = path.relative(resolvedRoot, resolvedCandidate);
    if (fileRelative === ".." || fileRelative.startsWith(`..${path.sep}`) || path.isAbsolute(fileRelative)) return false;

    await rm(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
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
      // A concurrent replacement can change the type after lstat. Unlink only the leaf;
      // the kernel refuses a directory even when it appears between the check and this call.
      try { await unlink(dir); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
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

// Is `candidate` the same path as `root` or beneath it? Both must already be resolved (realpath)
// when the question is about where a link really points.
export function pathWithin(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

// Resolve a link found INSIDE a trusted source tree. Returns the link's real target when it stays
// inside `realRoot` (the tree's own resolved root), or null when it dangles or leaves the tree.
export async function containedLinkTarget(realRoot, link) {
  let target;
  try {
    target = await realpath(link);
  } catch {
    return null;
  }
  return pathWithin(realRoot, target) ? target : null;
}

// Read a regular file without following a symlink at its final component (the caller has already
// resolved and vetted any link). Throws on a non-regular file.
export async function readFileNoFollow(file) {
  const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await fh.stat();
    if (!info.isFile()) {
      const error = new Error("Refusing to read a path that is not a regular file.");
      error.code = "ENOTREG";
      throw error;
    }
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

// Copy a host source tree (a skill folder in the operator's skill store, say) into a managed
// workspace path base/…segments. The source root itself may be a symlink — it is resolved first —
// but a symlink INSIDE it is followed only while its real target stays inside that resolved root:
// a link that leaves it (to ~/.ssh, the gateway's config, another skill) or dangles is SKIPPED and
// reported through onSkip(relPath), so a planted link can never copy an arbitrary host file into a
// folder a container can read. A link back to a directory already on the current path (a loop) is
// not walked again, and `maxFiles` bounds what a link fan-out could multiply. Destination
// directories go through ensureRealDir and files through writeNoFollow, so a link planted on the
// destination side is never written through either. Mode bits are kept.
export async function copyTreeContained(src, base, segments, { onSkip = () => {}, maxFiles = 10_000 } = {}) {
  const realRoot = await realpath(src);
  let files = 0;
  const walk = async (realDir, relSegments, ancestors) => {
    const destDir = await ensureRealDir(base, ...segments, ...relSegments);
    const entries = await readdir(realDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relPath = [...relSegments, entry.name].join("/");
      let abs = path.join(realDir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await containedLinkTarget(realRoot, abs);
        if (!target) {
          onSkip(relPath);
          continue;
        }
        abs = target;
      }
      let info;
      try {
        info = await stat(abs);
      } catch {
        continue; // vanished between readdir and stat
      }
      if (info.isDirectory()) {
        if (ancestors.has(abs)) continue;
        await walk(abs, [...relSegments, entry.name], new Set([...ancestors, abs]));
      } else if (info.isFile()) {
        if (++files > maxFiles) throw new Error(`${src} has more than ${maxFiles} files`);
        await writeNoFollow(path.join(destDir, entry.name), await readFileNoFollow(abs), { mode: info.mode & 0o777 });
      }
      // Sockets, FIFOs and devices are never copied.
    }
  };
  await walk(realRoot, [], new Set([realRoot]));
  return { files };
}
