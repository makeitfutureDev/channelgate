import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readEditableFile } from "../src/slack/file-explorer.js";
import {
  BROWSER_EDIT_MAX_BYTES,
  BROWSER_EDIT_MAX_CHARS,
  createFileEditorGrantUrl,
  createFileEditorRouter,
  editorPage,
  FILE_EDITOR_GRANT_TTL_MS,
  resetFileEditorStateForTests,
} from "../src/web/file-editor.js";

const LIMITS = { maxChars: BROWSER_EDIT_MAX_CHARS, maxBytes: BROWSER_EDIT_MAX_BYTES, label: "Browser editing" };

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// Minimal DOM stand-in: enough of an element for the generated editor script to run under Node, so
// the save behaviour itself is tested rather than a regex over its source.
function fakeElement(value = "") {
  const listeners = new Map();
  return {
    value,
    textContent: "",
    className: "",
    innerHTML: "",
    disabled: false,
    readOnly: false,
    addEventListener: (type, handler) => listeners.set(type, handler),
    focus() {},
    fire: (type, event = {}) => listeners.get(type)?.(event),
  };
}

function runEditorScript(html, { initial = "", fetchImpl }) {
  const script = /<script nonce="[^"]+">([\s\S]+?)<\/script>/.exec(html)?.[1];
  assert.ok(script, "the editor page must carry its nonce'd script");
  const elements = {
    editor: fakeElement(initial),
    save: fakeElement(),
    revert: fakeElement(),
    status: fakeElement(),
    count: fakeElement(),
    preview: fakeElement(),
  };
  const requests = [];
  const doc = { getElementById: (id) => elements[id] ?? null, addEventListener: () => {} };
  const fetchStub = (url, options) => {
    requests.push({ url, options });
    return fetchImpl();
  };
  new Function("document", "fetch", "location", "addEventListener", "confirm", script)(
    doc,
    fetchStub,
    { pathname: "/file-editor/editor-id" },
    () => {},
    () => true,
  );
  return { elements, requests };
}

test("browser editor exchanges a one-time grant, serves securely, saves, and rejects conflicts", async (t) => {
  resetFileEditorStateForTests();
  t.after(resetFileEditorStateForTests);
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-browser-editor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "notes.md");
  await writeFile(filename, "# Notes\n\nOriginal\n");
  const opened = await readEditableFile(root, "notes.md", LIMITS);
  const audits = [];
  let authorizationChecks = 0;

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/file-editor", createFileEditorRouter({
    authorize: async (grant) => {
      authorizationChecks++;
      assert.equal(grant.channelId, "C123");
      assert.equal(grant.ownerId, "U123");
      return { root };
    },
    audit: async (event, fields) => audits.push({ event, fields }),
  }));
  const server = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const grantUrl = createFileEditorGrantUrl({
    baseUrl: base,
    channelId: "C123",
    slug: "channel",
    ownerId: "U123",
    relative: "notes.md",
    expectedHash: opened.hash,
  });

  const exchange = await fetch(grantUrl, { redirect: "manual", headers: { "x-forwarded-proto": "https" } });
  assert.equal(exchange.status, 303);
  const editorPath = exchange.headers.get("location");
  const cookie = exchange.headers.get("set-cookie").split(";")[0];
  assert.match(editorPath, /^\/file-editor\/[A-Za-z0-9_-]+$/);
  assert.match(exchange.headers.get("set-cookie"), /HttpOnly/);
  assert.match(exchange.headers.get("set-cookie"), /SameSite=Strict/);
  assert.match(exchange.headers.get("set-cookie"), /Secure/);
  assert.equal(exchange.headers.get("cache-control"), "no-store");

  const reused = await fetch(grantUrl, { redirect: "manual" });
  assert.equal(reused.status, 410);
  const noCookie = await fetch(`${base}${editorPath}`);
  assert.equal(noCookie.status, 401);

  const page = await fetch(`${base}${editorPath}`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  const html = await page.text();
  assert.match(html, /<textarea[^>]+>\# Notes/);
  assert.match(html, /Preview/);
  assert.match(html, /250,000/);
  const browserScript = /<script nonce="[^"]+">([\s\S]+)<\/script>/.exec(html)?.[1];
  assert.ok(browserScript);
  assert.doesNotThrow(() => new Function(browserScript));
  const csrf = /const CSRF="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
  assert.ok(csrf);

  const badCsrf = await fetch(`${base}${editorPath}/api/save`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-cg-csrf": "wrong" },
    body: JSON.stringify({ content: "bad" }),
  });
  assert.equal(badCsrf.status, 403);

  const saved = await fetch(`${base}${editorPath}/api/save`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-cg-csrf": csrf },
    body: JSON.stringify({ content: "# Notes\n\nSaved in browser\n" }),
  });
  assert.equal(saved.status, 200);
  assert.equal(await readFile(filename, "utf8"), "# Notes\n\nSaved in browser\n");
  assert.deepEqual(audits.map((entry) => entry.event), ["channel_file_edited_in_browser"]);
  assert.equal(audits[0].fields.file, "notes.md");

  await writeFile(filename, "# Changed elsewhere\n");
  const conflict = await fetch(`${base}${editorPath}/api/save`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-cg-csrf": csrf },
    body: JSON.stringify({ content: "stale browser contents\n" }),
  });
  assert.equal(conflict.status, 409);
  assert.match((await conflict.json()).error, /changed after you opened/i);
  assert.equal(await readFile(filename, "utf8"), "# Changed elsewhere\n");
  assert.ok(authorizationChecks >= 4, "authorization must be repeated on exchange, page load, and saves");
});

test("file editor grants reject invalid inputs and expire before exchange", async () => {
  resetFileEditorStateForTests();
  assert.equal(createFileEditorGrantUrl({ baseUrl: "javascript:alert(1)" }), "");
  const expired = createFileEditorGrantUrl({
    baseUrl: "https://gateway.example",
    channelId: "C1",
    slug: "channel",
    ownerId: "U1",
    relative: "a.txt",
    expectedHash: "a".repeat(64),
    now: Date.now() - FILE_EDITOR_GRANT_TTL_MS - 1,
  });
  const app = express();
  app.use("/file-editor", createFileEditorRouter({ authorize: async () => ({ root: "/missing" }) }));
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(expired.replace("https://gateway.example", base), { redirect: "manual" });
    assert.equal(response.status, 410);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    resetFileEditorStateForTests();
  }
});

test("the editor acknowledges the SUBMITTED text, not whatever is in the textarea when the save lands", async () => {
  let settle;
  const inFlight = new Promise((resolve) => { settle = resolve; });
  const page = editorPage({
    editorId: "editor-id",
    session: { csrf: "csrf-token", grant: { slug: "channel" } },
    file: { relative: "notes.md", text: "original\n" },
  });
  const { elements, requests } = runEditorScript(page.html, { initial: "original\n", fetchImpl: () => inFlight });
  const { editor, save, status } = elements;

  editor.value = "typed before saving\n";
  editor.fire("input");
  assert.equal(status.textContent, "Unsaved changes");

  const saving = save.fire("click");
  assert.equal(status.textContent, "Saving…");
  assert.equal(save.disabled, true);
  assert.equal(editor.readOnly, true, "the textarea is frozen while its contents are in flight");

  // The user keeps typing (or a second Cmd+S arrives) while the request is outstanding.
  editor.value = "typed DURING the save\n";
  await save.fire("click");
  assert.equal(requests.length, 1, "saves are serialized — no second PUT against the same expected hash");

  settle({ ok: true, json: async () => ({ ok: true, chars: 20 }) });
  await saving;

  assert.equal(JSON.parse(requests[0].options.body).content, "typed before saving\n");
  assert.equal(save.disabled, false);
  assert.equal(editor.readOnly, false);
  // The acknowledged string is NOT what the textarea holds now, so the edit must not read as saved —
  // that false "Saved" also silenced the beforeunload guard and lost the text on close.
  assert.equal(status.textContent, "Unsaved changes");
  assert.equal(status.className, "status");

  // Back to exactly the acknowledged string → genuinely saved.
  editor.value = "typed before saving\n";
  editor.fire("input");
  assert.equal(status.textContent, "Saved");
  assert.equal(status.className, "status ok");
});

test("a failed save reports the error and never claims the text landed", async () => {
  const page = editorPage({
    editorId: "editor-id",
    session: { csrf: "csrf-token", grant: { slug: "channel" } },
    file: { relative: "notes.md", text: "original\n" },
  });
  const { elements, requests } = runEditorScript(page.html, {
    initial: "original\n",
    fetchImpl: async () => ({ ok: false, json: async () => ({ error: "This file changed after you opened the editor." }) }),
  });
  const { editor, save, status } = elements;

  editor.value = "conflicting edit\n";
  await save.fire("click");
  assert.equal(requests.length, 1);
  assert.match(status.textContent, /changed after you opened/);
  assert.equal(status.className, "status bad");
  assert.equal(save.disabled, false, "the button must be usable again after a failure");
  assert.equal(editor.readOnly, false);

  // The rejected text is still unsaved, so reverting to it must not be mistaken for a clean state.
  editor.fire("input");
  assert.equal(status.textContent, "Unsaved changes");
});

test("the live markdown preview renders instead of throwing on every keystroke", () => {
  // Regression: the emphasis patterns were written as /\*\*…\*\*/ inside a template literal, so the
  // page shipped `/**([^*]+)**/g` — a block COMMENT followed by a bare `g`. inline() threw a
  // ReferenceError, markdown() and render() with it, and the whole status indicator went dead.
  const page = editorPage({
    editorId: "editor-id",
    session: { csrf: "csrf-token", grant: { slug: "channel" } },
    file: { relative: "notes.md", text: "" },
  });
  const { elements } = runEditorScript(page.html, { initial: "", fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  elements.editor.value = "# Title\n\n**bold** and *italic* and `code`\n";
  elements.editor.fire("input");
  assert.match(elements.preview.innerHTML, /<h1>Title<\/h1>/);
  assert.match(elements.preview.innerHTML, /<strong>bold<\/strong>/);
  assert.match(elements.preview.innerHTML, /<em>italic<\/em>/);
  assert.match(elements.preview.innerHTML, /<code>code<\/code>/);
  assert.match(elements.count.textContent, /chars/);
});
