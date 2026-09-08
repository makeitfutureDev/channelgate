// Native Slack file explorer for a channel's effective working directory.
//
// The UI is built from Block Kit modal views, but every filesystem operation happens here so the
// confinement boundary is small and unit-testable. Paths carried by Slack are always relative to
// the channel root; before list/preview/share we realpath BOTH the root and candidate, reject
// traversal, and verify the resolved target still lives under the root. Names are not filtered.
import path from "node:path";
import { spawn } from "node:child_process";
import { chmod, link, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { MAX_FILE_UPLOAD_BYTES } from "./upload.js";

export const FILES_ACTION_ID = "cg_channel_files";
export const FILES_UP_ACTION_ID = "cg_channel_files_up";
export const FILES_ROOT_ACTION_ID = "cg_channel_files_root";
export const FILES_PREVIOUS_ACTION_ID = "cg_channel_files_previous";
export const FILES_NEXT_ACTION_ID = "cg_channel_files_next";
export const FILES_BACK_ACTION_ID = "cg_channel_files_back";
export const FILES_SHARE_ACTION_ID = "cg_channel_files_share";
export const FILES_SEND_DM_ACTION_ID = "cg_channel_files_send_dm";
export const FILES_DOWNLOAD_ACTION_ID = "cg_channel_files_download";
export const FILES_EDIT_ACTION_ID = "cg_channel_files_edit";
export const FILES_BROWSER_EDIT_ACTION_ID = "cg_channel_files_browser_edit";
export const FILES_BROWSER_UPLOAD_ACTION_ID = "cg_channel_files_browser_upload";
export const FILES_NEW_FILE_ACTION_ID = "cg_channel_files_new_file";
export const FILES_NEW_FOLDER_ACTION_ID = "cg_channel_files_new_folder";
export const FILES_NEW_FILE_NAME_BLOCK_ID = "new_file_name";
export const FILES_NEW_FILE_NAME_INPUT_ACTION_ID = "cg_channel_files_new_file_name_value";
export const FILES_NEW_FILE_CONTENT_BLOCK_ID = "new_file_content";
export const FILES_NEW_FILE_CONTENT_INPUT_ACTION_ID = "cg_channel_files_new_file_content_value";
export const FILES_NEW_FOLDER_BLOCK_ID = "new_folder_name";
export const FILES_NEW_FOLDER_INPUT_ACTION_ID = "cg_channel_files_new_folder_value";
// Entry rows need per-view-unique action ids (Slack rejects a modal when ANY two controls reuse an
// action_id, even across separate blocks). Bolt accepts a RegExp constraint, so one handler can
// receive the stable controls above plus `cg_channel_files_entry_<page>_<row>` ids.
export const FILES_ACTION_PATTERN = /^cg_channel_files(?:$|_)/;
export const FILES_SHORTCUT_ID = "cg_browse_channel_files";
export const FILES_PAGE_SIZE = 18;
export const MAX_SHARED_FILE_BYTES = MAX_FILE_UPLOAD_BYTES;
export const MAX_BROWSER_UPLOAD_BYTES = MAX_FILE_UPLOAD_BYTES;
export const MAX_EDIT_CHARS = 3000;
export const MAX_EDIT_BYTES = MAX_EDIT_CHARS * 4;
export const MAX_NEW_FILE_CHARS = 100;
export const MAX_NEW_FILE_BYTES = 240;
export const MAX_NEW_FOLDER_CHARS = 100;
export const MAX_NEW_FOLDER_BYTES = 240;
export const PREVIEW_BYTES = 2600;

const BOUND_FILE_WRITER = String.raw`
import path from "node:path";
import { open, realpath, rm } from "node:fs/promises";

const [expectedRoot, name] = process.argv.slice(1);
let handle;
let failure;
try {
  const rootReal = await realpath(expectedRoot);
  const cwdReal = await realpath(".");
  const contained = cwdReal === rootReal || cwdReal.startsWith(rootReal + path.sep);
  if (!contained) {
    const error = new Error("The selected directory moved outside this channel's working folder.");
    error.code = "OUTSIDE_ROOT";
    throw error;
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  handle = await open(name, "wx", 0o644);
  await handle.writeFile(Buffer.concat(chunks));
} catch (error) {
  failure = error;
} finally {
  await handle?.close().catch(() => {});
}
if (failure) {
  if (handle) await rm(name, { force: true }).catch(() => {});
  process.stderr.write(JSON.stringify({ code: failure.code || "", message: failure.message || "File creation failed." }));
  process.exit(1);
}
`;

const PROTECTED_EXACT = new Set([
  ".claude",
  ".git",
  "CLAUDE.md",
  "AGENTS.md",
  "MEMORY.md",
  "credentials.json",
  "secrets.json",
  "token.json",
  "tokens.json",
  "id_rsa",
  "id_ed25519",
  ".npmrc",
  ".netrc",
  ".ssh",
  ".aws",
  ".gnupg",
  ".DS_Store",
]);
const PROTECTED_EXTENSIONS = new Set([".key", ".pem", ".p12", ".pfx"]);

// Visibility and writability are separate policies: every contained name can be browsed/read, but
// existing protected/internal paths remain read-only so showing them does not create a write path.
export function isManagedClaudePath(relative = "") {
  const value = String(relative || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  return value === "CLAUDE.md" || value === ".claude" || value.startsWith(".claude/");
}

export function isProtectedName(name) {
  const value = String(name || "");
  if (!value || value === "." || value === "..") return true;
  if (PROTECTED_EXACT.has(value)) return true;
  if (/^\.gateway-(?:edit|upload)-/i.test(value)) return true;
  if (PROTECTED_EXTENSIONS.has(path.extname(value).toLowerCase())) return true;
  if (/^\.env(?:\.|$)/i.test(value)) return false;
  if (/(?:^|[._-])(?:secret|secrets|token|tokens|credential|credentials)(?:[._-]|$)/i.test(value)) return true;
  return false;
}

function isWithin(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

export function normalizeRelativePath(relative = "") {
  const raw = String(relative || "").replaceAll("\\", "/");
  if (!raw || raw === ".") return "";
  if (raw.startsWith("/") || raw.includes("\0")) throw new Error("Invalid file path.");
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length) return "";
  if (parts.some((part) => part === "." || part === "..")) throw new Error("Invalid file path.");
  const normalized = parts.join("/");
  if (normalized.length > 1200) throw new Error("That path is too deep for Slack's file explorer.");
  return normalized;
}

export function isProtectedWritePath(relative = "") {
  const clean = normalizeRelativePath(relative);
  if (isManagedClaudePath(clean)) return true;
  return clean.split("/").filter(Boolean).some((part) => isProtectedName(part));
}

function isProtectedResolvedPath(resolved) {
  const physicalRelative = path.relative(resolved.rootReal, resolved.path).split(path.sep).join("/");
  return isProtectedWritePath(resolved.relative) || isProtectedWritePath(physicalRelative);
}

export function canEditChannelFiles(meta = {}, { isAdminUser = false } = {}) {
  if (meta.adminMode) return Boolean(isAdminUser);
  return Boolean(meta.allowBash || meta.autoMode);
}

function contentHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function conflictError() {
  const error = new Error("This file changed after you opened the editor. Reopen it and apply your changes to the latest version.");
  error.code = "FILE_EDIT_CONFLICT";
  return error;
}

// Returns a real, contained path. Internal symlinks work; symlinks leaving the channel root do not.
export async function resolveVisiblePath(root, relative = "", { kind = "any" } = {}) {
  const rootReal = await realpath(root);
  const clean = normalizeRelativePath(relative);
  const lexical = path.resolve(rootReal, clean);
  if (!isWithin(rootReal, lexical)) throw new Error("That path leaves this channel's working folder.");
  const targetReal = await realpath(lexical);
  if (!isWithin(rootReal, targetReal)) throw new Error("That item points outside this channel's working folder.");
  const info = await stat(targetReal);
  if (kind === "directory" && !info.isDirectory()) throw new Error("That item is not a folder.");
  if (kind === "file" && !info.isFile()) throw new Error("That item is not a regular file.");
  return { rootReal, relative: clean, path: targetReal, stat: info };
}

export function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export async function listVisibleDirectory(root, relative = "", { page = 0, pageSize = FILES_PAGE_SIZE } = {}) {
  const dir = await resolveVisiblePath(root, relative, { kind: "directory" });
  const raw = await readdir(dir.path, { withFileTypes: true });
  const entries = [];
  let inaccessibleCount = 0;
  for (const item of raw) {
    const childRelative = dir.relative ? `${dir.relative}/${item.name}` : item.name;
    try {
      // Follow symlinks only after proving their real target stays inside the root.
      const child = await resolveVisiblePath(dir.rootReal, childRelative);
      if (!child.stat.isDirectory() && !child.stat.isFile()) continue;
      entries.push({
        name: item.name,
        relative: childRelative,
        type: child.stat.isDirectory() ? "directory" : "file",
        size: child.stat.size,
        modifiedMs: child.stat.mtimeMs,
        symlink: item.isSymbolicLink(),
        shareable: child.stat.isFile() && child.stat.size <= MAX_SHARED_FILE_BYTES,
      });
    } catch {
      // Still render the directory entry, but never offer a control that could follow an escaping
      // or broken link (or race a newly unavailable item). Visibility must not weaken confinement.
      inaccessibleCount++;
      entries.push({
        name: item.name,
        relative: childRelative,
        type: item.isDirectory() ? "directory" : item.isFile() ? "file" : item.isSymbolicLink() ? "link" : "other",
        size: 0,
        modifiedMs: 0,
        symlink: item.isSymbolicLink(),
        shareable: false,
        accessible: false,
      });
    }
  }
  entries.sort((a, b) => {
    const rank = (entry) => entry.type === "directory" ? 0 : entry.type === "file" ? 1 : 2;
    return rank(a) === rank(b) ? a.name.localeCompare(b.name) : rank(a) - rank(b);
  });
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const safePage = Math.min(Math.max(0, Number(page) || 0), totalPages - 1);
  return {
    root: dir.rootReal,
    // Display the configured logical root spelling (a symlinked root rather than its realpath
    // alias). Filesystem access and confinement stay on `dir.path`.
    absolutePath: path.resolve(root, dir.relative),
    relative: dir.relative,
    entries: entries.slice(safePage * pageSize, (safePage + 1) * pageSize),
    total: entries.length,
    page: safePage,
    totalPages,
    inaccessibleCount,
    readOnly: isProtectedResolvedPath(dir),
  };
}

function metadata(state) {
  return JSON.stringify({
    c: String(state.channelId || ""),
    s: String(state.slug || ""),
    t: String(state.threadTs || ""),
    u: String(state.ownerId || ""),
    p: String(state.relative || ""),
    g: Math.max(0, Number(state.page) || 0),
    ...(state.editRelative ? { e: String(state.editRelative), h: String(state.editHash || "") } : {}),
  });
}

export function parseExplorerMetadata(raw) {
  let value;
  try {
    value = JSON.parse(String(raw || ""));
  } catch {
    throw new Error("This file explorer expired. Open it again with the 📂 button on a reply.");
  }
  if (!value || typeof value !== "object" || !value.c || !value.s || !value.u) {
    throw new Error("This file explorer expired. Open it again with the 📂 button on a reply.");
  }
  const state = {
    channelId: String(value.c),
    slug: String(value.s),
    threadTs: String(value.t || ""),
    ownerId: String(value.u),
    relative: normalizeRelativePath(value.p || ""),
    page: Math.max(0, Number(value.g) || 0),
  };
  if (value.e) state.editRelative = normalizeRelativePath(value.e);
  if (/^[a-f0-9]{64}$/i.test(String(value.h || ""))) state.editHash = String(value.h).toLowerCase();
  return state;
}

export function actionValue(op, extra = {}) {
  return JSON.stringify({ o: op, ...extra });
}

export function parseActionValue(raw) {
  try {
    const value = JSON.parse(String(raw || ""));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function plain(text) {
  return { type: "plain_text", text: String(text).slice(0, 3000), emoji: true };
}

function displayPath(relative) {
  return relative ? `/${relative}` : "/";
}

function explorerTitle(channelName) {
  const value = String(channelName || "Channel files");
  const characters = Array.from(value);
  return characters.length <= 24 ? value : `${characters.slice(0, 23).join("")}…`;
}

export function buildFilesLoadingView(state, { channelName = "" } = {}) {
  return {
    type: "modal",
    callback_id: "cg_channel_files_modal",
    private_metadata: metadata(state),
    title: plain(explorerTitle(channelName)),
    close: plain("Close"),
    blocks: [{ type: "section", text: plain("📂 Loading channel files…") }],
  };
}

export async function buildFilesView(root, state, { channelName = "", notice = "", canUpload = false, browserUploadUrl = "" } = {}) {
  const listing = await listVisibleDirectory(root, state.relative, { page: state.page });
  const current = { ...state, relative: listing.relative, page: listing.page };
  const blocks = [
    { type: "context", elements: [plain(listing.absolutePath)] },
  ];
  if (notice) blocks.push({ type: "context", elements: [plain(notice)] });
  if (listing.readOnly) {
    blocks.push({ type: "context", elements: [plain("Protected/internal files are browseable but read-only here.")] });
  }
  if (canUpload && !listing.readOnly) {
    blocks.push({
      type: "actions",
      elements: [
        ...(browserUploadUrl
          ? [{
              type: "button",
              style: "primary",
              action_id: FILES_BROWSER_UPLOAD_ACTION_ID,
              text: plain("Upload files / folder"),
              url: String(browserUploadUrl),
              value: actionValue("browser_upload"),
            }]
          : []),
        {
          type: "button",
          action_id: FILES_NEW_FILE_ACTION_ID,
          text: plain("New file"),
          value: actionValue("new_file"),
        },
        {
          type: "button",
          action_id: FILES_NEW_FOLDER_ACTION_ID,
          text: plain("New folder"),
          value: actionValue("new_folder"),
        },
      ],
    });
  }
  if (listing.relative) {
    const parent = path.posix.dirname(listing.relative);
    blocks.push({
      type: "actions",
      elements: [
        { type: "button", action_id: FILES_UP_ACTION_ID, text: plain("↑ Up"), value: actionValue("directory", { p: parent === "." ? "" : parent }) },
        { type: "button", action_id: FILES_ROOT_ACTION_ID, text: plain("⌂ Root"), value: actionValue("directory", { p: "" }) },
      ],
    });
  }
  for (const [index, entry] of listing.entries.entries()) {
    const isDir = entry.type === "directory";
    const suffix = entry.accessible === false
      ? `${entry.symlink ? " · link" : ""} · unavailable`
      : isDir
      ? `${entry.symlink ? " · link" : ""}`
      : ` · ${formatFileSize(entry.size)}${entry.shareable ? "" : " · too large to share"}${entry.symlink ? " · link" : ""}`;
    blocks.push({
      type: "section",
      text: plain(`${isDir ? "📁" : entry.type === "file" ? "📄" : "🔗"} ${entry.name}${suffix}`),
      ...(entry.accessible === false ? {} : {
        accessory: {
          type: "button",
          action_id: `${FILES_ACTION_ID}_entry_${listing.page}_${index}`,
          text: plain(isDir ? "Open" : "Preview"),
          value: actionValue(isDir ? "directory" : "preview", { p: entry.relative }),
        },
      }),
    });
  }
  if (!listing.entries.length) blocks.push({ type: "section", text: plain("This folder is empty.") });
  if (listing.totalPages > 1) {
    const elements = [];
    if (listing.page > 0) elements.push({ type: "button", action_id: FILES_PREVIOUS_ACTION_ID, text: plain("← Previous"), value: actionValue("page", { g: listing.page - 1 }) });
    if (listing.page + 1 < listing.totalPages) elements.push({ type: "button", action_id: FILES_NEXT_ACTION_ID, text: plain("Next →"), value: actionValue("page", { g: listing.page + 1 }) });
    blocks.push({ type: "actions", elements });
  }
  blocks.push({
    type: "context",
    elements: [plain(`${listing.total} item${listing.total === 1 ? "" : "s"} · page ${listing.page + 1}/${listing.totalPages}${listing.inaccessibleCount ? ` · ${listing.inaccessibleCount} unavailable item${listing.inaccessibleCount === 1 ? "" : "s"} shown without open controls` : ""}`)],
  });
  return {
    type: "modal",
    callback_id: "cg_channel_files_modal",
    private_metadata: metadata(current),
    title: plain(explorerTitle(channelName)),
    close: plain("Close"),
    blocks,
  };
}

export function buildNewFolderView(state) {
  return {
    type: "modal",
    callback_id: "cg_channel_files_new_folder_modal",
    private_metadata: metadata(state),
    title: plain("Create folder"),
    submit: plain("Create"),
    close: plain("Cancel"),
    blocks: [
      { type: "section", text: plain(`Create inside ${displayPath(state.relative || "")}`) },
      {
        type: "input",
        block_id: FILES_NEW_FOLDER_BLOCK_ID,
        label: plain("Folder name"),
        element: {
          type: "plain_text_input",
          action_id: FILES_NEW_FOLDER_INPUT_ACTION_ID,
          max_length: MAX_NEW_FOLDER_CHARS,
          placeholder: plain("New folder"),
        },
      },
      { type: "context", elements: [plain("Creates one folder here. Existing items are never replaced.")] },
    ],
  };
}

export function buildNewFileView(state) {
  return {
    type: "modal",
    callback_id: "cg_channel_files_new_file_modal",
    private_metadata: metadata(state),
    title: plain("Create file"),
    submit: plain("Create"),
    close: plain("Cancel"),
    blocks: [
      { type: "section", text: plain(`Create inside ${displayPath(state.relative || "")}`) },
      {
        type: "input",
        block_id: FILES_NEW_FILE_NAME_BLOCK_ID,
        label: plain("File name"),
        element: {
          type: "plain_text_input",
          action_id: FILES_NEW_FILE_NAME_INPUT_ACTION_ID,
          max_length: MAX_NEW_FILE_CHARS,
          placeholder: plain("config.json"),
          focus_on_load: true,
        },
      },
      {
        type: "input",
        block_id: FILES_NEW_FILE_CONTENT_BLOCK_ID,
        label: plain("Initial contents"),
        optional: true,
        element: {
          type: "plain_text_input",
          action_id: FILES_NEW_FILE_CONTENT_INPUT_ACTION_ID,
          multiline: true,
          max_length: MAX_EDIT_CHARS,
        },
      },
      { type: "context", elements: [plain("Creates one UTF-8 text file here. Existing items are never replaced.")] },
    ],
  };
}

export function normalizeNewFileName(value) {
  const name = String(value ?? "").trim();
  if (!name) throw new Error("Enter a file name.");
  if (name.includes("/") || name.includes("\\") || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("File names can't contain path separators or control characters.");
  }
  if (name.length > MAX_NEW_FILE_CHARS || Buffer.byteLength(name, "utf8") > MAX_NEW_FILE_BYTES) {
    throw new Error(`File names are limited to ${MAX_NEW_FILE_CHARS} characters.`);
  }
  if (isProtectedName(name)) {
    throw new Error("That file name is protected and can't be created here.");
  }
  return name;
}

export function normalizeNewFolderName(value) {
  const name = String(value ?? "").trim();
  if (!name) throw new Error("Enter a folder name.");
  if (name.includes("/") || name.includes("\\") || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("Folder names can't contain path separators or control characters.");
  }
  if (name.length > MAX_NEW_FOLDER_CHARS || Buffer.byteLength(name, "utf8") > MAX_NEW_FOLDER_BYTES) {
    throw new Error(`Folder names are limited to ${MAX_NEW_FOLDER_CHARS} characters.`);
  }
  if (isProtectedName(name)) {
    throw new Error("That folder name is protected and can't be created here.");
  }
  return name;
}

// Create exactly one visible directory under the currently browsed confined folder. `mkdir`
// without `recursive` is collision-safe: a file, directory, or symlink with the same name wins and
// is never replaced.
export async function createVisibleDirectory(root, relative, requestedName) {
  const parent = await resolveVisiblePath(root, relative, { kind: "directory" });
  if (isProtectedResolvedPath(parent)) throw new Error("Protected/internal files are read-only in this explorer.");
  const name = normalizeNewFolderName(requestedName);
  const createdRelative = parent.relative ? `${parent.relative}/${name}` : name;
  const destination = path.join(parent.path, name);
  try {
    await mkdir(destination, { mode: 0o755 });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`An item named ${name} already exists in this folder.`);
    throw error;
  }
  const created = await resolveVisiblePath(root, createdRelative, { kind: "directory" });
  return { ...created, name };
}

// Bind the final relative open to a child process cwd. `spawn` resolves cwd to a directory object
// before the script starts; replacing the pathname with an escaping symlink afterward cannot move
// that cwd. The child re-realpaths `.` before opening the basename, so a swap that wins before spawn
// is refused without creating or writing the file. This provides portable openat-like containment
// with documented Node APIs.
export function writeNewFileInBoundDirectory(directoryPath, rootReal, name, bytes) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, ["--input-type=module", "--eval", BOUND_FILE_WRITER, rootReal, name], {
        cwd: directoryPath,
        env: {},
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let stderr = "";
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4_096) stderr += chunk.slice(0, 4_096 - stderr.length);
    });
    child.stdin.on("error", () => {});
    child.on("error", finish);
    child.on("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }
      let detail = {};
      try {
        detail = JSON.parse(stderr);
      } catch {
        detail = {};
      }
      const error = new Error(detail.message || "File creation failed.");
      if (detail.code) error.code = detail.code;
      finish(error);
    });
    child.stdin.end(Buffer.from(bytes));
  });
}

export async function createVisibleFile(root, relative, requestedName, content = "") {
  const parent = await resolveVisiblePath(root, relative, { kind: "directory" });
  if (isProtectedResolvedPath(parent)) throw new Error("Protected/internal files are read-only in this explorer.");
  const name = normalizeNewFileName(requestedName);
  if (typeof content !== "string" || content.length > MAX_EDIT_CHARS) {
    throw new Error(`Initial text is limited to ${MAX_EDIT_CHARS.toLocaleString()} characters and ${MAX_EDIT_BYTES.toLocaleString()} bytes.`);
  }
  if (content.includes("\0")) throw new Error("Text files cannot contain NUL characters.");
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > MAX_EDIT_BYTES) {
    throw new Error(`Initial text is limited to ${MAX_EDIT_CHARS.toLocaleString()} characters and ${MAX_EDIT_BYTES.toLocaleString()} bytes.`);
  }
  const createdRelative = parent.relative ? `${parent.relative}/${name}` : name;
  try {
    await writeNewFileInBoundDirectory(parent.path, parent.rootReal, name, bytes);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`An item named ${name} already exists in this folder.`);
    throw error;
  }
  const created = await resolveVisiblePath(root, createdRelative, { kind: "file" });
  return { ...created, name, bytes, text: content, hash: contentHash(bytes) };
}

export function normalizeUploadFilename(value) {
  let name = path.posix.basename(String(value || "").replaceAll("\\", "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .trim();
  if (!name || isProtectedName(name)) {
    throw new Error("That filename is protected and can't be added to the channel folder.");
  }
  while (Buffer.byteLength(name, "utf8") > 200) name = name.slice(0, -1);
  if (!name || isProtectedName(name)) {
    throw new Error("That filename is protected and can't be added to the channel folder.");
  }
  return name;
}

export function normalizeBrowserUploadPath(value) {
  const raw = String(value || "");
  if (!raw || raw.startsWith("/") || raw.includes("\\") || raw.includes("\0")) {
    throw new Error("Invalid upload path.");
  }
  const parts = raw.split("/");
  if (!parts.length || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Upload paths cannot contain empty or traversal segments.");
  }
  const folders = parts.slice(0, -1).map(normalizeNewFolderName);
  return [...folders, normalizeUploadFilename(parts.at(-1))].join("/");
}

function numberedFilename(name, number) {
  if (!number) return name;
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  const suffix = ` (${number})`;
  let shortened = stem;
  while (Buffer.byteLength(`${shortened}${suffix}${extension}`, "utf8") > 240) shortened = shortened.slice(0, -1);
  return `${shortened}${suffix}${extension}`;
}

async function writeUploadedBytes(directory, name, bytes) {
  const temp = path.join(directory.path, `.gateway-upload-${randomUUID()}`);
  await writeFile(temp, bytes, { flag: "wx", mode: 0o644 });
  try {
    for (let number = 0; number < 1000; number++) {
      const candidate = numberedFilename(name, number);
      const destination = path.join(directory.path, candidate);
      try {
        await link(temp, destination);
        const savedRelative = directory.relative ? `${directory.relative}/${candidate}` : candidate;
        return { relative: savedRelative, path: destination, name: candidate, bytes: bytes.length, renamed: candidate !== name };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    throw new Error("Too many files with that name already exist in this folder.");
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

async function resolveOrCreateUploadDirectory(root, baseRelative, folderParts) {
  let directory = await resolveVisiblePath(root, baseRelative, { kind: "directory" });
  if (isProtectedResolvedPath(directory)) throw new Error("Protected/internal files are read-only in this explorer.");
  for (const requested of folderParts) {
    const name = normalizeNewFolderName(requested);
    const childRelative = directory.relative ? `${directory.relative}/${name}` : name;
    try {
      await mkdir(path.join(directory.path, name), { mode: 0o755 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    directory = await resolveVisiblePath(root, childRelative, { kind: "directory" });
  }
  return directory;
}

// Browser folder selection supplies each file's webkitRelativePath. Recreate its visible directory
// chain under the folder that was open in Slack, then use the same collision-safe atomic write as
// browser uploads. Existing directories may be merged into; existing files are never replaced.
export async function saveBrowserUploadedFile(root, baseRelative, uploadRelative, content) {
  const clean = normalizeBrowserUploadPath(uploadRelative);
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content || []);
  if (bytes.length > MAX_BROWSER_UPLOAD_BYTES) {
    throw new Error(`File is larger than the ${formatFileSize(MAX_BROWSER_UPLOAD_BYTES)} upload limit.`);
  }
  const parts = clean.split("/");
  const name = parts.pop();
  const directory = await resolveOrCreateUploadDirectory(root, baseRelative, parts);
  return { ...(await writeUploadedBytes(directory, name, bytes)), sourceRelative: clean };
}

export async function readFilePreview(root, relative) {
  const file = await resolveVisiblePath(root, relative, { kind: "file" });
  const length = Math.min(PREVIEW_BYTES, file.stat.size);
  const bytes = Buffer.alloc(length);
  if (length) {
    const handle = await open(file.path, "r");
    try {
      await handle.read(bytes, 0, length, 0);
    } finally {
      await handle.close();
    }
  }
  const binary = bytes.includes(0);
  return {
    ...file,
    binary,
    truncated: file.stat.size > length,
    text: binary ? "" : bytes.toString("utf8"),
    shareable: file.stat.size <= MAX_SHARED_FILE_BYTES,
  };
}

function editLimits(options = {}) {
  const maxChars = Math.max(1, Number(options.maxChars) || MAX_EDIT_CHARS);
  const maxBytes = Math.max(1, Number(options.maxBytes) || MAX_EDIT_BYTES);
  const label = String(options.label || "Slack editing");
  return { maxChars, maxBytes, label };
}

export async function readEditableFile(root, relative, options = {}) {
  const { maxChars, maxBytes, label } = editLimits(options);
  const file = await resolveVisiblePath(root, relative, { kind: "file" });
  if (isProtectedResolvedPath(file)) throw new Error("Protected/internal files are read-only in this explorer.");
  if (file.stat.size > maxBytes) throw new Error(`${label} is limited to ${maxChars.toLocaleString()} characters and ${maxBytes.toLocaleString()} bytes.`);
  const bytes = await readFile(file.path);
  if (bytes.length > maxBytes) throw new Error(`${label} is limited to ${maxChars.toLocaleString()} characters and ${maxBytes.toLocaleString()} bytes.`);
  if (bytes.includes(0)) throw new Error("This file contains NUL bytes, so it can't be edited as text.");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("This file is not valid UTF-8 text, so it can't be edited.");
  }
  if (text.length > maxChars) throw new Error(`${label} is limited to ${maxChars.toLocaleString()} characters and ${maxBytes.toLocaleString()} bytes.`);
  return { ...file, bytes, text, hash: contentHash(bytes) };
}

// Per-file write serialization. The optimistic-concurrency dance below (hash verify → temp write →
// re-verify → rename) spans several awaits, so two saves of the SAME file from this process — the
// Slack modal and the browser editor, or one impatient double-click — could interleave: both verify
// against the same hash, then both rename, and the loser's bytes win with an "ok" reported to each.
// Chaining every write for one resolved path behind the previous one closes that window; writes to
// DIFFERENT files still run in parallel. The re-verify stays, since it also guards external writers.
const fileWriteChains = new Map(); // resolved path -> promise settling when the last queued write finishes

function serializeFileWrite(key, task) {
  const previous = fileWriteChains.get(key) || Promise.resolve();
  // Run on both settlements: one caller's conflict must not cancel the writes queued behind it.
  const run = previous.then(task, task);
  const settled = run.then(() => {}, () => {});
  fileWriteChains.set(key, settled);
  settled.then(() => {
    if (fileWriteChains.get(key) === settled) fileWriteChains.delete(key); // keep the map bounded
  });
  return run;
}

export async function writeEditableFile(root, relative, expectedHash, content, options = {}) {
  const { maxChars, maxBytes, label } = editLimits(options);
  if (typeof content !== "string" || content.length > maxChars) {
    throw new Error(`${label} is limited to ${maxChars.toLocaleString()} characters and ${maxBytes.toLocaleString()} bytes.`);
  }
  if (content.includes("\0")) throw new Error("Text files cannot contain NUL characters.");
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > maxBytes) throw new Error(`Edited text exceeds the ${maxBytes.toLocaleString()}-byte safety limit.`);
  // Resolve first so the queue key is the real file, not a spelling of its relative path. The same
  // containment/protection rules readEditableFile applies, applied before anything is queued.
  const target = await resolveVisiblePath(root, relative, { kind: "file" });
  if (isProtectedResolvedPath(target)) throw new Error("Protected/internal files are read-only in this explorer.");
  return serializeFileWrite(target.path, () => commitEditableFile(root, relative, expectedHash, bytes, content, options));
}

async function commitEditableFile(root, relative, expectedHash, bytes, content, options) {
  const current = await readEditableFile(root, relative, options);
  if (!expectedHash || current.hash !== expectedHash) throw conflictError();

  const temp = path.join(path.dirname(current.path), `.gateway-edit-${randomUUID()}`);
  try {
    await writeFile(temp, bytes, { mode: current.stat.mode & 0o777 });
    // Narrow the external-writer race: verify once more after preparing the replacement, directly
    // before the atomic rename. This is optimistic concurrency, not a filesystem-wide lock.
    const latest = await readEditableFile(root, relative, options);
    if (latest.path !== current.path || latest.hash !== expectedHash) throw conflictError();
    await rename(temp, current.path);
    await chmod(current.path, current.stat.mode & 0o777);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
  return { ...current, bytes, text: content, hash: contentHash(bytes), stat: await stat(current.path) };
}

function safeCodeBlock(text) {
  // A literal triple-backtick would terminate the preview block; use a visually similar mark.
  return String(text || "").replaceAll("```", "ˋˋˋ").slice(0, PREVIEW_BYTES);
}

export async function buildFilePreviewView(root, state, relative, { notice = "", canEdit = false, createDownloadUrl = null, createEditUrl = null, browserEditLimits = null } = {}) {
  const file = await readFilePreview(root, relative);
  const parent = path.posix.dirname(file.relative);
  const parentRelative = parent === "." ? "" : parent;
  const name = path.posix.basename(file.relative);
  const blocks = [
    { type: "section", text: plain(`📄 ${name}\n${displayPath(file.relative)} · ${formatFileSize(file.stat.size)}`) },
  ];
  if (notice) blocks.push({ type: "context", elements: [plain(notice)] });
  if (file.binary) {
    blocks.push({ type: "section", text: plain("Binary file — preview isn't available. You can share it into Slack below.") });
  } else {
    const body = safeCodeBlock(file.text) || "(empty file)";
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\`\`\`\n${body}\n\`\`\`${file.truncated ? `\n_Preview shows the first ${PREVIEW_BYTES.toLocaleString()} bytes; the file itself is complete._` : ""}`,
      },
    });
  }
  const elements = [
    { type: "button", action_id: FILES_BACK_ACTION_ID, text: plain("← Back"), value: actionValue("directory", { p: parentRelative }) },
  ];
  let downloadUrl = "";
  if (typeof createDownloadUrl === "function") {
    try {
      downloadUrl = String(await createDownloadUrl({ relative: file.relative })) || "";
    } catch {
      downloadUrl = "";
    }
  }
  if (downloadUrl) {
    elements.push({
      type: "button",
      action_id: FILES_DOWNLOAD_ACTION_ID,
      text: plain("Download"),
      value: actionValue("browser_download", { p: file.relative }),
      url: downloadUrl,
    });
  }
  if (file.shareable) {
    elements.push({
      type: "button",
      style: "primary",
      action_id: FILES_SHARE_ACTION_ID,
      text: plain(state.threadTs ? "Share in thread" : "Share in channel"),
      value: actionValue("share", { p: file.relative }),
      confirm: {
        title: plain("Share this file?"),
        text: plain(`Slack will receive a copy of ${name}.`),
        confirm: plain("Share"),
        deny: plain("Cancel"),
      },
    });
    elements.push({
      type: "button",
      action_id: FILES_SEND_DM_ACTION_ID,
      text: plain("Send to me"),
      value: actionValue("send_dm", { p: file.relative }),
      confirm: {
        title: plain("Send a private copy?"),
        text: plain(`The bot will upload the complete ${name} file into your Slack DM.`),
        confirm: plain("Send"),
        deny: plain("Cancel"),
      },
    });
  }
  let browserEditUrl = "";
  if (canEdit && !file.binary && typeof createEditUrl === "function") {
    try {
      const editableFile = await readEditableFile(root, file.relative, browserEditLimits || {});
      browserEditUrl = String(await createEditUrl({ relative: editableFile.relative, expectedHash: editableFile.hash })) || "";
    } catch {
      browserEditUrl = "";
    }
  }
  if (browserEditUrl) {
    elements.push({
      type: "button",
      action_id: FILES_BROWSER_EDIT_ACTION_ID,
      text: plain("Edit in browser"),
      value: actionValue("browser_edit", { p: file.relative }),
      url: browserEditUrl,
    });
  }
  if (canEdit && !file.binary) {
    try {
      await readEditableFile(root, file.relative);
      elements.push({
        type: "button",
        action_id: FILES_EDIT_ACTION_ID,
        text: plain("Edit"),
        value: actionValue("edit", { p: file.relative }),
      });
    } catch {
      // The Slack editor is intentionally absent for ineligible extension/encoding/size.
    }
  }
  blocks.push({ type: "actions", elements });
  if (!file.shareable) blocks.push({ type: "context", elements: [plain(`Files larger than ${formatFileSize(MAX_SHARED_FILE_BYTES)} can't be shared from this explorer.`)] });
  return {
    type: "modal",
    callback_id: "cg_channel_files_modal",
    private_metadata: metadata({ ...state, relative: parentRelative, page: 0 }),
    title: plain("File preview"),
    close: plain("Close"),
    blocks,
  };
}

export async function buildFileEditView(root, state, relative) {
  const file = await readEditableFile(root, relative);
  const name = path.posix.basename(file.relative);
  return {
    type: "modal",
    callback_id: "cg_channel_files_edit_modal",
    private_metadata: metadata({ ...state, editRelative: file.relative, editHash: file.hash }),
    title: plain("Edit channel file"),
    submit: plain("Save"),
    close: plain("Cancel"),
    blocks: [
      { type: "section", text: plain(`✏️ ${name} · ${file.text.length.toLocaleString()}/${MAX_EDIT_CHARS.toLocaleString()} characters`) },
      {
        type: "input",
        block_id: "file_content",
        label: plain("Contents"),
        optional: true,
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          ...(file.text ? { initial_value: file.text } : {}),
          max_length: MAX_EDIT_CHARS,
          focus_on_load: true,
        },
      },
      { type: "context", elements: [plain("Save is refused if the file changed after this editor opened.")] },
    ],
  };
}
