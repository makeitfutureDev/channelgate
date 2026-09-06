import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { passwordDialog, confirmDialog } from "../public/admin-view.js";

test("admin reauthentication uses a masked dialog that clears secrets on accept and cancellation", async (t) => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="confirm-password"[^>]*type="password"[^>]*autocomplete="current-password"/);
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /window\.prompt\([^\n]*current admin password/);
  const savedDocument = globalThis.document;
  const document = new EventTarget();
  const controls = new Map();
  for (const id of ["confirm-modal", "confirm-title", "confirm-body", "confirm-ok", "confirm-cancel", "confirm-password-field", "confirm-password", "previous"]) {
    const control = new EventTarget();
    Object.assign(control, { style: {}, classList: { toggle() {} }, hidden: true, value: "", focus() { document.activeElement = control; } });
    controls.set(id, control);
  }
  document.getElementById = (id) => controls.get(id);
  globalThis.document = document;
  t.after(() => { globalThis.document = savedDocument; });
  const input = controls.get("confirm-password");
  const field = controls.get("confirm-password-field");
  const modal = controls.get("confirm-modal");
  const previous = controls.get("previous");
  previous.focus();
  const key = (key, shiftKey = false) => {
    const event = new Event("keydown", { cancelable: true });
    Object.assign(event, { key, shiftKey });
    document.dispatchEvent(event);
  };

  const accepted = passwordDialog({ body: "Confirm a password change." });
  assert.equal(field.hidden, false);
  assert.equal(document.activeElement, input);
  key("Enter");
  assert.equal(modal.hidden, false, "an empty password cannot accept the dialog");
  key("Tab", true);
  assert.equal(document.activeElement, controls.get("confirm-ok"), "keyboard focus remains inside the modal");
  input.value = "fake-current-password";
  key("Enter");
  assert.equal(await accepted, "fake-current-password");
  assert.equal(input.value, "");
  assert.equal(field.hidden, true);
  assert.equal(document.activeElement, previous);

  const cancelled = passwordDialog();
  assert.equal(input.value, "", "a new request cannot reuse the old password");
  input.value = "fake-cancelled-password";
  key("Escape");
  assert.equal(await cancelled, "");
  assert.equal(input.value, "");
  assert.equal(modal.hidden, true);
  const ordinary = confirmDialog({ title: "Continue?" });
  assert.equal(field.hidden, true, "ordinary confirmations remain ordinary confirmations");
  controls.get("confirm-ok").dispatchEvent(new Event("click"));
  assert.equal(await ordinary, true);
});
