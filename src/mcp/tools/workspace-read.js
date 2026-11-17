// Engine-neutral, read-only access to the current channel workspace. Claude has native
// Read/Glob/Grep tools; Codex does not expose an equivalent filesystem primitive when its
// permission profile is read-only. These MCP tools keep the user-facing Read-mode contract the
// same without granting a shell: every path is realpath-confined to effectiveWorkDir, escaping
// symlinks are rejected, outputs are bounded, and no write operation exists in this module.
import { readdir, readFile } from "node:fs/promises";
import { z } from "zod";
import { channelFileRoot } from "../../gateway/channel-file-root.js";
import { explorerMounts, MOUNT_SEGMENT, resolveVisiblePath } from "../../slack/file-explorer.js";

const MAX_READ_BYTES = 64 * 1024;
const MAX_SCAN_FILES = 500;
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_RESULTS = 100;

// The working folder plus the channel's additional folders (`@mounts/<name>/…`).
function workspaceFor(slug, meta) {
  return channelFileRoot(slug, meta);
}

function cleanError(error) {
  return String(error?.message || "Workspace read failed.").replace(/\s+/g, " ").trim();
}

async function walkFiles(root, relative = "", state = { files: 0, directories: new Set() }) {
  const dir = await resolveVisiblePath(root, relative, { kind: "directory" });
  // Internal symlinks are valid workspace entries, but they can point back to an already-walked
  // directory. Track real directory paths so a symlink cycle cannot make list/search recurse
  // forever, and bound empty-directory trees as well as files.
  if (state.directories.has(dir.path) || state.directories.size >= MAX_SCAN_FILES) return [];
  state.directories.add(dir.path);
  const entries = await readdir(dir.path, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (state.files >= MAX_SCAN_FILES) break;
    const child = dir.relative ? `${dir.relative}/${entry.name}` : entry.name;
    let resolved;
    try { resolved = await resolveVisiblePath(root, child); } catch { continue; }
    if (resolved.stat.isDirectory()) files.push(...await walkFiles(root, child, state));
    else if (resolved.stat.isFile()) {
      state.files++;
      files.push({ relative: child, resolved });
    }
  }
  // From the working folder's top level, the channel's additional folders are walked too, each
  // under its `@mounts/<name>` prefix; a vanished mount is skipped like an escaping link.
  if (!dir.relative && !dir.mount) {
    for (const mount of explorerMounts(root)) {
      if (state.files >= MAX_SCAN_FILES) break;
      try { files.push(...await walkFiles(root, `${MOUNT_SEGMENT}/${mount.name}`, state)); } catch { /* unavailable mount */ }
    }
  }
  return files;
}

export function register(server, ctx) {
  const { slug, text, loadMeta } = ctx;

  server.registerTool(
    "workspace_list",
    {
      description: "READ ONLY. List files and folders inside this channel's working folder. Paths are relative to the workspace; escaping paths and symlinks are refused. The channel's additional mounted folders appear at the root as `@mounts/<name>` and are browsed with that prefix.",
      inputSchema: { path: z.string().optional(), recursive: z.boolean().optional() },
    },
    async ({ path: relative = "", recursive = false }) => {
      try {
        const root = workspaceFor(slug, await loadMeta());
        const dir = await resolveVisiblePath(root, relative, { kind: "directory" });
        if (recursive) {
          const files = await walkFiles(root, dir.relative);
          const suffix = files.length >= MAX_SCAN_FILES ? `\n…limited to ${MAX_SCAN_FILES} files.` : "";
          return text(files.length ? `${files.map((f) => f.relative).join("\n")}${suffix}` : "(empty folder)");
        }
        const entries = await readdir(dir.path, { withFileTypes: true });
        const lines = [];
        // Mounted additional folders first at the root, as the Slack explorer shows them.
        if (!dir.relative && !dir.mount) {
          for (const mount of explorerMounts(root)) {
            const child = `${MOUNT_SEGMENT}/${mount.name}`;
            try {
              await resolveVisiblePath(root, child, { kind: "directory" });
              lines.push(`dir\t${child}\t(mounted ${mount.path}${mount.mode === "ro" ? ", read-only" : ""})`);
            } catch {
              lines.push(`unavailable\t${child}`);
            }
          }
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          const child = dir.relative ? `${dir.relative}/${entry.name}` : entry.name;
          try {
            const resolved = await resolveVisiblePath(root, child);
            lines.push(`${resolved.stat.isDirectory() ? "dir" : "file"}\t${child}`);
          } catch {
            lines.push(`unavailable\t${child}`);
          }
        }
        return text(lines.length ? lines.join("\n") : "(empty folder)");
      } catch (error) {
        return text(`Workspace list refused: ${cleanError(error)}`);
      }
    }
  );

  server.registerTool(
    "workspace_read",
    {
      description: `READ ONLY. Read one UTF-8 text file inside this channel's working folder or one of its additional mounted folders (\`@mounts/<name>/…\`), maximum ${MAX_READ_BYTES} bytes. Paths are workspace-relative; escaping paths and symlinks are refused.`,
      inputSchema: { path: z.string() },
    },
    async ({ path: relative }) => {
      try {
        const root = workspaceFor(slug, await loadMeta());
        const file = await resolveVisiblePath(root, relative, { kind: "file" });
        if (file.stat.size > MAX_READ_BYTES) return text(`Workspace read refused: file exceeds ${MAX_READ_BYTES} bytes.`);
        const bytes = await readFile(file.path);
        if (bytes.includes(0)) return text("Workspace read refused: binary files are not returned as text.");
        let content;
        try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { return text("Workspace read refused: file is not valid UTF-8 text."); }
        return text(content);
      } catch (error) {
        return text(`Workspace read refused: ${cleanError(error)}`);
      }
    }
  );

  server.registerTool(
    "workspace_search",
    {
      description: "READ ONLY. Search UTF-8 files inside this channel's working folder (or under `@mounts/<name>` for an additional mounted folder) for a literal text string. Results, scanned files, and bytes are bounded; escaping paths and symlinks are refused.",
      inputSchema: { query: z.string().min(1), path: z.string().optional() },
    },
    async ({ query, path: relative = "" }) => {
      try {
        const root = workspaceFor(slug, await loadMeta());
        const files = await walkFiles(root, relative);
        const matches = [];
        let scannedBytes = 0;
        for (const file of files) {
          if (matches.length >= MAX_RESULTS || scannedBytes >= MAX_SCAN_BYTES) break;
          if (file.resolved.stat.size > MAX_READ_BYTES || scannedBytes + file.resolved.stat.size > MAX_SCAN_BYTES) continue;
          const bytes = await readFile(file.resolved.path);
          scannedBytes += bytes.length;
          if (bytes.includes(0)) continue;
          let content;
          try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { continue; }
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length && matches.length < MAX_RESULTS; i++) {
            if (lines[i].includes(query)) matches.push(`${file.relative}:${i + 1}:${lines[i].slice(0, 500)}`);
          }
        }
        const suffix = matches.length >= MAX_RESULTS ? `\n…limited to ${MAX_RESULTS} matches.` : "";
        return text(matches.length ? `${matches.join("\n")}${suffix}` : "No matches.");
      } catch (error) {
        return text(`Workspace search refused: ${cleanError(error)}`);
      }
    }
  );
}
