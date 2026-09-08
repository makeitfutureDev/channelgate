import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { compileFunction } from "node:vm";
import { parse } from "acorn";
import { tempDir } from "./helpers.js";
import * as files from "../src/slack/file-explorer.js";
import { createFileFormNavigation } from "../src/slack/file-form-navigation.js";

// Execute the actual registered Bolt callbacks with a bounded Slack stack transport and real
// file operations, without starting Socket Mode or replacing the production authorization code.
const source = readFileSync(new URL("../src/slack/app.js", import.meta.url), "utf8");
const callbacks = new Map();
function visit(node) {
  if (!node || typeof node !== "object") return;
  if (node.type === "CallExpression" && node.callee?.object?.name === "app" && node.callee?.property?.name === "view") {
    const [id, callback] = node.arguments;
    if (id?.value?.startsWith("cg_channel_files_")) callbacks.set(id.value, source.slice(callback.start, callback.end));
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") visit(value);
  }
}
visit(parse(source, { ecmaVersion: "latest", sourceType: "module" }));

async function fixture() {
  const root = tempDir("cg-file-form-stack-");
  const state = { channelId: "C_FILES", slug: "files", ownerId: "U_OWNER", threadTs: "123.456", relative: "", page: 0 };
  const entry = { slug: "files", name: "Files" };
  const stack = [{ id: "V_ROOT", ...await files.buildFilesView(root, state, { canUpload: true }) }];
  const audit = [], updates = [], acknowledgements = [], authorizations = [];
  let serial = 0, mayEdit = true, member = true, failNextUpdate = false;
  const client = { views: { update: async ({ view_id, view }) => {
    updates.push({ view_id, view });
    if (failNextUpdate) { failNextUpdate = false; throw new Error("temporary view update failure"); }
    const index = stack.findIndex((v) => v.id === view_id);
    assert.notEqual(index, -1, "must update an existing view, never a popped form");
    stack[index] = { ...view, id: view_id, previous_view_id: stack[index].previous_view_id };
  } } };
  const errorView = (message) => ({ type: "modal", callback_id: "file_error", blocks: [{ type: "section", text: { type: "plain_text", text: message } }] });
  const dependencies = {
    ...files, path, createFileFormNavigation,
    console: { warn() {} },
    effectiveMeta: (meta) => meta,
    getChannelEntry: async () => entry,
    fileExplorerContext: async (_client, request) => {
      authorizations.push(request);
      assert.equal(request.verifyMembership, true);
      assert.equal(request.expectedSlug, state.slug);
      if (!member) throw new Error("No longer a member of this channel");
      return { entry, meta: { allowBash: mayEdit }, userIsAdmin: false, root };
    },
    logEvent: async (event, data) => audit.push({ event, data }),
    filePreviewOptions: ({ mayEdit: editable, notice }) => ({ canEdit: editable, notice }),
    fileExplorerViewOptions: ({ mayEdit: editable, notice }) => ({ canUpload: editable, channelName: entry.name, notice }),
    fileExplorerErrorView: errorView,
  };
  const handlers = new Map([...callbacks].map(([id, code]) => [id, compileFunction(`return (${code});`, Object.keys(dependencies))(...Object.values(dependencies))]));
  function push(view) {
    if (stack.length >= 3) throw new Error("push_limit_reached");
    stack.push({ ...view, id: `V_FORM_${++serial}`, previous_view_id: stack.at(-1).id });
  }
  async function submit(values, user = state.ownerId) {
    const view = { ...stack.at(-1), state: { values } };
    let ackCount = 0;
    const ack = async (payload) => {
      ackCount++;
      assert.equal(ackCount, 1, "submission must be acknowledged once");
      acknowledgements.push(payload);
      if (!payload) stack.pop();
      else if (payload.response_action === "update") stack[stack.length - 1] = { ...payload.view, id: view.id, previous_view_id: view.previous_view_id };
      else assert.equal(payload.response_action, "errors");
    };
    await handlers.get(view.callback_id)({ ack, body: { user: { id: user }, view }, view, client });
    assert.equal(ackCount, 1);
  }
  return { root, state, stack, audit, updates, acknowledgements, authorizations, push, submit,
    cancel() { assert.equal(stack.at(-1).close.text, "Cancel"); stack.pop(); },
    setEditable(value) { mayEdit = value; }, setMember(value) { member = value; },
    failUpdate() { failNextUpdate = true; },
  };
}
const fileValues = (name, content = "initial") => ({ new_file_name: { cg_channel_files_new_file_name_value: { value: name } }, new_file_content: { cg_channel_files_new_file_content_value: { value: content } } });
const folderValues = (name) => ({ new_folder_name: { cg_channel_files_new_folder_value: { value: name } } });
const editValues = (content) => ({ file_content: { value: { value: content } } });

test("five create cycles and repeated inline saves return to one explorer level", async () => {
  const f = await fixture();
  for (let i = 0; i < 5; i++) {
    f.push(files.buildNewFolderView(f.state));
    await f.submit(folderValues(`folder-${i}`));
    assert.equal(f.stack.length, 1, "folder submit must pop its temporary form");
    assert.equal(f.stack[0].id, "V_ROOT");
    f.push(files.buildNewFileView(f.state));
    await f.submit(fileValues(`file-${i}.txt`, `value-${i}`));
    assert.equal(f.stack.length, 1, "file submit must pop its temporary form");
    assert.equal(await readFile(path.join(f.root, `file-${i}.txt`), "utf8"), `value-${i}`);
  }
  for (let i = 0; i < 4; i++) {
    f.push(await files.buildFileEditView(f.root, f.state, "file-0.txt"));
    await f.submit(editValues(`revision-${i}`));
    assert.equal(f.stack.length, 1, "save must pop the editor instead of retaining a preview level");
    assert.equal(await readFile(path.join(f.root, "file-0.txt"), "utf8"), `revision-${i}`);
  }
  assert.equal(f.audit.filter((e) => e.event === "channel_file_created").length, 5);
  assert.equal(f.audit.filter((e) => e.event === "channel_folder_created").length, 5);
  assert.equal(f.audit.filter((e) => e.event === "channel_file_edited").length, 4);
  assert.equal(f.authorizations.length, 14);
  assert.ok(f.updates.every((u) => u.view_id === "V_ROOT"));
});

test("Cancel restores the unchanged parent for all forms and duplicate create never overwrites", async () => {
  const f = await fixture();
  await writeFile(path.join(f.root, "existing.txt"), "keep");
  for (const form of [files.buildNewFolderView(f.state), files.buildNewFileView(f.state), await files.buildFileEditView(f.root, f.state, "existing.txt")]) {
    const before = structuredClone(f.stack[0]);
    f.push(form); f.cancel();
    assert.deepEqual(f.stack, [before]);
    assert.deepEqual(await readdir(f.root), ["existing.txt"]);
    assert.equal(await readFile(path.join(f.root, "existing.txt"), "utf8"), "keep");
    assert.equal(f.audit.length, 0);
  }
  f.push(files.buildNewFileView(f.state));
  await f.submit(fileValues("existing.txt", "overwrite"));
  assert.equal(await readFile(path.join(f.root, "existing.txt"), "utf8"), "keep");
  assert.equal(f.audit.length, 0);
  assert.equal(f.stack.length, 1);
  assert.match(JSON.stringify(f.stack[0]), /already exists/i);
});

test("invalid owner/name and stale edit hash leave the form open without mutation", async () => {
  const f = await fixture();
  f.push(files.buildNewFileView(f.state));
  await f.submit(fileValues("outside.txt"), "U_OTHER");
  assert.equal(f.stack.length, 2);
  assert.equal(f.authorizations.length, 0);
  assert.match(JSON.stringify(f.acknowledgements.at(-1)), /isn't yours/i);
  await f.submit(fileValues("../escape.txt"));
  assert.equal(f.stack.length, 2);
  assert.deepEqual(await readdir(f.root), []);
  f.cancel();
  await writeFile(path.join(f.root, "edit.txt"), "before");
  f.push(await files.buildFileEditView(f.root, f.state, "edit.txt"));
  await writeFile(path.join(f.root, "edit.txt"), "concurrent");
  await f.submit(editValues("stale"));
  assert.equal(f.stack.length, 2);
  assert.equal(await readFile(path.join(f.root, "edit.txt"), "utf8"), "concurrent");
  assert.match(JSON.stringify(f.acknowledgements.at(-1)), /changed/i);
  assert.equal(f.audit.length, 0);
});

test("post-ack membership/mode/update errors target the parent and do not create files", async () => {
  for (const failure of ["membership", "mode", "update"]) {
    const f = await fixture();
    if (failure === "membership") f.setMember(false);
    if (failure === "mode") f.setEditable(false);
    if (failure === "update") f.failUpdate();
    f.push(files.buildNewFolderView(f.state));
    await f.submit(folderValues("denied"));
    assert.equal(f.stack.length, 1);
    assert.equal(f.stack[0].callback_id, "file_error");
    assert.ok(f.updates.every((u) => u.view_id === "V_ROOT"));
    assert.deepEqual(await readdir(f.root), []);
    assert.equal(f.audit.length, 0);
    assert.equal(f.acknowledgements.length, 1);
  }
});

test("standalone file forms keep the existing update-in-place fallback", async () => {
  const f = await fixture();
  f.stack[0] = { ...files.buildNewFileView(f.state), id: "V_ROOT" };
  await f.submit(fileValues("standalone.txt", "value"));
  assert.equal(f.stack.length, 1);
  assert.equal(f.stack[0].id, "V_ROOT");
  assert.equal(f.acknowledgements[0].response_action, "update");
  assert.equal(await readFile(path.join(f.root, "standalone.txt"), "utf8"), "value");
});

test("inline edit rechecks current membership and mode before popping or saving", async () => {
  for (const failure of ["membership", "mode"]) {
    const f = await fixture();
    await writeFile(path.join(f.root, "edit.txt"), "unchanged");
    f.push(await files.buildFileEditView(f.root, f.state, "edit.txt"));
    if (failure === "membership") f.setMember(false);
    else f.setEditable(false);
    await f.submit(editValues("denied"));
    assert.equal(f.stack.length, 2);
    assert.equal(f.acknowledgements[0].response_action, "errors");
    assert.equal(await readFile(path.join(f.root, "edit.txt"), "utf8"), "unchanged");
    assert.equal(f.audit.length, 0);
  }
});
