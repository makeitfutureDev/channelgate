import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { confirmDialog } from "../public/admin-view.js";

function dialogFixture(t) {
  const previous = globalThis.document;
  const document = new EventTarget();
  const controls = new Map();
  for (const id of ["confirm-modal", "confirm-title", "confirm-body", "confirm-ok", "confirm-cancel", "confirm-alternative", "confirm-password-field", "confirm-password"]) {
    const control = new EventTarget();
    Object.assign(control, { style: {}, hidden: false, value: "", classList: { toggle() {} }, focus() { document.activeElement = control; } });
    controls.set(id, control);
  }
  document.getElementById = (id) => controls.get(id);
  globalThis.document = document;
  t.after(() => { globalThis.document = previous; });
  const key = (key) => {
    const event = new Event("keydown", { cancelable: true });
    Object.assign(event, { key });
    document.dispatchEvent(event);
  };
  return { document, controls, key };
}

test("restart dialog defaults to wait, supports explicit force, and keeps cancellation separate", async (t) => {
  const { document, controls, key } = dialogFixture(t);
  const options = { title: "Restart?", confirmLabel: "Wait until idle", alternativeLabel: "Force restart", alternativeDanger: true };
  const wait = confirmDialog(options);
  assert.equal(document.activeElement, controls.get("confirm-ok"));
  assert.equal(controls.get("confirm-alternative").hidden, false);
  key("Enter");
  assert.equal(await wait, true);
  const force = confirmDialog(options);
  controls.get("confirm-alternative").focus();
  key("Enter");
  assert.equal(await force, "alternative");
  assert.equal(controls.get("confirm-alternative").hidden, true);
  const cancelled = confirmDialog(options);
  key("Escape");
  assert.equal(await cancelled, false);
  const ordinary = confirmDialog({ title: "Ordinary confirmation" });
  assert.equal(controls.get("confirm-alternative").hidden, true, "force action never leaks into another dialog");
  controls.get("confirm-cancel").dispatchEvent(new Event("click"));
  assert.equal(await ordinary, false);
});

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const start = source.indexOf('  document.getElementById("restart-daemon").addEventListener');
const endMarker = "\n  });";
const listener = source.slice(start, source.indexOf(endMarker, start) + endMarker.length);

test("Settings sends the selected restart policy and sends nothing on cancellation", async () => {
  for (const [choice, expected] of [[true, false], ["alternative", true], [false, null]]) {
    let handler;
    let dialog;
    const calls = [];
    const msg = { textContent: "" };
    const context = {
      document: { getElementById: (id) => id === "restart-daemon" ? { addEventListener: (_event, fn) => { handler = fn; } } : msg },
      confirmDialog: async (options) => { dialog = options; return choice; },
      api: async (url, options) => { calls.push({ url, options }); return url.includes("health") ? { instanceId: "before" } : { id: "restart", waitMs: 300_000 }; },
      setInterval() {}, clearInterval() {}, Date, Number, JSON,
    };
    runInNewContext(listener, context);
    await handler();
    assert.match(dialog.body, /interrupts active turns and jobs/);
    assert.equal(dialog.confirmLabel, "Wait until idle");
    assert.equal(dialog.alternativeLabel, "Force restart");
    const mutation = calls.find((call) => call.options?.method === "POST");
    if (expected === null) assert.equal(calls.length, 0);
    else {
      assert.equal(mutation.url, "/api/daemon/restart");
      assert.deepEqual(JSON.parse(mutation.options.body), { force: expected });
    }
  }
});
