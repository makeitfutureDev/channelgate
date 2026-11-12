// Channel-native transcripts are shared by the two container scopes. Everything else in HOME
// (logins, settings, personal MCP payloads, jobs and SQLite state) remains scope-local.
import path from "node:path";
import { runtimeArtifactsRoot } from "../../config/paths.js";
import { runtimeArtifactDir, homeVolumeName, currentInstallId } from "./names.js";

const MARKER = ".project-history-seeded-v1.json";

export function channelHistoryRoot(target) {
  const slug = String(target?.slug || "");
  if (!slug || slug === "." || slug === ".." || /[/\\\0]/.test(slug)) throw new Error("Invalid channel history path");
  const root = runtimeArtifactsRoot();
  const relative = path.relative(root, runtimeArtifactDir(slug, target.platform, "admin"));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Invalid channel history path");
  }
  return path.join(`${root}-history`, currentInstallId(), relative);
}

export function channelHistoryIdentity(target) {
  return `channel-history-v1:${channelHistoryRoot(target)}`;
}

export function historySeedMarker(target) {
  return path.join(channelHistoryRoot(target), MARKER);
}

export function historyMounts(target) {
  const root = channelHistoryRoot(target);
  return [
    ["claude-projects", "/home/agent/.claude/projects"],
    ["codex-sessions", "/home/agent/.codex/sessions"],
    ["codex-archived-sessions", "/home/agent/.codex/archived_sessions"],
  ].map(([name, destination]) => ({
    kind: `history-${name}`, type: "bind", source: path.join(root, name), target: destination, mode: "rw",
  }));
}

// Self-contained so the SAME audited implementation runs in an unprivileged, network-less helper.
// Only the old project HOME (read-only) and the new history store are mounted; the traversal below
// selects transcript trees, never that HOME's login/configuration files or daemon/admin state.
// The lifecycle holds the channel-wide history lock and drains project writers before invoking it.
export async function seedProjectHistory({
  sourceRoot,
  sharedRoot,
  maxFiles = 20_000,
  maxEntries = 40_000,
  maxBytes = 512 * 1024 * 1024,
  maxFileBytes = 128 * 1024 * 1024,
  maxDepth = 16,
} = {}) {
  const fs = await import("node:fs/promises");
  const { constants } = await import("node:fs");
  const path = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  for (const limit of [maxFiles, maxEntries, maxBytes, maxFileBytes, maxDepth]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid channel history migration limit");
  }
  if (!sourceRoot || !sharedRoot) throw new Error("Channel history migration requires two directories");
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(sharedRoot);
  if (source === destination || source.startsWith(`${destination}${path.sep}`) || destination.startsWith(`${source}${path.sep}`)) {
    throw new Error("Channel history migration directories must be separate");
  }
  const marker = path.join(destination, ".project-history-seeded-v1.json");
  const stats = { version: 1, files: 0, copied: 0, unchanged: 0, bytes: 0 };
  let entries = 0;

  async function directory(dir, create = false) {
    const absolute = path.resolve(dir);
    let current = path.parse(absolute).root;
    for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let info;
      try { info = await fs.lstat(current); }
      catch (error) {
        if (error.code !== "ENOENT" || !create) throw error;
        try { await fs.mkdir(current, { mode: 0o700 }); }
        catch (createError) { if (createError.code !== "EEXIST") throw createError; }
        info = await fs.lstat(current);
      }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe channel history directory");
    }
  }

  async function readFile(file, bound) {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1) throw new Error("Unsafe channel history file");
      if (before.size > bound) throw new Error("Channel history migration byte limit exceeded");
      const contents = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < contents.length) {
        const read = await handle.read(contents, offset, contents.length - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      const after = await handle.stat();
      if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new Error("Channel history source changed during migration");
      }
      return { contents: contents.subarray(0, offset), info: before };
    } finally { await handle.close(); }
  }

  await directory(source);
  await directory(destination, true);
  try {
    const saved = await readFile(marker, 4096);
    if (JSON.parse(saved.contents.toString("utf8")).version !== 1) throw new Error("Invalid channel history migration marker");
    return { ...stats, alreadySeeded: true };
  } catch (error) { if (error.code !== "ENOENT") throw error; }

  async function walk(from, to, depth = 0) {
    if (depth > maxDepth) throw new Error("Channel history migration depth limit exceeded");
    await directory(from);
    await directory(to, true);
    for await (const entry of await fs.opendir(from)) {
      if (++entries > maxEntries) throw new Error("Channel history migration entry limit exceeded");
      const input = path.join(from, entry.name);
      const output = path.join(to, entry.name);
      const info = await fs.lstat(input);
      if (info.isSymbolicLink()) throw new Error("Unsafe channel history source link");
      if (info.isDirectory()) { await walk(input, output, depth + 1); continue; }
      if (!info.isFile() || info.nlink !== 1) throw new Error("Unsafe channel history source file");
      if (++stats.files > maxFiles) throw new Error("Channel history migration file limit exceeded");
      const remaining = Math.min(maxFileBytes, maxBytes - stats.bytes);
      if (info.size > remaining) throw new Error("Channel history migration byte limit exceeded");
      const { contents, info: openedInfo } = await readFile(input, remaining);
      stats.bytes += contents.length;
      try {
        const existing = await readFile(output, maxFileBytes);
        if (!contents.equals(existing.contents)) throw new Error("Channel history migration conflict; existing history was preserved");
        stats.unchanged++;
        continue;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      const temporaryFile = path.join(to, `.cg-history-import-${randomUUID()}`);
      let writer;
      try {
        writer = await fs.open(temporaryFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await writer.writeFile(contents);
        await writer.sync();
        await writer.utimes(openedInfo.atime, openedInfo.mtime);
        await writer.close(); writer = null;
        // link is an atomic publish that cannot replace a destination another writer created.
        await fs.link(temporaryFile, output);
        stats.copied++;
      } finally { await writer?.close(); await fs.rm(temporaryFile, { force: true }); }
    }
  }

  for (const [input, output] of [
    [".claude/projects", "claude-projects"],
    [".codex/sessions", "codex-sessions"],
    [".codex/archived_sessions", "codex-archived-sessions"],
  ]) {
    const from = path.join(source, input);
    try { await directory(from); }
    catch (error) { if (error.code === "ENOENT") { await directory(path.join(destination, output), true); continue; } throw error; }
    await walk(from, path.join(destination, output));
  }
  // Publish completion only after every source has been checked and copied without conflict.
  const temporary = `${marker}.${randomUUID()}`;
  let writer;
  try {
    writer = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await writer.writeFile(JSON.stringify(stats));
    await writer.sync();
    await writer.close(); writer = null;
    await fs.rename(temporary, marker);
  } finally { await writer?.close(); await fs.rm(temporary, { force: true }); }
  return { ...stats, alreadySeeded: false };
}

export function buildHistorySeedArgs(target, caps) {
  const c = target.container;
  const args = ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"];
  if (caps.uidStrategy === "keep-id") args.push("--userns=keep-id");
  else if (c.uid != null && c.gid != null) args.push("--user", `${c.uid}:${c.gid}`);
  args.push("-v", `${homeVolumeName({ ...target, runtimeScope: "project" })}:/legacy:ro`);
  args.push("-v", `${channelHistoryRoot(target)}:/shared`);
  args.push("--entrypoint", "node", c.image, "--input-type=module", "-e",
    `const result = await (${seedProjectHistory.toString()})({ sourceRoot: "/legacy", sharedRoot: "/shared" }); process.stdout.write(JSON.stringify(result));`);
  return args;
}
