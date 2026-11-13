// Preserve only a legacy thread's rollout when its dedicated account gains its own CODEX_HOME.
// Self-contained: serialized into a bounded Node helper inside the already leased container.
import { newRunId } from "../runtimes/contract.js";

export async function copyLegacyChannelCodexHistory({ sourceRoot, destinationRoot, sessionIds,
  maxEntries = 40_000, maxBytes = 512 * 1024 * 1024, maxFileBytes = 128 * 1024 * 1024 } = {}) {
  const fs = await import("node:fs/promises");
  const { constants } = await import("node:fs");
  const path = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const ids = [...new Set(sessionIds || [])];
  if (!ids.length || ids.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id))) throw new Error("Invalid legacy Codex session identity");
  for (const limit of [maxEntries, maxBytes, maxFileBytes]) if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid legacy Codex history bound");
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  if (source === destination || source.startsWith(`${destination}${path.sep}`) || destination.startsWith(`${source}${path.sep}`)) throw new Error("Legacy Codex history directories must be separate");
  const stats = { copied: 0, existing: 0, bytes: 0 };
  let entries = 0;

  async function directory(dir, create = false) {
    const absolute = path.resolve(dir);
    let current = path.parse(absolute).root;
    for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let info;
      try { info = await fs.lstat(current); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (!create) return false;
        try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
        info = await fs.lstat(current);
      }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe legacy Codex history directory");
    }
    return true;
  }

  async function copy(file, relative) {
    const dest = path.join(destination, "sessions", relative);
    await directory(path.dirname(dest), true);
    try {
      const existing = await fs.lstat(dest);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("Unsafe existing Codex history file");
      stats.existing++;
      return;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const input = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const temporary = path.join(path.dirname(dest), `.cg-codex-history-${randomUUID()}.tmp`);
    let output;
    try {
      const before = await input.stat();
      if (!before.isFile() || before.nlink !== 1) throw new Error("Unsafe legacy Codex rollout");
      if (before.size > maxFileBytes || stats.bytes + before.size > maxBytes) throw new Error("Legacy Codex history byte limit exceeded");
      output = await fs.open(temporary, "wx", 0o600);
      const buffer = Buffer.alloc(Math.min(64 * 1024, before.size + 1));
      let offset = 0;
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        if (offset > before.size) throw new Error("Legacy Codex rollout changed while copying");
        await output.writeFile(buffer.subarray(0, bytesRead));
      }
      const after = await input.stat();
      if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("Legacy Codex rollout changed while copying");
      await output.close(); output = null;
      // Atomic no-clobber publication: concurrent resumes never replace a newer dedicated file.
      try { await fs.link(temporary, dest); stats.copied++; stats.bytes += offset; }
      catch (error) { if (error.code !== "EEXIST") throw error; stats.existing++; }
    } finally {
      await input.close();
      await output?.close();
      await fs.rm(temporary, { force: true });
    }
  }

  async function scan(dir, relative = [], depth = 0) {
    const handle = await fs.opendir(dir);
    for await (const entry of handle) {
      if (++entries > maxEntries) throw new Error("Legacy Codex history entry limit exceeded");
      const full = path.join(dir, entry.name);
      if (depth < 3) {
        if (!entry.isDirectory() || !(depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name)) continue;
        await directory(full);
        await scan(full, [...relative, entry.name], depth + 1);
      } else if (entry.isFile() && entry.name.startsWith("rollout-") && ids.some(id => entry.name.endsWith(`-${id}.jsonl`))) {
        await copy(full, path.join(...relative, entry.name));
      }
    }
  }
  const sessions = path.join(source, "sessions");
  if (!(await directory(sessions))) return stats;
  await scan(sessions);
  return stats;
}

export async function preserveChannelCodexHistory(ctx, { timeoutMs = 30_000 } = {}) {
  const target = ctx?.target;
  if (!target?.meta?.codexChannelLegacyHistory || target.backend !== "container") return null;
  const ids = [!ctx.session?.fresh ? ctx.session?.id : "", ctx.runtime?.forkSourceSessionId].filter(Boolean);
  if (!ids.length) return null;
  const signal = ctx.runtime?.signal;
  signal?.throwIfAborted();
  const options = { sourceRoot: `${target.container?.home || "/home/agent"}/.codex`,
    destinationRoot: target.container?.codexChannelHome || `${target.container?.home || "/home/agent"}/.codex-channel`, sessionIds: ids };
  const source = `(${copyLegacyChannelCodexHistory.toString()})(${JSON.stringify(options)}).then(r=>process.stdout.write(JSON.stringify(r))).catch(e=>{process.stderr.write(e.message);process.exitCode=1})`;
  const child = target.runtime.spawn(target, { cmd: "node", args: ["--input-type=module", "-e", source], cwd: ctx.cwd || target.cwd,
    stdio: ["ignore", "pipe", "pipe"], detached: false, kind: "helper", runId: newRunId("run") });
  return await new Promise((resolve, reject) => {
    let stdout = "", stderr = "", settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(result);
    };
    const stop = () => { Promise.resolve().then(() => target.runtime.signal?.(child, "SIGKILL")).catch(() => {}); };
    const abort = () => { stop(); finish(signal?.reason || Object.assign(new Error("Legacy Codex history copy aborted"), { name: "AbortError" })); };
    const timer = setTimeout(() => { stop(); finish(new Error("Legacy Codex history copy timed out; retry this thread before continuing")); }, timeoutMs);
    child.stdout?.on("data", data => { stdout = (stdout + data).slice(0, 4096); });
    child.stderr?.on("data", data => { stderr = (stderr + data).slice(0, 4096); });
    child.once("error", error => finish(error));
    child.once("close", code => {
      if (settled) return;
      if (code !== 0) return finish(new Error(`Legacy Codex history could not be preserved: ${stderr || `helper exited ${code}`}`));
      try { finish(null, JSON.parse(stdout)); } catch { finish(new Error("Legacy Codex history helper returned an invalid result")); }
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
