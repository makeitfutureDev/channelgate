import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { reconcileChannelMeta } from "../public/admin-state.js";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

// Exercise the actual card listeners and save handler with a small DOM boundary. The full SPA
// boot would also request dashboards, providers and Slack membership, none involved in this edit.
const slice = (start, end) => {
  const from = client.indexOf(start);
  const to = client.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `UI section exists: ${start}`);
  return client.slice(from, to);
};
const setup = [
  slice('  const savebar = card.querySelector(".detail-savebar");', "  // Guest users checklist"),
  slice('  const workdirInput = card.querySelector(".ch-workdir");', '  card.querySelector(".ch-syncdrive").value'),
  slice('  savebar.querySelector(".save-channel").addEventListener', "  // Discard: re-render the detail"),
].join("\n");

class Control {
  value = "";
  checked = false;
  dataset = {};
  hidden = true;
  textContent = "";
  handlers = new Map();
  classList = { add() {}, remove() {} };
  addEventListener(name, handler) { this.handlers.set(name, handler); }
  closest() { return null; }
  focus() { this.focused = true; }
  dispatchEvent(event) { this.card.handlers.get(event.type)?.({ target: this }); }
  click() { return this.handlers.get("click")(); }
}

function fixture({ workDir = "/home/operator/project", saveError } = {}) {
  const controls = new Map();
  const card = new Control();
  const control = (selector) => {
    if (!controls.has(selector)) {
      const element = new Control();
      element.card = card;
      element.querySelector = control;
      controls.set(selector, element);
    }
    return controls.get(selector);
  };
  card.querySelector = control;
  control(".ch-model").value = "model-fixture";
  control(".ch-effort").value = "high";
  control(".ch-network").checked = true;
  const ch = { channelId: "C/FOLDER", slug: "folder-fixture", meta: { workDir, engine: "codex" } };
  const calls = [];
  const context = {
    card, ch, meta: ch.meta, Event, detailDirty: false, SELF_SAVING_CONTROLS: ".channel-env-card",
    engineSelect: { value: "codex" }, usersBox: { dataset: { ready: "" } }, mcpsBox: {}, skillsPicker: null,
    makeToolboxKeyInput: control(".ch-make-toolbox-key"),
    makeToolboxUrlInput: control(".ch-make-toolbox-url"), makeToolboxState: new Control(),
    clearMakeToolbox: false,
    tokenValue: () => "", selectedMcpEntries: () => [], checkedValues: () => [],
    explicitCheckedValues: () => [], channelGuestSavePatch: () => ({}),
    channelGuestAcceptedIds: () => null, reconcileChannelMeta,
    attachReveal() {}, revealSecret() {}, paintModePill() {}, renderConvList() {}, setTimeout() {},
    openFolderPicker() { throw new Error("Reset must not browse folders"); },
    async api(url, request) {
      calls.push({ url, method: request.method, body: JSON.parse(request.body) });
      if (saveError) throw new Error(saveError);
      return { meta: { ...ch.meta, ...JSON.parse(request.body) } };
    },
  };
  runInNewContext(setup, context);
  return { ch, context, calls, control };
}

test("Runtime offers a folder reset beside Browse and describes when it applies", () => {
  assert.match(html, /class="ch-browse ghost">Browse…<\/button>\s*<button type="button" class="ch-workdir-reset ghost"[^>]*>Reset to default<\/button>/);
  assert.match(html, /class="ch-workdir"[^>]*placeholder="Default gateway folder"/);
  assert.match(html, /Save to apply a folder change\. Existing files stay in their current folders\./);
});

test("reset stages an empty workDir, then Save persists it without resetting runtime options", async () => {
  const { ch, context, calls, control } = fixture();
  control(".ch-workdir-reset").click();
  assert.equal(control(".ch-workdir").value, "");
  assert.equal(control(".ch-workdir").focused, true);
  assert.equal(context.detailDirty, true);
  assert.equal(control(".detail-savebar").hidden, false);
  assert.equal(control(".msg").textContent, "Unsaved changes");
  assert.equal(ch.meta.workDir, "/home/operator/project", "reset waits for Save");
  assert.equal(calls.length, 0);

  await control(".save-channel").click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/channels/C%2FFOLDER/meta");
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].body.workDir, "");
  assert.equal(calls[0].body.engine, "codex");
  assert.equal(calls[0].body.model, "model-fixture");
  assert.equal(calls[0].body.effort, "high");
  assert.equal(calls[0].body.allowNetwork, true);
  assert.equal(ch.meta.workDir, "", "future renders retain the accepted reset");
  assert.equal(context.detailDirty, false);
  assert.equal(control(".msg").textContent, "Saved");
});

test("resetting an already-default folder does not create a pending change", () => {
  const { context, calls, control } = fixture({ workDir: "" });
  control(".ch-workdir-reset").click();
  assert.equal(context.detailDirty, false);
  assert.equal(control(".detail-savebar").hidden, true);
  assert.equal(calls.length, 0);
});

test("a failed folder reset save preserves the saved folder and pending edit", async () => {
  const { ch, context, control } = fixture({ saveError: "connection lost" });
  control(".ch-workdir-reset").click();
  await control(".save-channel").click();
  assert.equal(ch.meta.workDir, "/home/operator/project");
  assert.equal(control(".ch-workdir").value, "");
  assert.equal(context.detailDirty, true);
  assert.equal(control(".msg").textContent, "Couldn't save: connection lost");
});
