// Preserve displaced local skills outside engine discovery. Paths below a workspace can be
// rewritten by an agent: directory descriptors pin every component and symlinks are archived
// as nodes, never read through. A failed archive leaves the original entry available.
import { constants } from "node:fs";
import { open, mkdir, rename, rm, readdir, lstat, readlink, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const directoryPath = (handle) => `/proc/self/fd/${handle.fd}`;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

// Linux is the supported host. Opening each component relative to an already-open directory
// prevents an ancestor replacement from redirecting subsequent reads or writes.
export async function openWorkspaceDirectory(value, { create = false, mode = 0o700 } = {}) {
  const absolute = path.resolve(value);
  let handle = await open(path.parse(absolute).root, directoryFlags);
  try {
    for (const segment of absolute.split(path.sep).filter(Boolean)) {
      const next = await openChildDirectory(handle, segment, { create, mode });
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function openChildDirectory(parent, name, { create = false, mode = 0o755 } = {}) {
  const target = path.join(directoryPath(parent), name);
  if (create) {
    try { await mkdir(target, { mode }); } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  return open(target, directoryFlags);
}

function sameNode(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}

async function copyNode(source, destination) {
  const before = await lstat(source);
  if (before.isSymbolicLink()) {
    await symlink(await readlink(source), destination);
  } else if (before.isDirectory()) {
    const input = await open(source, directoryFlags);
    try {
      if (!sameNode(before, await input.stat())) throw new Error("workspace entry changed while archiving");
      await mkdir(destination, { mode: 0o700 });
      const output = await open(destination, directoryFlags);
      try {
        for (const name of await readdir(directoryPath(input))) {
          await copyNode(path.join(directoryPath(input), name), path.join(directoryPath(output), name));
        }
        await output.chmod(before.mode & 0o777);
      } finally { await output.close(); }
    } finally { await input.close(); }
  } else if (before.isFile()) {
    const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let output;
    try {
      if (!sameNode(before, await input.stat())) throw new Error("workspace entry changed while archiving");
      output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const chunk = Buffer.alloc(256 * 1024);
      let offset = 0;
      for (;;) {
        const { bytesRead } = await input.read(chunk, 0, chunk.length, offset);
        if (!bytesRead) break;
        // Bound a concurrently growing input to its initial size.
        if (offset + bytesRead > before.size) throw new Error("workspace file changed while archiving");
        let written = 0;
        while (written < bytesRead) {
          const { bytesWritten } = await output.write(chunk, written, bytesRead - written, offset + written);
          written += bytesWritten;
        }
        offset += bytesRead;
      }
      const after = await input.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error("workspace file changed while archiving");
      }
      await output.chmod(before.mode & 0o777);
    } finally {
      await input.close();
      await output?.close();
    }
  } else {
    throw new Error("cannot archive a special workspace file; move it out of the skills folder first");
  }
  const after = await lstat(source);
  if (!sameNode(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error("workspace entry changed while archiving");
  }
}

export async function archiveWorkspaceEntry(entry, backupDir) {
  if (!backupDir || !path.isAbsolute(backupDir)) throw new Error("an absolute backupDir is required before replacing local skills");
  const source = path.resolve(entry);
  const backup = path.resolve(backupDir);
  const parent = path.dirname(source);
  // The entry may be a conflicting .claude/.agents container, not an individual skill. In that
  // case a sibling .channelgate backup beneath the same workDir is safe (including cwd = HOME).
  // Individual skill entries still reject backups anywhere under their discovery parent.
  const name = path.basename(source);
  const containerNames = new Set([".claude", ".agents", ".codex"]);
  const discoveryRoot = containerNames.has(name) || (name === "skills" && containerNames.has(path.basename(parent))) ? source : parent;
  const relative = path.relative(discoveryRoot, backup);
  const segments = backup.split(path.sep);
  const inOtherDiscoveryTree = segments.some((segment, index) => containerNames.has(segment) && segments[index + 1] === "skills");
  if (inOtherDiscoveryTree || !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("skill backups must be outside the skill discovery tree");
  }
  const sourceParent = await openWorkspaceDirectory(parent);
  let archiveRoot;
  try {
    archiveRoot = await openWorkspaceDirectory(backup, { create: true });
    const node = path.join(directoryPath(sourceParent), path.basename(source));
    const name = `${path.basename(source).slice(0, 160)}-${Date.now()}-${randomUUID()}`;
    const destination = path.join(directoryPath(archiveRoot), name);
    try {
      await rename(node, destination);
    } catch (error) {
      if (error?.code !== "EXDEV") throw error;
      // Cross-device mounts cannot rename. Copy the complete node first, then compare its inode
      // before removing it. Descriptor-relative traversal cannot follow a planted link.
      const original = await lstat(node);
      try {
        await copyNode(node, destination);
        if (!sameNode(original, await lstat(node))) throw new Error("workspace entry changed while archiving");
      } catch (copyError) {
        await rm(destination, { recursive: true, force: true });
        throw copyError;
      }
      await rm(node, { recursive: true, force: true });
    }
    return path.join(backup, name);
  } finally {
    await sourceParent.close();
    await archiveRoot?.close();
  }
}
