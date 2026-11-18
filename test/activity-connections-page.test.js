import test from "node:test";
import assert from "node:assert/strict";
import { activityConnectionsBrowser } from "../src/web/activity-connections-page.js";

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {}; this.value = ""; this.text = ""; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(item => item.textContent).join(""); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ""; this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  all() { return this.children.flatMap(item => [item, ...item.all()]); }
  querySelectorAll(selector) { return this.all().filter(item => selector.split(",").includes(item.tag)); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const response = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const state = (extra = {}) => ({ mode: "sdk", canAdd: true, state: "ready", accounts: [], policy: { multiAccount: true, maxAccountsPerToolkit: 5 }, ...extra });
const app = (slug, extra = {}) => ({ slug, name: slug, canConnect: true, ...extra });
const find = (root, tag, text) => root.all().find(item => item.tag === tag && item.textContent === text);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(fetch, config = {}) {
  const requests = [], timers = new Map(); let timerId = 0;
  const browser = { document: { createElement: tag => new Element(tag) }, URL,
    fetch: (url, options) => { requests.push({ url, options }); return fetch(url, options); },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id) };
  const widget = activityConnectionsBrowser({ base: "/activity/me", csrf: "private-csrf", ...config }, browser);
  const root = widget.mount();
  return { root, widget, requests, tick() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); } };
}

test("cached mount groups own application accounts, renders hostile data as text and links to add", async () => {
  const { root, widget, requests } = fixture(async () => response(state({ accounts: [
    { app: "gmail", account: "<img src=x onerror=alert(1)>", alias: "work", status: "ACTIVE", isDefault: true },
    { app: "gmail", account: "personal@example.test", alias: "personal", status: "ACTIVE" },
  ] })));
  assert.equal(widget.mount(), root); await flush();
  assert.equal(requests.length, 1); assert.equal(root.all().filter(item => item.tag === "h3").length, 1);
  assert.ok(find(root, "div", "<img src=x onerror=alert(1)>"));
  assert.ok(find(root, "div", "Alias: work · ACTIVE · Default account"));
  assert.equal(find(root, "a", "Add connection").href, "/activity/me/settings/connections/new");
});

test("personal token mode is list-only even on the add page and never fetches the catalog", async () => {
  const { root, requests } = fixture(async () => response(state({ mode: "personal", canAdd: false })), { connectionsNew: true });
  await flush(); assert.equal(requests.length, 1);
  assert.match(root.textContent, /Add or manage applications in Composio/);
  assert.equal(find(root, "a", "Add connection"), undefined);
  assert.ok(find(root, "button", "Refresh"));
});

test("parent token changes refresh the cached widget and immediately clear removed accounts", async () => {
  const stale = deferred(), removed = deferred(); let calls = 0;
  const { root, widget } = fixture(async () => {
    calls++;
    if (calls === 1) return response(state({ mode: "personal", state: "unconfigured", canAdd: false }));
    if (calls === 2) return response(state({ mode: "personal", canAdd: false, accounts: [{ app: "gmail", account: "private@example.test" }] }));
    return calls === 3 ? stale.promise : removed.promise;
  });
  await flush(); assert.match(root.textContent, /Add your personal Composio token below/);
  await widget.refresh(); assert.match(root.textContent, /private@example.test/); assert.equal(widget.mount(), root);
  const beforeRemove = widget.refresh();
  assert.doesNotMatch(root.textContent, /private@example.test/);
  const removal = widget.refresh();
  removed.resolve(response(state({ mode: "personal", state: "unconfigured", canAdd: false })));
  await removal;
  stale.resolve(response(state({ mode: "personal", canAdd: false, accounts: [{ app: "gmail", account: "stale@example.test" }] })));
  await beforeRemove;
  assert.match(root.textContent, /Add your personal Composio token below/); assert.doesNotMatch(root.textContent, /private@example.test|stale@example.test/);
});

test("refresh ignores access refusals from the old inventory request", async () => {
  const stale = deferred(); let calls = 0;
  const { root, widget } = fixture(async () => ++calls === 1 ? stale.promise : response(state({ accounts: [{ app: "gmail", account: "current@example.test" }] })));
  await widget.refresh(); stale.resolve(response({}, 403)); await flush();
  assert.match(root.textContent, /current@example.test/); assert.doesNotMatch(root.textContent, /session has ended/);
});

test("load failure differs from empty, retries successfully and access loss clears old account data", async () => {
  let calls = 0;
  const { root } = fixture(async () => ++calls === 1 ? response({ error: "Provider unavailable" }, 502)
    : calls === 2 ? response(state({ accounts: [{ app: "gmail", account: "private@example.test" }] })) : response({}, 401));
  await flush(); assert.match(root.textContent, /Provider unavailable/); assert.doesNotMatch(root.textContent, /No applications/);
  find(root, "button", "Retry connections").listeners.click(); await flush();
  assert.match(root.textContent, /private@example.test/);
  find(root, "button", "Refresh").listeners.click(); await flush();
  assert.match(root.textContent, /session has ended/); assert.doesNotMatch(root.textContent, /private@example.test/);
});

test("provider unavailable state is never rendered as an empty connection list", async () => {
  const { root } = fixture(async () => response(state({ state: "unavailable", message: "Token is not configured" })));
  await flush(); assert.match(root.textContent, /Token is not configured/); assert.doesNotMatch(root.textContent, /No applications/);
});

test("unconfigured modes show setup instructions instead of an empty connected-account list", async () => {
  for (const mode of ["sdk", "personal"]) {
    const { root, requests } = fixture(async () => response(state({ mode, state: "unconfigured", canAdd: false })), { connectionsNew: true });
    await flush(); assert.match(root.textContent, mode === "sdk" ? /SDK is not configured/ : /Add your personal Composio token below/);
    assert.doesNotMatch(root.textContent, /No applications are connected/); assert.equal(requests.length, 1);
  }
});

test("catalog search ignores stale requests and preserves search focus by reusing its input", async () => {
  const held = deferred();
  const { root, tick, requests } = fixture(async url => !url.includes("/apps?") ? response(state()) : url.endsWith("query=") ? held.promise : response({ apps: [app("slack")], nextCursor: null }), { connectionsNew: true });
  await flush(); const search = root.querySelectorAll("input")[0]; search.value = "slack"; search.listeners.input(); tick(); await flush();
  assert.ok(find(root, "button", "Connect slack"));
  held.resolve(response({ apps: [app("gmail")], nextCursor: "stale" })); await flush();
  assert.equal(root.querySelectorAll("input")[0], search); assert.equal(find(root, "button", "Connect gmail"), undefined);
  assert.ok(requests.some(item => item.url.endsWith("query=slack")));
});

test("catalog pagination deduplicates applications and policy-refused applications cannot be chosen", async () => {
  const { root, requests } = fixture(async url => !url.includes("/apps?") ? response(state()) : url.includes("cursor=")
    ? response({ apps: [app("gmail"), app("slack", { canConnect: false, reason: "Limit reached" })], nextCursor: null })
    : response({ apps: [app("gmail")], nextCursor: "next page" }), { connectionsNew: true });
  await flush(); find(root, "button", "Load more applications").listeners.click(); await flush();
  assert.equal(root.all().filter(item => item.tag === "button" && item.textContent === "Connect gmail").length, 1);
  assert.equal(find(root, "button", "Connect slack").disabled, true);
  assert.match(requests.at(-1).url, /cursor=next%20page/);
  assert.equal(find(root, "button", "Load more applications").hidden, true);
});

test("catalog error shows retry without claiming that no apps match", async () => {
  let calls = 0;
  const { root } = fixture(async url => !url.includes("/apps?") ? response(state()) : ++calls === 1
    ? response({ error: "Catalog temporarily unavailable" }, 503) : response({ apps: [app("gmail")] }), { connectionsNew: true });
  await flush(); assert.match(root.textContent, /Catalog temporarily unavailable/); assert.doesNotMatch(root.textContent, /No applications match/);
  find(root, "button", "Retry applications").listeners.click(); await flush(); assert.ok(find(root, "button", "Connect gmail"));
});

test("create requires alias, prevents duplicate POST and offers explicit HTTPS authorization with CSRF", async () => {
  const held = deferred();
  const { root, requests } = fixture(async (url, options) => options.method === "POST" ? held.promise
    : url.includes("/apps?") ? response({ apps: [app("gmail")] }) : response(state()), { connectionsNew: true });
  await flush(); find(root, "button", "Connect gmail").listeners.click();
  const form = root.all().find(item => item.tag === "form"), alias = form.querySelectorAll("input")[0];
  await form.listeners.submit({ preventDefault() {} }); assert.match(form.textContent, /Enter an account alias/);
  alias.value = " work "; const first = form.listeners.submit({ preventDefault() {} }); const second = form.listeners.submit({ preventDefault() {} });
  assert.equal(requests.filter(item => item.options.method === "POST").length, 1);
  const post = requests.at(-1); assert.equal(post.options.headers["X-CG-CSRF"], "private-csrf");
  assert.deepEqual(JSON.parse(post.options.body), { app: "gmail", alias: "work" });
  held.resolve(response({ redirectUrl: "https://connect.composio.dev/link/one" })); await Promise.all([first, second]);
  const authorize = find(root, "a", "Continue to gmail"); assert.equal(authorize.target, "_blank"); assert.equal(authorize.rel, "noopener noreferrer");
  assert.equal(find(root, "a", "View your connections").href, "/activity/me/settings/connections");
});

test("unsafe authorization URLs are refused and a failed POST is not retried automatically", async () => {
  for (const redirectUrl of ["javascript:alert(1)", "http://connect.composio.dev/auth", "https://user:password@connect.composio.dev/auth", "https://connect.composio.dev:444/auth", "https://connect.composio.dev.attacker.test/auth", "https://attacker.test/auth", "/relative"]) {
    const { root, requests } = fixture(async (url, options) => options.method === "POST" ? response({ redirectUrl })
      : url.includes("/apps?") ? response({ apps: [app("gmail")] }) : response(state()), { connectionsNew: true });
    await flush(); find(root, "button", "Connect gmail").listeners.click();
    const form = root.all().find(item => item.tag === "form"); form.querySelectorAll("input")[0].value = "work";
    await form.listeners.submit({ preventDefault() {} });
    assert.match(root.textContent, /invalid authorization link/); assert.equal(find(root, "a", "Continue to gmail"), undefined);
    assert.equal(requests.filter(item => item.options.method === "POST").length, 1);
    assert.equal(form.querySelectorAll("input")[0].disabled, false);
  }
});

test("access loss during catalog/create clears the whole widget and ignores late responses", async () => {
  const held = deferred(); let calls = 0;
  const { root, tick } = fixture(async url => !url.includes("/apps?") ? response(state()) : ++calls === 1 ? held.promise : response({}, 403), { connectionsNew: true });
  await flush(); const search = root.querySelectorAll("input")[0]; search.value = "new"; search.listeners.input(); tick(); await flush();
  assert.match(root.textContent, /session has ended/);
  held.resolve(response({ apps: [app("private-app")] })); await flush(); assert.doesNotMatch(root.textContent, /private-app/);
});
