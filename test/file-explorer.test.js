import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as fileExplorer from "../src/slack/file-explorer.js";

import {
  buildFileEditView,
  buildFilePreviewView,
  buildFilesLoadingView,
  buildFilesView,
  buildNewFolderView,
  canEditChannelFiles,
  createVisibleDirectory,
  FILES_ACTION_ID,
  FILES_ACTION_PATTERN,
  FILES_BROWSER_UPLOAD_ACTION_ID,
  FILES_BROWSER_EDIT_ACTION_ID,
  FILES_EDIT_ACTION_ID,
  FILES_NEW_FOLDER_ACTION_ID,
  FILES_NEW_FOLDER_BLOCK_ID,
  FILES_NEW_FOLDER_INPUT_ACTION_ID,
  FILES_SEND_DM_ACTION_ID,
  FILES_SHARE_ACTION_ID,
  FILES_SHORTCUT_ID,
  isProtectedName,
  listVisibleDirectory,
  MAX_EDIT_CHARS,
  MAX_NEW_FOLDER_CHARS,
  MAX_SHARED_FILE_BYTES,
  normalizeBrowserUploadPath,
  normalizeNewFolderName,
  parseExplorerMetadata,
  readEditableFile,
  readFilePreview,
  resolveVisiblePath,
  saveBrowserUploadedFile,
  writeEditableFile,
} from "../src/slack/file-explorer.js";
import { uploadLocalFile } from "../src/slack/upload.js";

function assertUniqueActionIds(view) {
  const ids = (view.blocks || [])
    .flatMap((block) => [block.accessory, ...(block.elements || [])])
    .filter(Boolean)
    .map((item) => item.action_id)
    .filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, `duplicate action_id in view: ${ids.join(", ")}`);
  assert.ok(ids.every((id) => FILES_ACTION_PATTERN.test(id)), `unregistered file action id in view: ${ids.join(", ")}`);
}

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "gateway-files-"));
  const root = path.join(base, "channel");
  const outside = path.join(base, "outside");
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(path.join(root, ".ssh"));
  await mkdir(outside);
  await writeFile(path.join(root, "readme.txt"), "hello from the channel\n");
  await writeFile(path.join(root, "docs", "guide.md"), "# Guide\n");
  await writeFile(path.join(root, ".env"), "TOKEN=secret\n");
  await writeFile(path.join(root, "credentials.json"), "{}\n");
  await mkdir(path.join(root, ".claude", "skills", "gateway-usage"), { recursive: true });
  await mkdir(path.join(root, ".claude", "skills", "token-helper"));
  await mkdir(path.join(root, ".claude", "skills", ".git"));
  await mkdir(path.join(root, ".agents"));
  await symlink(path.join("..", ".claude", "skills"), path.join(root, ".agents", "skills"));
  await writeFile(path.join(root, ".claude", "settings.json"), "{\"sandbox\":true}\n");
  await writeFile(path.join(root, ".claude", "skills", "gateway-usage", "SKILL.md"), "# Gateway usage\n");
  await writeFile(path.join(root, "CLAUDE.md"), "# Channel instructions\n");
  await writeFile(path.join(outside, "private.txt"), "outside\n");
  await symlink(path.join(root, "docs"), path.join(root, "docs-link"));
  await symlink(outside, path.join(root, "escape-link"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return { root, outside };
}

test("protected gateway and secret-like names remain classified for write protection", () => {
  for (const name of [".claude", ".git", ".gateway-edit-deadbeef", ".gateway-upload-deadbeef", "CLAUDE.md", "AGENTS.md", "MEMORY.md", "credentials.json", "prod-token.txt", "client_secret.json", "id_rsa", "client.pem", "client.key", ".env.pem", ".env.key", ".env.p12", ".env.pfx", ".npmrc", ".ssh"]) {
    assert.equal(isProtectedName(name), true, name);
  }
  for (const name of ["src", "README.md", ".gitignore", ".env", ".env.local", ".env.secret", "environment.md", "public.keynote"]) {
    assert.equal(isProtectedName(name), false, name);
  }
});

test("listing shows every name but opens only contained symlinks", async (t) => {
  const { root } = await fixture(t);
  const result = await listVisibleDirectory(root);
  assert.deepEqual(result.entries.map((e) => [e.type, e.name]), [
    ["directory", ".agents"],
    ["directory", ".claude"],
    ["directory", ".ssh"],
    ["directory", "docs"],
    ["directory", "docs-link"],
    ["file", ".env"],
    ["file", "CLAUDE.md"],
    ["file", "credentials.json"],
    ["file", "readme.txt"],
    ["link", "escape-link"],
  ]);
  assert.equal(result.entries.find((e) => e.name === "docs-link").symlink, true);
  assert.equal(result.entries.find((e) => e.name === "escape-link").accessible, false);
  assert.equal(result.inaccessibleCount, 1);
});

test("traversal and escaping symlinks are rejected while dotfiles are readable", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(() => resolveVisiblePath(root, "../outside/private.txt"), /invalid|leaves/i);
  await assert.rejects(() => resolveVisiblePath(root, "escape-link/private.txt"), /outside/i);
  const dotfile = await resolveVisiblePath(root, ".env", { kind: "file" });
  assert.equal(dotfile.relative, ".env");
  const inside = await resolveVisiblePath(root, "docs-link/guide.md", { kind: "file" });
  assert.ok(inside.path.endsWith(path.join("channel", "docs", "guide.md")));
});

test("managed files, lockdown settings, and every skill directory are browseable", async (t) => {
  const { root } = await fixture(t);
  const claude = await resolveVisiblePath(root, "CLAUDE.md", { kind: "file" });
  assert.equal(claude.relative, "CLAUDE.md");

  const managed = await listVisibleDirectory(root, ".claude");
  assert.deepEqual(managed.entries.map((entry) => [entry.type, entry.name]), [
    ["directory", "skills"],
    ["file", "settings.json"],
  ]);
  assert.equal(managed.inaccessibleCount, 0);

  const skills = await listVisibleDirectory(root, ".claude/skills");
  assert.deepEqual(skills.entries.map((entry) => [entry.type, entry.name]), [
    ["directory", ".git"],
    ["directory", "gateway-usage"],
    ["directory", "token-helper"],
  ]);
  const skillFiles = await listVisibleDirectory(root, ".claude/skills/gateway-usage");
  assert.deepEqual(skillFiles.entries.map((entry) => [entry.type, entry.name]), [["file", "SKILL.md"]]);

  const agents = await listVisibleDirectory(root, ".agents");
  assert.deepEqual(agents.entries.map((entry) => [entry.type, entry.name, entry.symlink]), [["directory", "skills", true]]);
  const codexSkills = await listVisibleDirectory(root, ".agents/skills");
  assert.deepEqual(codexSkills.entries.map((entry) => entry.name), [".git", "gateway-usage", "token-helper"]);
  assert.equal(codexSkills.readOnly, true);

  const settings = await readFilePreview(root, ".claude/settings.json");
  assert.match(settings.text, /sandbox/);
});

test("protected and managed items stay read-only even though they are visible", async (t) => {
  const { root } = await fixture(t);
  const state = { channelId: "C123", slug: "channel", threadTs: "123.456", ownerId: "U123", relative: ".claude/skills", page: 0 };
  const view = await buildFilesView(root, state, { canUpload: true, browserUploadUrl: "https://gateway.example/upload" });
  const actions = view.blocks.flatMap((block) => block.elements || []);
  assert.equal(actions.some((item) => item.action_id === FILES_BROWSER_UPLOAD_ACTION_ID), false);
  assert.equal(actions.some((item) => item.action_id === FILES_NEW_FOLDER_ACTION_ID), false);
  assert.match(JSON.stringify(view.blocks), /browseable but read-only/i);

  const preview = await buildFilePreviewView(root, { ...state, relative: "", page: 0 }, "CLAUDE.md", { canEdit: true });
  assert.match(JSON.stringify(preview.blocks), /Channel instructions/);
  assert.equal(preview.blocks.flatMap((block) => block.elements || []).some((item) => item.action_id === FILES_EDIT_ACTION_ID), false);

  await assert.rejects(() => createVisibleDirectory(root, ".claude/skills", "new-skill"), /read-only/i);
  await assert.rejects(() => saveBrowserUploadedFile(root, ".claude/skills", "new.txt", "content"), /read-only/i);
  await assert.rejects(() => writeEditableFile(root, "CLAUDE.md", "0".repeat(64), "changed"), /read-only/i);

  const sshView = await buildFilesView(root, { ...state, relative: ".ssh" }, { canUpload: true });
  assert.equal(sshView.blocks.flatMap((block) => block.elements || []).some((item) => item.action_id === FILES_BROWSER_UPLOAD_ACTION_ID), false);
  await assert.rejects(() => createVisibleDirectory(root, ".ssh", "new-folder"), /read-only/i);

  const aliasView = await buildFilesView(root, { ...state, relative: ".agents/skills" }, { canUpload: true });
  assert.equal(aliasView.blocks.flatMap((block) => block.elements || []).some((item) => item.action_id === FILES_BROWSER_UPLOAD_ACTION_ID), false);
  await assert.rejects(() => createVisibleDirectory(root, ".agents/skills", "new-skill"), /read-only/i);
});

test("modal carries compact channel state and builds native navigation controls", async (t) => {
  const { root } = await fixture(t);
  const state = { channelId: "C123", slug: "channel", threadTs: "123.456", ownerId: "U123", relative: "", page: 0 };
  const loading = buildFilesLoadingView(state, { channelName: "#ops" });
  assert.equal(loading.title.text, "#ops");
  assert.match(JSON.stringify(loading.blocks), /Loading channel files/);
  assert.deepEqual(parseExplorerMetadata(loading.private_metadata), state);
  const view = await buildFilesView(root, state, { channelName: "#ops" });
  assert.equal(view.type, "modal");
  assert.equal(view.title.text, "#ops");
  assert.equal(view.blocks[0].type, "context");
  assert.equal(view.blocks[0].elements[0].text, root);
  assert.deepEqual(parseExplorerMetadata(view.private_metadata), state);
  const controls = view.blocks.flatMap((b) => [b.accessory, ...(b.elements || [])]).filter(Boolean);
  assert.ok(controls.some((c) => c.action_id?.startsWith(`${FILES_ACTION_ID}_entry_`) && c.text.text === "Open"));
  assert.ok(controls.some((c) => c.action_id?.startsWith(`${FILES_ACTION_ID}_entry_`) && c.text.text === "Preview"));
  assertUniqueActionIds(view);

  const nested = await buildFilesView(root, { ...state, relative: "docs" }, {
    channelName: "#a-channel-name-that-is-longer-than-slack-allows",
  });
  assert.equal(nested.blocks[0].type, "context");
  assert.equal(nested.blocks[0].elements[0].text, path.join(root, "docs"));
  assert.equal(nested.title.text.length, 24);
  assert.equal(nested.title.text, "#a-channel-name-that-is…");

  const unicodeTitle = buildFilesLoadingView(state, { channelName: `${"a".repeat(22)}😀bc` }).title.text;
  assert.equal(unicodeTitle, `${"a".repeat(22)}😀…`);
  assert.equal(Array.from(unicodeTitle).length, 24);
  assert.equal(unicodeTitle.endsWith("…"), true);
  assert.equal(unicodeTitle.includes("�"), false);
  assert.equal(Array.from(unicodeTitle).some((character) => /^[\uD800-\uDFFF]$/u.test(character)), false);
});

test("file explorer propagates authoritative channel names through loading and refreshed views", () => {
  const appSource = readFileSync(new URL("../src/slack/app.js", import.meta.url), "utf8");
  const openExplorerSource = appSource.match(/async function openFileExplorer[\s\S]*?\n}\n\nasync function updateFileExplorerView/)?.[0] || "";
  const viewOptionsSource = appSource.match(/function fileExplorerViewOptions[\s\S]*?\n}\n\nfunction filePreviewOptions/)?.[0] || "";
  const navigationSource = appSource.match(/const handleFileExplorerAction[\s\S]*?\n\s*app\.action\(FILES_ACTION_PATTERN/)?.[0] || "";
  const folderRefreshSource = appSource.match(/app\.view\("cg_channel_files_new_folder_modal"[\s\S]*?\n\s*for \(const a of APPROVAL_ACTIONS\)/)?.[0] || "";

  assert.match(openExplorerSource, /buildFilesLoadingView\(state,\s*{\s*channelName:\s*entry\.name\s*}\)/);
  assert.match(openExplorerSource, /relativeFile[\s\S]*?buildFilePreviewView\(root,\s*state,\s*relativeFile/);
  assert.match(viewOptionsSource, /channelName:\s*entry\.name/);
  assert.match(openExplorerSource, /buildFilesView\(root,\s*state,\s*fileExplorerViewOptions\(\{\s*state,\s*entry,\s*mayEdit\s*}\)\)/);
  assert.equal(
    navigationSource.match(/buildFilesView\(root,\s*nextState,\s*fileExplorerViewOptions\(\{\s*state:\s*nextState,\s*entry,\s*mayEdit\s*}\)\)/g)?.length,
    2,
  );
  assert.match(folderRefreshSource, /const loadingEntry = await getChannelEntry\(state\.channelId\)/);
  assert.match(folderRefreshSource, /!loadingEntry \|\| loadingEntry\.slug !== state\.slug/);
  assert.match(folderRefreshSource, /buildFilesLoadingView\(state,\s*\{\s*channelName:\s*loadingEntry\.name\s*}\)/);
  assert.match(folderRefreshSource, /buildFilesView\(root,\s*\{ \.\.\.state, page: 0 },\s*fileExplorerViewOptions\(\{[\s\S]*?entry,[\s\S]*?notice:\s*`✅ Created \$\{created\.name}\.`/);
});

test("Slack new-file lifecycle reauthorizes, creates, audits, and opens the preview", () => {
  const appSource = readFileSync(new URL("../src/slack/app.js", import.meta.url), "utf8");
  const navigationSource = appSource.match(/const handleFileExplorerAction[\s\S]*?\n\s*app\.action\(FILES_ACTION_PATTERN/)?.[0] || "";
  const createSource = appSource.match(/app\.view\("cg_channel_files_new_file_modal"[\s\S]*?\n\s*app\.view\("cg_channel_files_new_folder_modal"/)?.[0] || "";

  assert.match(navigationSource, /command\.o === "new_file"[\s\S]*?!mayEdit[\s\S]*?buildNewFileView\(state\)/);
  assert.match(createSource, /state\.ownerId !== clicker/);
  assert.match(createSource, /normalizeNewFileName\(submittedName\)/);
  assert.match(createSource, /getChannelEntry\(state\.channelId\)/);
  assert.match(createSource, /buildFilesLoadingView\(state,\s*\{\s*channelName:\s*loadingEntry\.name\s*}\)/);
  assert.match(createSource, /fileExplorerContext\(client,\s*\{[\s\S]*?verifyMembership:\s*true/);
  assert.match(createSource, /canEditChannelFiles\(effectiveMeta\(meta\),\s*\{\s*isAdminUser:\s*userIsAdmin\s*}\)/);
  assert.match(createSource, /createVisibleFile\(root,\s*state\.relative,\s*fileName,\s*initialContent\)/);
  assert.match(createSource, /logEvent\("channel_file_created"[\s\S]*?file:\s*created\.relative[\s\S]*?bytes:\s*created\.bytes\.length/);
  assert.match(createSource, /buildFilePreviewView\(root,\s*state,\s*created\.relative,\s*filePreviewOptions\(\{[\s\S]*?notice:\s*`✅ Created \$\{created\.name}\.`/);
});

test("writable explorer offers browser upload, new-file, and new-folder controls", async (t) => {
  const { root } = await fixture(t);
  const state = { channelId: "C123", slug: "channel", threadTs: "123.456", ownerId: "U123", relative: "docs", page: 0 };
  assert.equal(typeof fileExplorer.FILES_NEW_FILE_ACTION_ID, "string");
  const readOnly = await buildFilesView(root, state);
  assert.equal(readOnly.blocks.flatMap((block) => block.elements || []).some((item) => item.action_id === FILES_BROWSER_UPLOAD_ACTION_ID), false);
  assert.equal(readOnly.blocks.flatMap((block) => block.elements || []).some((item) => item.action_id === FILES_NEW_FOLDER_ACTION_ID), false);
  assert.equal(readOnly.blocks.flatMap((block) => block.elements || []).some((item) => item.action_id === fileExplorer.FILES_NEW_FILE_ACTION_ID), false);

  const writable = await buildFilesView(root, state, { canUpload: true, browserUploadUrl: "https://gateway.example/file-upload/open/token" });
  const browserUpload = writable.blocks.flatMap((block) => block.elements || []).find((item) => item.action_id === FILES_BROWSER_UPLOAD_ACTION_ID);
  const newFile = writable.blocks.flatMap((block) => block.elements || []).find((item) => item.action_id === fileExplorer.FILES_NEW_FILE_ACTION_ID);
  const newFolder = writable.blocks.flatMap((block) => block.elements || []).find((item) => item.action_id === FILES_NEW_FOLDER_ACTION_ID);
  assert.equal(browserUpload.text.text, "Upload files / folder");
  assert.equal(browserUpload.style, "primary");
  assert.equal(browserUpload.url, "https://gateway.example/file-upload/open/token");
  assert.equal(JSON.parse(browserUpload.value).o, "browser_upload");
  assert.equal(newFile.text.text, "New file");
  assert.equal(JSON.parse(newFile.value).o, "new_file");
  assert.equal(newFolder.text.text, "New folder");
  assert.equal(JSON.parse(newFolder.value).o, "new_folder");
  assertUniqueActionIds(writable);

  const folderModal = buildNewFolderView(state);
  assert.equal(folderModal.callback_id, "cg_channel_files_new_folder_modal");
  assert.equal(folderModal.submit.text, "Create");
  assert.deepEqual(parseExplorerMetadata(folderModal.private_metadata), state);
  const folderInput = folderModal.blocks.find((block) => block.block_id === FILES_NEW_FOLDER_BLOCK_ID);
  assert.equal(folderInput.element.type, "plain_text_input");
  assert.equal(folderInput.element.action_id, FILES_NEW_FOLDER_INPUT_ACTION_ID);
  assert.equal(folderInput.element.max_length, MAX_NEW_FOLDER_CHARS);
  assert.match(JSON.stringify(folderModal.blocks), /Create inside \/docs/);

  assert.equal(typeof fileExplorer.buildNewFileView, "function");
  const fileModal = fileExplorer.buildNewFileView(state);
  assert.equal(fileModal.callback_id, "cg_channel_files_new_file_modal");
  assert.equal(fileModal.submit.text, "Create");
  assert.deepEqual(parseExplorerMetadata(fileModal.private_metadata), state);
  const nameInput = fileModal.blocks.find((block) => block.block_id === fileExplorer.FILES_NEW_FILE_NAME_BLOCK_ID);
  const contentInput = fileModal.blocks.find((block) => block.block_id === fileExplorer.FILES_NEW_FILE_CONTENT_BLOCK_ID);
  assert.equal(nameInput.element.action_id, fileExplorer.FILES_NEW_FILE_NAME_INPUT_ACTION_ID);
  assert.equal(nameInput.element.max_length, fileExplorer.MAX_NEW_FILE_CHARS);
  assert.equal(contentInput.optional, true);
  assert.equal(contentInput.element.multiline, true);
  assert.equal(contentInput.element.max_length, MAX_EDIT_CHARS);
  assert.match(JSON.stringify(fileModal.blocks), /Create inside \/docs/);
});

test("new folders are confined to the selected directory and never replace collisions", async (t) => {
  const { root } = await fixture(t);
  const created = await createVisibleDirectory(root, "docs", "Reports 2026");
  assert.equal(created.relative, "docs/Reports 2026");
  assert.equal(created.name, "Reports 2026");
  assert.equal(created.stat.isDirectory(), true);
  assert.equal((await resolveVisiblePath(root, "docs/Reports 2026", { kind: "directory" })).path, created.path);

  await assert.rejects(() => createVisibleDirectory(root, "docs", "Reports 2026"), /already exists/i);
  await assert.rejects(() => createVisibleDirectory(root, "docs", "guide.md"), /already exists/i);
  for (const name of ["", ".claude", "../outside", "nested/folder", "nested\\folder", "bad\0name"]) {
    await assert.rejects(() => createVisibleDirectory(root, "docs", name), /enter|protected|separator|control/i, name);
  }
  assert.equal(normalizeNewFolderName("  Plans  "), "Plans");
  assert.throws(() => normalizeNewFolderName("x".repeat(MAX_NEW_FOLDER_CHARS + 1)), /limited/i);
});

test("new files are confined, preserve UTF-8 content, and never replace collisions", async (t) => {
  const { root } = await fixture(t);
  assert.equal(typeof fileExplorer.createVisibleFile, "function");
  assert.equal(typeof fileExplorer.normalizeNewFileName, "function");

  const created = await fileExplorer.createVisibleFile(root, "docs", "  config.json  ", "{\"enabled\":true}\n");
  assert.equal(created.relative, "docs/config.json");
  assert.equal(created.name, "config.json");
  assert.equal(created.text, "{\"enabled\":true}\n");
  assert.equal(await readFile(path.join(root, "docs", "config.json"), "utf8"), "{\"enabled\":true}\n");

  const env = await fileExplorer.createVisibleFile(root, "docs", ".env.local", "MODEL=opus\n");
  assert.equal(env.relative, "docs/.env.local");
  assert.equal((await readEditableFile(root, env.relative)).text, "MODEL=opus\n");

  await assert.rejects(() => fileExplorer.createVisibleFile(root, "docs", "config.json", "replace\n"), /already exists/i);
  await assert.rejects(() => fileExplorer.createVisibleFile(root, "docs", "guide.md", "replace\n"), /already exists/i);
  await symlink("guide.md", path.join(root, "docs", "guide-link"));
  await assert.rejects(() => fileExplorer.createVisibleFile(root, "docs", "guide-link", "replace\n"), /already exists/i);
  assert.equal(await readFile(path.join(root, "docs", "guide.md"), "utf8"), "# Guide\n");

  for (const name of ["", ".claude", "credentials.json", "prod-token.txt", "../outside", "nested/file", "nested\\file", "bad\0name"]) {
    await assert.rejects(() => fileExplorer.createVisibleFile(root, "docs", name, "content\n"), /enter|protected|separator|control/i, name);
  }
  assert.equal(fileExplorer.normalizeNewFileName("  notes.yaml  "), "notes.yaml");
  assert.throws(() => fileExplorer.normalizeNewFileName("x".repeat(fileExplorer.MAX_NEW_FILE_CHARS + 1)), /limited/i);
  await assert.rejects(() => fileExplorer.createVisibleFile(root, ".claude", "notes.txt", "nope\n"), /read-only/i);
  await assert.rejects(() => fileExplorer.createVisibleFile(root, "docs", "nul.txt", "bad\0text"), /NUL/i);
});

test("bound file creation rejects a parent swapped to an escaping symlink before mutation", async (t) => {
  const { root, outside } = await fixture(t);
  assert.equal(typeof fileExplorer.writeNewFileInBoundDirectory, "function");
  const parentPath = path.join(root, "race-parent");
  await mkdir(parentPath);
  const resolved = await resolveVisiblePath(root, "race-parent", { kind: "directory" });
  await rename(parentPath, path.join(root, "race-parent-held"));
  await symlink(outside, parentPath);

  await assert.rejects(
    () => fileExplorer.writeNewFileInBoundDirectory(parentPath, resolved.rootReal, "escaped.txt", Buffer.from("must stay confined\n")),
    /outside|working folder|confined/i,
  );
  await assert.rejects(() => readFile(path.join(outside, "escaped.txt")), { code: "ENOENT" });
  await assert.rejects(() => readFile(path.join(root, "race-parent-held", "escaped.txt")), { code: "ENOENT" });
});

test("bound file creation does not force-kill a bounded write before child cleanup", () => {
  const explorerSource = readFileSync(new URL("../src/slack/file-explorer.js", import.meta.url), "utf8");
  const writerSource = explorerSource.match(/export function writeNewFileInBoundDirectory[\s\S]*?\n}\n\nexport async function createVisibleFile/)?.[0] || "";
  assert.doesNotMatch(writerSource, /SIGKILL|Timed out while creating the file/);
});

test("every modal control has a unique action id across the whole view", async (t) => {
  const { root } = await fixture(t);
  const state = { channelId: "C123", slug: "channel", threadTs: "123.456", ownerId: "U123", relative: "docs", page: 0 };
  const nested = await buildFilesView(root, state);
  const nav = nested.blocks.find((block) => block.type === "actions" && block.elements?.some((item) => item.text?.text === "↑ Up"));
  assert.deepEqual(nav.elements.map((item) => item.text.text), ["↑ Up", "⌂ Root"]);
  assertUniqueActionIds(nested);

  await Promise.all(Array.from({ length: 40 }, (_, i) => writeFile(path.join(root, `file-${String(i).padStart(2, "0")}.txt`), `${i}\n`)));
  const middlePage = await buildFilesView(root, { ...state, relative: "", page: 1 });
  const pager = middlePage.blocks.find((block) => block.type === "actions" && block.elements?.some((item) => item.text?.text === "← Previous"));
  assert.deepEqual(pager.elements.map((item) => item.text.text), ["← Previous", "Next →"]);
  assertUniqueActionIds(middlePage);
});

test("text preview offers thread share, private delivery, and eligible editing", async (t) => {
  const { root } = await fixture(t);
  const preview = await readFilePreview(root, "readme.txt");
  assert.equal(preview.binary, false);
  assert.match(preview.text, /hello from the channel/);
  const state = { channelId: "C123", slug: "channel", threadTs: "123.456", ownerId: "U123", relative: "", page: 0 };
  const view = await buildFilePreviewView(root, state, "readme.txt", { canEdit: true });
  const share = view.blocks.flatMap((b) => b.elements || []).find((e) => e.text?.text === "Share in thread");
  const send = view.blocks.flatMap((b) => b.elements || []).find((e) => e.text?.text === "Send to me");
  const edit = view.blocks.flatMap((b) => b.elements || []).find((e) => e.text?.text === "Edit");
  assert.equal(share.action_id, FILES_SHARE_ACTION_ID);
  assert.equal(share.style, "primary");
  assert.equal(share.confirm.confirm.text, "Share");
  assert.equal(send.action_id, FILES_SEND_DM_ACTION_ID);
  assert.match(send.confirm.text.text, /complete.*Slack DM/i);
  assert.equal(edit.action_id, FILES_EDIT_ACTION_ID);
  assertUniqueActionIds(view);
});

test("truncated preview says the real file is complete and remains editable within Slack's limit", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "long.txt"), "x".repeat(2800));
  const state = { channelId: "C123", slug: "channel", threadTs: "", ownerId: "U123", relative: "", page: 0 };
  const view = await buildFilePreviewView(root, state, "long.txt", { canEdit: true });
  const rendered = JSON.stringify(view);
  assert.match(rendered, /first 2,600 bytes/);
  assert.match(rendered, /file itself is complete/);
  assert.ok(view.blocks.flatMap((b) => b.elements || []).some((e) => e.action_id === FILES_EDIT_ACTION_ID));
});

test("browser editor URL complements the Slack modal and supports files beyond 3,000 characters", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "browser.md"), "# Browser editor\n\n" + "x".repeat(5_000));
  const state = { channelId: "C123", slug: "channel", threadTs: "", ownerId: "U123", relative: "", page: 0 };
  let granted = null;
  const view = await buildFilePreviewView(root, state, "browser.md", {
    canEdit: true,
    browserEditLimits: { maxChars: 250_000, maxBytes: 1_000_000, label: "Browser editing" },
    createEditUrl: (file) => {
      granted = file;
      return "https://gateway.example/file-editor/open/opaque";
    },
  });
  const actions = view.blocks.flatMap((block) => block.elements || []);
  const browserEdit = actions.find((item) => item.action_id === FILES_BROWSER_EDIT_ACTION_ID);
  assert.equal(browserEdit.text.text, "Edit in browser");
  assert.equal(browserEdit.url, "https://gateway.example/file-editor/open/opaque");
  assert.equal(JSON.parse(browserEdit.value).o, "browser_edit");
  assert.equal(actions.some((item) => item.action_id === FILES_EDIT_ACTION_ID), false, "large files remain browser-only");
  assert.equal(granted.relative, "browser.md");
  assert.match(granted.expectedHash, /^[a-f0-9]{64}$/);
  assertUniqueActionIds(view);
});

test("eligible small text offers both Slack-popup and browser editing", async (t) => {
  const { root } = await fixture(t);
  const state = { channelId: "C123", slug: "channel", threadTs: "", ownerId: "U123", relative: "", page: 0 };
  const view = await buildFilePreviewView(root, state, "readme.txt", {
    canEdit: true,
    browserEditLimits: { maxChars: 250_000, maxBytes: 1_000_000, label: "Browser editing" },
    createEditUrl: () => "https://gateway.example/file-editor/open/opaque",
  });
  const actions = view.blocks.flatMap((block) => block.elements || []);
  assert.equal(actions.find((item) => item.action_id === FILES_EDIT_ACTION_ID)?.text.text, "Edit");
  assert.equal(actions.find((item) => item.action_id === FILES_BROWSER_EDIT_ACTION_ID)?.text.text, "Edit in browser");
  assertUniqueActionIds(view);
});

test("edit modal carries a content hash and Slack's 3,000-character input cap", async (t) => {
  const { root } = await fixture(t);
  const state = { channelId: "C123", slug: "channel", threadTs: "123.456", ownerId: "U123", relative: "", page: 0 };
  const view = await buildFileEditView(root, state, "readme.txt");
  const editState = parseExplorerMetadata(view.private_metadata);
  const input = view.blocks.find((block) => block.block_id === "file_content").element;
  assert.equal(editState.editRelative, "readme.txt");
  assert.match(editState.editHash, /^[a-f0-9]{64}$/);
  assert.equal(input.initial_value, "hello from the channel\n");
  assert.equal(input.max_length, MAX_EDIT_CHARS);
  assert.equal(view.blocks.find((block) => block.block_id === "file_content").optional, true);
});

test("editing policy matches channel write capability and keeps Full admin-only", () => {
  assert.equal(canEditChannelFiles({}, { isAdminUser: true }), false);
  assert.equal(canEditChannelFiles({ allowBash: true }), true);
  assert.equal(canEditChannelFiles({ autoMode: true }), true);
  assert.equal(canEditChannelFiles({ adminMode: true }, { isAdminUser: false }), false);
  assert.equal(canEditChannelFiles({ adminMode: true }, { isAdminUser: true }), true);
});

test("text saves are hash-guarded, atomic replacements and reject stale or oversized edits", async (t) => {
  const { root } = await fixture(t);
  const opened = await readEditableFile(root, "readme.txt");
  const saved = await writeEditableFile(root, "readme.txt", opened.hash, "updated in Slack\n");
  assert.equal(saved.text, "updated in Slack\n");
  assert.equal(await readFile(path.join(root, "readme.txt"), "utf8"), "updated in Slack\n");

  await writeFile(path.join(root, "readme.txt"), "changed elsewhere\n");
  await assert.rejects(
    () => writeEditableFile(root, "readme.txt", saved.hash, "stale save\n"),
    (error) => error.code === "FILE_EDIT_CONFLICT",
  );
  assert.equal(await readFile(path.join(root, "readme.txt"), "utf8"), "changed elsewhere\n");

  const latest = await readEditableFile(root, "readme.txt");
  await writeEditableFile(root, "readme.txt", latest.hash, "");
  assert.equal(await readFile(path.join(root, "readme.txt"), "utf8"), "");

  await writeFile(path.join(root, "large.md"), "x".repeat(MAX_EDIT_CHARS + 1));
  await writeFile(path.join(root, "data.bin"), "valid text despite its extension\n");
  await assert.rejects(() => readEditableFile(root, "large.md"), /3,000 characters/i);
  assert.equal((await readEditableFile(root, "data.bin")).text, "valid text despite its extension\n");
});

test("concurrent saves of one file serialize; different files still run in parallel", async (t) => {
  const { root } = await fixture(t);
  const opened = await readEditableFile(root, "readme.txt");

  // Both writers hold the SAME expected hash — the Slack modal and the browser editor open from one
  // preview, and a double-click does it on its own. Unserialized, each verified the hash, each wrote
  // its temp file, and each renamed: two "saved" answers and one silently discarded edit.
  const settled = await Promise.allSettled([
    writeEditableFile(root, "readme.txt", opened.hash, "first writer\n"),
    writeEditableFile(root, "readme.txt", opened.hash, "second writer\n"),
  ]);
  const won = settled.filter((r) => r.status === "fulfilled");
  const lost = settled.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1, "exactly one writer may be told its save landed");
  assert.equal(lost[0].reason.code, "FILE_EDIT_CONFLICT");
  assert.equal(await readFile(path.join(root, "readme.txt"), "utf8"), won[0].value.text);

  // The queue does not wedge after a conflict: a save against the fresh hash still goes through.
  const latest = await readEditableFile(root, "readme.txt");
  await writeEditableFile(root, "readme.txt", latest.hash, "third writer\n");
  assert.equal(await readFile(path.join(root, "readme.txt"), "utf8"), "third writer\n");

  // Serialization is per file, not a global lock.
  await writeFile(path.join(root, "other.txt"), "other\n");
  const [a, b] = await Promise.all([
    readEditableFile(root, "readme.txt").then((f) => writeEditableFile(root, "readme.txt", f.hash, "parallel A\n")),
    readEditableFile(root, "other.txt").then((f) => writeEditableFile(root, "other.txt", f.hash, "parallel B\n")),
  ]);
  assert.equal(a.text, "parallel A\n");
  assert.equal(b.text, "parallel B\n");
});

test("editing accepts common and extensionless UTF-8 text while rejecting protected or binary content", async (t) => {
  const { root } = await fixture(t);
  const editable = new Map([
    [".env", "TOKEN=secret\n"],
    ["config.json", "{\"ok\":true}\n"],
    ["workflow.yaml", "steps: []\n"],
    ["settings.toml", "enabled = true\n"],
    ["script", "#!/bin/sh\necho ok\n"],
    ["process.py", "print('ok')\n"],
  ]);
  for (const [name, content] of editable) {
    if (name !== ".env") await writeFile(path.join(root, name), content);
    assert.equal((await readEditableFile(root, name)).text, content, name);
  }

  await writeFile(path.join(root, "nul.data"), Buffer.from([0x61, 0x00, 0x62]));
  await writeFile(path.join(root, "invalid.data"), Buffer.from([0xff, 0xfe, 0xfd]));
  await assert.rejects(() => readEditableFile(root, "nul.data"), /NUL|binary/i);
  await assert.rejects(() => readEditableFile(root, "invalid.data"), /valid UTF-8/i);
  await assert.rejects(() => readEditableFile(root, "credentials.json"), /read-only/i);
  await assert.rejects(() => readEditableFile(root, "CLAUDE.md"), /read-only/i);
});

test("binary preview is identified without dumping bytes into Slack", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "image.bin"), Buffer.from([1, 2, 0, 4]));
  const preview = await readFilePreview(root, "image.bin");
  assert.equal(preview.binary, true);
  assert.equal(preview.text, "");
  assert.equal(preview.shareable, true);
});

test("manifest registers the native /files command and message shortcut", () => {
  const manifest = JSON.parse(readFileSync(new URL("../slack-app-manifest.json", import.meta.url), "utf8"));
  assert.ok(manifest.features.slash_commands.some((c) => c.command === "/files"));
  assert.ok(manifest.features.shortcuts.some((s) => s.callback_id === FILES_SHORTCUT_ID && s.type === "message"));
  assert.equal(MAX_SHARED_FILE_BYTES, 25 * 1024 * 1024);
});

test("local uploads reject oversized files before contacting Slack", async (t) => {
  const { root } = await fixture(t);
  const huge = path.join(root, "huge.bin");
  await writeFile(huge, "");
  await truncate(huge, MAX_SHARED_FILE_BYTES + 1);
  await assert.rejects(() => uploadLocalFile({ filePath: huge, channelId: "C123" }), /larger than the 25 MB/i);
});

test("browser uploads preserve safe folder trees and collision-rename files", async (t) => {
  const { root } = await fixture(t);
  const first = await saveBrowserUploadedFile(root, "docs", "Project/assets/logo.txt", Buffer.from("first\n"));
  assert.equal(first.relative, "docs/Project/assets/logo.txt");
  assert.equal(first.sourceRelative, "Project/assets/logo.txt");
  assert.equal(await readFile(first.path, "utf8"), "first\n");

  const second = await saveBrowserUploadedFile(root, "docs", "Project/assets/logo.txt", Buffer.from("second\n"));
  assert.equal(second.relative, "docs/Project/assets/logo (1).txt");
  assert.equal(second.renamed, true);
  assert.equal(await readFile(first.path, "utf8"), "first\n");
  assert.equal(await readFile(second.path, "utf8"), "second\n");

  assert.equal(normalizeBrowserUploadPath("folder/.env"), "folder/.env");
  for (const uploadPath of ["../outside.txt", "/absolute.txt", "folder//file.txt", "folder\\file.txt", ".claude/file.txt"]) {
    assert.throws(() => normalizeBrowserUploadPath(uploadPath), /invalid|traversal|protected/i, uploadPath);
  }
  await assert.rejects(
    () => saveBrowserUploadedFile(root, "../outside", "file.txt", Buffer.from("nope")),
    /invalid|protected|leaves/i,
  );
});

test("file browser uploads never use Slack file storage", () => {
  const explorerSource = readFileSync(new URL("../src/slack/file-explorer.js", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("../src/slack/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(explorerSource, /type:\s*["']file_input["']/);
  assert.doesNotMatch(appSource, /cg_channel_files_upload_modal/);
  assert.doesNotMatch(appSource, /saveSlackUploadedFile/);
});
