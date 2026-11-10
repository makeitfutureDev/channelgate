import test from "node:test";
import assert from "node:assert/strict";
import { mountCustomMcpEditor } from "../public/admin-custom-mcps.js";

// A small DOM fixture for the editor's input/event behavior. No credential or real network access.
class Element extends EventTarget {
  constructor() { super(); this.children = []; this.value = ""; this.textContent = ""; }
  appendChild(child) { this.children.push(child); return child; }
  createTHead() { return this.appendChild(new Element()); }
  createTBody() { return this.appendChild(new Element()); }
  insertRow() { return this.appendChild(new Element()); }
  insertCell() { return this.appendChild(new Element()); }
  focus() {}
}
const descendants = (node) => [node, ...node.children.flatMap(descendants)];

test("custom MCP web editor preserves Composio authentication for typed names and edits, and sends explicit changes", async (t) => {
  const previous = { document: globalThis.document, Node: globalThis.Node, fetch: globalThis.fetch };
  t.after(() => Object.assign(globalThis, previous));
  globalThis.Node = Element;
  globalThis.document = { createElement: () => new Element() };
  const controls = Object.fromEntries(["list", "state", "hint", "name", "url", "token", "auth", "save"].map((name) => [`.cmcp-${name}`, new Element()]));
  controls[".cmcp-auth"].value = "bearer";
  const root = { querySelector: (selector) => controls[selector] };
  let saved = [{ name: "second", serverName: "custom-second", url: "https://connect.composio.dev/mcp", authType: "composio", tokenLast4: "1234" }];
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    saved = [{ ...saved[0], ...body }];
    return { ok: true, json: async () => ({ servers: saved }) };
  };
  mountCustomMcpEditor({ root, endpoint: (name) => `/custom-mcps/${name}`, servers: saved });
  const input = (name, value) => { controls[`.cmcp-${name}`].value = value; controls[`.cmcp-${name}`].dispatchEvent(new Event("input")); };
  const save = async () => {
    controls[".cmcp-save"].dispatchEvent(new Event("click"));
    // The handler awaits two resolved promises for fetch and JSON before clearing the fields.
    await new Promise((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
  };
  input("name", "SECOND");
  assert.equal(controls[".cmcp-name"].value, "second");
  assert.equal(controls[".cmcp-auth"].value, "composio", "typing an existing name selects its saved authentication");
  input("url", "https://connect.composio.dev/mcp/v2");
  await save();
  assert.deepEqual(requests[0].body, { url: "https://connect.composio.dev/mcp/v2", authType: "composio" }, "blank key is omitted so the stored key survives");
  assert.equal(controls[".cmcp-token"].value, "");
  assert.equal(controls[".cmcp-auth"].value, "bearer", "a successful save resets a new entry to Bearer");

  const edit = descendants(controls[".cmcp-list"]).filter((node) => node.className === "ghost cmcp-edit").at(-1);
  edit.dispatchEvent(new Event("click"));
  assert.equal(controls[".cmcp-auth"].value, "composio");
  assert.equal(controls[".cmcp-token"].value, "", "editing never refills a saved key");
  controls[".cmcp-auth"].value = "bearer";
  controls[".cmcp-auth"].dispatchEvent(new Event("change"));
  input("token", "replacement-test-token");
  await save();
  assert.deepEqual(requests[1].body, { url: "https://connect.composio.dev/mcp/v2", authType: "bearer", token: "replacement-test-token" });
  assert.equal(controls[".cmcp-token"].value, "");
});
