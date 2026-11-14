import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { activityPage } from "../src/web/activity-page.js";

// Runs the exact script the Settings view serves against a minimal DOM.
class Element {
  constructor(tag = "div") {
    this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.attrs = {};
    this.value = ""; this.checked = false; this.disabled = false; this.hidden = false; this.parent = null; this.text = ""; this.className = "";
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  removeAttribute(key) { delete this.attrs[key]; }
  append(...items) { for (const item of items) { item.parent?.children.splice(item.parent.children.indexOf(item), 1); item.parent = this; this.children.push(item); } }
  replaceChildren(...items) { for (const child of this.children) child.parent = null; this.children = []; this.text = ""; this.append(...items); }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelectorAll(selector) { const tags = selector.split(",").map((s) => s.trim()); return this.all().filter((c) => tags.includes(c.tag)); }
  attached(root) { let node = this; while (node && node !== root) node = node.parent; return node === root; }
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const reply = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const find = (root, tag, text) => root.all().find((c) => c.tag === tag && c.textContent === text);

function snapshot(overrides = {}) {
  return {
    account: { id: "U_ME", name: "<img src=x onerror=alert(1)>", role: "member" },
    general: { nudges: false, replyMentions: false },
    connections: { composioMode: "personal", composio: { configured: true, last4: "0001", label: "Work" }, toolbox: { configured: false, last4: "" }, toolboxServer: "toolbox.example", email: [] },
    mcps: { limit: 5, servers: [] }, variables: [{ name: "API_TOKEN", exposure: "hidden", hosts: [], last4: "3456", provider: "local", setAt: 0 }],
    skills: { options: [{ key: "writer", label: "writer", description: "Writes" }], selected: [], foreign: [] },
    ssh: { max: 5, keys: [] }, ...overrides,
  };
}
function browser(fetchImpl, { hash = "" } = {}) {
  const elements = { "theme-toggle": new Element("button"), "settings-panel": new Element(), "settings-nav": new Element("nav"), "settings-status": new Element() };
  const document = { documentElement: new Element("html"), getElementById: (id) => elements[id], createElement: (tag) => new Element(tag) };
  const requests = [];
  const page = activityPage({ sessionId: "session", csrf: "fixture-csrf", view: "settings" });
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(page.html)?.[1];
  assert.ok(script);
  vm.runInNewContext(script, {
    document, location: { hash }, Intl, Date, confirm: () => true, history: { replaceState() {} },
    fetch: (url, options = {}) => { requests.push({ url, options }); return fetchImpl(url, options); },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  });
  return { elements, requests, page, panel: elements["settings-panel"], nav: elements["settings-nav"], status: elements["settings-status"] };
}

test("settings view serves one nonce script, no Activity stream and no innerHTML rendering", () => {
  const page = activityPage({ sessionId: "s", csrf: "c", view: "settings" });
  assert.equal((page.html.match(/<script nonce=/g) || []).length, 1);
  assert.doesNotMatch(page.html, /new EventSource|id="threads"/);
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(page.html)[1];
  assert.doesNotMatch(script.slice(script.indexOf("function settingsBrowser")), /innerHTML/);
  for (const view of ["activity", "subscriptions", "settings"]) assert.match(activityPage({ sessionId: "s", csrf: "c", view }).html, /href="\/activity\/s\/settings"/);
});

test("General renders hostile names as text and saves the reminder preference with CSRF", async () => {
  let data = snapshot();
  const { panel, requests, status } = browser(async (url, options) => {
    if (options.method === "POST") { data = snapshot({ general: { nudges: true, replyMentions: false } }); return reply({ notice: "Quiet-thread reminders are on.", settings: data }); }
    return reply(data);
  });
  await flush();
  assert.equal(requests[0].url, "/activity/session/api/settings");
  assert.ok(find(panel, "div", "<img src=x onerror=alert(1)>"), "the name is a text node");
  find(panel, "button", "Turn on").listeners.click();
  await flush();
  const post = requests.at(-1);
  assert.equal(post.options.headers["X-CG-CSRF"], "fixture-csrf");
  assert.deepEqual(JSON.parse(post.options.body), { action: "nudges", enabled: true });
  assert.equal(status.textContent, "Quiet-thread reminders are on.");
  assert.ok(find(panel, "button", "Turn off"));
});

test("a refused save keeps the form and what was typed, and shows the reason beside it", async () => {
  const { panel, nav, requests } = browser(async (url, options) => options.method === "POST"
    ? reply({ error: "\"PATH\" is reserved.", field: "name" }, 400) : reply(snapshot()), { hash: "#variables" });
  await flush();
  assert.equal(nav.all().find((c) => c.attrs["aria-current"] === "page").textContent, "Variables");
  const form = panel.all().find((c) => c.tag === "form");
  const [name] = form.querySelectorAll("input"), [value] = form.querySelectorAll("textarea");
  name.value = "PATH"; value.value = "/tmp";
  form.listeners.submit({ preventDefault() {} });
  await flush();
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), { action: "variable.save", name: "PATH", value: "/tmp", readable: false });
  assert.ok(form.attached(panel), "the same form stays on the page");
  assert.equal(name.value, "PATH");
  assert.equal(name.disabled, false, "the page unlocks after a refusal");
  assert.equal(form.all().find((c) => c.className === "settings-error").textContent, "\"PATH\" is reserved.");
});

test("secret inputs are never prefilled, and access loss clears the page", async () => {
  let ended = false;
  const { panel, nav, status } = browser(async (url, options) => ended ? reply({}, 401) : reply(snapshot()), { hash: "#connections" });
  await flush();
  assert.equal(nav.all().find((c) => c.attrs["aria-current"] === "page").textContent, "Connections");
  const passwords = panel.all().filter((c) => c.tag === "input" && c.type === "password");
  assert.ok(passwords.length >= 2);
  assert.ok(passwords.every((c) => c.value === ""));
  assert.match(panel.textContent, /Connected · ••••0001/);
  ended = true;
  find(panel, "button", "Remove").listeners.click();
  await flush();
  assert.equal(panel.children.length, 0);
  assert.match(status.textContent, /session has ended/);
});

test("Voice calls section offers the closed choices and saves the person's own preferences", async () => {
  let data = snapshot({ voice: { language: "Romanian", style: "conversational", patience: "patient", instructions: "Call me Tibi.", styles: ["brief", "conversational", "thinking-partner"], patience_options: ["quick", "normal", "patient"], limits: { language: 60, instructions: 2000 } } });
  const { panel, nav, requests, status } = browser(async (url, options) => {
    if (options.method === "POST") return reply({ notice: "Voice preferences saved. They apply to your next call.", settings: data });
    return reply(data);
  }, { hash: "#voice" });
  await flush();
  assert.equal(nav.all().find((c) => c.attrs["aria-current"] === "page").textContent, "Voice calls");
  assert.ok(find(panel, "h2", "How the agent talks to you on a call"));
  assert.ok(find(panel, "p", "Voice calls are not enabled on this gateway yet; an administrator turns them on under gateway Settings → Voice calls. Your preferences are kept for when they are."), "the settings view is rendered without the gateway flag here");
  const language = panel.querySelectorAll("input").find((c) => c.attrs.name === "language" || c.name === "language");
  assert.equal(language.value, "Romanian");
  const selects = panel.querySelectorAll("select");
  assert.deepEqual(selects.map((s) => s.name), ["style", "patience"]);
  assert.deepEqual(selects[0].children.map((o) => o.value), ["brief", "conversational", "thinking-partner"]);
  assert.equal(selects[0].children.find((o) => o.selected).value, "conversational");
  assert.equal(selects[1].children.find((o) => o.selected).value, "patient");
  const textarea = panel.querySelectorAll("textarea")[0];
  assert.equal(textarea.value, "Call me Tibi."); assert.equal(textarea.attrs.maxlength, "2000");
  language.value = "English"; selects[1].value = "quick"; textarea.value = "Keep it short.";
  const form = panel.all().find((c) => c.tag === "form");
  form.listeners.submit({ preventDefault() {} });
  await flush();
  const post = requests.at(-1);
  assert.equal(post.options.headers["X-CG-CSRF"], "fixture-csrf");
  assert.deepEqual(JSON.parse(post.options.body), { action: "voice.save", language: "English", style: "conversational", patience: "quick", instructions: "Keep it short." });
  assert.equal(status.textContent, "Voice preferences saved. They apply to your next call.");
});
